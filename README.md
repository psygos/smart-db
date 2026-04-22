<p align="center">
  <img src="docs/images/logo.svg" alt="Smart DB" width="400" />
</p>

<p align="center">
  A fast-ingest inventory system for university makerspaces.<br/>
  Built for the Mphasis AI & Applied Tech Lab at Ashoka University.
</p>

<p align="center">
  <a href="https://github.com/Makerspace-Ashoka/smart-db/actions/workflows/ci.yml"><img src="https://github.com/Makerspace-Ashoka/smart-db/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
</p>

<p align="center">
  <img src="docs/images/main_page.png" alt="Smart DB main interface" width="320" />
</p>

## Problem

Lab equipment arrives in bulk. Purchase orders list 60+ line items across motors, sensors, filaments, batteries, dev boards. Each item needs to be cataloged, counted, located, and eventually tracked when handed out to students. Doing this in a spreadsheet is slow and error-prone. Part-DB provides a rich catalog UI but has no fast-intake workflow.

## Solution

Smart DB puts a phone-first scanning interface in front of a typed inventory backend. A lab manager scans barcodes (manufacturer or QR), assigns part types from a pre-seeded catalog, and the system tracks quantities, locations, and check-out history. Every write is mirrored to a self-hosted [Part-DB](https://part-db.github.io/) instance through a durable outbox.

### Intake flow

<p align="center">
  <img src="docs/images/scan_section.png" alt="Barcode scanning interface" width="300" />
</p>

1. Scan a manufacturer barcode on a product box. Smart DB looks up the part type from the catalog.
2. If the barcode is new, a registration form opens with category, unit, and location fields.
3. First scan creates the record. Subsequent scans of the same barcode increment the bulk quantity.
4. Pre-printed QR stickers can be assigned to individual items for lifecycle tracking (checked out, returned, damaged, lost).

### Stock overview

<p align="center">
  <img src="docs/images/stock_page.png" alt="Inventory stock page with technical drawing wallpaper" width="320" />
</p>

The stock page shows all part types grouped by category with live quantities. Each row expands to reveal individual bins with QR codes and locations. The background features a tiling SVG wallpaper of technical drawings (gears, resistors, IC chips, bolts, spools) on graph paper -- a nod to the makerspace environment.

### Part-DB sync

Every inventory write is enqueued in a SQLite-backed outbox. A background worker delivers operations to Part-DB over its JSON-LD API with retry, exponential backoff, and dead-letter handling. If Part-DB is down, Smart DB keeps working. The outbox catches up on recovery.

## Architecture

```
Phone/Scanner --> Caddy (TLS) --> Fastify API --> SQLite
                                       |
                                  Outbox worker --> Part-DB (Symfony)
```

| Package | Stack | Role |
|---------|-------|------|
| `packages/contracts` | Zod, TypeScript | Shared schemas, FSM transition tables, Result types |
| `apps/middleware` | Fastify 5, node:sqlite | API server, domain logic, outbox worker |
| `apps/frontend` | TypeScript, HTML, CSS, XState, Vite | Phone-first scanning and management UI |

Deployed via Docker Compose on a self-hosted runner with CI/CD through GitHub Actions. Three containers: Caddy gateway, Node.js middleware, Part-DB.

## Barcode scanning

Hybrid detection strategy that works on every modern mobile browser over HTTPS:

- **jsQR** (pure JS, 150ms interval) for QR codes.
- **barcode-detector** (zxing-wasm polyfill, background init) for 1D barcodes: EAN-13, EAN-8, Code 128, Code 39, UPC-A/E, ITF.
- WASM binary self-hosted. No CDN. Works on air-gapped networks.
- Hardware USB wedge scanners supported (input auto-clears between scans).

## Part-DB typed layer

The middleware wraps Part-DB's API Platform with a fully typed client:

- REST client with `application/ld+json` reads/writes, `application/merge-patch+json` for PATCH, Zod response validation, structured error taxonomy (10 error kinds).
- Hydra collection unwrapping (extracts `hydra:member` from JSON-LD envelopes).
- Category resolver that walks slash-separated paths (`Materials/3D Printing Filament/PLA`), creates missing nodes top-down, caches IRIs with case-insensitive keys.
- Outbox with 8 operation kinds, SHA256 idempotency, dependency chains, lease-based concurrency, 10-attempt max with backoff, admin visibility.

## State machines

Five FSMs govern all stateful entities (full transition tables in [CLAUDE.md](CLAUDE.md)):

| Entity | States | Key rule |
|--------|--------|----------|
| QR Code | printed, assigned, voided | Void cascades to inventory entity |
| Physical Instance | available, checked_out, consumed, damaged, lost | consumed is terminal |
| Bulk Stock | derived from quantity (good/low/empty) | 5 event types with quantity guards |
| Part Type | needsReview boolean | Merge transfers inventory, deletes source |
| Outbox Row | pending, leased, delivered, failed, dead | Dependency ordering, lease expiry |

## Development

```bash
pnpm install
pnpm dev              # frontend :5173 + middleware :4000
pnpm typecheck        # tsc --noEmit, strict mode
pnpm test             # state/failure-focused test suite
```

TypeScript strict mode with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`. Zod validation at all system boundaries.

## Deployment

```bash
cd deploy
docker compose build --no-cache
docker compose up -d
```

Pushes to `main` trigger CI (typecheck + test on GitHub cloud) then auto-deploy via a self-hosted runner on the lab server. Environment variables in `deploy/config/*.env` (gitignored).

## Catalog seeding

Seed scripts parse purchase orders into typed part-type records with hierarchical categories:

| Script | Items | Unit |
|--------|-------|------|
| `seed-catalog.ts` | 61 Robu.in electronics | pcs |
| `seed-fdm-filaments.ts` | 44 eSUN/SunLU FDM filaments | kg |
| `seed-sla-resins.ts` | 15 SLA/MSLA resins | L/kg |

## Frontend

No framework. The frontend is vanilla TypeScript, HTML, and CSS.

- **Controller** (`app-controller.ts`) owns all state and delegates rendering to a DOM-first `render.ts` module. No virtual DOM, no reconciliation.
- **State machines** (XState) drive auth and scan lifecycle. The auth machine handles session restore, login redirect, logout, and expiry. The scan session machine handles the full flow from idle through lookup, unknown/label/instance/bulk resolution, assignment, and event recording.
- **Parse-first forms.** Every submission (assign, event, batch, merge) goes through a dedicated parser that returns `Result<Command, Failure[]>` before any API call. Field-level errors with recovery guidance.
- **Camera service** (`camera-scanner-service.ts`) manages getUserMedia, jsQR detection, and barcode-detector polyfill with an explicit failure taxonomy: capability, permission, acquisition, playback, scan-frame.
- **Scan mode** defaults to view-only on every page load. Auto-count (+1 per scan) is opt-in per session.

### Data model

A part type can own both individually QR-tracked units and a pooled bulk quantity. Intake starts as a quantity pool. Individual units are pulled from the pool when QR stickers are assigned. The database schema is unchanged; the mixed model is implemented in the service layer.

## License

Internal project. Ashoka University, Mphasis AI & Applied Tech Lab.
