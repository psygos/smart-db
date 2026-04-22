# CI/CD Pipeline Spec — Smart DB

Branch: `dev`
Date: 2026-04-16

---

## 1. Current State

### What exists

One workflow: `.github/workflows/ci.yml`

| Job | Trigger | Steps |
|-----|---------|-------|
| `check` | push/PR → `main` | install → typecheck → test |
| `deploy` | push → `main` (after `check`) | git reset → pnpm install via docker → compose build → health poll |

### Known Problems

**P1 — Deploy job assumes a git repo on server.**
`ci.yml` runs `git fetch origin main && git reset --hard origin/main`, but the server has no git repo. This step silently does nothing or fails.

**P2 — `pnpm build` never runs in CI.**
The gateway Dockerfile builds the frontend internally — a broken Vite build is only caught inside the container build, after the green CI check.

**P3 — Coverage not enforced.**
`pnpm test` is called, not `pnpm coverage`. 100% coverage requirement goes unenforced. When `pnpm coverage` was introduced in CI it revealed ~70% actual coverage — `scripts/`, `app-controller.ts`, `render.ts`, `zitadel-client.ts`, and several partdb files are significantly undertested. Coverage enforcement is deferred until that debt is addressed.

**P4 — No CI on `dev` branch.**
Workflow only triggers on `main`. All work on `dev` is unchecked until a PR is opened.

**P5 — No staging or preview environments.**
One environment: production. Every merged commit goes directly to prod with no intermediate validation.

**P6 — No rollback path.**
Health check failure leaves partially-upgraded containers running with no recovery.

**P7 — Unlabeled self-hosted runner.**
`runs-on: self-hosted` with no labels — any registered runner can pick up the deploy job.

---

## 2. Infrastructure Model

Two separate Proxmox LXC containers. Each runs Docker Compose and has its own GitHub Actions self-hosted runner registered with a distinct label.

| LXC | Purpose | Hosts | Runner label |
|-----|---------|-------|--------------|
| **prod-lxc** | Production only | `main` branch deploys | `smartdb-prod-lxc` |
| **staging-lxc** | Staging + PR previews | `dev` branch + all PRs → `dev` | `smartdb-staging-lxc` |

**prod-lxc** — existing container at `10.42.200.4`. Runs the full three-service stack (gateway + middleware + partdb). One Compose project: `smartdb-prod`.

**staging-lxc** — `192.168.7.3` (`root`, key `~/.ssh/id_ed25519`). Runs multiple slim stacks (gateway + middleware only, no Part-DB). Compose projects are isolated by project name and host port.

---

## 3. Environment Model

All non-production environments live on **staging-lxc**.

| Environment | Tracks | Compose Project | HTTPS Port | Part-DB | Data Path | Data lifecycle |
|-------------|--------|-----------------|------------|---------|-----------|----------------|
| production  | `main` | `smartdb-prod`    | 443        | yes     | `state/prod/` | persistent |
| staging     | `dev`  | `smartdb-staging` | 9443       | no      | `state/staging/` | **persistent across deploys** |
| preview-N   | PR branch | `smartdb-pr-{N}` | `10000+N` | no  | `state/preview-{N}/` | **reset on every commit** |

**Part-DB:**
Part-DB is too heavy to spin up per preview. Staging and previews run without it. The middleware outbox will queue failed sync attempts harmlessly — SmartDB is the source of truth and the app stays fully functional.

**Port arithmetic for previews:**
`HTTPS_PORT = 10000 + PR_NUMBER`. For PR #42: `https://{STAGING_HOST}:10042`. Supports up to PR #9999. A guard in the workflow rejects any PR whose computed port collides with 9443 (staging) or 443/8443 (not on this host, but guard anyway).

**TLS:**
Shared root CA. The prod root CA (`smart-db-root-ca.key` + `smart-db-root-ca.crt`) signs both the prod and staging server certs. Client devices only need to trust one CA. `generate-tls-certs.sh` will be parameterized to accept a target IP so it can be run for `192.168.7.3` using the existing CA — the CA key never needs to permanently live on staging-lxc. Only `server.crt` and `server.key` are deployed there.

**Self-hosted runners:**
Both runners run directly inside their respective LXC containers and call `docker compose` commands directly — no SSH indirection.

---

## 4. Target Pipeline

```
Any push or PR (any branch → dev or main)
  └─► check  [runs-on: ubuntu-latest]
        ├── typecheck
        ├── build  (pnpm build)
        └── coverage  (pnpm coverage — enforces 100%)

Push → dev  (after check)
  └─► staging-deploy  [runs-on: smartdb-staging-lxc]
        ├── snapshot current staging image IDs
        ├── rsync workspace → /opt/smart-db/builds/staging/
        ├── docker compose -p smartdb-staging build --no-cache middleware gateway
        ├── docker compose -p smartdb-staging up -d
        ├── health poll: https://{STAGING_HOST}:9443/health  (30s)
        └── on failure: restore previous images, exit 1

PR opened/synchronized/reopened  (base = dev)
  └─► preview-deploy  [runs-on: smartdb-staging-lxc]
        ├── compute PR_PORT = 10000 + PR_NUMBER, guard for collisions
        ├── tear down existing preview (if any): down --volumes --remove-orphans
        ├── rm -rf /opt/smart-db/state/preview-{N}/  (wipe data on every commit)
        ├── rsync workspace → /opt/smart-db/builds/preview-{N}/
        ├── docker compose -p smartdb-pr-{N} build --no-cache middleware gateway
        ├── docker compose -p smartdb-pr-{N} up -d
        ├── health poll: https://{STAGING_HOST}:{PR_PORT}/health  (30s)
        ├── seed catalog (every deploy — data is always fresh)
        └── post/update PR comment with preview URL + commit SHA

PR closed  (base = dev)
  └─► preview-teardown  [runs-on: smartdb-staging-lxc]
        ├── docker compose -p smartdb-pr-{N} down --volumes --remove-orphans
        ├── rm -rf /opt/smart-db/builds/preview-{N}/
        ├── rm -rf /opt/smart-db/state/preview-{N}/
        └── update PR comment: "Preview torn down"

Push → main  (after check)
  └─► prod-deploy  [runs-on: smartdb-prod-lxc]
        ├── snapshot current prod image IDs
        ├── rsync workspace → /opt/smart-db/builds/prod/
        ├── docker compose -p smartdb-prod build --no-cache middleware gateway
        ├── docker compose -p smartdb-prod up -d
        ├── health poll: https://10.42.200.4/health  (30s)
        └── on failure: restore previous images, exit 1
```

---

## 5. Work Items

### W1 — Extend `check` triggers to `dev` and PRs

```yaml
on:
  push:
    branches: [main, dev]
  pull_request:
    branches: [main, dev]
```

`check` runs on `ubuntu-latest` — no self-hosted runner needed.

### W2 — Add `pnpm build` to `check`

```yaml
- name: Build
  run: pnpm build
```

Insert after typecheck, before coverage.

### W3 — Replace `pnpm test` with `pnpm coverage` in `check`

```yaml
- name: Test & Coverage
  run: pnpm coverage
```

### W4 — Create `staging.yml`

New file: `.github/workflows/staging.yml`

- Trigger: `push` to `dev`, `needs: check`
- Runner: `[self-hosted, smartdb-staging-lxc]`
- Steps: snapshot → rsync → build → up → health poll → rollback on failure

Environment variables needed from GitHub secrets: `STAGING_HOST` (IP of staging-lxc).

### W5 — Create `preview.yml`

New file: `.github/workflows/preview.yml`

```yaml
on:
  pull_request:
    branches: [dev]
    types: [opened, synchronize, reopened, closed]

permissions:
  pull-requests: write
```

Runner: `[self-hosted, smartdb-staging-lxc]`

**deploy job** (types: opened, synchronize, reopened):
1. `PR_N=${{ github.event.pull_request.number }}`
2. `PR_PORT=$((10000 + PR_N))` — guard: fail if port is 443, 8443, or 9443
3. Tear down any existing preview: `docker compose -p smartdb-pr-${PR_N} down --volumes --remove-orphans 2>/dev/null || true`
4. Wipe state: `rm -rf /opt/smart-db/state/preview-${PR_N}/` — data is always fresh per commit
5. Rsync workspace to `/opt/smart-db/builds/preview-${PR_N}/`
6. `COMPOSE_PROJECT_NAME=smartdb-pr-${PR_N} HTTPS_PORT=${PR_PORT} docker compose build --no-cache middleware gateway`
7. `docker compose -p smartdb-pr-${PR_N} up -d`
8. Poll health endpoint (30s)
9. Seed catalog (every time — state was just wiped)
10. Post/update PR comment via `gh pr comment --edit-last` or create new

**teardown job** (type: closed):
1. `docker compose -p smartdb-pr-${PR_N} down --volumes --remove-orphans`
2. `rm -rf /opt/smart-db/builds/preview-${PR_N}/ /opt/smart-db/state/preview-${PR_N}/`
3. Update PR comment

### W6 — Create `prod.yml`, delete (or gut) `ci.yml`

Split `ci.yml` into `ci.yml` (check only) and `prod.yml` (deploy only).

`prod.yml`:
- Trigger: `push` to `main`, `needs: check` (references `ci.yml`'s check job via `workflow_run` or inline)
- Runner: `[self-hosted, smartdb-prod-lxc]`
- Fix P1: replace `git fetch/reset` with rsync to `/opt/smart-db/builds/prod/`
- Fix P6: snapshot image IDs before deploy, restore on health check failure

### W7 — Parameterize `compose.yaml` and `Caddyfile`

Staging and previews use a slim Compose file (no Part-DB, no port 8443). Two files:

- `deploy/compose.yaml` — full prod stack (unchanged except Caddyfile parameterization)
- `deploy/compose.preview.yaml` — gateway + middleware only, no partdb service

`Caddyfile` parameterized via environment variable substitution:

```caddyfile
https://{$CADDY_HOST}:{$CADDY_PORT} {
  tls /certs/server.crt /certs/server.key
  ...
}
```

`CADDY_HOST` and `CADDY_PORT` injected via `compose.preview.yaml` environment block.

### W8 — Rollback helper (staging and prod)

Shared pattern. Before `docker compose up -d`:

```bash
PREV_MIDDLEWARE=$(docker compose -p "$PROJECT" images -q middleware 2>/dev/null || true)
PREV_GATEWAY=$(docker compose -p "$PROJECT" images -q gateway 2>/dev/null || true)
```

On health check failure:
```bash
if [ -n "$PREV_MIDDLEWARE" ] && [ -n "$PREV_GATEWAY" ]; then
  docker tag "$PREV_MIDDLEWARE" "${PROJECT}_middleware:rollback"
  docker tag "$PREV_GATEWAY"    "${PROJECT}_gateway:rollback"
  # update compose to use :rollback tags and re-up
  docker compose -p "$PROJECT" up -d
fi
exit 1
```

### W9 — Parameterize `generate-tls-certs.sh`

The script has `IP.1 = 10.42.200.4` / `IP.2 = 10.42.200.136` hardcoded in the OpenSSL config. Add a `--ip` flag (repeatable) so it can be called for any target:

```bash
# prod (existing behaviour)
./generate-tls-certs.sh --ip 10.42.200.4 --ip 10.42.200.136

# staging — reuses existing CA, produces a new server.crt/server.key for 192.168.7.3
./generate-tls-certs.sh --ip 192.168.7.3
```

The CA creation block already skips regeneration when `smart-db-root-ca.key` exists, so running the script a second time with the prod CA present will only generate a new server cert signed by the same CA.

### W10 — Generate and deploy staging server cert

One-time manual step, run from a machine that has the prod CA key:

1. Run `./deploy/scripts/generate-tls-certs.sh --ip 192.168.7.3` (with prod CA key present at `deploy/state/caddy/certs/`).
2. `scp deploy/state/caddy/certs/server.crt deploy/state/caddy/certs/server.key smartdb-staging:/opt/smart-db/state/caddy/certs/`
3. The prod CA key never touches staging-lxc.

### W11 — Provision staging-lxc

Outside GitHub Actions, but blocks W4 and W5. Container already exists at `192.168.7.3`.

1. Verify Docker is installed and the daemon is running.
2. Complete W9 + W10 first (cert must be in place).
3. Register GitHub Actions self-hosted runner with label `smartdb-staging-lxc`.
4. Create directory structure:
   ```
   /opt/smart-db/{builds,state}/
   /opt/smart-db/state/staging/data/
   /opt/smart-db/state/caddy/certs/
   ```
5. Place `deploy/config/middleware.env` adapted for staging:
   - `FRONTEND_ORIGIN=https://192.168.7.3:9443`
   - `PUBLIC_BASE_URL=https://192.168.7.3:9443`
   - `PARTDB_BASE_URL=` (empty — no Part-DB on staging)
6. Add GitHub secret: `STAGING_HOST=192.168.7.3`.

### W12 — Label prod-lxc runner

Register the existing prod-lxc runner with label `smartdb-prod-lxc`. Update `ci.yml`'s deploy job to use `[self-hosted, smartdb-prod-lxc]`.

### W13 — Pin `node-version` across all workflows

```yaml
env:
  NODE_VERSION: "24"
```

Use `node-version: ${{ env.NODE_VERSION }}` in every workflow. Matches `node:24-bookworm-slim` in both Dockerfiles.

---

## 6. File Layout After Implementation

```
.github/
  workflows/
    ci.yml          # check only (typecheck, build, coverage) — all branches
    staging.yml     # staging deploy on push → dev
    preview.yml     # PR previews for PRs → dev
    prod.yml        # production deploy on push → main

deploy/
  compose.yaml              # full stack: gateway + middleware + partdb (prod)
  compose.preview.yaml      # slim stack: gateway + middleware only (staging + previews)
  Caddyfile                 # parameterized via CADDY_HOST / CADDY_PORT
  Dockerfile.gateway
  Dockerfile.middleware
```

Server paths on **prod-lxc** (`10.42.200.4`):
```
/opt/smart-db/builds/prod/      # rsync target for main
/opt/smart-db/state/prod/data/  # production SQLite
```

Server paths on **staging-lxc** (`{STAGING_HOST}`):
```
/opt/smart-db/builds/staging/         # rsync target for dev
/opt/smart-db/builds/preview-{N}/     # rsync target for PR N
/opt/smart-db/state/staging/data/     # staging SQLite (persistent)
/opt/smart-db/state/preview-{N}/data/ # preview SQLite (deleted on PR close)
```

---

## 7. Out of Scope

- Docker image registry (local build-and-run only)
- Secrets rotation automation
- Dependency update automation (Dependabot / Renovate)
- Feature-level work of any kind
- Multi-region or load-balanced deployments

---

## 8. Resolved Decisions

| # | Decision |
|---|----------|
| Q1 | staging-lxc is `192.168.7.3` (`root`, `~/.ssh/id_ed25519`) |
| Q2 | Staging data persists across `dev` deploys. Preview data resets on every commit. |
| Q3 | Shared root CA. Prod CA signs both prod and staging server certs. One cert for client devices to trust. |
| Q4 | `GITHUB_TOKEN` has `pull-requests: write`. `preview.yml` will declare `permissions: pull-requests: write` explicitly. |
