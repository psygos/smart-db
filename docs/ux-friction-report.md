# Smart DB UX Friction Report

Prepared by walking through the pre-rewrite frontend codebase as five distinct personas operating on a phone in a busy makerspace.

Historical note:
- This document audits the legacy frontend shell and intentionally retains historical flow observations.

---

## Part 1: Persona Walkthroughs

---

### Persona 1: Lab Manager (Setup Day)

**Context**: First time opening the app. Needs to register 2000 QR stickers across 4 batches, then label roughly 50 items. Has a stack of printed QR stickers and a pile of parts on a table. Using a phone.

#### Journey A: Authentication

| Step | Action | Friction (1-5) | Notes |
|------|--------|-----------------|-------|
| 1 | Open Smart DB on phone | 1 | Page loads, login screen appears |
| 2 | Read the login screen instructions | **3** | "Sign In With Part-DB" -- a first-time user may not know what a Part-DB API token is, where to find one, or how to generate one. There is no link to Part-DB, no help text about where to find the token, no instructions |
| 3 | Switch to Part-DB in browser, navigate to API token page | **4** | This is a multi-app context switch on a phone. The user must leave Smart DB, open Part-DB, find the API token settings, generate or copy a token, then switch back. On mobile, copy-paste between browser tabs is clumsy |
| 4 | Paste token and tap "Authenticate" | 1 | The input field is a password field, which is correct. Button disables during submission |
| 5 | Wait for authentication | 2 | No progress indicator beyond button text changing to "Authenticating..." -- on a slow connection, user may wonder if anything is happening |
| 6 | See the authenticated home screen | **3** | The screen explodes with information: hero header, status card, 5 metrics, 4 panels. On a phone at 900px or below, this is a single-column scroll of enormous length. The user has no orientation about what to do first |

**Journey A total**: 6 steps, 2 decision points, ~14/30 friction score.

**Critical gap**: No onboarding. A first-time user sees a firehose of panels with no guidance about sequencing (register QRs first, then scan, then label). The tagline "Fast intake, durable inventory" does not explain the workflow.

#### Journey B: Register 4 QR Batches (2000 stickers)

| Step | Action | Friction (1-5) | Notes |
|------|--------|-----------------|-------|
| 1 | Scroll to "Print QR batches" panel | **3** | On mobile, the user must scroll past the hero (username, Part-DB status, token expiry, logout button), the metrics bar (5 cards stacked vertically), to reach the first panel. This is ~4 screen-heights of scrolling on a typical phone |
| 2 | Read the panel title and copy | 2 | "Pre-register sticker ranges" is jargon for someone unfamiliar. "This batch will be attributed to {username}" is reassuring but not actionable |
| 3 | Edit Prefix field | 1 | Default "QR" is sensible |
| 4 | Edit Start number field | 2 | Default "1001" -- the user must know their numbering scheme. No help about what happens if numbers overlap with an existing batch |
| 5 | Edit Count field | 2 | Default "500" -- for 2000 stickers across 4 batches, user needs to think about arithmetic: batch 1 = 1001-1500, batch 2 = 1501-2000, etc. |
| 6 | Tap "Register batch" | 1 | Button disables, text changes to "Registering..." |
| 7 | Read success banner | 2 | "Registered 500 QR codes in batch-123456. 0 were already present." -- the banner appears at the TOP of the page. On mobile, the user just submitted a form that is well below the fold. **The user cannot see the success banner without scrolling back up.** |
| 8 | Scroll back up to see the banner | **4** | Wasted motion. Success/error feedback must be near the action that triggered it |
| 9 | Scroll back down to the batch form | **4** | The form has NOT reset. The same values are still there. Good for batch 1, but for batch 2, the user must manually change Start number to 1501. There is no auto-increment |
| 10-18 | Repeat steps 4-9 three more times | **5** | For 4 batches, the user performs this scroll-up-scroll-down dance 4 times. Each batch requires manually computing the next start number (1001, 1501, 2001, 2501). There is no preview of what codes will be generated, no confirmation, no batch history visible |

**Journey B total**: 18+ steps (4 batches), 4 decision points, heavy scrolling tax.

**Critical friction**: (1) No preview of generated code range before committing. (2) Banner placement forces scrolling after every action. (3) No auto-increment of start number after successful batch. (4) No visual confirmation of what batch ranges already exist.

#### Journey C: Label 50 Items

| Step | Action | Friction (1-5) | Notes |
|------|--------|-----------------|-------|
| 1 | Scroll to Scan panel | 2 | After batch registration, user must locate the scan panel (immediately below the batch panel on mobile) |
| 2 | Tap the scan input field | 1 | The field auto-focuses on authentication, but NOT after batch registration. After the scroll, the user must manually tap |
| 3 | Type or scan the first QR code | 2 | The placeholder says "Scan or type a QR / barcode" but there is no camera scanner integration. "Scan" is misleading -- the user must type "QR-1001" manually or use a hardware Bluetooth scanner. On a phone with no hardware scanner, this is a significant barrier |
| 4 | Tap "Open" | 1 | |
| 5 | Wait for scan response | 2 | Button shows "Opening..." |
| 6 | See the assignment form appear below the scan input | 2 | The form appears inline below the scan bar. On mobile, it may be partially below the fold, requiring a scroll to see the full form |
| 7 | Read "Assign QR-1001" heading | 1 | Clear |
| 8 | Search for a part type | **3** | The user must type in the search field. On a phone, the keyboard covers ~50% of the screen. The picker buttons (part type results) render below the search input. With the keyboard open, the user likely cannot see any results. They must type, then dismiss the keyboard to see results, then tap a result. This is a 3-step micro-interaction that happens 50 times |
| 9 | Tap a part type button | 2 | The button selection is indicated by a gold border (`border-color: #b06f13`). On a phone, with many part types, the picker wraps and may require scrolling. Selected state is subtle |
| 10 | Review/edit Location field | 2 | Default is "Buffer Room A". If labeling in a different room, the user must change this for every single item, or set it once and hope it sticks. But it resets to default after each assignment (line 504: `setAssignForm(defaultAssignForm)`) |
| 11 | Review Kind dropdown | 1 | Auto-set from part type's `countable` flag. Correct behavior |
| 12 | Review Initial status/level dropdown | 1 | Default "available"/"good" is sensible |
| 13 | Skip "New canonical name" field | 1 | Placeholder says "Leave blank when reusing an existing part type" -- clear |
| 14 | Skip Category, Countable, Notes | 1 | Only relevant for new part types |
| 15 | Tap "Assign QR" | 1 | |
| 16 | Wait for assignment | 2 | Button shows "Assigning..." |
| 17 | See success banner (at top of page) | **4** | Same problem as batch registration: the success banner appears at the very top of the page. The user just tapped a button deep in the scan panel. On mobile, the banner is invisible |
| 18 | Notice the form has been replaced with the interact view | 3 | After assignment, a silent re-scan fires, and the scan result switches from `label` mode to `interact` mode. The assignment form disappears and is replaced by the event form. This is a jarring visual transition with no animation or explanation. The user may think something went wrong |
| 19 | Notice the scan input has been re-focused | 2 | Good: `scanInputRef.current?.focus()` fires. But on mobile, this may trigger the keyboard to reappear, covering the success message or the new interact view |
| 20 | Type or scan the NEXT QR code | 2 | |
| 21-... | Repeat steps 4-20 for each of the remaining 49 items | **5** | **THE CRITICAL FRICTION**: For every single item, the user must: scan, wait, search for part type (keyboard open/close dance), tap part type, potentially edit location, tap assign, scroll up to see success, scroll back down, scan next. If labeling 10 identical Arduino boards, the part type search+select happens 10 times identically. There is ZERO "repeat last" functionality |

**Journey C total**: ~20 steps per item, 50 items = ~1000 interactions.

**Critical friction**: (1) No "repeat last assignment" or sticky part type selection. (2) Location resets to default after every assignment. (3) Part type search on mobile requires keyboard dismiss to see results. (4) Banner feedback is at the wrong position. (5) No batch/multi-assign capability. (6) No camera-based QR scanning.

---

### Persona 2: Student Worker (Rapid Intake)

**Context**: Familiar user, daily usage. 30 new items arrived. Working fast: scan sticker, identify part, slap sticker, next. Some items are identical (10 Arduino boards).

#### Journey: Label 30 Items at Speed

| Step | Action | Friction (1-5) | Notes |
|------|--------|-----------------|-------|
| 1 | Open app, auto-authenticated | 1 | Token in localStorage, session restores |
| 2 | Scan first QR code | 2 | Must type manually or use hardware scanner |
| 3 | Tap "Open" | 1 | |
| 4 | Search for "Arduino" | **3** | Type "Arduino", keyboard covers results, dismiss keyboard, see results |
| 5 | Tap "Arduino Mega 2560" | 1 | |
| 6 | Tap "Assign QR" | 1 | Location is "Buffer Room A" -- probably correct for the intake table |
| 7 | **Scan second QR code (same Arduino)** | 2 | Must type/scan the code |
| 8 | Tap "Open" | 1 | |
| 9 | **Search for "Arduino" AGAIN** | **5** | The form has reset. `setAssignForm(defaultAssignForm)` clears everything. The part type search results have reverted to the default suggestion list. The user must re-type "Arduino" and re-select the same part type. FOR TEN IDENTICAL ITEMS. This is 10x the work it should be |
| 10 | Tap "Arduino Mega 2560" AGAIN | 1 | |
| 11 | Tap "Assign QR" | 1 | |
| 12-100 | Repeat for remaining 28 items | **5** | The dominant cost is the search-and-select cycle, repeated identically for each item of the same type |

**Speed analysis for 10 identical Arduinos**:

- Optimal (if "repeat last" existed): scan, tap assign. 2 taps x 10 = 20 taps.
- Current: scan, open, type "Arduino", dismiss keyboard, tap result, tap assign. 6 taps x 10 = 60 taps + 10 keyboard interactions.

**3x more work than necessary for the most common intake pattern.**

#### Error scenario: Wrong part type selected

| Step | Action | Friction (1-5) | Notes |
|------|--------|-----------------|-------|
| 1 | Realize wrong part type was assigned | -- | |
| 2 | Look for an "undo" button | **5** | There is none. There is no undo, no edit, no re-assign capability in the UI |
| 3 | The item is now permanently linked to the wrong part type | **5** | The only recovery path would be: (a) find the item in the database, (b) somehow change its part type -- but there is no UI for this. The interact mode only offers lifecycle events (moved, checked_out, etc.), not "change part type" |
| 4 | The actual recovery: create a merge or ask an admin | **4** | If the mistake created a new provisional type, an admin can merge it. If the user picked the wrong existing type, there is NO recovery path at all through the UI |

**Critical gap**: Wrong part type assignment is unrecoverable through the UI.

#### Error scenario: Wrong QR code scanned

| Step | Action | Friction (1-5) | Notes |
|------|--------|-----------------|-------|
| 1 | Scan wrong QR, assign it to a part | -- | The physical sticker is now on the wrong item |
| 2 | Look for a way to void or re-assign the QR | **5** | There is none. Once a QR is assigned, it cannot be voided or re-assigned through the UI. The QR status goes from "printed" to "assigned" and there is no reverse transition in the schema or the UI |

**Critical gap**: QR assignment is permanent and unrecoverable.

---

### Persona 3: Researcher (Checkout)

**Context**: Occasional user. Needs to check out 3 items, use them, return them later.

#### Journey A: Check Out 3 Items

| Step | Action | Friction (1-5) | Notes |
|------|--------|-----------------|-------|
| 1 | Open app, authenticate (may need to look up token again) | **3** | Occasional user may not have token saved. No "remember me" beyond localStorage |
| 2 | Scroll to scan input | **3** | On mobile, must scroll past hero + metrics. The scan input does auto-focus, but the visual page may not scroll to it |
| 3 | Scan first item's QR code | 2 | Type or hardware scan |
| 4 | Tap "Open" | 1 | |
| 5 | See the interact view | 2 | Entity card shows part type name, location, current state |
| 6 | Select "checked_out" from Event dropdown | 2 | The dropdown defaults to "moved" (first item in `availableActions`). User must open the dropdown and find "checked_out". On mobile, native select dropdown is usable |
| 7 | Set Next status to "checked_out" | **3** | The `nextStatus` field is a separate dropdown below the Event dropdown. It defaults to the current status (which is "available" for a new checkout). The user must ALSO change this to "checked_out". **This is confusing** -- the event type should imply the next status. Why must the user set both? |
| 8 | Type their name in the Assignee field | 2 | Manual text entry. No autocomplete, no dropdown of known users. The user must spell their name correctly every time |
| 9 | Optionally update Location | 1 | Pre-filled with current location. For checkout, the user might update it to their lab |
| 10 | Tap "Log event" | 1 | |
| 11 | See success banner (at top of page, invisible) | **4** | Same banner placement problem |
| 12 | See the interact view refresh (silent re-scan) | 2 | The entity card now shows "checked_out" state |
| 13-24 | Repeat for items 2 and 3 | **3** | Each checkout is 6-8 taps. No bulk checkout. If all 3 items are going to the same researcher in the same lab, the user must re-enter assignee and location 3 times |

**Journey A total**: ~24 steps for 3 items, 3 decision points per item.

**Critical friction**: (1) Event type and next status are independent dropdowns -- the user can set contradictory values (event = "checked_out", nextStatus = "available"). (2) No bulk checkout. (3) Assignee is a free-text field with no memory.

#### Journey B: Return 3 Items (days later)

| Step | Action | Friction (1-5) | Notes |
|------|--------|-----------------|-------|
| 1 | Open app | 1 | Session probably expired -- token has `expiresAt`. User must re-authenticate |
| 2 | Re-authenticate | **3** | Must find token again |
| 3-14 | Scan each item, select "returned", submit | 2 per item | Similar to checkout but fewer fields. "returned" event should auto-set status to "available" |
| 15 | **But wait**: does the user need to change nextStatus to "available"? | **3** | The form pre-fills nextStatus with the current status ("checked_out"). If the user just selects "returned" event and submits without changing nextStatus, the event is logged but the status might remain "checked_out" depending on server logic. The UI does not auto-update nextStatus when event type changes |

**Critical friction**: Event type selection does not auto-update the next status dropdown. The user can log a "returned" event but leave the status as "checked_out", creating an incoherent state.

---

### Persona 4: Admin (Cleanup -- Merge 15 Provisionals)

**Context**: 15 provisional part types accumulated during a busy intake week. Admin needs to review each, find canonical match, merge.

#### Journey: Merge 15 Provisional Types

| Step | Action | Friction (1-5) | Notes |
|------|--------|-----------------|-------|
| 1 | Open app, authenticate | 1 | |
| 2 | Scroll to "Canonicalize provisional types" panel | **4** | On mobile, this panel is the THIRD panel in the layout. User must scroll past: hero, metrics, batch registration panel, entire scan panel (which may include a long assignment form or interact view from a previous scan). This could be 8-10 screen-heights of scrolling |
| 3 | Open "Provisional source" dropdown | 2 | All 15 provisional types are in a native `<select>` dropdown. On mobile, this opens the OS picker. Scrollable, but the names are terse: "arduino mega - electronics". May be hard to distinguish similar entries |
| 4 | Select first provisional type | 1 | |
| 5 | Type search query in "Find canonical destination" | **3** | Same keyboard-covers-results problem. The picker buttons appear below the search field. On mobile with keyboard open, they are invisible |
| 6 | Dismiss keyboard, scroll to see results | **3** | Wasted motion |
| 7 | Find and tap the canonical destination | 2 | The picker shows all matching part types as buttons. If there are many similar names, distinguishing them requires reading both name and category on small buttons |
| 8 | Tap "Merge provisional type" | 1 | |
| 9 | **No confirmation dialog** | **4** | Merge is destructive -- it DELETES the source part type and repoints all entities. There is no "Are you sure?" dialog. One wrong tap merges the wrong types with no undo |
| 10 | See success banner (at top of page) | **4** | Same placement problem. The merge panel is far down the page |
| 11 | Notice the provisional dropdown has refreshed | 2 | `loadAuthenticatedData()` fires, which refreshes the provisional list. Good |
| 12 | The merge destination picker has also reset | **3** | After merge, `mergeSourceId` and `mergeDestinationId` are cleared. But `mergeSearch` state is also refreshed. If the admin was working through a batch of similar types, they lose their search context |
| 13-180 | Repeat for remaining 14 provisionals | **5** | 12 steps per merge x 15 merges = 180 interactions. Each merge requires: select source, search destination, tap destination, tap merge, scroll up for banner, scroll back down. No batch merge, no side-by-side comparison, no "skip" or "mark as genuinely new" |

**Journey total**: ~180 steps for 15 merges.

**Critical friction**: (1) No confirmation dialog on destructive merge. (2) No batch merge. (3) Panel position requires heavy scrolling. (4) No "mark as confirmed new" action for genuinely new provisional types. (5) No preview of what entities will be affected by the merge. (6) The search context resets between merges.

---

### Persona 5: Anyone (Error Recovery)

#### Scenario A: Wrong Part Type Selected

- **Current state**: The part type is permanently bound. The interact mode shows lifecycle events only, not "reassign" or "change part type."
- **Recovery path**: None through the UI. Requires database surgery or, if a new provisional was created, an admin merge (which is a workaround, not a fix).
- **Severity**: BLOCKING for correctness.

#### Scenario B: Wrong QR Scanned

- **Current state**: The wrong physical sticker is now associated with this inventory entry. The correct sticker might not even be registered yet.
- **Recovery path**: None through the UI. No void/reassign QR capability exists.
- **Severity**: BLOCKING for correctness.

#### Scenario C: Accidentally Marked Something Consumed

- **Current state**: Instance status is "consumed." The `availableActions` for an interact scan may still include "moved" or "returned," but the semantic damage is done -- the event log shows a consumption.
- **Recovery path**: Theoretically, the user could log a "returned" or "moved" event to change the status back. But the event log now contains a false "consumed" entry that cannot be deleted. The audit trail is corrupted.
- **Severity**: PAINFUL. Partial workaround exists but the audit trail is permanently incorrect.

#### Scenario D: Phone Lost Connection Mid-Form-Fill

- **Current state**: The user has filled out the assignment form (selected part type, set location, etc.) but hasn't submitted yet.
- **What happens**: If the user taps "Assign QR" while offline, the `fetch` call will throw a network error. The `handleAssign` catch block will set `setError(errorMessage(caught))`, which will display "Failed to fetch" or similar at the top of the page.
- **Recovery**: The form state is preserved (the assignment form values remain). The user can retry by tapping "Assign QR" again once connectivity returns.
- **BUT**: If the connection drops during `loadAuthenticatedData()` after a successful assignment, the form will have already been reset (`setAssignForm(defaultAssignForm)`) and the success state will be shown, but dashboard data won't refresh. This is a partial success state that may confuse the user -- did it work?
- **Severity**: ANNOYING. Form state preservation on retry is good. Partial success visibility is poor.

#### Scenario E: Token Expires Mid-Session

- **Current state**: User is working, token expires on Part-DB side.
- **What happens**: Next API call returns 401. `handleApiFailure` catches it, clears token, resets ALL state, drops user to login.
- **Impact**: Any in-progress form data is lost. If the user had typed a long note or was mid-assignment, all that work is gone.
- **Severity**: PAINFUL. No graceful degradation, no "save draft" concept.

---

## Part 2: Friction Inventory

### BLOCKING (Cannot Complete the Task)

| # | Friction Point | Affected Personas | Location |
|---|---------------|-------------------|----------|
| B1 | No way to correct a wrong part type assignment | Student, Anyone | `handleAssign` -- no reverse flow |
| B2 | No way to void or re-assign a QR code | Student, Anyone | QR status is one-way: printed -> assigned |
| B3 | No camera-based QR scanning | All phone users | `scanCode` is a text input only |

### PAINFUL (Can Complete but With Significant Suffering)

| # | Friction Point | Affected Personas | Location |
|---|---------------|-------------------|----------|
| P1 | No "repeat last part type" for identical items | Student Worker | `setAssignForm(defaultAssignForm)` resets everything after each assignment |
| P2 | Location resets to "Buffer Room A" after every assignment | All labelers | `defaultAssignForm.location` is hardcoded |
| P3 | Event type does not auto-set next status | Researcher | `eventForm` -- event and nextStatus are independent |
| P4 | Success/error banners render at page top, far from the triggering action | All personas | `{message ? <p className="banner success">...}` at line 662, before all panels |
| P5 | No confirmation dialog on destructive merge | Admin | `handleMergePartTypes` fires immediately |
| P6 | Part type search results hidden by mobile keyboard | All labelers | Picker renders below search input; keyboard occludes it |
| P7 | Merge panel requires 8-10 screen-heights of scrolling on mobile | Admin | Panel is third in `<main className="layout">` |
| P8 | No undo for any operation | All | No undo mechanism exists anywhere |
| P9 | Auth expiry drops all in-progress form state with no warning | All | `handleApiFailure` resets everything |
| P10 | No batch/bulk operations for checkout, return, or labeling | Researcher, Student | Each item requires a full individual flow |

### ANNOYING (Noticeable Friction, Workarounds Exist)

| # | Friction Point | Affected Personas | Location |
|---|---------------|-------------------|----------|
| A1 | No preview of QR code range before batch registration | Lab Manager | Batch form has no preview |
| A2 | Start number does not auto-increment after batch registration | Lab Manager | `batchForm` is not updated after success |
| A3 | Post-assignment visual transition is jarring (label -> interact mode with no animation) | All labelers | Silent re-scan replaces form content |
| A4 | Assignee field is free-text with no autocomplete or memory | Researcher | `eventForm.assignee` is a plain input |
| A5 | Merge search context resets between merges | Admin | `mergeSourceId` and `mergeDestinationId` cleared |
| A6 | No indication of which provisionals are genuinely new vs. duplicates | Admin | No "confirm as new" action |
| A7 | Dashboard metrics bar consumes significant vertical space on mobile for little operational value | All | 5 metric cards stacked vertically at 900px |
| A8 | Part-DB resource discovery info consumes space but is not actionable | All | Resource list at bottom of recent events panel |
| A9 | Recent events panel shows global events, not scoped to current task | All | Dashboard recent events are system-wide |
| A10 | No loading spinner or skeleton during initial data fetch | All | Dashboard shows 0/null until data arrives |
| A11 | Event form "Notes" textarea has a 5.5rem minimum height, taking significant space on mobile | All | `textarea { min-height: 5.5rem }` |
| A12 | No haptic or audio feedback on successful scan/assignment (phone UX expectation) | All | Pure visual feedback only |

### MINOR (Cosmetic or Edge-Case)

| # | Friction Point | Affected Personas | Location |
|---|---------------|-------------------|----------|
| M1 | Login help text mentions Part-DB tokens but offers no link to Part-DB | New users | Login panel copy |
| M2 | "Canonicalize provisional types" is jargon | Non-technical users | Panel title |
| M3 | `status-card` button style (logout) looks the same as primary action buttons | All | CSS: buttons have uniform dark gradient |
| M4 | `createdAt` timestamps in event list are raw ISO strings, not human-readable | All | `stockEvent.createdAt` rendered as-is |
| M5 | Error messages show raw error codes like "parse_input: ..." | All | `errorMessage()` includes the code prefix |
| M6 | No visual distinction between instance and bulk in the picker | Labelers | Picker buttons show name + category but not countable/type |
| M7 | Picker buttons have `flex: 1 1 180px` which may create awkward orphan buttons on some widths | All | CSS `.picker button` |

---

## Part 3: Missing Flows

| # | Missing Flow | Impact | Who Needs It |
|---|-------------|--------|--------------|
| MF1 | **Camera QR scanning** | Without this, the app requires a hardware Bluetooth scanner or manual code typing. The fundamental promise of "scan sticker, take action" is broken on a bare phone | All phone users |
| MF2 | **Reassign/correct part type** | If a wrong part type is assigned, there is no way to fix it | Student, Admin |
| MF3 | **Void/re-assign QR code** | If a QR sticker is damaged, misapplied, or wrong, it cannot be freed for reuse | All |
| MF4 | **Bulk label (assign N items to same type)** | Labeling identical items one-by-one is the dominant friction for intake | Student, Lab Manager |
| MF5 | **Bulk checkout/return** | Researchers checking out 5 items for the same project must do 5 independent flows | Researcher |
| MF6 | **Scan history / "last 10 scans" list** | If the user scans 10 items, they cannot revisit a previous one without physically finding and re-scanning the sticker | All |
| MF7 | **Confirm provisional as genuinely new** | Admins can only merge provisionals; there is no "this is correct, mark it as canonical" button | Admin |
| MF8 | **Undo last action** | No undo exists for any operation | All |
| MF9 | **Search/browse all inventory** | There is no way to look up items except by scanning their QR code. No inventory list, no search-by-name, no filtering | All |
| MF10 | **Offline support / queue** | A phone in a large warehouse may have spotty connectivity. No offline queue exists | All |
| MF11 | **Location autocomplete** | Location is a free-text field that must be typed each time. No memory of previously used locations | All |
| MF12 | **Event type -> status auto-derivation** | When user selects "checked_out" event, the nextStatus should auto-set to "checked_out" | Researcher |

---

## Part 4: Quick Wins

These are friction points that could be fixed with small, low-risk changes:

| # | Quick Win | Fixes | Effort |
|---|-----------|-------|--------|
| QW1 | **Move success/error banners to a fixed-position toast at the bottom of the viewport** | P4 | CSS change + minor frontend refactor. Add `position: fixed; bottom: 1rem; left: 50%; transform: translateX(-50%)` with auto-dismiss timer |
| QW2 | **Persist last-used part type and location in `sessionStorage`; pre-fill on next label scan** | P1, P2 | ~20 lines. After successful assignment, save `{ partTypeId, location }` to sessionStorage. On next label mode, pre-select that part type and pre-fill that location. Add a visible "Same as last" shortcut button |
| QW3 | **Auto-derive nextStatus/nextLevel from event type selection** | P3 | ~15 lines in the `onChange` handler for the event dropdown. When event is "checked_out", set nextStatus to "checked_out". When "returned", set to "available". When "consumed", set to "consumed". Etc. |
| QW4 | **Auto-increment batch start number after successful registration** | A2 | 1 line: after batch success, `setBatchForm(c => ({...c, startNumber: c.startNumber + c.count}))` |
| QW5 | **Add confirmation dialog before merge** | P5 | ~10 lines. `if (!confirm(\`Merge "${sourceName}" into "${destName}"? This cannot be undone.\`)) return;` |
| QW6 | **Format timestamps as relative time ("2 min ago") instead of raw ISO** | M4 | Use `Intl.RelativeTimeFormat` or a tiny helper function |
| QW7 | **Collapse metrics bar into a single horizontal-scroll strip on mobile** | A7 | CSS: `overflow-x: auto; flex-wrap: nowrap` on mobile, reduce height |
| QW8 | **Hide Part-DB resource discovery section behind an expandable disclosure** | A8 | Wrap in a `<details>` element |
| QW9 | **Add a "Confirm as canonical" button to the merge panel for genuinely new provisionals** | A6, MF7 | Add a button that calls a new endpoint to set `needs_review = false` without merging. ~30 lines frontend + backend |
| QW10 | **Add a link to Part-DB on the login screen** | M1 | 1 line of HTML |
| QW11 | **Add debounce (200-300ms) to part type search** | Reduces unnecessary API calls | ~10 lines with a `useRef` timer pattern |

---

## Part 5: Structural Issues

These require rethinking the information architecture:

| # | Structural Issue | What Must Change |
|---|-----------------|------------------|
| S1 | **Single-page scroll layout is wrong for mobile operational use** | The app needs a **tab/screen-based** navigation pattern. Core screens: (1) Scan + Act (the 90% screen), (2) Batch Admin, (3) Merge Admin, (4) Dashboard/Audit. On a phone, only the Scan screen should be visible during intake. The batch and merge panels should be separate screens. The metrics and recent events should be a separate dashboard screen. This eliminates all scrolling friction |
| S2 | **No camera QR scanning** | This is architectural because it requires integrating a camera scanning library (e.g., `html5-qrcode`, `@zxing/library`), managing camera permissions, and handling the scan-to-input bridge. This is the single highest-impact change for phone usability |
| S3 | **Assignment is a one-shot, uncorrectable operation** | The domain model needs a "reassign" or "correct" flow. Options: (a) add a "reassign part type" event, (b) add a "void QR" action that returns it to "printed" status, (c) add an admin "edit entity" screen. This requires schema changes and new API endpoints |
| S4 | **No offline/queued operation model** | For warehouse use, the app needs a service worker and a local queue that syncs when connectivity returns. This is a significant architectural addition |
| S5 | **The assign form has too many fields for the common case** | The form shows 8+ fields (search, location, kind, status/level, canonical name, category, countable, notes) when the common case needs 2: (1) select part type, (2) tap assign. The form needs progressive disclosure: show only search + assign by default, with an "Advanced" toggle for the rest |
| S6 | **Global state management via 15+ `useState` hooks is fragile** | The component has 17 state variables, multiple refs, and complex interdependencies. This should be extracted into a state machine (XState) or at minimum a reducer. This would make the FSM transitions documented in `fsm-audit.md` enforceable in code rather than implicit |
| S7 | **Search picker ergonomics on mobile** | The picker pattern (search field + list of buttons below) fundamentally conflicts with the mobile keyboard. Solutions: (a) full-screen search modal that opens when search is focused, with results above the keyboard, (b) combobox pattern where results appear as a dropdown overlay |

---

## Part 6: Priority Ranking -- Top 10 Most Impactful Improvements

Ranked by (number of affected users) x (frequency of occurrence) x (severity of friction).

| Rank | Improvement | Fixes | Impact |
|------|-------------|-------|--------|
| **1** | **Camera QR scanning integration** | B3, MF1 | Transforms the app from "requires hardware scanner" to "works with any phone." This is the single feature that determines whether the app is usable by non-expert operators. Without it, the app's core promise ("scan sticker, take action on a phone") is false |
| **2** | **"Repeat last" / sticky part type + location** | P1, P2, MF4 | Cuts the per-item interaction count by ~60% during bulk intake. This is the dominant friction for the most common workflow (labeling many items of the same type). Implementation: persist last assignment config, add "Same as last" one-tap button |
| **3** | **Tab-based navigation instead of single-page scroll** | S1, P7, A7, P4 | Eliminates all scrolling friction. The scan screen becomes a clean, focused single-screen experience. Admin functions move to their own screens. Banners appear in context. Every interaction on every flow benefits from this |
| **4** | **Auto-derive next status from event type** | P3, MF12 | Prevents incoherent state (e.g., "returned" event with "checked_out" status). Reduces cognitive load for every event recording. Makes the checkout/return flow feel obvious instead of error-prone |
| **5** | **Error assignment recovery (reassign part type, void QR)** | B1, B2, S3, P8 | Without this, every mistake during intake requires database surgery. In a busy makerspace with student workers, mistakes are frequent. This is a correctness issue, not just a UX issue |
| **6** | **Inline toast notifications (fixed-position, auto-dismissing)** | P4 | Affects every single mutation in the app. Currently, success/error feedback is invisible after every action on mobile. This is ~5 minutes of CSS work with enormous payoff |
| **7** | **Progressive disclosure on the assign form** | S5, A11 | The assign form shows 8+ fields when 2 are needed. Hiding advanced fields behind a toggle reduces cognitive load and makes the form scannable at a glance on a phone. The common path becomes: pick type, tap assign |
| **8** | **Full-screen search modal for part type picker (mobile)** | P6, S7 | The keyboard-covers-results problem makes the most critical step (finding a part type) the most frustrating step. A full-screen modal with results above the keyboard solves this completely |
| **9** | **Confirmation dialog on destructive actions (merge, consumed, disposed)** | P5, MF8 | Merge deletes data. "consumed" and "disposed" are semantically irreversible. A simple `confirm()` dialog prevents accidental irreversible actions at near-zero cost |
| **10** | **Location autocomplete from previously used locations** | A11, MF11 | Location is typed from scratch every time. After the first few uses, the system knows all valid locations. An autocomplete dropdown eliminates typos and saves time on every assignment and event |

---

## Appendix: Step Count Summary

| Flow | Steps per Unit | Units per Session | Total Steps | With Top 3 Fixes |
|------|---------------|-------------------|-------------|-------------------|
| Label 1 item (new type) | ~20 | 50 (setup day) | ~1000 | ~500 (camera + repeat + tabs) |
| Label 1 item (repeat type) | ~12 | 30 (daily intake) | ~360 | ~90 (repeat = 3 steps each) |
| Check out 1 item | ~8 | 3-5 | ~32 | ~20 (auto-derive + tabs) |
| Return 1 item | ~6 | 3-5 | ~24 | ~16 |
| Merge 1 provisional | ~12 | 15 (weekly cleanup) | ~180 | ~80 (tabs + confirmation) |
| Register 1 batch | ~9 | 4 (setup day) | ~36 | ~16 (auto-increment + tabs) |

The top 3 fixes (camera scanning, repeat-last, tab navigation) would reduce total interaction cost by approximately 50-70% across all personas.
