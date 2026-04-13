# SmartDB ⇄ Part-DB Sync Plan

## Purpose

This plan turns SmartDB into the source of truth and Part-DB into a typed, eventually consistent mirror with guaranteed delivery semantics.

The plan is grounded in the current codebase, not a greenfield rewrite.
That means it accounts for the existing SmartDB FSM, current SQLite schema, existing `PartDbClient`, and the recently tightened contract/error/auth layers.

## Core Principles

1. Parse, don't validate.
   HTTP input must parse into domain commands. Background sync rows must parse into typed operations.

2. Make illegal states unrepresentable.
   No operation should exist in a half-specified form. If a category path, quantity change, or dependency chain is incomplete, it does not parse.

3. SmartDB is the only source of truth.
   Part-DB is a projection. We never accept Part-DB edits back into SmartDB.

4. User writes must not depend on Part-DB availability.
   Inventory writes commit locally and enqueue sync work in the same SQLite transaction.

5. Delivery must be observable.
   Every sync attempt is durable, attributable, and inspectable.

6. FSM semantics come before UI semantics.
   Quantity events, category paths, lot lifecycles, and recovery/correction flows must be precise before frontend polish.

## Current-Code Reality Check

The proposed design is directionally correct, but several refinements are needed to fit the current code cleanly:

- SmartDB currently models bulk stock as qualitative `level`, not quantitative `amount`. Introducing quantities is a schema and FSM change, not just a Part-DB adapter.
- The current bulk event model is still `"moved" | "level_changed" | "consumed"`. The proposed `"restocked" | "stocktaken" | "adjusted"` events are the right direction, but they should replace `level_changed`, not coexist as a parallel model.
- `PartDbClient` is currently a health/auth probe wrapper. We should not mutate it into a giant everything-client. The layered split in the proposal is correct: health client stays small; sync REST/resources/ops should live beside it.
- Current migrations are linear `ALTER TABLE` SQL scripts. Migration v4/v5 should follow that pattern and keep explicit backfill behavior test-covered.
- Current error design uses `ApplicationError` plus the new frontend-side humanization. The new Part-DB sync path must preserve that shape, but should use `Result<T, PartDbError>` internally rather than throwing raw fetch/schema errors.
- The current FSM now has explicit route auth, idempotency reservations, and stronger request parsing. The outbox and worker should inherit those guarantees rather than introduce weaker side channels.

## Required Invariants

### Domain

- A part type has exactly one canonical category path in SmartDB.
- A category path is a non-empty array of non-empty segments.
- A bulk stock quantity is never negative.
- A unit is always known at the time a quantitative bulk stock is created.
- A synced Part-DB row reference in SmartDB is either `null` or a valid remote identifier shape.

### Delivery

- A local inventory mutation that requires sync enqueues at least one durable outbox row before commit completes.
- No outbox row can be processed by more than one worker lease at a time.
- A delivered outbox row is idempotent to replay and never silently mutates into another operation kind.
- Dependency edges are explicit and acyclic.

### Error Design

- Every Part-DB failure maps to a typed `PartDbError`.
- Retryability is a property of the error, not a heuristic guessed by the worker.
- Every dead-letter row has a structured last error payload.

### FSM

- Bulk quantity events are exhaustive and mutually exclusive.
- Part-lot lifecycle operations are derived from SmartDB entity state, not invented ad hoc in the worker.
- A correction/reconciliation path must exist before destructive deletion is treated as routine recovery.

## Refined Commit Stack

### Commit 0: Baseline Checkpoint

Purpose:
- Freeze the current green SmartDB baseline before sync work begins.

Contents:
- All current local changes already made in contracts, auth/RBAC/idempotency, scan flow, assignment flow, PDF/download, accessibility, deploy config, and tests.

Exit criteria:
- `pnpm typecheck`
- `pnpm test`

### Commit 1: Result And Error Foundations

Purpose:
- Introduce typed `Result` machinery and the Part-DB-specific error language without changing behavior yet.

Files:
- `packages/contracts/src/result.ts`
- `apps/middleware/src/partdb/partdb-errors.ts`
- `apps/middleware/src/partdb/partdb-schemas.ts`
- export plumbing and tests

Refinements:
- Keep `Result` minimal and composable.
- `PartDbError` must carry retryability as data.
- Schema mismatch and validation violations must be first-class error kinds.

### Commit 2: Schema And Migration Foundations

Purpose:
- Add the new persistence/model structures needed for sync without yet wiring the worker.

Files:
- `apps/middleware/src/db/migrations.ts`
- migration tests
- `packages/contracts/src/schemas.ts`
- `packages/contracts/src/transitions.ts`

Refinements:
- Replace qualitative bulk `level` with quantity-based bulk semantics in one coherent migration path.
- Add category path array, unit definition, Part-DB reference columns, category cache table, outbox table.
- Backfill existing `category` to `[category]`.
- Backfill `level` to quantity via an explicit mapping and record that the mapping is legacy-derived.

### Commit 3: Typed Part-DB REST Layer

Purpose:
- Introduce a pure, typed HTTP layer that talks to Part-DB resources and returns `Result`.

Files:
- `apps/middleware/src/partdb/partdb-rest.ts`
- `apps/middleware/src/partdb/resources/*.ts`
- tests for every error kind and happy path

Refinements:
- Keep the existing `PartDbClient` for health/auth discovery.
- The new REST/resources layer is for sync writes and reads only.
- No inventory logic here.

### Commit 4: Category Resolver And Resource Operations

Purpose:
- Materialize category hierarchies and measurement/storage resources with idempotent resolution.

Files:
- `apps/middleware/src/partdb/category-resolver.ts`
- `apps/middleware/src/partdb/partdb-operations.ts`
- tests

Refinements:
- Cache key is the full canonical path.
- Parent resolution is explicit.
- Existing category lookup must be by `(name, parent)` semantics, not name alone.
- Do not lose case information unless we explicitly decide to normalize.

### Commit 5: Outbox Store And Worker

Purpose:
- Add durable async delivery with leasing, retry backoff, and dead-letter visibility.

Files:
- `apps/middleware/src/outbox/outbox-types.ts`
- `apps/middleware/src/outbox/partdb-outbox.ts`
- `apps/middleware/src/outbox/partdb-worker.ts`
- tests

Refinements:
- Reuse the idempotency/reservation mindset already present in request handling.
- Lease expiry must reclaim abandoned work.
- Dependency blocking must be explicit and test-covered.

### Commit 6: Inventory Service Integration

Purpose:
- Inventory writes enqueue typed sync operations inside the same SQLite transaction.

Files:
- `apps/middleware/src/services/inventory-service.ts`
- service tests

Refinements:
- The service never calls Part-DB directly.
- Category and part sync should happen on part-type creation/update.
- Lot sync should happen on assign/move/quantity change/void.
- Corrections must be thought through before lot deletion is treated as the default cleanup path.

### Commit 7: Server Wiring And Admin Observability

Purpose:
- Start the worker, expose sync status/failures/retry endpoints, and make failure handling visible.

Files:
- `apps/middleware/src/server.ts`
- `apps/middleware/src/routes/partdb-admin-routes.ts`
- tests

Refinements:
- Worker lifecycle tied to Fastify lifecycle.
- Admin routes stay behind existing `smartdb.admin` enforcement.

### Commit 8: Frontend Quantity And Sync Surfaces

Purpose:
- Update forms and admin UI to speak quantity/category path/unit and show sync state.

Files:
- `apps/frontend/src/rewrite/app-controller.ts`
- `apps/frontend/src/rewrite/presentation-helpers.ts`
- `apps/frontend/src/rewrite/render.ts`
- `apps/frontend/src/rewrite/parsers/*`
- styles/tests

Refinements:
- Bulk events become quantity-first, not level-first.
- Category path input should parse into path segments locally before submit.
- Sync failures should be humanized the same way current API errors are.

### Commit 9: End-To-End Sync Tests

Purpose:
- Verify the full SmartDB → Part-DB projection path.

Files:
- `apps/middleware/src/partdb-e2e.test.ts` or equivalent
- supporting helpers

Refinements:
- Prefer real Part-DB container or a reproducible contract harness.
- Cover outage, retry, dead-letter, and recovery.

## Additional Refinements To The Proposed Design

### Category Handling

- Keep `category` as a derived display field only for compatibility; treat `categoryPath` as canonical.
- Add a pure parser:
  - trims segments
  - rejects empty/deep/invalid segments
  - returns `Result<string[], CategoryPathParseError>`
- Cap depth explicitly and test it.
- Consider a normalization rule now, not later:
  - likely trim-only, preserve case
  - no slash escaping support in v1

### Quantity FSM

- Replace `bulkLevels`-based transitions with quantity events in a single commit, not incrementally.
- Derived UI badges like “low” should become computed from `quantity` + `minimumQuantity`, not persisted as state.
- Inventory service should reject negative or non-integer quantities for integer units.

### Error Design

- `PartDbError` should never be thrown across layers; it should stay inside `Result`.
- At the API boundary, convert sync-admin failures into existing `ApplicationError` envelopes.
- Frontend should humanize sync errors the same way it now humanizes parse/conflict/integration errors.

### Outbox Payloads

- Store the exact operation payload that will be sent, not partially normalized fragments that require hidden reconstruction.
- If a dependency result is needed later (for example, category IRI), model it explicitly in the hydrated operation stage.

### Idempotency

- Outbox enqueue idempotency and request idempotency are separate concerns.
- Do not overload one mechanism to solve the other.

## What I Will Implement First

The first implemented slice should be:

1. Baseline checkpoint commit
2. `Result` type
3. `PartDbError` taxonomy
4. Part-DB response schemas
5. migration v4/v5 scaffolding
6. tests for all of the above

This is the highest-leverage start because it locks the shape of correctness before we begin the async sync machinery.
