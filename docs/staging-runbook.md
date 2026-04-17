# Staging Environment Runbook

Covers initial provisioning, day-to-day operation, and the PR preview system for the `dev` pipeline.

---

## Infrastructure

| | Production | Staging / Previews |
|---|---|---|
| **Host** | Proxmox LXC (`10.42.200.4`) | Proxmox LXC (`192.168.7.3`) |
| **Runner label** | `smartdb` | `smartdb-staging-lxc` |
| **Workflow** | `prod.yml` — push → `main` | `staging.yml` — push → `dev` |
| **Preview workflow** | — | `preview.yml` — PR → `dev` |

Staging and all PR previews share the staging-lxc container. They are isolated by Docker Compose project name and host port.

| Environment | Project name | HTTPS port | Data |
|---|---|---|---|
| staging | `smartdb-staging` | `9443` | persistent |
| preview-N | `smartdb-pr-{N}` | `10000 + N` | wiped on every commit |

---

## One-time provisioning (already done)

### 1. Base dependencies

```bash
ssh smartdb-staging
apt-get update && apt-get install -y curl rsync git ca-certificates gnupg

# Docker
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian trixie stable" \
  > /etc/apt/sources.list.d/docker.list
apt-get update && apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

### 2. Directory structure

```bash
mkdir -p /opt/smart-db/{builds,state,config}/staging
mkdir -p /opt/smart-db/state/staging/{data,caddy/certs}
mkdir -p /opt/smart-db/config/staging
```

### 3. TLS certificate

The staging cert is self-signed with its own root CA (separate from prod for now). Client devices that need to access staging must trust `smart-db-root-ca.crt`.

```bash
# Run directly on staging-lxc — generates CA + server cert for 192.168.7.3
cert_dir=/opt/smart-db/state/staging/caddy/certs

openssl req -x509 -new -nodes -newkey rsa:4096 \
  -keyout $cert_dir/smart-db-root-ca.key \
  -out $cert_dir/smart-db-root-ca.crt \
  -sha256 -days 3650 -subj "/CN=Smart DB Local Root CA"

# Server cert (SAN = 192.168.7.3)
# See deploy/scripts/generate-tls-certs.sh --ip 192.168.7.3 for the full script
```

To distribute the CA to a client device, copy `/opt/smart-db/state/staging/caddy/certs/smart-db-root-ca.crt` and install it as a trusted root.

### 4. GitHub Actions runner

```bash
cd /opt && mkdir -p actions-runner && cd actions-runner
curl -fsSL -o runner.tar.gz \
  https://github.com/actions/runner/releases/download/v2.323.0/actions-runner-linux-x64-2.323.0.tar.gz
tar xzf runner.tar.gz && rm runner.tar.gz

# Register (get a fresh token from repo → Settings → Actions → Runners → New runner)
RUNNER_ALLOW_RUNASROOT=1 ./config.sh \
  --url https://github.com/Makerspace-Ashoka/smart-db \
  --token <TOKEN> \
  --name smartdb-staging-lxc \
  --labels smartdb-staging-lxc \
  --unattended

# Persist root override and install as service
echo "RUNNER_ALLOW_RUNASROOT=1" >> /opt/actions-runner/.env
RUNNER_ALLOW_RUNASROOT=1 ./svc.sh install root
RUNNER_ALLOW_RUNASROOT=1 ./svc.sh start
```

### 5. Middleware config

```bash
# Copy the template and fill in secrets
cp deploy/config/staging.middleware.env.example \
   /opt/smart-db/config/staging/middleware.env
nano /opt/smart-db/config/staging/middleware.env
```

Fields that require real values:

| Field | How to get it |
|---|---|
| `SESSION_COOKIE_SECRET` | `openssl rand -base64 48` |
| `ZITADEL_CLIENT_ID` | From Zitadel console — staging application |
| `ZITADEL_CLIENT_SECRET` | From Zitadel console — staging application |
| `ZITADEL_ROLE_CLAIM` | Same value as production |

### 6. Zitadel application

Create a new **Web** application in Zitadel (`https://auth.makerspace.tools`) with:

| Setting | Value |
|---|---|
| Auth method | `CODE` (PKCE) |
| Redirect URI | `https://192.168.7.3:9443/api/auth/callback` |
| Post-logout URI | `https://192.168.7.3:9443` |

---

## Day-to-day operation

### Trigger a staging deploy

Any push to `dev` automatically deploys to staging after the check job passes. To redeploy without a code change:

```bash
git commit --allow-empty -m "redeploy staging" && git push origin dev
```

### Check runner status

```bash
gh api repos/Makerspace-Ashoka/smart-db/actions/runners \
  --jq '.runners[] | {name, status, labels: [.labels[].name]}'
```

### View staging logs

```bash
ssh smartdb-staging
docker compose -p smartdb-staging \
  -f /opt/smart-db/builds/staging/deploy/compose.preview.yaml logs -f
```

### Restart staging containers

```bash
ssh smartdb-staging
cd /opt/smart-db/builds/staging/deploy
COMPOSE_PROJECT_NAME=smartdb-staging \
HTTPS_PORT=9443 \
CADDY_HOST=192.168.7.3 \
SMART_DB_STATE=/opt/smart-db/state/staging \
SMART_DB_CONFIG=/opt/smart-db/config/staging \
  docker compose -f compose.preview.yaml restart
```

### Restart the runner

```bash
ssh smartdb-staging systemctl restart \
  actions.runner.Makerspace-Ashoka-smart-db.smartdb-staging-lxc.service
```

---

## PR previews

Opening a PR against `dev` automatically:
1. Runs the check job (typecheck, build, tests)
2. Wipes any existing preview state for that PR
3. Builds and starts a fresh environment on port `10000 + PR_NUMBER`
4. Seeds the part catalog
5. Posts a comment on the PR with the preview URL

Every subsequent push to the PR branch repeats steps 2–5 (always fresh data).

Closing or merging the PR tears down the containers and removes all state.

**Preview URL format:** `https://192.168.7.3:{10000 + PR_NUMBER}`

---

## Known gaps

- Staging uses a separate root CA from prod. Client devices need to trust it separately. Consolidating to a shared root CA (W9/W10 in `docs/cicd-spec.md`) is deferred.
- Coverage enforcement (`pnpm coverage`) is disabled in CI — codebase is at ~70% coverage. See `docs/cicd-spec.md` P3.
- `SESSION_COOKIE_SECRET` and Zitadel credentials are stored in a plain file on staging-lxc. Consider secrets management if the attack surface grows.
