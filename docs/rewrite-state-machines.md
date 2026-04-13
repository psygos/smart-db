# Rewrite State Machines

This document is the executable-design brief for the `codex/rewrite` branch.

Status:

- frontend cutover complete: the browser entrypoint is now the vanilla TypeScript runtime
- explicit machine map and typed actors are live for auth and scan flows
- parse-first command modules are live for assign, event, batch, and merge forms
- legacy shell removed from the active frontend

The rewrite will:

- keep SQLite, migrations, and Part-DB sync as the persistence substrate
- run the frontend as route-oriented TypeScript, HTML, and CSS
- drive every user flow from explicit state machines
- parse external input into typed commands before side effects
- treat failures as first-class values with precise propagation rules

## Why XState

XState v5 is the right fit here because Smart DB already behaves like a collection of interacting state machines:

- auth and session expiry
- camera permission and scan lifecycle
- lookup and scan result resolution
- assignment and event submission
- admin sync operations
- merge and approval workflows

The rewrite will use XState for machine definition and transition safety, then a thin DOM runtime to bind actors to HTML.

## Parse Boundaries

The rewrite follows parse, don’t validate. That means every boundary produces either a typed value or a typed failure.

### External boundaries

- browser URL and query params -> parsed route input
- local storage -> parsed preferences/session hints
- form drafts -> parsed commands
- API responses -> parsed DTOs
- camera scans -> parsed scan codes
- environment/config -> parsed startup config

### Internal boundaries

- DTOs -> domain view models
- domain view models -> machine events
- machine context -> DOM rendering model

No handler should receive a loose request bag and then clean it up.

## Failure Algebra

Every failure in the rewrite must fit one of these categories:

| Kind | Meaning | Retryable |
|---|---|---|
| `parse` | Input or response could not be parsed into a trusted type | no |
| `transport` | Network timeout, offline, abort, unreachable backend | usually yes |
| `auth` | unauthenticated, forbidden, expired session | depends |
| `conflict` | stale data, idempotency collision, illegal transition | depends |
| `domain` | a business rule was violated by a legal request shape | no |
| `integration` | camera, PDF, Part-DB, browser API, or download failure | depends |
| `unexpected` | bug or uncategorized failure | no |

Each failure value must carry:

- operation name
- precise kind
- human-safe message
- machine-facing retryability
- structured details for telemetry and UI recovery
- enough structure to recover without string matching

## Core Invariants

These invariants drive the rewrite.

### Auth

- anonymous users cannot enter authenticated route states
- admin-only routes are impossible without an admin session
- expired sessions move the app into a dedicated recovery path

### Scan

- a scan session has exactly one active code or none
- camera lookup cannot clobber an in-progress parsed command
- lookup results are mutually exclusive: `unknown`, `label`, `interact.instance`, `interact.bulk`

### Commands

- form drafts are never sent to the API directly
- only parsed commands may trigger network mutations
- parsed commands are specific to the target flow; no placeholder defaults

### Inventory model

The current DB schema remains intact for now, but the rewrite will present a unified conceptual model:

- `PartDefinition`: catalog identity and classification
- `StockPool`: aggregate quantity on hand for a part definition
- `TrackedUnit`: optional individually tracked unit attached to the same part definition

The middleware can project this unified model from `bulk_stocks` and `physical_instances` without requiring a DB migration in phase 1.

## Machine Inventory

## 1. `appShellMachine`

Purpose:
- own startup, route access, and fatal failure handling

States:

- `bootstrapping`
- `unauthenticated`
- `ready`
- `fatal`

Events:

- `BOOTSTRAP.SUCCEEDED`
- `BOOTSTRAP.FAILED`
- `AUTH.BECAME_ANONYMOUS`
- `AUTH.BECAME_AUTHENTICATED`
- `ROUTE.REQUESTED`
- `FATAL.ACKNOWLEDGED`

Failure states:

- `fatal`

## 2. `authMachine`

Purpose:
- own session restoration, login redirect, logout, and expiry

States:

- `bootstrapping`
- `anonymous`
- `redirecting`
- `authenticated`
- `loggingOut`
- `expired`
- `failure.lookup`
- `failure.assign`
- `failure.event`
- `failure.split`

Events:

- `SESSION.RESTORED`
- `SESSION.MISSING`
- `LOGIN.REQUESTED`
- `LOGIN.REDIRECTED`
- `SESSION.EXPIRED`
- `LOGOUT.REQUESTED`
- `LOGOUT.SUCCEEDED`
- `LOGOUT.FAILED`
- `AUTH.FAILED`
- `FAILURE.ACKNOWLEDGED`

Failure states:

- `expired`
- `failure.lookup`
- `failure.assign`
- `failure.event`
- `failure.split`

## 3. `connectivityMachine`

Purpose:
- make online/offline an explicit signal instead of an ambient browser read

States:

- `online`
- `offline`

Events:

- `BROWSER.WENT_ONLINE`
- `BROWSER.WENT_OFFLINE`

Failure states:

- none, offline is not itself an exception

## 4. `cameraMachine`

Purpose:
- own permission, scanner start/stop, duplicate suppression, and browser capability

States:

- `idle`
- `unsupported`
- `requestingPermission`
- `ready`
- `scanning`
- `denied`
- `failure`

Events:

- `CAMERA.START_REQUESTED`
- `CAMERA.PERMISSION_GRANTED`
- `CAMERA.PERMISSION_DENIED`
- `CAMERA.READY`
- `CAMERA.CODE_DETECTED`
- `CAMERA.STOP_REQUESTED`
- `CAMERA.FAILED`

Failure states:

- `unsupported`
- `denied`
- `failure`

## 5. `scanSessionMachine`

Purpose:
- own lookup resolution, unknown-code intake, assignment, instance events, bulk events, and split moves

States:

- `idle`
- `lookingUp`
- `unknown`
- `labeling.editing`
- `labeling.parsing`
- `labeling.submitting`
- `interacting.instanceReady`
- `interacting.instanceSubmitting`
- `interacting.bulkReady`
- `interacting.bulkEventParsing`
- `interacting.bulkEventSubmitting`
- `interacting.bulkSplitParsing`
- `interacting.bulkSplitSubmitting`
- `failure`

Events:

- `LOOKUP.REQUESTED`
- `LOOKUP.UNKNOWN`
- `LOOKUP.LABEL`
- `LOOKUP.INSTANCE`
- `LOOKUP.BULK`
- `LOOKUP.FAILED`
- `UNKNOWN.PROMOTED_TO_INTAKE`
- `ASSIGN.PARSE_REQUESTED`
- `ASSIGN.SUBMIT_REQUESTED`
- `ASSIGN.SUCCEEDED`
- `EVENT.PARSE_REQUESTED`
- `EVENT.SUBMIT_REQUESTED`
- `EVENT.SUCCEEDED`
- `SPLIT.PARSE_REQUESTED`
- `SPLIT.SUBMIT_REQUESTED`
- `SPLIT.SUCCEEDED`
- `SCAN.CLEAR_REQUESTED`
- `SCAN.NEXT_REQUESTED`

Failure states:

- `failure`

## 6. `inventoryRouteMachine`

Purpose:
- own summary loading, filters, and expandable item detail loading

States:

- `idle`
- `loading`
- `ready`
- `expanding`
- `failure`

Events:

- `INVENTORY.LOAD_REQUESTED`
- `INVENTORY.LOAD_SUCCEEDED`
- `INVENTORY.LOAD_FAILED`
- `INVENTORY.FILTER_CHANGED`
- `INVENTORY.EXPAND_REQUESTED`
- `INVENTORY.EXPAND_SUCCEEDED`
- `INVENTORY.EXPAND_FAILED`

Failure states:

- `failure`

## 7. `activityRouteMachine`

Purpose:
- own dashboard/activity loading and refresh

States:

- `idle`
- `loading`
- `ready`
- `failure`

Events:

- `ACTIVITY.LOAD_REQUESTED`
- `ACTIVITY.LOAD_SUCCEEDED`
- `ACTIVITY.LOAD_FAILED`

Failure states:

- `failure`

## 8. `batchAdminMachine`

Purpose:
- own QR batch registration and PDF download

States:

- `idle`
- `editing`
- `parsing`
- `submitting`
- `downloadingLabels`
- `success`
- `failure`

Events:

- `BATCH.EDITED`
- `BATCH.PARSE_REQUESTED`
- `BATCH.SUBMIT_REQUESTED`
- `BATCH.SUBMIT_SUCCEEDED`
- `BATCH.DOWNLOAD_REQUESTED`
- `BATCH.DOWNLOAD_SUCCEEDED`
- `BATCH.FAILED`

Failure states:

- `failure`

## 9. `mergeAdminMachine`

Purpose:
- own provisional approval, merge destination search, confirmation, and merge submission

States:

- `idle`
- `selectingSource`
- `searching`
- `selectingDestination`
- `confirming`
- `submitting`
- `success`
- `failure`

Events:

- `MERGE.SOURCE_SELECTED`
- `MERGE.SEARCH_REQUESTED`
- `MERGE.SEARCH_SUCCEEDED`
- `MERGE.SEARCH_FAILED`
- `MERGE.DESTINATION_SELECTED`
- `MERGE.CONFIRM_REQUESTED`
- `MERGE.SUBMIT_REQUESTED`
- `MERGE.SUBMIT_SUCCEEDED`
- `MERGE.APPROVE_AS_IS_REQUESTED`
- `MERGE.APPROVE_AS_IS_SUCCEEDED`
- `MERGE.FAILED`

Failure states:

- `failure`

## 10. `syncAdminMachine`

Purpose:
- own on-demand sync drain, backfill, retry, and failure list refresh

States:

- `unavailable`
- `idle`
- `draining`
- `backfilling`
- `retrying`
- `success`
- `failure`

Events:

- `SYNC.STATUS_LOADED`
- `SYNC.DRAIN_REQUESTED`
- `SYNC.DRAIN_SUCCEEDED`
- `SYNC.BACKFILL_REQUESTED`
- `SYNC.BACKFILL_SUCCEEDED`
- `SYNC.RETRY_REQUESTED`
- `SYNC.RETRY_SUCCEEDED`
- `SYNC.FAILED`

Failure states:

- `failure`

## DOM Strategy

The DOM layer will be route-oriented.

Modules:

- `routes/scan`
- `routes/inventory`
- `routes/activity`
- `routes/admin`
- `shared/components`
- `shared/services`
- `shared/styles`

Each route module receives:

- parsed route input
- actor refs
- typed render helpers

No module will receive a giant mutable props bag.

## Rewrite Order

1. Freeze machine map and error algebra
2. Introduce typed command parsers for auth, scan, assign, event, split, batch, merge
3. Build vanilla TypeScript app shell around machine actors
4. Port scan/intake flow first
5. Port inventory and activity routes
6. Port admin routes
7. Remove the old entrypoint and its legacy dependencies
