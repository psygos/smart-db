# Smart DB Exhaustive FSM Audit

Historical note:
- This document audits the pre-rewrite frontend shell and retains historical file names and behaviors for context.

Produced 2026-03-28. Covers every state machine in the pre-rewrite frontend shell, `inventory-service.ts`, `auth-service.ts`, `partdb-client.ts`, `api.ts`, and all Zod schemas in `packages/contracts`.

---

## Table of Contents

1. [Auth State Machine](#1-auth-state-machine)
2. [Scan Result State Machine](#2-scan-result-state-machine)
3. [QR Code Lifecycle FSM](#3-qr-code-lifecycle-fsm)
4. [Entity Lifecycle FSMs](#4-entity-lifecycle-fsms)
5. [Form State Machines](#5-form-state-machines)
6. [Search State Machines](#6-search-state-machines)
7. [PendingAction Mutex](#7-pendingaction-mutex)
8. [Cross-Machine Interactions](#8-cross-machine-interactions)
9. [GAPS](#9-gaps)
10. [RISKS](#10-risks)
11. [RECOMMENDATIONS](#11-recommendations)

---

## 1. Auth State Machine

### 1.1 States

| State | `authState.status` | `authState.session` | `authState.error` | Description |
|---|---|---|---|---|
| **checking** | `"checking"` | `null` | `null` | App is hydrating from localStorage and validating the token via `GET /api/auth/session` |
| **authenticating** | `"authenticating"` | `null` | `null` | User has submitted a token and `POST /api/auth/login` is in flight |
| **authenticated** | `"authenticated"` | `AuthSession` | `null` | Token is valid; the session object contains username, issuedAt, expiresAt |
| **unauthenticated** | `"unauthenticated"` | `null` | `string \| null` | No valid session; error may contain the reason |

### 1.2 Transitions

```
[mount] ──────────────────────────────────┐
         │                                │
  token in localStorage?                  │
         │                                │
    YES ──> checking ──┬──> authenticated  │
         │             │     (session valid)│
         │             │                   │
         │             └──> unauthenticated│
         │                  (session invalid, token revoked, network error)
         │                                 │
    NO ───> unauthenticated ◄──────────────┘
                │
                └──> authenticating ──┬──> authenticated
                     (user submits    │    (login success)
                      token)          │
                                      └──> unauthenticated
                                           (login failed)

authenticated ──┬──> unauthenticated (explicit logout via handleLogout)
                │
                └──> unauthenticated (401 on any API call via handleApiFailure)
```

### 1.3 Guard Conditions

- **checking -> authenticated**: `api.getSession()` resolves successfully AND signal is not aborted.
- **checking -> unauthenticated**: `api.getSession()` rejects (network, 401, parse error) AND signal is not aborted. If aborted, the effect cleanup runs and no state change occurs.
- **authenticating -> authenticated**: `api.login()` resolves successfully.
- **authenticating -> unauthenticated**: `api.login()` throws. `clearSessionToken()` is called.
- **authenticated -> unauthenticated (logout)**: Always fires in the `finally` block of `handleLogout`, regardless of whether `api.logout()` succeeds or fails.
- **authenticated -> unauthenticated (401 revocation)**: Any API call that returns error code `"unauthenticated"` triggers `handleApiFailure()` -> `handleAuthenticationFailure()`.

### 1.4 What triggers each exit from "checking"?

The `checking` state is entered at mount if `hydrateSessionToken()` returns a non-null token. `restoreSession()` calls `api.getSession(signal)`. Exits:
- **Success path**: API returns a valid `AuthSession` -> state becomes `authenticated`, then `loadAuthenticatedData()` fires.
- **Failure path (token invalid)**: API returns 401 or any error -> `handleAuthenticationFailure()` clears the token and sets `unauthenticated`.
- **Cleanup path (StrictMode double-mount)**: The `AbortController` signal is aborted in the effect cleanup. `restoreSession` checks `signal.aborted` and returns silently, leaving the state as `checking` until the second mount's effect runs.

**GAP**: During the `checking` state, the login form IS rendered (the unauthenticated branch renders for any status that is not `authenticated`). The submit button is correctly disabled when `authState.status === "checking"`, but the user can still type into the token input. This is cosmetically fine but creates a subtle race: if the user submits before the check completes and the check then succeeds, the `authenticating` state from the form will overwrite the in-flight `checking` logic. However, this cannot happen because the button is disabled during `checking`.

### 1.5 What if the network drops mid-auth?

During `authenticating` (handleLogin):
- `api.login()` will throw a `TypeError` (fetch failure) or an `ApiClientError` with code `"transport"`.
- The catch block sets `unauthenticated` with the error message.
- `setPendingAction(null)` fires in the finally block.
- **No timeout**: There is no explicit timeout on the fetch. A hanging connection will leave the UI in `authenticating` state indefinitely until the browser's own TCP timeout fires (typically 30-120 seconds depending on browser).

During `checking` (restoreSession):
- Same fetch failure behavior; `handleAuthenticationFailure()` runs.
- The AbortController provides a cleanup path if the component unmounts.

### 1.6 What causes de-auth? Is it always clean?

De-auth happens in two paths:

**Explicit logout** (`handleLogout`):
1. `setPendingAction("logout")`.
2. `api.logout()` fires (may succeed or fail; either way, `finally` runs).
3. `clearSessionToken()` removes localStorage.
4. `resetAuthenticatedView()` nullifies all data state and aborts in-flight searches/scans.
5. Auth state is set to `unauthenticated`.
6. `setPendingAction(null)`.
**This is clean** -- all state is explicitly reset.

**Implicit 401 revocation** (`handleApiFailure` -> `handleAuthenticationFailure`):
1. `clearSessionToken()` removes localStorage.
2. `resetAuthenticatedView()` nullifies all data state and aborts in-flight searches/scans.
3. Auth state is set to `unauthenticated` with error message.
**This is also clean** -- same reset path as logout.

### 1.7 What state is preserved/lost on de-auth?

**Lost**: dashboard, partDbStatus, catalogSuggestions, provisionalPartTypes, labelSearch, mergeSearch, scanResult, batchForm, assignForm, eventForm, scanCode, mergeSourceId, mergeDestinationId, pendingAction, in-flight AbortControllers (aborted).
**Preserved**: `message` and `error` global banners are NOT cleared by `resetAuthenticatedView()`. They are cleared individually at the start of each action handler, but if auth fails during one action, the error banner from `handleAuthenticationFailure` remains visible on the login screen. The `partDbTokenInput` is also not explicitly cleared during auth failure (it IS cleared on successful login at line 298).

**GAP**: `message` state survives auth transitions. A success message from a previous session could persist on the login screen after a 401 revocation.

### 1.8 Two-tab scenario

Each tab had its own local shell state. They shared the same `localStorage` key (`smart-db.partdb-api-token`).

- Tab A logs in: token is saved to localStorage.
- Tab B opens: `hydrateSessionToken()` reads the same token. Both tabs are authenticated.
- Tab A logs out: `clearSessionToken()` removes the token. Tab B's in-memory `sessionToken` variable is still set.
- Tab B makes a request: the request uses the in-memory token (not localStorage). If Part-DB still accepts that token, it works. If the token itself was revoked (not just cleared from storage), the request fails with 401 and Tab B de-auths.

**GAP**: There is no `storage` event listener. Tab B will not proactively notice that Tab A logged out. It will continue operating until its next API call fails. If the token was valid but only removed from localStorage, Tab B could even re-persist it on next login or session restore.

### 1.9 Token revocation during mid-form-fill

If Part-DB revokes the token while the user is editing a form:
- The form state was purely local shell state. It was not lost until an API call was made.
- When the user submits the form, the API call will return 401.
- `handleApiFailure()` catches `code === "unauthenticated"` and triggers full de-auth.
- All form state is lost in `resetAuthenticatedView()`.

**GAP**: There is no way to recover or save the form data. The user loses all in-progress work immediately upon the next API call. There is no warning that the session is about to expire (even though `expiresAt` is available in the session object and displayed in the UI).

### 1.10 In-flight requests during auth state change

When `handleAuthenticationFailure` fires:
- `resetAuthenticatedView()` calls `.abort()` on all three AbortControllers (`labelSearchAbortRef`, `mergeSearchAbortRef`, `scanAbortRef`).
- This correctly cancels any in-flight search or scan requests.
- However, the currently executing mutation handler (e.g., `handleAssign`) is NOT aborted because mutation requests do not use AbortControllers. The mutation's `finally` block will set `pendingAction(null)`, but `resetAuthenticatedView()` has already set it to `null`.

**GAP**: Mutation requests (assign, event, batch, merge) do not have AbortControllers. If auth is revoked during a mutation, the mutation's catch block will call `handleApiFailure()` which correctly handles it, but the mutation cannot be cancelled from outside. This is a minor issue since mutations are typically short-lived.

### 1.11 Gap between "token invalid" and "UI shows login"

The gap is exactly one render cycle in the old shell state model. `handleAuthenticationFailure()` called `setAuthState({ status: "unauthenticated" })`, which immediately swapped to the login shell on the next render. There was no intermediate loading state.

**FINDING**: The transition is atomic from a UI perspective. No gap.

---

## 2. Scan Result State Machine

### 2.1 States

The scan result is stored as `scanResult: ScanResponse | null`. Effective states:

| State | Value | UI rendered |
|---|---|---|
| **idle** | `null` | No result card |
| **unknown** | `{ mode: "unknown", code, partDb }` | "Code is unknown to Smart DB" card |
| **label** | `{ mode: "label", qrCode, suggestions, partDb }` | Assignment form card |
| **interact** | `{ mode: "interact", qrCode, entity, recentEvents, availableActions, partDb }` | Event form + history card |

### 2.2 Transitions

```
idle ──> unknown  (scan returns mode=unknown)
idle ──> label    (scan returns mode=label)
idle ──> interact (scan returns mode=interact)

unknown ──> unknown  (rescan same/different code -> unknown)
unknown ──> label    (rescan -> label)
unknown ──> interact (rescan -> interact)

label ──> unknown  (rescan different code -> unknown)
label ──> label    (rescan different unassigned QR)
label ──> interact (assign success triggers silent rescan -> interact)
label ──> interact (rescan different assigned QR)

interact ──> unknown  (rescan different code -> unknown)
interact ──> label    (rescan different unassigned QR)
interact ──> interact (event success triggers silent rescan -> interact)
interact ──> interact (rescan different assigned QR)

ANY ──> idle (logout or auth failure clears scanResult via resetAuthenticatedView)
```

### 2.3 Can the user get stuck in a mode?

**unknown mode**: The user cannot take any action from this mode except scanning a different code. This is by design -- an unknown code has no inventory entity. The user is effectively told to register a QR batch first. **Not stuck**, but could be confusing if the user expects to register an ad-hoc QR from this screen.

**label mode**: The user can submit the assignment form or scan a different code. If the assignment form submission fails (e.g., validation error, conflict), the error banner appears but the label form remains visible with all data intact. The user can retry or scan a different code. **Not stuck**.

**interact mode**: The user can submit an event or scan a different code. Same error recovery as label. **Not stuck**.

**idle**: Only reachable at initial load or after auth reset. The user must scan a code to proceed. **Not stuck** (the scan input is auto-focused).

### 2.4 What happens if the user scans while a previous scan is in flight?

`performScan()` at line 402-466 handles this with:
1. `scanAbortRef.current?.abort()` -- cancels the previous in-flight request.
2. `scanRequestRef.current += 1` -- increments the request counter.
3. After the response arrives, checks `if (requestId !== scanRequestRef.current) return` -- discards stale responses.

**FINDING**: Correctly handled. The previous scan is aborted and its response (if it arrives) is discarded. Only the latest scan updates state.

### 2.5 What happens if the user scans the same code twice rapidly?

Same mechanism as above. The first scan is aborted, the second scan proceeds. The end result is the same as scanning once (deterministic).

However, there is a subtle edge case: if the first scan completes between the abort and the check:
- The abort fires.
- The first scan's response has already been received (the abort happens after the fetch resolved but before the stale-check runs).
- The `requestId !== scanRequestRef.current` guard correctly drops the first response.

**FINDING**: Correctly handled by the request ordering counter.

### 2.6 Backend state change between scan and action (TOCTOU)

**Scenario**: User A scans QR-1001, sees mode=label. Between seeing this and clicking "Assign", User B (on another device) assigns QR-1001.

What happens:
1. User A submits assignment. `POST /api/assignments` fires.
2. `InventoryService.assignQr()` re-reads the QR from the database at line 237.
3. The QR now has status `assigned` (User B's assignment).
4. The guard at line 245 (`if (qrCode.status !== "printed")`) fires.
5. A `ConflictError` is thrown: "QR QR-1001 is already assigned."
6. Frontend shows the error. The scan result still shows the stale label mode.

**GAP**: After this conflict error, the user's scan result is stale. The UI still shows the label/assignment form for QR-1001, but the QR is actually assigned. The user must manually rescan to see the updated state. The form data (part type selection, location, etc.) is preserved but is now useless.

### 2.7 What happens to the scan result if the user navigates away and back?

This is a single-page application with no client-side routing. There is no "navigate away". The only way to leave the authenticated view is logout/auth failure. On those transitions, `resetAuthenticatedView()` clears `scanResult` to null.

Browser back/forward buttons have no effect on SPA state. A page refresh destroyed all local shell state; `scanResult` was lost. The only persistent state was the auth token in localStorage.

---

## 3. QR Code Lifecycle FSM

### 3.1 Schema-Defined States

From `schemas.ts` line 16:
```typescript
export const qrStatuses = ["printed", "assigned", "voided", "duplicate"] as const;
```

### 3.2 State Diagram

```
[batch registration] ──> printed ──> assigned (via assignQr)
                              │
                              └──> [No code path to "voided" or "duplicate"]
```

### 3.3 Transitions in Code

| From | To | Trigger | Code location |
|---|---|---|---|
| (none) | `printed` | `registerQrBatch()` loop, `INSERT OR IGNORE` with `status = 'printed'` | inventory-service.ts:146-148 |
| `printed` | `assigned` | `assignQr()` -> `updateQrAssignment()` | inventory-service.ts:662-672 |

### 3.4 Missing transitions (voided, duplicate)

**voided**: The `qrStatuses` schema defines `"voided"` as a valid status, but there is NO code path anywhere in the codebase that sets a QR to `voided`.

- No API endpoint exists to void a QR.
- No service method exists to void a QR.
- The scan code at line 213 handles non-printed, non-assigned QRs by returning mode `"unknown"` with a message like "QR X is voided and cannot be assigned." This means the UI code is prepared for voided QRs, but they cannot be created through the application.

**duplicate**: Same situation. Defined in the schema, handled in the scan flow (would produce `"unknown"` mode), but no code path creates a duplicate QR.

### 3.5 Can a QR ever go back to `printed`?

**No.** There is no code path that sets `status = 'printed'` except the initial `INSERT`. The `updateQrAssignment` method only sets `status = 'assigned'`. There is no "unassign" or "reset" operation.

### 3.6 What happens if you try to assign a voided QR?

`assignQr()` line 245: `if (qrCode.status !== "printed")` throws `ConflictError("QR X is already voided.")`. Correctly prevented.

### 3.7 What happens if batch registration is interrupted mid-loop?

`registerQrBatch()` wraps the entire loop in `this.withTransaction()` (line 126-159). If the process crashes mid-loop, the SQLite transaction is rolled back. No partial batch is persisted.

However, the transaction boundary is `withTransaction()` which uses `BEGIN`/`COMMIT`/`ROLLBACK`. If an exception is thrown inside the loop, the catch in `withTransaction` (line 737) rolls back and re-throws.

**FINDING**: Atomicity is correctly guaranteed by the SQLite transaction.

**GAP**: The `INSERT OR IGNORE` behavior means that if a batch is re-submitted with overlapping codes, the existing codes are silently skipped. This is intentional (idempotent batch registration) but means there is no way to detect if a previous partial batch left some codes without repeating the entire batch.

---

## 4. Entity Lifecycle FSMs

### 4.1 PhysicalInstance

#### Schema-defined states

```typescript
export const instanceStatuses = ["available", "checked_out", "consumed", "damaged", "lost"] as const;
```

#### Available events (from scanCode, line 207):
```
["moved", "checked_out", "returned", "consumed", "damaged", "lost", "disposed"]
```

#### Complete transition table (from recordEvent, lines 345-369):

| Current Status | Event | Next Status | Assignee | Location |
|---|---|---|---|---|
| ANY | `moved` | (unchanged) | (unchanged) | updated from input |
| ANY | `checked_out` | `checked_out` | input.assignee or actor | updated from input |
| ANY | `returned` | `available` | `null` | updated from input |
| ANY | `consumed` | `consumed` | `null` | updated from input |
| ANY | `disposed` | `consumed` | `null` | updated from input |
| ANY | `damaged` | `damaged` | `null` | updated from input |
| ANY | `lost` | `lost` | `null` | updated from input |

**Critical observation**: The middleware does NOT enforce any transition constraints. ANY event can be applied from ANY status. For example:
- A `consumed` item can receive a `moved` event (status stays `consumed` but location changes).
- A `lost` item can receive a `checked_out` event (status changes to `checked_out`).
- A `consumed` item can receive a `returned` event (status changes to `available`).

#### Terminal states analysis

None of the states are truly terminal because any event can transition out of any state:
- `consumed` can be escaped via `returned` (-> available), `checked_out` (-> checked_out), etc.
- `damaged` can be escaped the same way.
- `lost` can be escaped the same way.

**GAP: No transition guard enforcement.** The middleware accepts any event on any status. The frontend controls the `availableActions` dropdown, but the API accepts any valid event regardless of current state. A direct API call could make any transition.

#### Missing transitions analysis

**Repair flow**: There is no `repaired` event. To move a `damaged` item back to `available`, the user would use `returned`. This is semantically wrong but mechanically possible.

**Found flow**: There is no `found` event for `lost` items. Same workaround: use `returned`.

**Undo**: There is no undo capability for any event.

#### Assignee field behavior

| Event | Assignee after event |
|---|---|
| `moved` | Unchanged |
| `checked_out` | Set to `input.assignee` or `actor` |
| `returned` | Cleared to `null` |
| `consumed` | Cleared to `null` |
| `disposed` | Cleared to `null` |
| `damaged` | Cleared to `null` |
| `lost` | Cleared to `null` |

**GAP**: The `nextStatus` field from the frontend is sent but NOT used by the middleware for most events. The middleware's switch statement hardcodes the resulting status for each event. The `nextStatus` in the `RecordEventRequest` schema exists and is parsed, but the middleware ignores it except for `moved` (where status is unchanged). The frontend lets the user change `nextStatus` via a dropdown, but this selection has no effect for most events. This is misleading UI.

### 4.2 BulkStock

#### Schema-defined states (levels)

```typescript
export const bulkLevels = ["full", "good", "low", "empty"] as const;
```

#### Available events (from scanCode, line 208):
```
["moved", "level_changed", "consumed"]
```

#### Complete transition table (from recordEvent, lines 409-418):

| Current Level | Event | Next Level | Location |
|---|---|---|---|
| ANY | `moved` | (unchanged) | updated from input |
| ANY | `level_changed` | `input.nextLevel` (validated) or (unchanged) | updated from input |
| ANY | `consumed` | `input.nextLevel` (validated) or `"low"` | updated from input |

#### Level direction validation

**There is NO validation that levels change in a sensible direction.** The code:
```typescript
case "level_changed":
  nextLevel = validBulkLevel(input.nextLevel) ? input.nextLevel : current.level;
  break;
```

This validates that `nextLevel` is a valid bulk level string, but does NOT check that the transition is directionally sensible. You can go from `empty` to `full` in one step, or from `full` to `empty`. There is no monotonicity enforcement.

**GAP: No level direction validation.** `empty` -> `full` is accepted without question. `full` -> `empty` via `consumed` is also accepted.

---

## 5. Form State Machines

### 5.1 Login Form (Legacy Shell Only)

#### States
| State | Conditions |
|---|---|
| idle | `authState.status === "unauthenticated"`, `pendingAction === null` |
| filling | User types in token input (no explicit machine state; controlled input) |
| submitting | `pendingAction === "login"`, `authState.status === "authenticating"` |
| success | `authState.status === "authenticated"` (form disappears from DOM) |
| error | `authState.status === "unauthenticated"`, `authState.error !== null` |

#### Form data on error
- `partDbTokenInput` is NOT cleared on login failure. The user can see and edit their previous input to retry.

#### Form data on success
- `partDbTokenInput` is explicitly cleared to `""` at line 298.

#### Dirty-state tracking
- None. The form has one field (token input). No warning on navigation or auth change.

#### Double-submit prevention
- Button disabled when `pendingAction === "login"` OR `authState.status === "checking"`.
- The pendingAction mutex prevents overlapping submits.

### 5.2 Batch Registration Form

#### States
| State | Conditions |
|---|---|
| idle | `pendingAction === null` |
| filling | User edits prefix/startNumber/count fields |
| submitting | `pendingAction === "batch"` |
| success | `message` is set, form retains previous values |
| error | `error` is set, form retains previous values |

#### Form data on error
- Preserved. The `batchForm` state is not reset on error.

#### Form data on success
- **NOT reset.** The batch form retains its values after success. This means the user could accidentally re-register the same batch by clicking submit again.

**GAP**: Batch form is not cleared after successful registration. The user can easily duplicate a batch by clicking submit again. The `INSERT OR IGNORE` in the backend prevents actual duplicate QR creation (they would be counted as `skipped`), but this is confusing UX.

#### Double-submit prevention
- Button disabled when `pendingAction !== null` (any pending action blocks all buttons).

### 5.3 Assignment Form (label mode)

#### States
| State | Conditions |
|---|---|
| idle | Scan returned mode=label, form is pre-populated |
| filling | User selects part type, edits location, etc. |
| submitting | `pendingAction === "assign"` |
| success | Form is reset to defaults (line 504), then silent rescan fires |
| error | Error banner shown, form retains values |

#### Form data on error
- Preserved. User can fix and retry.

#### Form data on success
- Reset to `defaultAssignForm` (line 504). Then `scanCode` is updated to the assigned QR code, and a silent rescan fires to show the interact view.

#### Can the user submit while previous submit is in flight?
- No. `pendingAction !== null` disables all submit buttons.

#### Can the user change form values during submit?
- The controlled inputs were not explicitly disabled during submit. The user could still type into fields while the submit was in flight. However, the form reset on success would overwrite any concurrent edits.

**GAP**: Form inputs are not disabled during submission. User edits during in-flight submit are silently lost on success.

### 5.4 Event Form (interact mode)

#### States
| State | Conditions |
|---|---|
| idle | Scan returned mode=interact, form is pre-populated |
| filling | User selects event, edits location/status/level/notes |
| submitting | `pendingAction === "event"` |
| success | Message shown, silent rescan fires to refresh interact view |
| error | Error banner shown, form retains values |

#### Form data on error
- Preserved.

#### Form data on success
- The form is NOT explicitly reset after event success. Instead, a silent rescan fires (`performScan(scanResult.qrCode.code, true)`) which, when it completes, updates `eventForm` with the entity's new state (lines 436-449). This means the form reflects the post-event state.

**GAP**: Between the event success and the silent rescan completing, the event form still shows the pre-event values. The user could potentially resubmit the same event during this window if `pendingAction` were already cleared. However, `pendingAction` is not cleared until the finally block (line 539), which runs after the rescan. Wait -- actually, `performScan` with `silent=true` does NOT set `pendingAction` (lines 409-413), and the caller `handleRecordEvent` has its own finally block at line 539 that sets `pendingAction(null)`. The sequence is:

1. `handleRecordEvent` sets `pendingAction("event")`.
2. `api.recordEvent()` succeeds.
3. `performScan(code, true)` fires -- this does NOT set pendingAction.
4. `loadAuthenticatedData()` fires.
5. `finally` runs: `setPendingAction(null)`.

So `pendingAction` remains `"event"` throughout the rescan and data reload. **Double-submit is correctly prevented during this entire window.**

### 5.5 Merge Form

#### States
| State | Conditions |
|---|---|
| idle | No source/destination selected |
| filling | User selects source dropdown and searches for destination |
| blocked | Either source or destination is empty (client-side guard at line 543) |
| submitting | `pendingAction === "merge"` |
| success | Source and destination IDs cleared (lines 558-559) |
| error | Error banner shown, selections preserved |

#### Form data on error
- Preserved. Source and destination IDs remain selected.

#### Form data on success
- Source and destination IDs are cleared. The provisionalPartTypes list is refreshed (the merged source disappears).

#### Double-submit prevention
- Button disabled when `pendingAction !== null`.

---

## 6. Search State Machines

### 6.1 Architecture

Two independent search machines existed in the legacy shell:
- `labelSearch: SearchState` with `labelSearchAbortRef` and `labelSearchRequestRef`
- `mergeSearch: SearchState` with `mergeSearchAbortRef` and `mergeSearchRequestRef`

Both share the `performSearch(surface, query)` function.

### 6.2 SearchState type

```typescript
type SearchState = {
  query: string;
  results: PartType[];
  status: "idle" | "loading" | "error";
  error: string | null;
};
```

### 6.3 State Diagram

```
idle ──> loading (user types non-empty query)
idle ──> idle    (user clears query -> results reset to catalogSuggestions)

loading ──> idle    (response received, requestId matches current)
loading ──> loading (new query typed -> previous aborted, new request started)
loading ──> error   (request fails and is not aborted)

error ──> loading (user types new query)
error ──> idle    (user clears query)
```

### 6.4 Independence verification

- **Separate state slices**: `labelSearch` and `mergeSearch` are separate `useState` hooks.
- **Separate abort controllers**: `labelSearchAbortRef` and `mergeSearchAbortRef`.
- **Separate request counters**: `labelSearchRequestRef` and `mergeSearchRequestRef`.
- **Separate result display**: `labelOptions` (line 570-575) and `mergeOptions` (line 577) compute independently.

**FINDING**: The two search machines are fully independent. Verified.

### 6.5 Rapid typing (debounce / abort)

There is NO debounce. Every keystroke calls `performSearch()`. However, each call:
1. Aborts the previous in-flight request (`abortRef.current?.abort()`).
2. Increments the request counter.
3. Starts a new request.
4. On response, checks `if (requestId !== requestRef.current) return` to discard stale responses.

**FINDING**: Correctness is maintained through cancellation + ordering, not debouncing. This means every keystroke generates an HTTP request to the middleware. For a search query "arduino", this creates 7 requests, 6 of which are immediately aborted. This is correct but potentially noisy for the network and middleware.

### 6.6 Out-of-order responses

Handled by the double-guard:
1. `controller.signal.aborted` check at line 384 -- catches responses from already-aborted requests.
2. `requestId !== requestRef.current` check at line 373 -- catches responses that arrive after a newer request was issued.

**FINDING**: Out-of-order responses are correctly discarded. Only the latest request's response is applied.

### 6.7 Search failure recovery

On failure (not aborted, not auth error):
- `status` is set to `"error"` with the error message.
- The global `error` banner is also set.
- The `results` array is NOT cleared -- it retains the previous results.
- The user can type a new query to retry.

**FINDING**: Error state is recoverable. Previous results are preserved during error.

### 6.8 Initial state of search results

- Default is `{ query: "", results: [], status: "idle", error: null }`.
- After `loadAuthenticatedData()` completes, if `query` is still empty, `results` is backfilled with `partTypes` from the initial `searchPartTypes("")` call (lines 249-268).
- For `labelSearch`, when a scan returns mode=label, the results are replaced with `scanResult.suggestions` (line 427-432).

### 6.9 Legacy Prototype Search Issues

The legacy prototype used a single shared `partTypeQuery` and `partTypeResults` for BOTH the label search and the merge search. This meant:
- Typing in the merge search panel also changes the label search results.
- There are no abort controllers or request ordering.
- Out-of-order responses will corrupt results.

**GAP (legacy only)**: the legacy prototype had a shared search state problem. The later shell separated them correctly.

---

## 7. PendingAction Mutex

### 7.1 Definition

```typescript
type PendingAction = "login" | "logout" | "batch" | "scan" | "assign" | "event" | "merge" | null;
```

`null` means no action is pending. Any non-null value means an operation is in flight.

### 7.2 Every place pendingAction is set

| Action | Set location | Clear location | Guard |
|---|---|---|---|
| `"login"` | `handleLogin` line 280 | `handleLogin finally` line 310 | Button disabled at line 619 |
| `"logout"` | `handleLogout` line 315 | `handleLogout finally` line 334 | Button disabled at line 655 |
| `"batch"` | `handleRegisterBatch` line 470 | `handleRegisterBatch finally` line 485 | Button disabled at line 718 (`pendingAction !== null`) |
| `"scan"` | `performScan` line 410 (when `!silent`) | `performScan finally` line 462 (when `!silent` and `requestId === scanRequestRef.current`) | Button disabled at line 736 (`pendingAction !== null`) |
| `"assign"` | `handleAssign` line 496 | `handleAssign finally` line 515 | Button disabled at line 918 (`pendingAction !== null`) |
| `"event"` | `handleRecordEvent` line 520 | `handleRecordEvent finally` line 539 | Button disabled at line 1030 (`pendingAction !== null`) |
| `"merge"` | `handleMergePartTypes` line 548 | `handleMergePartTypes finally` line 567 | Button disabled at line 1097 (`pendingAction !== null`) |
| `null` | `resetAuthenticatedView` line 212 | -- | -- |

### 7.3 Can pendingAction get stuck?

Every set is paired with a clear in a `finally` block, except:

**Scan edge case**: `performScan` only clears pendingAction `if (!silent && requestId === scanRequestRef.current)` at line 462. This means:
- If a scan is initiated, then a second scan replaces it (incrementing `scanRequestRef`), the first scan's finally block will NOT clear `pendingAction` (because `requestId !== scanRequestRef.current`).
- The second scan's finally block WILL clear it (because its `requestId` matches).
- But what if the second scan is silent (called from handleAssign or handleRecordEvent)? Silent scans never set `pendingAction`, so they don't clear it either.

**Scenario**: User clicks Scan (pendingAction = "scan"), then handleAssign fires immediately (impossible because pendingAction blocks the button). OK, this scenario cannot happen because all submit buttons are disabled when pendingAction is non-null.

**Scenario**: User clicks Scan (pendingAction = "scan"), network is slow. User clicks Scan again (but the button is disabled! so this cannot happen).

Wait -- the scan form's submit button IS disabled when `pendingAction !== null`. But the form itself can be submitted via Enter key. Let me check... The form's onSubmit handler calls `handleScan()` which calls `performScan()`. The `performScan()` function itself does not check `pendingAction` -- it always aborts the previous scan and starts a new one. But `handleScan` is triggered by form submit, which goes through the `<button type="submit" disabled={pendingAction !== null}>`. If the button is disabled, the form submit is prevented.

Actually, pressing Enter in the input field will submit the form regardless of whether the button is disabled, depending on browser behavior. Most browsers WILL submit the form when Enter is pressed in an input, even if the submit button is disabled. Let me trace this:

1. User types code, presses Enter.
2. Form onSubmit fires `handleScan()`.
3. `handleScan` calls `performScan(scanCode)` with `silent=false`.
4. `performScan` aborts previous scan, increments counter, sets `pendingAction("scan")`.
5. User presses Enter again while still in flight.
6. Form onSubmit fires `handleScan()` again.
7. `performScan` aborts the first scan, increments counter again, sets `pendingAction("scan")` again (already "scan", no change).
8. First scan's finally: `!silent` is true, but `requestId !== scanRequestRef.current`, so pendingAction is NOT cleared.
9. Second scan completes. Finally: `!silent` is true AND `requestId === scanRequestRef.current`, so pendingAction IS cleared.

**FINDING**: This works correctly even with rapid Enter presses. The last scan always clears pendingAction.

**Edge case that COULD get stuck**: If the second scan throws synchronously before the try block (impossible given the structure), or if the fetch promise is garbage-collected (not possible in JS). I believe this is safe.

**handleLogout edge case**: `handleLogout` always clears pendingAction in finally (line 334), and also calls `resetAuthenticatedView()` which sets pendingAction to null (line 212). The double-clear is harmless.

**handleAuthenticationFailure edge case**: `resetAuthenticatedView()` sets pendingAction to null. If this fires during another handler, the handler's finally block will also set it to null. Double-clear is harmless. But what if auth failure fires BEFORE the handler's try block sets pendingAction? E.g.:

1. User clicks "Assign".
2. `handleAssign` sets `pendingAction("assign")` at line 496.
3. `api.assignQr()` returns 401.
4. Catch block: `handleApiFailure()` returns true -> `handleAuthenticationFailure()` -> `resetAuthenticatedView()` -> `setPendingAction(null)`.
5. Finally block: `setPendingAction(null)`. (Harmless double-clear.)

**FINDING**: pendingAction cannot get stuck in a non-null state under normal circumstances. Every code path has a finally-based cleanup, and the auth failure path provides an additional safety clear.

### 7.4 Does it prevent double-submits across ALL forms?

All mutation buttons check `disabled={pendingAction !== null}`. This means:
- While a batch is registering, scan/assign/event/merge/logout are all disabled.
- While an event is recording, all other mutations are disabled.

**FINDING**: Yes, the mutex correctly prevents double-submits across all forms. However, it is a global mutex -- it does not allow independent actions to proceed concurrently. For example, you cannot search while a batch registration is in flight (search does not set pendingAction, so search actually DOES work during mutations).

Correction: Search uses `performSearch()` which does NOT set or check pendingAction. So search works during any pending action. Only form submits are blocked.

### 7.5 What happens if auth fails during a pending action?

The 401 is caught in the action's catch block -> `handleApiFailure()` returns true -> `handleAuthenticationFailure()` -> `resetAuthenticatedView()` (clears pendingAction to null) -> auth state set to `unauthenticated`. The action's finally block then also sets pendingAction to null. The user sees the login screen with the auth error.

**FINDING**: Correctly handled. No stuck state.

---

## 8. Cross-Machine Interactions

### 8.1 Auth FSM x Scan FSM

- When auth fails, `resetAuthenticatedView()` aborts all scan abort controllers and sets `scanResult = null`.
- The scan form is only rendered in the authenticated view (`authState.status === "authenticated"`).
- Scan requests include the auth token via the `Authorization` header. If the token is invalid, the request returns 401, which triggers de-auth.

**Interaction sequence during scan**:
1. User is authenticated.
2. User scans a code. `performScan` fires `POST /api/scan`.
3. Mid-flight, Part-DB revokes the token.
4. The middleware's `requireAuth` hook calls `authService.authenticateApiToken(apiToken)` which calls Part-DB. Part-DB rejects the token.
5. The middleware throws `UnauthenticatedError`.
6. The error handler returns `{ error: { code: "unauthenticated", ... } }` with HTTP 401.
7. Frontend receives 401. `handleApiFailure()` fires. Auth state -> unauthenticated.
8. `resetAuthenticatedView()` aborts the scan abort controller (already resolved, so abort is a no-op).
9. `scanResult` is set to null.
10. Login screen appears.

**FINDING**: Clean interaction. Auth failure during scan correctly triggers full de-auth.

### 8.2 Failed event recording x scan result display

If `handleRecordEvent` catches a non-auth error:
1. Error banner is set.
2. `scanResult` is NOT modified (the error path does not call `performScan` or clear `scanResult`).
3. The interact card remains visible with the pre-event state.
4. The user can retry the event or scan a different code.

**GAP**: After a failed event, the interact card shows the state from the last successful scan, which may be stale. If the event actually succeeded on the backend but the response was lost (e.g., network error after the server committed), the UI shows the pre-event state. A manual rescan would show the actual post-event state.

### 8.3 Partial failure of loadAuthenticatedData()

`loadAuthenticatedData()` uses `Promise.all()` (line 239):
```typescript
const [dashboardData, partDbData, provisionalData, partTypes] = await Promise.all([
  api.getDashboard(),
  api.getPartDbStatus(),
  api.getProvisionalPartTypes(),
  api.searchPartTypes(""),
]);
```

If ANY of these four requests fails:
- `Promise.all` rejects with the first error.
- None of the four state updates at lines 245-268 execute.
- The catch block at line 269 checks for auth failure, otherwise sets the global error banner.
- **All four data slices remain in their previous state** (or null if this is the initial load).

**GAP**: Partial success is not possible. If one of the four requests fails (e.g., Part-DB is down but the local DB is fine), ALL data is stale. The dashboard, provisional list, and catalog suggestions could all be successfully loaded but are discarded because `getPartDbStatus` failed. This is a design choice that prioritizes consistency over availability but could leave the user with no data if Part-DB is intermittently down.

**Note**: `getPartDbStatus` calls Part-DB with the user's token. If Part-DB is unreachable, the retry mechanism in `partdb-client.ts` will retry up to 3 times with exponential backoff. If all retries fail, the error propagates and kills the entire `loadAuthenticatedData` call.

Wait -- actually, let me re-check. `getConnectionStatus` in partdb-client.ts has a catch block (line 99-115) that returns a degraded status object rather than throwing (except for `UnauthenticatedError` which is re-thrown). So `getPartDbStatus` should NOT throw on Part-DB unreachable -- it returns `{ connected: false, ... }`.

The only case where `getPartDbStatus` would throw is if the token is invalid (401 from Part-DB), in which case `UnauthenticatedApplicationError` is thrown and bubbles up.

So the partial failure scenario is primarily:
- Auth failure on any request -> de-auth (handled by handleApiFailure).
- Parse error on any response -> global error, all four slices stale.
- Network error to the Smart DB middleware itself -> global error, all four slices stale.

**FINDING**: The `Promise.all` approach is correct for auth-related failures but overly conservative for independent data fetches.

### 8.4 loadAuthenticatedData() during an in-flight scan

`loadAuthenticatedData()` is called:
- After successful login (line 300 in handleLogin).
- After successful batch registration (line 479).
- After successful assignment (line 507, after the silent rescan).
- After successful event recording (line 533, after the silent rescan).
- After successful merge (line 560).

If a scan is in flight when `loadAuthenticatedData()` fires:
- `loadAuthenticatedData` calls `api.searchPartTypes("")` which updates `catalogSuggestions` and potentially `labelSearch`/`mergeSearch` results (lines 249-268).
- The search update only applies if the search query is empty (`current.query ? current : { ...current, results: partTypes }`). If the user has typed a query, the results are preserved.
- The in-flight scan is NOT aborted or affected. `loadAuthenticatedData` does not touch `scanResult`, `scanAbortRef`, or `scanRequestRef`.

**FINDING**: Safe interaction. `loadAuthenticatedData()` and scan do not interfere with each other.

---

## 9. GAPS

### G1: No voided/duplicate QR code paths
**Location**: `inventory-service.ts`, `schemas.ts`
The QR status schema defines `voided` and `duplicate` states, but no API endpoint or service method can transition a QR to these states. They exist only as schema placeholders. The scan handler correctly handles them (returns `unknown` mode), but they can never be reached.

### G2: No instance status transition guards
**Location**: `inventory-service.ts:345-369`
Any event can be applied to any instance status. A `consumed` item can be `checked_out`. A `lost` item can be `moved`. The middleware does not enforce a transition matrix. The frontend limits the event dropdown to a fixed set of available actions, but the API accepts anything valid per the schema.

### G3: No bulk level direction validation
**Location**: `inventory-service.ts:409-418`
Bulk stock levels can transition in any direction. `empty` -> `full` in a single `level_changed` event. No validation that levels change monotonically or sensibly.

### G4: nextStatus field is misleading
**Location**: `inventory-service.ts:345-369`, legacy shell inventory scan path
The event form shows a `nextStatus` dropdown for instances, but the middleware hardcodes the resulting status based on the event type (checked_out -> checked_out, returned -> available, etc.). The user's `nextStatus` selection is ignored for all events except `moved` (where the status does not change at all). The dropdown gives the false impression that the user controls the resulting status.

### G5: Stale scan result after conflict
**Location**: legacy shell assignment flow
If an assignment fails with a ConflictError (QR was assigned by someone else), the scan result still shows label mode for that QR. The user must manually rescan to see the updated state.

### G6: Message state survives auth transitions
**Location**: legacy shell auth restore flow
`resetAuthenticatedView()` does not clear `message` or `error`. Success/error messages from a previous session can persist on the login screen after a 401 de-auth.

### G7: No token expiry warning
**Location**: legacy shell scan reset flow
The session expiry time is displayed in the UI, but there is no timer or check that warns the user before the token expires. The user discovers expiry only when their next API call fails with 401.

### G8: No cross-tab synchronization
**Location**: `api.ts:37-39`
The `sessionToken` module-level variable and `localStorage` are not synchronized across tabs. There is no `storage` event listener. Logout in one tab does not propagate to other tabs.

### G9: Batch form not cleared after success
**Location**: legacy shell search flow
After successful batch registration, the form retains its values. The user could re-submit the same batch.

### G10: Form inputs not disabled during submission
**Location**: legacy shell (multiple forms)
While mutation buttons are disabled during `pendingAction`, form inputs (text fields, dropdowns) remain editable. User edits during an in-flight mutation are silently lost if the mutation succeeds (form gets reset).

### G11: Promise.all in loadAuthenticatedData kills all updates on single failure
**Location**: legacy shell authenticated bootstrap
If any of the four parallel requests fails, none of the state updates execute. Independent data (like the dashboard) could have been successfully loaded but is discarded.

### G12: No fetch timeout
**Location**: `api.ts:69-102`
No explicit timeout is set on fetch requests. A hanging server or network could leave the UI in a loading state indefinitely.

### G13: No event undo/correction
**Location**: `inventory-service.ts`
Events are append-only. There is no mechanism to undo or correct a mistaken event (e.g., accidentally marking an item as consumed).

### G14: Silent rescan failure is swallowed
**Location**: legacy shell form reset paths
After successful assign or event recording, a silent rescan fires. If this rescan fails, the error is caught by `performScan`'s catch block, but since `silent=true`, `pendingAction` is not affected. The error sets the global error banner, but the scan result may show stale data from the previous successful scan rather than the updated state.

### G15: Legacy Prototype Shared Search State
**Location**: legacy prototype shared search path
The legacy app shares a single `partTypeQuery` and `partTypeResults` between the label search and merge search, and has no abort controllers or request ordering. This is a correctness bug in the legacy app.

### G16: No QR unassignment path
**Location**: `inventory-service.ts`
Once a QR is assigned, it cannot be unassigned, voided, or reassigned. The assignment is permanent and irreversible.

### G17: requireAuth re-validates on every request
**Location**: `server.ts:37-44`
Every authenticated request calls `authService.authenticateApiToken(apiToken)` which calls Part-DB's `/api/tokens/current`. There is no server-side session cache. This means every Smart DB API call makes a round-trip to Part-DB. If Part-DB is slow, every Smart DB request is slow. The retry mechanism (3 attempts, 250ms-2s backoff) compounds this.

---

## 10. RISKS

### R1: TOCTOU on QR assignment (MEDIUM)
Two users scanning the same unassigned QR can both see label mode. The first to submit wins; the second gets a ConflictError. The losing user's UI shows a stale label form until they rescan. Data integrity is preserved (the middleware's `status !== "printed"` check is atomic within the transaction), but the UX is jarring.

### R2: Unauthorized state transitions via direct API calls (HIGH)
The middleware does not enforce a state transition matrix for instances. Any valid event can be sent for any status via a direct API call, bypassing the frontend's `availableActions` filter. This means:
- A consumed item can be returned to available.
- A lost item can be checked out.
- A damaged item can be moved (status stays damaged, but it is supposed to be quarantined).
This undermines audit trail integrity if the frontend is not the only client.

### R3: Token revocation surprise (LOW)
Part-DB token revocation causes immediate de-auth on the next API call. All form data is lost. There is no grace period, warning, or data recovery. The risk is low because tokens are typically long-lived, but the user impact is high when it occurs.

### R4: Stale data after conflict (MEDIUM)
After any mutation conflict (409), the UI shows stale data. The scan result, dashboard, and part type lists are not automatically refreshed. The user must take manual action (rescan, refresh) to see the current state.

### R5: Part-DB outage cascades to all Smart DB reads (MEDIUM)
Because `requireAuth` calls Part-DB on every request, a Part-DB outage makes all Smart DB API calls fail (after retry exhaustion). Even purely local operations (dashboard, scan) that don't need Part-DB data are blocked. The middleware has no local session cache to fall back on.

### R6: No protection against concurrent browser tab state divergence (LOW)
Two tabs can have different auth states, scan states, and form states with no synchronization. If one tab logs out and the other continues operating with a now-orphaned in-memory token, the second tab will work until it encounters a network error or the token actually expires.

### R7: Bulk level jumps without audit rationale (LOW)
A bulk stock can go from `empty` to `full` in one `level_changed` event with no requirement to explain the jump. This makes the audit trail less trustworthy for inventory reconciliation.

### R8: Misleading nextStatus dropdown (MEDIUM)
The event form shows a "Next status" dropdown for instances, but the middleware ignores the user's selection for all events except `moved`. The user may believe they are controlling the outcome but are not. This creates a false sense of control.

### R9: Head-of-line blocking from global mutex (LOW)
The `pendingAction` mutex blocks all mutations while any one is in flight. If a batch registration takes 5 seconds, the user cannot scan, assign, or record events during that time. This is conservative but penalizes throughput.

---

## 11. RECOMMENDATIONS

### Fix G2/R2: Add a server-side transition matrix for instance status

```typescript
const ALLOWED_TRANSITIONS: Record<InstanceStatus, Set<StockEventKind>> = {
  available:    new Set(["moved", "checked_out", "consumed", "damaged", "lost", "disposed"]),
  checked_out:  new Set(["moved", "returned", "consumed", "damaged", "lost"]),
  consumed:     new Set([]),  // terminal
  damaged:      new Set(["moved", "disposed", "returned"]),  // returned = repaired
  lost:         new Set(["returned"]),  // returned = found
};
```

Enforce this in `recordEvent()` before applying the event. Return a `ConflictError` for disallowed transitions. Update the scan response's `availableActions` to use this matrix rather than a static list.

### Fix G4/R8: Remove or make nextStatus functional

Option A: Remove the `nextStatus` dropdown from the event form entirely. Let the middleware own status transitions completely. This is the safer approach.

Option B: Have the middleware respect `nextStatus` and validate it against the transition matrix. The `nextStatus` field becomes the user's explicit intent rather than an ignored decoration.

### Fix G3/R7: Add level transition validation for bulk stock

At minimum, log a warning for non-adjacent level jumps. Optionally, require a `notes` field when the level change is more than one step (e.g., `empty` -> `full` must have notes explaining the restock).

### Fix G1: Implement voided/duplicate QR endpoints

Add `POST /api/qr-codes/:code/void` and a duplicate detection mechanism. Without these, the schema definitions are dead code.

### Fix G5: Auto-rescan after conflict error

When `handleAssign` catches a ConflictError, automatically rescan the QR to show the updated state:

```typescript
} catch (caught) {
  if (!handleApiFailure(caught)) {
    setError(errorMessage(caught));
    // Auto-rescan to show the updated state
    await performScan(assignForm.qrCode, true);
  }
}
```

### Fix G6: Clear message/error on auth transitions

Add `setMessage(null)` and `setError(null)` to `handleAuthenticationFailure()` or `resetAuthenticatedView()`.

### Fix G7: Add token expiry timer

If `authState.session.expiresAt` is set, start a `setTimeout` or `setInterval` that warns the user N minutes before expiry. On actual expiry, proactively transition to `unauthenticated` rather than waiting for the next API call to fail.

### Fix G8: Add cross-tab synchronization

Listen to the `storage` event on `window`:

```typescript
useEffect(() => {
  const handler = (event: StorageEvent) => {
    if (event.key === "smart-db.partdb-api-token" && event.newValue === null) {
      handleAuthenticationFailure(new Error("Logged out in another tab."));
    }
  };
  window.addEventListener("storage", handler);
  return () => window.removeEventListener("storage", handler);
}, []);
```

### Fix G9: Reset batch form after success

Add `setBatchForm(defaultBatchForm)` after successful batch registration, or at minimum increment `startNumber` by `count` to stage the next batch.

### Fix G10: Disable form inputs during submission

Add `fieldset disabled` around form contents during pending state, or add `disabled` attributes to individual inputs.

### Fix G11: Use Promise.allSettled for loadAuthenticatedData

```typescript
const results = await Promise.allSettled([...]);
// Apply each result independently, logging failures
```

This allows partial data to load even if one request fails.

### Fix G12: Add fetch timeout

Wrap the `fetch` call in `api.ts` with `AbortSignal.timeout(15000)` or equivalent.

### Fix G17/R5: Add server-side session cache

Cache the result of `authenticateApiToken()` for a short TTL (e.g., 60 seconds). This eliminates the per-request Part-DB round-trip and makes Smart DB resilient to brief Part-DB outages. The cache must be keyed by token hash and invalidated on any 401 from Part-DB.

### Fix G16: Consider a QR reassignment or voiding path

At minimum, add an admin endpoint to void QR codes. This allows physical stickers that are damaged or misprinted to be removed from the active pool. Without this, every QR code consumes a code in the `qrcodes` table permanently with no way to reclaim it.

### Fix R1: Add optimistic locking or version check

Include the QR's `updatedAt` timestamp in the assignment request. The middleware can verify that the QR has not been modified since the scan result was fetched. This converts the TOCTOU window from the full time between scan and submit into a precise version check.

### Fix R9: Consider scoped pending action

Replace the global `pendingAction` mutex with per-form state (e.g., `batchPending`, `assignPending`, `eventPending`). This allows independent operations to proceed concurrently. Only truly conflicting operations (e.g., two scans) need mutual exclusion.
