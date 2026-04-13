# User Flows

End-to-end documentation of every user flow in Smart DB, traced through both frontend and backend.

Note:
- This doc now describes the current vanilla TypeScript frontend runtime.

## 1. Authentication

The entry point is `apps/frontend/src/main.ts`, which boots the rewrite controller and immediately calls `GET /api/auth/session` to check for an existing Smart DB session cookie.

**No session**: The user sees a login screen with a single "Continue With SSO" control.

**Login flow**:
1. User clicks "Continue With SSO"
2. Browser navigates to `GET /api/auth/login?returnTo=...`
3. Middleware creates a signed auth-request cookie, generates `state` / `nonce` / PKCE verifier, and redirects to Zitadel
4. Zitadel authenticates the user and redirects back to `GET /api/auth/callback`
5. Middleware exchanges the authorization code, verifies the returned `id_token` against Zitadel JWKS, creates a server-side session, and sets an opaque session cookie
6. Browser is redirected back to the requested Smart DB URL and `loadAuthenticatedData()` fetches dashboard, Part-DB status, provisional part types, and the default part-type catalog in parallel

**Session restore**: As long as the session cookie is valid, `GET /api/auth/session` returns the authenticated user and the app skips the login shell.

**Global auth guard**: Every API call can still return `unauthenticated`. The frontend's `handleApiFailure()` resets all state and drops the user back to login. No browser-held bearer token is cleared because Smart DB now relies on an opaque cookie session.

---

## 2. Dashboard (the authenticated home)

Once authenticated, the user sees:
- **Header**: Signed-in username, Part-DB connection status (linked/degraded), sync status when applicable, logout button
- **Metrics bar**: Part type count, instance count, bulk bin count, provisional count, unassigned QR count — all from `GET /api/dashboard`, which runs 5 aggregate `COUNT(*)` queries against SQLite
- **Four panels**: QR Batch Registration, Scan, Merge, Recent Events

All data refreshes after every mutation via `loadAuthenticatedData()`.

---

## 3. QR Batch Registration

**Purpose**: Before any physical labeling can happen, QR sticker ranges must be pre-registered. This establishes which codes the system recognizes.

**Flow**:
1. User fills in prefix (default `"QR"`), start number (default `1001`), and count (default `25`)
2. Submit calls `POST /api/qr-batches` with `{ prefix, startNumber, count }`
3. The route handler overrides `actor` with the authenticated username (the server always uses the session identity)
4. `InventoryService.registerQrBatch()` runs inside a transaction:
   - Creates a `qr_batches` row (`batch-{timestamp}` ID)
   - Loops from `startNumber` to `startNumber + count - 1`, inserting each code as `{prefix}-{number}` (e.g., `QR-1001`) into `qrcodes` with status `printed`
   - Uses `INSERT OR IGNORE` — if a code already exists, it's counted as `skipped`
5. Returns `{ batch, created, skipped }`
6. Frontend shows success banner: "Registered 500 QR codes in batch-123456. 0 were already present."

After this, those 500 QR codes exist in the system with status `printed` — ready to be scanned and assigned.

---

## 4. Scan (the central routing decision)

**Purpose**: Scanning a code is how the user enters every workflow. The middleware classifies the code and the frontend renders the appropriate form.

**Flow**:
1. User types or scans a code into the scan field and submits
2. Frontend calls `POST /api/scan` with `{ code }`
3. `InventoryService.scanCode()` looks up the code in `qrcodes`:

### Outcome A — `"unknown"` mode
The code doesn't exist in `qrcodes`. This means either:
- It's a manufacturer barcode (not a Smart DB QR)
- The QR hasn't been batch-registered yet
- The QR was voided

Frontend shows: "{code} is unknown to Smart DB" with a Part-DB lookup summary.

**Dead end** — the user must register a QR batch containing this code first, or scan a different code.

### Outcome B — `"label"` mode
The code exists with status `printed` (registered but unassigned). This triggers the **intake flow**.

The middleware returns:
- The `qrCode` object
- `suggestions`: the 12 most recently updated part types (from `searchPartTypes("")`)
- Part-DB lookup summary

Frontend:
- Auto-populates `assignForm.qrCode` with the scanned code
- Initializes `labelSearch` results with the suggestions from the server
- Renders the **assignment form** (see flow 5 below)

### Outcome C — `"interact"` mode
The code exists with status `assigned`. This triggers the **lifecycle flow**.

The middleware:
- Follows the QR's `assignedKind` + `assignedId` to look up the `physical_instances` or `bulk_stocks` row, JOINed with `part_types`
- Fetches the last 8 `stock_events` for that entity
- Returns the entity summary, recent events, and `availableActions` (different for instances vs. bulk)

Frontend:
- Shows the entity card: part type name, QR code, location, current state
- Auto-populates `eventForm` with the entity's target type, ID, current location, and current status/level
- Renders the **event form** (see flow 6 below)
- Shows the event history timeline below the form

---

## 5. Assignment (label mode — QR gets its identity)

**Purpose**: This is the core intake path. A pre-registered QR sticker gets permanently bound to an inventory entity.

**Flow**:
1. After scanning triggers `"label"` mode, the user sees the assignment form pre-filled with the QR code
2. The user must choose a part type — two options:
   - **Pick existing**: A predictive search field queries `GET /api/part-types/search?q=...` as the user types. Results are rendered as selectable buttons. Clicking one sets `partTypeMode: "existing"` and auto-sets `entityKind` based on the part type's `countable` flag (countable → instance, non-countable → bulk)
   - **Create new (provisional)**: Type a canonical name in the "New canonical name" field. This switches to `partTypeMode: "new"`. The user also fills category and countable
3. The user sets location, entity kind (instance or bulk), and initial status/level
4. Submit calls `POST /api/assignments` — the route handler overrides `actor` with the session username
5. `InventoryService.assignQr()`:
   - Validates the QR is in `printed` status (409 Conflict if already assigned)
   - Resolves the part type: if `kind: "new"`, creates a new `part_types` row with `needs_review = true` (provisional)
   - Enforces compatibility: countable part types can only be instances, non-countable can only be bulk
   - Runs a transaction:
     - Inserts a `physical_instances` or `bulk_stocks` row with a new UUID
     - Updates the QR code status from `printed` → `assigned` and sets `assigned_kind`/`assigned_id`
     - Inserts a `labeled` stock event (the first event in the entity's lifecycle)
   - Returns the entity summary
6. Frontend:
   - Shows success: "Assigned QR-1001 to inventory"
   - Immediately re-scans the same code (silent scan) — the result will now be `"interact"` mode, showing the newly created entity
   - Refreshes all dashboard data
   - Focuses the scan input for the next code

**The key insight**: After assignment, the QR is now a permanent handle to an inventory entity. Every future scan of that code enters interact mode.

---

## 6. Event Recording (interact mode — lifecycle updates)

**Purpose**: Once an entity exists, its lifecycle is managed through events. Events update the entity's state and create an audit trail.

**Flow**:
1. After scanning triggers `"interact"` mode, the user sees the entity card and the event form
2. The form is pre-filled with:
   - `targetType` and `targetId` from the entity
   - Current location
   - Current status (instances) or level (bulk)
3. The user selects an event from the `availableActions` dropdown:

   **For instances** (PhysicalInstance):
   - `moved` — changes location only, status stays the same
   - `checked_out` — status → `checked_out`, sets assignee (defaults to the actor)
   - `returned` — status → `available`, clears assignee
   - `consumed` / `disposed` — status → `consumed`, clears assignee
   - `damaged` — status → `damaged`, clears assignee
   - `lost` — status → `lost`, clears assignee

   **For bulk** (BulkStock):
   - `moved` — changes location only
   - `level_changed` — updates level to the `nextLevel` value from the form
   - `consumed` — updates level (defaults to `low` if no explicit level given)

4. Submit calls `POST /api/events` — actor is overridden with the session username
5. `InventoryService.recordEvent()`:
   - Loads the current entity to get the `fromState`
   - Computes the `toState` based on event type (the switch statement above)
   - Runs a transaction:
     - Updates the entity row (status/level, location, assignee, updated_at)
     - Inserts a `stock_events` row recording from→to state, actor, notes, timestamp
   - Returns the newly created `StockEvent`
6. Frontend:
   - Shows success: "Logged moved for instance abc-123"
   - Silent re-scan to refresh the entity card (state, events)
   - Refreshes dashboard
   - Focuses scan input for next action

**The audit trail**: Every event is append-only. The `stock_events` table is a complete history. Counts and current state are derived from the latest state on the entity row, not from counting events.

---

## 7. Part Type Merge (admin cleanup)

**Purpose**: During fast intake, labelers may create provisional part types (e.g., "arduino mega" when "Arduino Mega 2560" already exists). The merge flow lets an admin consolidate them.

**Flow**:
1. The "Canonicalize provisional types" panel shows:
   - A dropdown of all provisional part types (`needs_review = true`)
   - A separate predictive search (independent from the label search — they have their own abort controllers and request ordering)
2. User selects a provisional source from the dropdown
3. User searches for and clicks the canonical destination
4. Submit calls `POST /api/part-types/merge` with `{ sourcePartTypeId, destinationPartTypeId }`
5. `InventoryService.mergePartTypes()`:
   - Loads both part types (404 if either is missing)
   - Merges aliases: destination keeps its aliases + gets the source's canonical name as an alias + all source aliases
   - Runs a transaction:
     - Repoints all `physical_instances` from source to destination (`UPDATE ... SET part_type_id = ?`)
     - Repoints all `bulk_stocks` from source to destination
     - Updates destination: merged aliases, `needs_review = 0`, new timestamp
     - Deletes the source part type entirely
   - Returns the updated destination PartType
6. Frontend shows: "Merged provisional part type into canonical record" and refreshes

**After merge**: All entities that were under the source now belong to the destination. The source's name is preserved as an alias so future searches still find it.

---

## 8. Part-DB Status (read-only)

The "Recent events" panel also shows discovered Part-DB resources (parts path, part lots path, storage locations path). This comes from `GET /api/partdb/status`, which calls `PartDbClient.getConnectionStatus()` using the middleware-side Part-DB service token — it reads Part-DB's `/api/docs.json` to discover API resource paths. This is informational only; no writes go to Part-DB yet.

---

## Data flow summary

```
Phone scan → POST /api/scan → classify code
                                  ↓
              ┌───────────────────┼───────────────────┐
              ↓                   ↓                   ↓
          "unknown"           "label"            "interact"
         (dead end)      (intake form)       (lifecycle form)
                              ↓                       ↓
                    POST /api/assignments    POST /api/events
                              ↓                       ↓
                    [QR: printed→assigned]   [entity state updated]
                    [entity created]         [event appended]
                    [labeled event]
                              ↓                       ↓
                         re-scan ──────────→ "interact" mode
```

Every mutation is attributed to the authenticated Part-DB user (never to a browser form field), wrapped in a SQLite transaction, and backed by an append-only event.
