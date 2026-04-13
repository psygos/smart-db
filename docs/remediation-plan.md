# SmartDB Remediation Plan

## Intent

This plan combines the live-host audit, code audit, UX audit, and failure-mode review into a single execution program.
The plan is intentionally systems-first:

- Parse, don't validate.
- Make illegal states unrepresentable.
- Prefer explicit command models over loose request bags.
- Fix root causes before UI band-aids.
- Keep tests authoritative and exhaustive around the FSM and failure modes.
- Avoid heuristic patches that leave contradictory types or hidden runtime fallbacks in place.

## Non-Negotiable Principles

1. Input parsing must produce domain-safe commands.
   A successfully parsed command should not need “defensive cleanup” later.

2. Shared contracts must encode business invariants.
   Contradictory defaults like `nextStatus: "available"` for `checked_out` requests are forbidden.

3. FSM transitions must be typed, total where legal, and impossible where illegal.
   The action surface, command shape, transition table, and stored state must agree.

4. Authn, authz, and replay protection must compose safely.
   No cache layer may be able to bypass auth or leak responses across sessions.

5. UX flows must follow the state machine, not improvise around it.
   The scan flow, assignment flow, PDF flow, and admin tools must all be derived from typed command/result states.

6. Tests are part of the product.
   We do not accept untested FSM branches, cross-session security gaps, or optimistic-concurrency blind spots.

## Current Systemic Problems

### Type / Contract Layer

- Request schemas manufacture bogus values (`"Unknown"`, `"available"`, `"good"`) that the service layer does not actually want.
- `scanResponse.availableActions` is typed wider than the actual FSM.
- Self-merge is representable in the request schema even though the service rejects it.
- Error taxonomy cannot represent `403 Forbidden`.
- The legacy dead shell had drifted away from the real contract model and was excluded from typecheck before the rewrite.

### Service / FSM Layer

- Event handling trusts raw identifiers without ownership or role checks.
- Optimistic concurrency columns exist but are not part of any command model or update predicate.
- QR batch metadata can advertise printable ranges that were only partially inserted.
- Void is destructive and is being used as a correction mechanism because no typed correction flow exists.

### Security / Infra Layer

- Root password SSH is enabled.
- Runtime secrets are plaintext and also copied into unencrypted backups with TLS keys.
- Idempotency runs before auth and is keyed to the wrong identity source.
- Roles exist but are never enforced.
- Gateway host networking expands blast radius.

### UX / Frontend Layer

- Camera loop and result flow are not modeled as a state machine.
- Unknown scans do not lead into intake.
- Assignment defaults lead users into invalid submits.
- Downloading PDF is not an app-managed flow.
- Mobile layout and accessibility constraints are not encoded in the design.

## Delivery Rules

- Every commit must leave the repo green.
- Every commit must add or tighten tests for the behavior it changes.
- Any behavior change in contracts must be reflected in frontend helpers and middleware parsing in the same commit.
- No commit may widen accepted state without adding a corresponding invariant test.

## Commit Plan

### Commit 1: Contract And Error Foundations

Goal:
- Remove contradictory request defaults.
- Tighten event command shapes.
- Add missing error taxonomy for authorization.
- Narrow action typing so impossible actions are not representable.

Scope:
- `packages/contracts/src/errors.ts`
- `packages/contracts/src/schemas.ts`
- `packages/contracts/src/transitions.ts`
- `packages/contracts/src/*.test.ts`
- Frontend helper/request builder compatibility updates

Acceptance:
- `recordEvent` requests no longer inject fake location/state defaults.
- `mergePartTypesRequestSchema` rejects self-merge.
- `scanResponse.availableActions` is target-specific.
- `ForbiddenError` exists and is covered by tests.

### Commit 2: Parse-First Middleware Commands

Goal:
- Push normalization into parsing and eliminate cleanup logic from services.

Scope:
- `packages/contracts`
- `apps/middleware/src/routes`
- `apps/middleware/src/services/inventory-service.ts`
- Helper builders/tests

Acceptance:
- Service layer no longer depends on impossible placeholder values from schemas.
- Request parsing yields domain-ready commands.

### Commit 3: FSM Completeness And Recovery Design

Goal:
- Make the inventory FSM explicit and recoverable.

Scope:
- Transition tables, action labels, command/result types, event correction model
- Add typed correction/reassignment path instead of destructive void-as-fix

Acceptance:
- Terminal/destructive actions require explicit confirmation semantics.
- Correction and reassignment use typed commands, not ad hoc destructive workarounds.
- Exhaustive FSM matrix tests exist.

### Commit 4: Idempotency / Auth / Authorization Integrity

Goal:
- Make replay protection session-scoped and unable to bypass auth.
- Introduce real RBAC and 403 handling.

Scope:
- `apps/middleware/src/middleware/idempotency.ts`
- `apps/middleware/src/server.ts`
- `apps/middleware/src/routes/*`
- auth/session tests and role tests

Acceptance:
- Idempotency keys are scoped to authenticated session identity.
- Auth runs before replay response can be emitted.
- Admin routes require explicit role checks.
- Cross-session and unauthenticated replay regressions are tested.

### Commit 5: Concurrency And Stale-Write Safety

Goal:
- Use explicit versions/preconditions in commands and updates.

Scope:
- contracts, service updates, tests for concurrent mutations

Acceptance:
- Updates include stale-read protection.
- Race-condition tests cover assign/event overlap and duplicate POST concurrency.

### Commit 6: Scan Flow As A Typed UI State Machine

Goal:
- Replace implicit camera/form coupling with an explicit scan-session machine.

Scope:
- camera scanner service
- scan route renderer
- scan route controller state
- rewrite app controller
- frontend tests

Acceptance:
- Detect -> acknowledge -> collapse -> lookup -> result -> scan-next is modeled explicitly.
- Camera cannot clobber dirty forms or pending mutations.
- Camera pauses on page hide and shuts down on success.

### Commit 7: Registration Flow Robustness

Goal:
- Make assignment and intake flows explicit and safe by default.

Scope:
- new/existing part flow
- field-level validation
- typed UI error mapping
- location persistence and sensible defaults

Acceptance:
- Default path is valid.
- Required fields are visible and locally validated.
- Existing/new part selection cannot silently flip into an invalid mode.

### Commit 8: PDF Pipeline Hardening

Goal:
- Make PDF generation correct, bounded, and app-managed.

Scope:
- PDF generator
- download API/client flow
- batch history
- load/error states

Acceptance:
- Download stays inside app flow.
- Large batch generation is bounded or asynchronous.
- filename handling is safe.
- overlapping batch ranges cannot produce misleading printable output.

### Commit 9: Mobile / Accessibility Corrections

Goal:
- Bring the live UI up to basic operational usability on phones and assistive tech.

Scope:
- layout, safe-area handling, target sizes, labels, tab semantics, reduced motion

Acceptance:
- WCAG issues found in the audit have direct tests where practical.
- Mobile scan flow remains usable on compact viewports.

### Commit 10: Infra And Operations Hardening

Goal:
- Close the attack chain and align deployment with the application model.

Scope:
- SSH hardening
- secret rotation/runbook
- backup design
- gateway networking
- firewall
- healthcheck correctness

Acceptance:
- Password SSH disabled.
- Secrets rotated and removed from routine backup artifacts or encrypted separately.
- Host/network/health assumptions documented and enforced.

## Test Strategy

### Contract / FSM

- Exhaustive transition matrix tests for each legal and illegal action/state pair.
- Tests proving impossible command combinations do not parse.
- Snapshot-free tests for command/result shapes.

### Security

- Cross-session replay leak tests.
- Unauthenticated replay bypass tests.
- Role enforcement tests.
- Cookie tamper and cookie option tests.
- callback/log redaction tests where feasible.

### Concurrency

- Parallel same-idempotency-key duplicate POST tests.
- Stale version rejection tests.
- assign/event overlap tests.

### UX

- Scan machine state transition tests.
- dirty-form guard tests.
- download failure tests.
- mobile viewport layout smoke tests for critical flows.

## Execution Order

The first implementation pass starts with Commit 1.
Do not jump to camera polish or PDF UI work before the shared contract layer stops manufacturing contradictory state.
