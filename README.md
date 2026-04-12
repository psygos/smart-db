<p align="center">
  <img src="docs/images/logo.svg" alt="Smart DB" width="400" />
</p>

<p align="center">
  A fast-ingest inventory system for university makerspaces.<br/>
  Built for the Mphasis AI & Applied Tech Lab at Ashoka University.
</p>

<p align="center">
  <a href="https://github.com/psygos/smart-db/actions/workflows/ci.yml"><img src="https://github.com/psygos/smart-db/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
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
| `apps/frontend` | React 19, Vite | Phone-first scanning and management UI |

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
pnpm test             # 229 tests, 42 files
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

## Roadmap

This is a working prototype. It solves the intake problem and is used daily. The next version will be a ground-up rewrite.

### Architecture rewrite

The current frontend is a single 1200-line React component with 28 pieces of state and 33 props drilled into the scan tab. This was the fastest way to ship but is now the bottleneck for every new feature. The rewrite will:

- Drop React. Pure TypeScript, CSS, and HTML. No framework, no virtual DOM, no build-time JSX transform. Web components where encapsulation matters, plain DOM manipulation everywhere else.
- Replace the god component with route-level modules. Scan, Stock, Activity, and Admin become independent entry points that share a typed event bus, not a prop chain.
- Move state management to explicit finite state machines (XState or a lightweight equivalent). The FSM transition tables already exist in `packages/contracts` — the UI should be driven by them directly instead of mirroring them in useState.
- Server-render the shell. The current SPA loads a blank page, fetches a session, then renders. The rewrite will serve a usable HTML page from the middleware on first request.

### Data model

The current model forces a choice between instance tracking (QR per item, lifecycle states) and bulk tracking (quantity counter, no identity) at part-type creation time. In practice, the same part type needs both: a bulk count of how many arrived, plus individual QR tracking when units are handed out. The rewrite will unify these into a single model where every part type has a quantity pool and optionally has individually tracked units pulled from that pool.

### Deployment

- Git-based deploys on the server (currently rsync). The self-hosted GitHub Actions runner is a step toward this but the server still has no `.git` history of its own.
- Proper secrets management instead of `.env` files with plaintext tokens.
- Health check dashboards beyond the current `/health` endpoint.

### Testing

- Integration tests against a real Part-DB instance in CI (currently only unit tests with mocked HTTP).
- End-to-end scan flow tests using Playwright on a phone viewport.
- The current test suite was partially rewritten to match UI changes rather than testing behavior. The rewrite will test state transitions, not DOM text.

### Design

- Design system in Figma before writing CSS. The current visual direction (light base, blue structure, SVG technical wallpaper) was found through trial and error across four rewrites in one session.
- Component library with isolated stories for each state (empty, loading, error, populated).
- Proper dark mode as a first-class theme, not an afterthought.

## License

Internal project. Ashoka University, Mphasis AI & Applied Tech Lab.
