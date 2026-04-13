# CLAUDE.md

This file is the single source of truth for Smart DB. Every Claude instance working on this project MUST read and follow this document.

## Commands

```bash
pnpm install                  # install all dependencies
pnpm dev                      # run frontend (5173) + middleware (4000) in parallel
pnpm build                    # TypeScript build all packages/apps
pnpm typecheck                # tsc --noEmit across all packages/apps
pnpm test                     # vitest run (all tests)
pnpm coverage                 # vitest with 100% coverage enforcement
```

**Deployment** (to Raspberry Pi — see `deploy/README.md` for credentials):
```bash
# SSH into the server (password in deploy/config — NOT in this file)
ssh root@<DEPLOY_HOST>

# On the server:
cd /opt/smart-db/deploy
docker compose build middleware gateway --no-cache
docker compose up -d

# Seed scripts (run inside middleware container):
docker exec deploy-middleware-1 sh -c 'cd /workspace && pnpm --filter @smart-db/middleware exec tsx src/scripts/seed-catalog.ts'
docker exec deploy-middleware-1 sh -c 'cd /workspace && pnpm --filter @smart-db/middleware smartdb:reset'
```

**Part-DB UI**: `https://<DEPLOY_HOST>:8443` (credentials in `deploy/config/partdb.env`)
**Smart DB UI**: `https://<DEPLOY_HOST>`

## Architecture

Smart DB is an intake-first inventory system for a university makerspace. Monorepo with three packages:

- **`packages/contracts`** — Zod schemas, typed errors, Result type, FSM transitions. Both apps import from `@smart-db/contracts`.
- **`apps/middleware`** — Fastify 5 API + SQLite (Node.js native `node:sqlite`, WAL mode). Port 4000.
- **`apps/frontend`** — TypeScript + HTML/CSS phone-first UI, built with Vite. Port 5173.

### Deployment Model

- **Server**: Raspberry Pi 5 at `10.42.200.4`, running Docker Compose
- **Containers**: `gateway` (Caddy + frontend static), `middleware` (Node.js), `partdb` (Part-DB Symfony)
- **Data**: SQLite at `/opt/smart-db/deploy/state/smartdb/data/smart.db`
- **Part-DB sync**: Outbox pattern, worker ticks every 2s, guaranteed eventual delivery
- **The server copy at `/opt/smart-db/` is NOT a git repo.** Code is deployed via rsync/scp from the local Mac repo at `/Users/ttrb/smart-db/`.

### Key Files

| Path | Purpose |
|------|---------|
| `packages/contracts/src/schemas.ts` | All Zod schemas, enums, measurement units |
| `packages/contracts/src/transitions.ts` | FSM transition tables (INSTANCE_TRANSITIONS) |
| `apps/middleware/src/services/inventory-service.ts` | All domain logic (~2000 LOC) |
| `apps/middleware/src/routes/inventory-routes.ts` | HTTP route handlers |
| `apps/middleware/src/partdb/partdb-rest.ts` | Part-DB HTTP client (JSON-LD, Hydra) |
| `apps/middleware/src/partdb/category-resolver.ts` | Category hierarchy with cache |
| `apps/middleware/src/outbox/partdb-outbox.ts` | Outbox store (enqueue, claim, deliver) |
| `apps/middleware/src/outbox/partdb-worker.ts` | Background worker draining outbox |
| `apps/frontend/src/rewrite/app-controller.ts` | Main frontend controller, app state, orchestration |
| `apps/frontend/src/rewrite/render.ts` | DOM-first rendering layer |
| `apps/frontend/src/rewrite/services/camera-scanner-service.ts` | Hybrid jsQR + barcode-detector scanner |
| `apps/frontend/src/rewrite/parsers/*` | Parse-first form command modules |

---

## FINITE STATE MACHINES — THE GROUND TRUTH

**Every state, every transition, every guard is defined here. If the code disagrees with this document, the code is wrong.**

### FSM 1: QR Code Lifecycle

States: `printed`, `assigned`, `voided`, `duplicate`

```
                assignQr()                    voidQrCode()
  printed ──────────────────► assigned ──────────────────► voided
                               [status='printed']          [cascades to inventory entity]
```

| From | Event | To | Guard | Side Effects |
|------|-------|----|-------|-------------|
| `printed` | `assignQr()` | `assigned` | `status = 'printed'` | INSERT instance/bulk, INSERT stock_events('labeled'), enqueue create_lot |
| `assigned` | `voidQrCode()` | `voided` | `status = 'assigned'` | Cascade dispose/consume to entity, enqueue delete_lot |
| `voided` | `voidQrCode()` | `voided` | idempotent | no-op |
| _(not in DB)_ | `assignQr()` | `printed` → `assigned` | external barcode, not in qrcodes table | Auto-INSERT into 'external' batch, then normal assign flow |

**`duplicate` is defined but never used in any transition.**

### FSM 2: Physical Instance Lifecycle

States: `available`, `checked_out`, `consumed`, `damaged`, `lost`

```
                    checked_out                    returned
  available ◄──────────────────► checked_out ──────────────► available
      │                              │
      ├── consumed ──► consumed      ├── consumed ──► consumed
      ├── damaged ──► damaged        ├── damaged ──► damaged
      └── lost ───► lost             └── lost ───► lost

  damaged ──► disposed ──► consumed     lost ──► returned ──► available
          ──► returned ──► available         ──► disposed ──► consumed
          ──► lost ───► lost
```

**`consumed` is TERMINAL. No transitions out.**

Full transition table (from `INSTANCE_TRANSITIONS` in `transitions.ts`):

| From | Event | To | Guard |
|------|-------|----|-------|
| available | moved | available | location must change |
| available | checked_out | checked_out | assignee = input.assignee or actor |
| available | consumed | consumed | — |
| available | damaged | damaged | — |
| available | lost | lost | — |
| available | disposed | consumed | — |
| checked_out | moved | checked_out | location must change |
| checked_out | checked_out | checked_out | re-checkout to different person |
| checked_out | returned | available | — |
| checked_out | consumed | consumed | — |
| checked_out | damaged | damaged | — |
| checked_out | lost | lost | — |
| checked_out | disposed | consumed | — |
| damaged | moved | damaged | location must change |
| damaged | disposed | consumed | — |
| damaged | returned | available | — |
| damaged | lost | lost | — |
| lost | returned | available | — |
| lost | disposed | consumed | — |
| consumed | _(none)_ | — | TERMINAL |

**`voidQrCode()` forces ANY → consumed via 'disposed' event, bypassing normal FSM.**

### FSM 3: Bulk Stock Quantity Events

Bulk stocks don't have a traditional FSM — they have a **quantity** (REAL) and a **derived level** (good/low/empty). The level is computed, never stored as the primary state.

```
quantity → level mapping:
  quantity <= 0                          → "empty"
  quantity <= minimumQuantity (if set)   → "low"
  otherwise                             → "good"
```

**"full" is a legacy value from migration. Never assigned at runtime.**

| Event | Quantity Change | Guard |
|-------|----------------|-------|
| moved | unchanged | location must change |
| restocked | current + delta | delta > 0 |
| consumed | current - delta | 0 < delta <= current |
| stocktaken | absolute value | quantity >= 0 |
| adjusted | current + delta | result >= 0, notes required |

Available actions depend on quantity:
- `quantity > 0`: moved, restocked, consumed, stocktaken, adjusted
- `quantity = 0`: moved, restocked, stocktaken, adjusted (no consume from empty)

**`voidQrCode()` forces level → 'empty' via 'consumed' event.**

### FSM 4: Part Type Review Lifecycle

```
  ┌─ resolvePartType() ──► needsReview=true ─┐
  │                                           │
  │           approvePartType()               │
  │        ──────────────────────►            │
  │                                           ▼
  │                               needsReview=false
  │                                           ▲
  │           mergePartTypes()                │
  └──────────────────────────────────────────►┘
             (source deleted, dest updated)
```

- New part types are ALWAYS created with `needsReview=true`
- `approvePartType()` sets `needsReview=false` (idempotent)
- `mergePartTypes(source, dest)` moves all inventory from source → dest, merges aliases, sets `needsReview=false` on dest, DELETES source

### FSM 5: Part-DB Outbox Lifecycle

States: `pending`, `leased`, `delivered`, `failed`, `dead`

```
  pending ──claimBatch()──► leased ──markDelivered()──► delivered
     ▲                        │
     │                        ├── markFailed(retryable, attempt<10) ──► failed ──► pending (backoff)
     │                        │
     │                        └── markFailed(attempt≥10) ──► dead
     │
     └── retry() ◄── failed
     └── retry() ◄── dead
     └── timeout (lease_expires_at < now) ◄── leased
```

| From | Event | To | Guard |
|------|-------|----|-------|
| pending | claimBatch | leased | depends_on IS NULL OR depends_on.status='delivered' |
| leased | markDelivered | delivered | HTTP 2xx from Part-DB |
| leased | markFailed | failed | retryable error, attempt < 10 |
| leased | markFailed | dead | attempt >= 10 |
| leased | timeout | pending | lease_expires_at < now |
| failed | retry | pending | manual admin action |
| dead | retry | pending | manual admin action |

**Max attempts: 10. Backoff: min(1000 * 2^attempt, 5 minutes). Lease duration: 30 seconds.**

Operation kinds: `create_category`, `create_measurement_unit`, `create_part`, `create_storage_location`, `delete_part`, `create_lot`, `update_lot`, `delete_lot`

Dependencies are respected: a `create_lot` waits for its `create_part` to be `delivered` before claiming.

---

## Coding Philosophy

### What We Do

- **Parser-first boundaries**: All inputs validated with Zod (`parseWithSchema()`) before any business logic.
- **TypeScript strict mode** with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`.
- **Result<T, E> types** for fallible operations (no thrown errors across module boundaries).
- **Discriminated unions** for variant types (outbox operations, scan responses, stock events).
- **Atomic transactions**: QR assignment + entity creation + event logging in a single SQLite transaction.
- **Append-only events**: State changes produce StockEvent records. History is never rewritten.
- **Case-insensitive normalization**: QR codes, part type names, locations, and category cache lookups all use `LOWER()` matching. Storage preserves original case; lookup ignores it.
- **The FSM is law**: Every state transition must be in the transition table. `getAvailableInstanceActions()` and `getAvailableBulkActions()` derive from the same table the backend enforces.
- **Outbox pattern for Part-DB**: SmartDB is the source of truth. Part-DB is a mirror. The user is NEVER blocked by Part-DB being down.
- **Self-hosted everything**: Fonts (fontsource), WASM (zxing_reader.wasm in public/), no CDN dependencies.

### What We Don't Do

- **No `any` or `unknown` casts** unless interfacing with a library that requires it (e.g., `QRCode.toBuffer`).
- **No silent failures**: Every error has a structured shape, propagates through typed Results, and is visible to the user via toasts or admin sync panel.
- **No bidirectional sync**: Part-DB never writes back to SmartDB. It's a one-way mirror.
- **No speculative abstractions**: Three similar lines of code is better than a premature helper function.
- **No backwards-compatibility shims**: If something is unused, delete it completely.
- **No feature flags**: If a feature isn't ready, don't ship it. Keep behavior explicit in the active rewrite runtime.
- **No CDN or external runtime dependencies**: The app must work on the local 10.42.200.x network with no internet.
- **No SF Symbols or icon libraries**: Text-only UI. The only icons are the toast status badges (✓ / ! / i) rendered as text in styled circles.
- **No default locations**: The assign form starts with an empty location. Users pick from the known-locations picker or type a new one.

### UI/UX Principles

- **Workshop precision aesthetic**: Fraunces (variable serif) for display, IBM Plex Sans for UI, IBM Plex Mono for codes/labels.
- **Single accent color**: Saffron `#c47214`. Everything else is warm off-white (`#f6f1e7`) and charcoal (`#1a1f2c`).
- **WCAG AA contrast everywhere**: `--ink-mute` at `#5c6270` (5.4:1 on cream), `--rule-strong` at `#8c826e` (3.4:1 on cream). Every state audited across 40 text/background pairs.
- **Toasts are terse**: No UUIDs, no internal types. "+1 Arduino Uno (now 5)" not "Saved restocked for bulk abc-123."
- **Picker cards, not dropdowns**: Part types and locations both use `.picker` button grids. Searchable, filterable, keyboard-accessible.
- **Scan input auto-clears**: After submit, after assign, after camera detect. The next wedge-scanner keystroke always starts fresh.

### Deployment Rules

- **Never edit files directly on the server** without syncing back to local git. The server has no `.git`.
- **Always `docker compose build --no-cache`** for both middleware and gateway after code changes.
- **Env files** (`deploy/config/*.env`) are gitignored. They contain secrets (Part-DB API token, session cookie secret, OIDC credentials).
- **Backups**: Server runs daily backups to `deploy/backups/`. Fetch to local via `scp root@<DEPLOY_HOST>:/opt/smart-db/deploy/backups/<timestamp>/smart.db /local/path/`.
- **CSP**: `script-src 'self' 'wasm-unsafe-eval'` is required for the barcode detector WASM. `default_sni 10.42.200.4` must be set in Caddyfile for TLS to work with IP-only access.

### Part-DB Integration Rules

- **Content types**: `application/ld+json` for GET/POST, `application/merge-patch+json` for PATCH.
- **List endpoints return Hydra collections**: Use `getCollection()` which unwraps `hydra:member`.
- **Category resolver**: Walks the path, creates parents before children, caches each level in `partdb_category_cache`. Cache keys stored lowercase.
- **Part creation**: The field for unit is `partUnit` (camelCase), not `default_measurement_unit`.
- **Outbox idempotency**: SHA256(kind + payload + target) prevents duplicate enqueues.

### Entity Compatibility Rule

```
countable=true  → entityKind='instance' ONLY  → tracked by lifecycle state
countable=false → entityKind='bulk' ONLY      → tracked by numeric quantity
```

This is enforced by `enforcePartTypeCompatibility()` and is **not overridable**. A countable part type can never be assigned as bulk, and vice versa. To change tracking mode, use `convert-to-bulk.ts`.

### Measurement Units

Fixed catalog in `schemas.ts`: pcs, g, kg, mg, m, cm, mm, mL, L, oz, lb. Integer units (pcs) reject fractional quantities. Countable part types MUST use integer units.

---

## Test Conventions

- **100% coverage** enforced by vitest config (excludes auth/types.ts and vite-env.d.ts).
- **Frontend tests in jsdom**: Matched by `environmentMatchGlobs` in vitest.config.ts.
- **Backend tests mock at the REST layer**: `restStub()` returns `{ getJson, getCollection, postJson, patchJson, deleteResource }`.
- **Frontend tests mock the entire api object**: frontend controller/runtime tests must include all methods used from `api.ts`, including `getKnownLocations` and `getInventorySummary`.

---

## Scripts Reference

| Script | Purpose | When to Use |
|--------|---------|-------------|
| `smartdb:reset` | Clear all SmartDB data + queue Part-DB deletes | Fresh start |
| `seed-catalog.ts` | Seed 61 Robu electronics part types | After reset, before first use |
| `seed-fdm-filaments.ts` | Seed 44 FDM filament types (kg, bulk) | After reset |
| `seed-sla-resins.ts` | Seed 15 SLA resin types (L/kg, bulk) | After reset |
| `convert-to-bulk.ts "<name>"` | Convert one part type from instance→bulk | Fix mis-created discrete types |
| `bulk-convert-robu.ts` | Batch convert Robu items to bulk (keeps 13 as instance) | After seeding |
| `fix-white-abs.ts` | Delete the mis-created White ABS+ instance | One-time cleanup |
