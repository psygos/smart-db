# Smart DB UX Redesign Specification

A comprehensive, mobile-first UX specification synthesized from five independent deep analyses: finite state machine audit, network resilience assessment, user journey friction mapping, mobile interaction design, and edge case/error recovery analysis.

**Design philosophy**: If the user has to think about the app, the app has failed. Every interaction should feel like pointing at a thing and having the right thing happen.

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Critical Findings](#2-critical-findings)
3. [Information Architecture](#3-information-architecture)
4. [The Scan Experience (Hot Path)](#4-the-scan-experience)
5. [Assignment Flow (Label Mode)](#5-assignment-flow)
6. [Lifecycle Events (Interact Mode)](#6-lifecycle-events)
7. [Admin Flows](#7-admin-flows)
8. [Authentication](#8-authentication)
9. [State Machine Corrections](#9-state-machine-corrections)
10. [Network Resilience Layer](#10-network-resilience-layer)
11. [Error Recovery & Edge Cases](#11-error-recovery--edge-cases)
12. [Accessibility](#12-accessibility)
13. [Implementation Phases](#13-implementation-phases)

---

## 1. Executive Summary

Smart DB is a phone-first scanning app used in makerspaces where people hold a phone in one hand and a part in the other. The current implementation has a functional backend but the frontend makes the core workflow (scan → label → next) take **25-40 seconds per item** with **7+ keystrokes, 3+ taps, and 3+ scroll gestures**.

The redesign targets **1-2 taps per item** for repeat part types and **under 5 taps** for new ones, bringing 30-item intake from **12-20 minutes down to 2-3 minutes**.

### The three transformative changes

1. **Camera-first scanning** — Replace the text input with a live viewfinder. Point and go.
2. **Bottom tab navigation** — Put scan at zero scroll depth. Kill the infinite scroll page.
3. **Sticky context** — Remember the last part type, location, and entity kind. One tap to repeat.

### What's broken at the system level

| Layer | Issue | Impact |
|-------|-------|--------|
| **FSM** | No server-side state transition enforcement | Any API caller can make illegal transitions (consumed → checked_out) |
| **FSM** | `voided` and `duplicate` QR statuses are unreachable | No way to void a QR or mark duplicates |
| **Network** | Every request re-validates token against Part-DB | Part-DB down = entire app down, even for local-only operations |
| **Network** | No fetch timeouts | A slow request freezes the entire app (all buttons disabled) |
| **Network** | No idempotency keys on mutations | Retry after timeout creates duplicate events |
| **UX** | Scan input is 800px below the fold | The primary action requires 3-5 swipes to reach |
| **UX** | No camera integration | Users must type "QR-1042" by hand on a phone |
| **UX** | No "repeat last" for identical items | Labeling 10 Arduinos = re-searching and re-selecting 10 times |
| **UX** | Success/error banners at page top | Invisible after actions deep in the scroll |
| **Edge** | Self-merge deletes the part type | `source === destination` is not validated |
| **Edge** | Giant batch (count=1M) blocks all users | Synchronous SQLite loop blocks the event loop |

---

## 2. Critical Findings

### 2.1 Finite State Machine Gaps (17 found)

The most dangerous: **the middleware has no state transition matrix**. The `availableActions` list is only enforced in the frontend dropdown — a direct API call can record any event from any state. A `consumed` item can be `checked_out`. A `lost` item can be `returned`. The audit trail would record these as legitimate transitions.

**Required fix**: Server-side transition validation.

```
INSTANCE TRANSITION MATRIX:
  available   → [moved, checked_out, consumed, damaged, lost, disposed]
  checked_out → [moved, returned, consumed, damaged, lost, disposed]
  consumed    → [] (terminal)
  damaged     → [moved, disposed, returned*]  (* = repaired)
  lost        → [returned*]                   (* = found)
```

```
BULK TRANSITION MATRIX:
  full  → [moved, level_changed, consumed]
  good  → [moved, level_changed, consumed]
  low   → [moved, level_changed, consumed]
  empty → [moved, level_changed]  (consumed from empty is nonsensical)
```

### 2.2 QR Lifecycle Dead Ends

Two of four QR statuses (`voided`, `duplicate`) have no code path to reach them. There is no way to:
- Void a mistakenly assigned QR
- Mark a duplicate sticker
- Reset a broken QR (assigned but entity missing)
- Un-assign a wrongly assigned QR

**Required**: Add `POST /api/qr-codes/:code/void` and a repair endpoint.

### 2.3 Part-DB as Single Point of Failure

The `requireAuth` pre-handler calls Part-DB on **every single authenticated request**. If Part-DB is slow or down:
- All Smart DB endpoints become unavailable
- Users cannot scan, assign, record events, or view the dashboard
- Operations that don't need Part-DB (everything except login and status check) are unnecessarily blocked

**Required**: Server-side auth token cache with 5-minute TTL.

### 2.4 No Recovery from Mistakes

There is no undo, no void, no correction mechanism for:
- Wrong part type assigned to a QR
- Wrong event recorded (e.g., accidentally marked as consumed)
- Provisional part type that should not have been created

**Required**: Corrective event type, QR void capability, entity reassignment.

---

## 3. Information Architecture

### 3.1 Current: Single Infinite Scroll Page

```
┌─────────────────────────┐
│ Hero (username, status)  │  ← 300px
├─────────────────────────┤
│ Metrics (5 cards)        │  ← 430px on mobile (stacked)
├─────────────────────────┤
│ QR Batch Registration    │  ← admin panel, above the primary action
├─────────────────────────┤
│ Scan Input + Results     │  ← THE HOT PATH, buried 800px down
│   └─ Assignment Form     │  ← 1200px down when open
│   └─ Event Form          │
├─────────────────────────┤
│ Merge Panel              │
├─────────────────────────┤
│ Recent Events + Part-DB  │
└─────────────────────────┘
```

**Problem**: The primary action (scan) is below 2+ screens of admin chrome. On mobile, the user scrolls more than they scan.

### 3.2 Proposed: Bottom Tab Navigation

```
┌─────────────────────────────────────┐
│                                     │
│         [Active Tab Content]        │
│                                     │
│                                     │
├──────────┬──────────┬───────────────┤
│  📷 Scan │ 📋 Activity│ ⚙ Admin     │
│ (primary)│          │               │
└──────────┴──────────┴───────────────┘
```

**Three tabs**:

| Tab | Purpose | Content |
|-----|---------|---------|
| **Scan** (default) | The hot path | Camera viewfinder, scan result, assignment/event forms |
| **Activity** | Audit & browse | Dashboard metrics, recent events, entity search/browse |
| **Admin** | Setup & cleanup | QR batch registration, provisional merge, Part-DB status, settings |

**Why this works**:
- Scan tab loads with zero scroll — camera is immediately visible
- Admin clutter is hidden unless the user explicitly wants it
- Activity tab serves the "what just happened" use case without polluting the hot path
- Bottom tab bar is always reachable with one thumb

### 3.3 Scan Tab Layout (Zero Scroll Depth)

```
┌─────────────────────────────┐
│ [Status Bar: user + PartDB] │  ← 44px, minimal
├─────────────────────────────┤
│                             │
│     ┌─────────────────┐    │
│     │                 │    │
│     │   Camera        │    │  ← 45% viewport height
│     │   Viewfinder    │    │
│     │                 │    │
│     └─────────────────┘    │
│                             │
│  [Manual code input]  [⌨]  │  ← collapsed, expandable
├─────────────────────────────┤
│                             │
│  [Scan Result / Action Area]│  ← remaining space
│                             │
│  • Label mode: compact form │
│  • Interact mode: actions   │
│  • Unknown: explanation     │
│                             │
├─────────────────────────────┤
│  📷 Scan  │ 📋 Activity │ ⚙│
└─────────────────────────────┘
```

**Key principle**: After a scan, the action form appears BELOW the viewfinder in the remaining viewport. The camera stays open. The user can act without scrolling and immediately scan the next item.

---

## 4. The Scan Experience

### 4.1 Camera Integration

**Technology**: Progressive enhancement.

```
BarcodeDetector API (native, Chrome Android 83+, Safari 17.2+)
  └─ fallback: html5-qrcode (~45KB, covers Firefox + older iOS)
    └─ fallback: manual text input (desktop, camera denied)
```

**Supported formats**: QR Code (primary), EAN-13, UPC-A, Code 128.

### 4.2 Permission Flow

```
[App Load]
  │
  ├─ Camera permission already granted?
  │    └─ YES → Start viewfinder immediately
  │
  ├─ Camera permission not yet asked?
  │    └─ Show "Enable Camera" button with explanation:
  │       "Smart DB uses your camera to scan QR codes on parts and bins."
  │       [Enable Camera Scanning]
  │       └─ On tap → navigator.mediaDevices.getUserMedia()
  │           ├─ Granted → Start viewfinder, save preference
  │           └─ Denied → Show manual input mode with re-ask option
  │
  └─ Camera permission denied?
       └─ Show manual input prominently
       └─ Show "Camera access was denied. You can type codes manually,
            or allow camera access in your browser settings."
```

**Never block the user**. Camera denied = manual input is promoted to primary. The app works either way.

### 4.3 Scanning Behavior

| Behavior | Specification |
|----------|---------------|
| **Continuous scanning** | Camera stays open between scans. After a successful scan and action, it immediately starts looking for the next code. |
| **Decode cooldown** | 800ms after a successful decode before accepting the next one. Prevents the same code from being scanned repeatedly while the user is still pointing at it. |
| **Duplicate suppression** | If the same code is decoded within 3 seconds of the previous decode, ignore it. |
| **Haptic feedback** | `navigator.vibrate(50)` on successful decode (short pulse). |
| **Audio feedback** | Optional soft "click" sound. Off by default, toggle in settings. |
| **Viewfinder overlay** | Crosshair guide centered in the viewfinder. Green flash on successful decode. |
| **Torch/flashlight** | Toggle button in viewfinder corner for dark environments. |
| **Front/back camera** | Default to back camera. Toggle available but rarely needed. |

### 4.4 Manual Input Fallback

Below the viewfinder (or as primary if camera denied): a single-line text input with an "Open" button. This serves:
- Desktop users
- Camera-denied scenarios
- Hardware barcode scanners (which emulate keyboard + Enter)
- Debugging / testing

The input auto-focuses on the Scan tab for keyboard scanners.

### 4.5 Scan Result Transitions

```
[Idle] ──scan──> [Loading] ──response──> [unknown | label | interact]
                     │
                     └──error──> [Error with retry]

[unknown] ──scan──> [Loading]  (user scans another code)
[label]   ──assign──> [interact]  (same QR, now assigned)
[label]   ──scan──> [Loading]  (user scans a different code)
[interact]──event──> [interact'] (same entity, updated state)
[interact]──scan──> [Loading]  (user scans another code)
```

**Dirty form guard**: If the user is mid-form-fill in label mode and scans a new code, show a brief confirmation: "Discard unsaved assignment?" with [Discard] [Cancel]. If no fields have been touched, skip the confirmation.

---

## 5. Assignment Flow (Label Mode)

When the scan returns `mode: "label"` (QR is registered but unassigned), the action area shows the assignment form.

### 5.1 Optimized Layout

```
┌─────────────────────────────┐
│ Assign QR-1042              │
│                             │
│ ┌─────────┐ ┌─────────┐    │
│ │ Arduino │ │ PLA Fil. │    │  ← Recent/suggested part types
│ │  Mega   │ │  1.75mm  │    │    as tappable chips
│ └─────────┘ └─────────┘    │
│ ┌─────────┐ ┌─────────┐    │
│ │ JST Con.│ │ +Search  │    │  ← "+Search" opens search input
│ └─────────┘ └─────────┘    │
│                             │
│ Location: [Buffer Room A ▾] │  ← Dropdown of recent locations
│                             │
│ [  Assign  ] [Assign Same▾] │  ← Primary + repeat shortcut
│                             │
│ ▸ More options              │  ← Expandable: kind, status, notes
└─────────────────────────────┘
```

### 5.2 Key Interactions

**Part type selection** — Three tiers:
1. **Sticky suggestion**: If the user just assigned a part type, it appears first with a highlight ("Same as last: Arduino Mega"). One tap.
2. **Recent + server suggestions**: The 6-8 most recently used part types, plus server suggestions. Tappable chips.
3. **Search**: Tapping "+Search" or starting to type opens an inline search field. Results replace the chips. Predictive search with abort + request ordering (already implemented correctly).
4. **New type**: If search yields no match, a "Create new: {query}" chip appears at the bottom of results. Tapping it opens the new-type inline form (name pre-filled from search query, category, countable toggle).

**Location** — Dropdown pre-filled with the last-used location. Most recent 5 locations in the dropdown. Option to type a new one.

**"Assign Same" button** — After the first assignment, this button appears. It repeats the exact same assignment (same part type, same location, same entity kind) for the next scanned QR code. **This is the 1-tap repeat path** that turns 30-identical-item intake from 12 minutes to 90 seconds.

**Expanded options** — Collapsed by default. Contains: entity kind (auto-set from part type's `countable` flag), initial status/level, notes. These are rarely changed and should not occupy space on the hot path.

### 5.3 Post-Assignment Behavior

1. Success feedback: Green flash on the viewfinder border + brief toast at the bottom (NOT a banner at the top). Toast auto-dismisses after 2 seconds.
2. Camera immediately resumes scanning for the next code.
3. The "Assign Same" bar appears/updates with the last assignment's context.
4. Dashboard and data refresh happens silently in the background. If it fails, no error shown — the scan view is unaffected.
5. Focus returns to the viewfinder (not a text input).

---

## 6. Lifecycle Events (Interact Mode)

When the scan returns `mode: "interact"` (QR is assigned to an entity), the action area shows the entity card and available actions.

### 6.1 Optimized Layout

```
┌──────────────────────────────┐
│ Arduino Mega 2560 · QR-1042  │
│ Instance · Buffer Room A     │
│ Status: available            │
│                              │
│ ┌──────┐ ┌─────────┐ ┌────┐ │
│ │ Move │ │Check Out│ │ ⋯  │ │  ← Action BUTTONS, not a dropdown
│ └──────┘ └─────────┘ └────┘ │
│                              │
│ ▸ Recent events (3)         │  ← Collapsible, shows last 3
└──────────────────────────────┘
```

### 6.2 Key Changes from Current Design

**Action buttons instead of a select dropdown**: The current design uses a `<select>` dropdown for event type, then a separate submit button. This is 2 taps where 1 would do. Replace with direct action buttons:

For instances:
- **Move** — Tap opens a location input inline. Submit logs `moved` event.
- **Check Out** — Tap opens assignee field (defaults to current user). Submit logs `checked_out`.
- **Return** — Single tap. No form needed. Logs `returned`, status → available.
- **More (...)** — Opens: consumed, damaged, lost, disposed. These are rare/destructive.

For bulk:
- **Move** — Same as above.
- **Adjust Level** — Tap opens level picker (full/good/low/empty). Submit logs `level_changed`.
- **Consumed** — Single tap confirmation. Logs `consumed`.

**Filtered by current state**: Buttons shown depend on current status (enforced by the server-side transition matrix). A `checked_out` item shows [Move] [Return] [More...] but NOT [Check Out].

**Auto-populated fields**:
- Location defaults to current location (editable).
- Assignee for check-out defaults to the authenticated user.
- The server overrides `actor` with the session username (already implemented).
- The `nextStatus` is determined by the event type (not a separate dropdown the user must set correctly). The current UI lets the user pick an event AND independently pick a next status — this is confusing and can create incoherent combinations. Remove the next-status dropdown.

### 6.3 Post-Event Behavior

Same as post-assignment: green flash, brief toast, camera resumes, background data refresh.

---

## 7. Admin Flows

### 7.1 QR Batch Registration (Admin Tab)

```
┌─────────────────────────────────┐
│ Register QR Batch               │
│                                 │
│ Prefix: [QR        ]           │
│ Start:  [1001      ]           │
│ Count:  [500       ]           │
│                                 │
│ Preview: QR-1001 through QR-1500│  ← Live preview of range
│                                 │
│ ⚠ 23 codes in this range       │  ← Overlap warning
│   already exist (will be        │
│   skipped)                      │
│                                 │
│ [Register 500 Codes]            │
│                                 │
│ ─── Recent Batches ───          │
│ batch-1711234567: QR-0001..0500 │  ← History visible
│ batch-1711234890: QR-0501..1000 │
└─────────────────────────────────┘
```

**Improvements**:
- Live preview of the code range before committing
- Overlap detection (query existing codes in the range, show count)
- Auto-increment: after registering, start number auto-advances to `endNumber + 1`
- Batch history visible below the form
- Max count enforced at 10,000 with confirmation for counts > 1,000
- Prefix restricted to `[A-Za-z0-9_-]` with real-time validation
- Success/error feedback inline, not at page top

### 7.2 Part Type Merge (Admin Tab)

```
┌─────────────────────────────────┐
│ Merge Provisional Types         │
│                                 │
│ 7 provisional types need review │
│                                 │
│ ┌─ arduino mega ──────────────┐ │
│ │ Category: electronics       │ │
│ │ 3 instances reference this  │ │  ← Show impact
│ │                             │ │
│ │ Merge into: [Search...    ] │ │
│ │                             │ │
│ │ ┌──────────────┐           │ │
│ │ │Arduino Mega  │ selected  │ │
│ │ │2560          │           │ │
│ │ └──────────────┘           │ │
│ │                             │ │
│ │ [Merge] [Skip / Keep As-Is]│ │
│ └─────────────────────────────┘ │
│                                 │
│ ┌─ pla filament ──────────────┐ │
│ │ ...next provisional...      │ │
│ └─────────────────────────────┘ │
└─────────────────────────────────┘
```

**Improvements**:
- Card-based list of provisionals (not a dropdown) — each card is self-contained with its own search and merge action
- Show how many instances/bulk reference each provisional (merge impact)
- "Skip / Keep As-Is" option for provisionals that are genuinely new types (marks `needsReview = false` without merging)
- Confirmation: "Merge 'arduino mega' into 'Arduino Mega 2560'? 3 instances will be repointed. This cannot be undone."
- Self-merge guard: source and destination cannot be the same (validated client AND server side)
- Independent search state per card (already correctly separated in the current implementation)

---

## 8. Authentication

### 8.1 Login Flow

```
┌─────────────────────────────────┐
│                                 │
│          Smart DB               │
│                                 │
│  Sign in with your Part-DB      │
│  API token.                     │
│                                 │
│  [How to get a token ▸]        │  ← Expandable help
│                                 │
│  ┌─────────────────────────┐   │
│  │ Paste your token here   │   │
│  └─────────────────────────┘   │
│                                 │
│  [Sign In]                      │
│                                 │
│  ─── or ───                     │
│                                 │
│  [Scan Token QR Code 📷]       │  ← Future: scan a QR from
│                                 │     Part-DB's token page
└─────────────────────────────────┘
```

**Improvements**:
- "How to get a token" expandable section with step-by-step instructions and a link to Part-DB
- QR-based login option (scan a QR code generated by Part-DB containing the API token)
- Error messages are specific: "Token rejected by Part-DB" vs "Could not reach Part-DB" vs "Token format is invalid"

### 8.2 Session Resilience

| Scenario | Current | Proposed |
|----------|---------|----------|
| Token expires mid-session | Abrupt redirect to login, all form data lost | Warning 5 min before expiry: "Session expiring soon." On expiry: re-auth overlay (not redirect), form state preserved in sessionStorage |
| Part-DB unreachable | All requests fail | Server-side auth cache (5 min TTL). Read-only operations continue. Mutations show "Part-DB is temporarily unavailable" |
| Two tabs open | Independent state, no sync | Listen for `storage` events. Token cleared in one tab → other tab shows re-auth prompt |
| Private browsing | Works, but token lost on close | Detect and inform user: "Private mode — you'll need to sign in again next visit" |

---

## 9. State Machine Corrections

### 9.1 Server-Side Transition Enforcement

Add to `inventory-service.ts`:

```
const INSTANCE_TRANSITIONS: Record<InstanceStatus, StockEventKind[]> = {
  available:   ['moved', 'checked_out', 'consumed', 'damaged', 'lost', 'disposed'],
  checked_out: ['moved', 'returned', 'consumed', 'damaged', 'lost', 'disposed'],
  consumed:    [],   // terminal
  damaged:     ['moved', 'disposed', 'returned'],  // returned = repaired
  lost:        ['returned'],  // returned = found
};

const BULK_TRANSITIONS: Record<BulkLevel, StockEventKind[]> = {
  full:  ['moved', 'level_changed', 'consumed'],
  good:  ['moved', 'level_changed', 'consumed'],
  low:   ['moved', 'level_changed', 'consumed'],
  empty: ['moved', 'level_changed'],  // can't consume from empty
};
```

`recordEvent()` must validate: `if (!TRANSITIONS[currentState].includes(event)) throw ConflictError(...)`.

`scanCode()` must return `availableActions` from this matrix (not a hardcoded list).

### 9.2 QR Lifecycle Completion

Add transitions for the unreachable statuses:

```
printed  ──assign──> assigned
printed  ──void────> voided     (NEW: admin action)
assigned ──void────> voided     (NEW: with entity disposal)
any      ──flag────> duplicate  (NEW: admin marks duplicate sticker)
```

### 9.3 Event-Driven Status Determination

Remove the `nextStatus` / `nextLevel` dropdown from the frontend. The event type alone determines the next state:

| Event | Next Status | Notes |
|-------|-------------|-------|
| `moved` | (unchanged) | Only location changes |
| `checked_out` | `checked_out` | Assignee set |
| `returned` | `available` | Assignee cleared |
| `consumed` | `consumed` | Terminal |
| `disposed` | `consumed` | Terminal |
| `damaged` | `damaged` | |
| `lost` | `lost` | |
| `level_changed` | (explicit) | User picks the new level |

The only case where the user needs to pick a target state is `level_changed` for bulk stock. All other transitions are deterministic from the event type.

---

## 10. Network Resilience Layer

### 10.1 Request Timeouts

Add to `api.ts`:

```
const REQUEST_TIMEOUT_MS = 15_000;
const SLOW_REQUEST_MS = 3_000;
```

Every `fetch()` gets an `AbortSignal.timeout(REQUEST_TIMEOUT_MS)` merged with any existing signal. After `SLOW_REQUEST_MS`, show a subtle "Taking longer than usual..." indicator. On timeout, show "Request timed out. Please try again."

### 10.2 Auth Token Cache (Server-Side)

```
Map<sha256(token), { session: AuthSession, validatedAt: Date }>
TTL: 5 minutes

On requireAuth:
  1. Hash token
  2. Cache hit + fresh? → use cached session
  3. Cache miss or stale? → call Part-DB
     - Success → cache and use
     - Failure + stale cache exists → use stale cache, log warning
     - Failure + no cache → return 502
```

This makes the system survive Part-DB outages for 5 minutes after the last successful validation.

### 10.3 Idempotency Keys

For `POST /api/assignments`, `POST /api/events`, `POST /api/qr-batches`, `POST /api/part-types/merge`:

- Frontend generates a UUID per form submission attempt.
- Sent as `X-Idempotency-Key` header.
- Server stores `{ key, response, createdAt }` in an `idempotency_keys` table.
- If the same key is seen again within 24 hours, return the cached response.
- Auto-expire after 24 hours.

This eliminates duplicate events on network-timeout retry.

### 10.4 Promise.allSettled for Data Loading

Replace `Promise.all` in `loadAuthenticatedData()` with `Promise.allSettled`. Update each data source independently. Show targeted warnings only for failed sub-requests, not a blanket error.

### 10.5 Background Refresh After Mutations

After a mutation succeeds:
1. Show success immediately (toast).
2. Fire re-scan and data refresh in the background.
3. If they fail, show a subtle "Data may be stale" indicator (not an error banner that overwrites the success).
4. Pull-to-refresh on the Activity tab to manually force a refresh.

### 10.6 Offline Detection

```
navigator.onLine + 'online'/'offline' events
  │
  ├─ Online → normal operation
  │
  └─ Offline → persistent banner: "You're offline"
       ├─ Read-only from cached data (dashboard, last scan results)
       ├─ Mutations queued with "pending" indicator
       └─ On reconnect → replay queue, refresh data, clear banner
```

Phase 1 (minimal): Detect offline, show banner, disable mutations.
Phase 2 (advanced): Queue mutations in IndexedDB, replay on reconnect.

---

## 11. Error Recovery & Edge Cases

### 11.1 Immediate Fixes (Trivial Effort, Critical Impact)

| Fix | Location | Effort |
|-----|----------|--------|
| Self-merge guard: `if (source.id === dest.id) throw ConflictError` | `inventory-service.ts` | 2 lines |
| Batch count max: `.max(10_000)` | `schemas.ts` | 1 line |
| SQLite busy timeout: `PRAGMA busy_timeout = 5000` | `database.ts` | 1 line |
| Graceful aliases JSON: catch → return `[]` instead of throw | `inventory-service.ts` | 1 line change |
| QR prefix regex: `/^[A-Za-z0-9_-]+$/` | `schemas.ts` | 1 line |
| Disable scan button when input empty | scan shell | 1 attribute |

### 11.2 Corrective Events (Undo Equivalent)

Instead of true undo (which would break the append-only audit trail), add a `correction` event type:

```
POST /api/events
{
  targetType: "instance",
  targetId: "abc-123",
  event: "correction",
  notes: "Accidentally marked as consumed. Restoring to available.",
  nextStatus: "available"
}
```

The `correction` event explicitly restores a previous state with a note explaining why. The audit trail shows both the mistake and the fix.

### 11.3 QR Void Capability

```
POST /api/qr-codes/:code/void
{
  reason: "Wrong sticker applied" | "Damaged sticker" | "Duplicate"
}
```

- If QR is `printed` → set status to `voided`. Done.
- If QR is `assigned` → record a `disposed` event on the entity, then set QR status to `voided`.
- Return the updated QR code.

### 11.4 Conflict Resolution Patterns

| Conflict | Detection | Resolution |
|----------|-----------|------------|
| Two users assign same QR | Server returns 409 | Show: "This QR was just assigned by {actor}. Scan it to see." |
| Part type deleted between search and submit | Server returns 404 | Auto-refresh search results, show: "This type was merged. Please select again." |
| Entity state changed since scan | Optimistic locking via `version` column | Show: "This item was modified. Re-scanning..." + auto re-scan |
| Token expired mid-form | 401 on submit | Re-auth overlay preserving form state |

### 11.5 Scan History

Maintain a list of the last 20 scanned codes with their results in local controller state:

```
{ code: "QR-1042", mode: "interact", partType: "Arduino Mega", timestamp: "...", entityState: "available" }
```

Accessible via a "Recent Scans" section on the Activity tab. Tapping a recent scan re-scans it (fresh data from server, not cached). This replaces the need to remember or re-type codes.

---

## 12. Accessibility

### 12.1 Screen Reader Support

| Element | Current | Required |
|---------|---------|----------|
| Error banners | No ARIA role | `role="alert"` |
| Success banners | No ARIA role | `role="status"` |
| Part type picker | Buttons with no group | `role="radiogroup"` with `role="radio"` on each button |
| Scan result area | No live region | `aria-live="polite"` on the result container |
| Loading states | Button text changes | `aria-busy="true"` on the form during submission |
| Camera viewfinder | No alternative | `aria-label="QR code scanner. Point your camera at a QR code."` + manual input always available |

### 12.2 Color Contrast

The metric label color `#6d7485` on a white background fails WCAG AA for small text (contrast ratio ~4.1:1, needs 4.5:1). Darken to `#5a6275` or use a larger font size.

### 12.3 Focus Management

After form submission: focus the scan input (or viewfinder) for the next code.
After error: focus the first problematic field.
After tab switch: focus the primary interactive element of the new tab.

### 12.4 Keyboard Navigation

All actions reachable via Tab. Action buttons in interact mode should be in a logical tab order. Escape closes expanded sections. Enter submits forms.

---

## 13. Implementation Phases

### Phase 1: Foundation (Structural)

**Goal**: Fix the information architecture and critical bugs. No new features.

1. Bottom tab navigation (Scan / Activity / Admin)
2. Server-side state transition enforcement
3. Self-merge guard
4. Batch count cap
5. SQLite busy timeout
6. Graceful aliases JSON handling
7. Auth token caching on server
8. Request timeouts in frontend API client
9. `Promise.allSettled` for data loading
10. Accessibility: ARIA roles on banners, contrast fix

**Outcome**: The app is structurally sound and the hot path is at zero scroll depth.

### Phase 2: Camera & Speed (The Transformation)

**Goal**: Make scanning feel like magic.

1. Camera QR scanning with BarcodeDetector + html5-qrcode fallback
2. Permission flow (ask → grant/deny → fallback)
3. Continuous scanning with cooldown + duplicate suppression
4. Haptic feedback on decode
5. Compact assignment form with part type chips
6. "Assign Same" repeat bar
7. Location dropdown with recent locations
8. Action buttons (not dropdown) for lifecycle events
9. Remove nextStatus/nextLevel dropdowns (event type determines state)
10. Toast notifications (not top-of-page banners)

**Outcome**: 1-2 taps per repeat item. 30 items in under 3 minutes.

### Phase 3: Resilience & Recovery

**Goal**: Make it impossible to get stuck.

1. Idempotency keys on all mutations
2. Corrective event type
3. QR void capability
4. Optimistic concurrency (version column on entities)
5. Dirty-form detection with discard confirmation
6. Offline detection with banner
7. Scan history (last 20 codes)
8. Session expiry warning + re-auth overlay
9. Cross-tab token sync via storage events
10. Field-level validation errors (not generic parse_input banners)

**Outcome**: Every error is recoverable. Every edge case is handled gracefully.

### Phase 4: Polish

**Goal**: Delight.

1. Auto-increment batch start number after success
2. Batch overlap detection (preview before commit)
3. Merge cards with impact counts
4. "Keep As-Is" option for genuine new provisional types
5. Activity tab with entity search/browse
6. Pull-to-refresh on Activity tab
7. Service worker for static asset caching
8. PWA manifest + install prompt
9. Periodic dashboard polling (30s when tab visible)
10. Sound feedback toggle in settings

---

## Source Reports

This specification synthesizes findings from five independent analyses, all saved in `docs/`:

1. `fsm-audit.md` — 8 state machines mapped, 17 gaps, 9 risks, 16 recommendations
2. `ux-friction-report.md` — 5 persona walkthroughs, 3 blocking + 10 painful friction points, 12 missing flows
3. `mobile-interaction-design.md` — Camera integration spec, screen layout analysis, touch targets, rapid intake optimization, navigation proposal
4. Network resilience analysis — 12 API calls inventoried, failure modes for each, race conditions, cache strategy, offline roadmap
5. Edge case analysis — 30+ edge cases across 8 categories, recovery designs, defensive patterns, undo/conflict resolution
