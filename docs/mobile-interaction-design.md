# Smart DB Mobile Interaction Design Report

Prepared for the Smart DB makerspace inventory system. This report analyzes the physical interaction model of the current frontend and specifies the changes needed to make it a best-in-class mobile scanning app.

---

## 1. CAMERA INTEGRATION SPEC

### 1.1 Current State

The pre-rewrite scan input was a plain `<input>` element with a submit button. The user had to manually type a code like `QR-1042`. On a phone, this meant: tap the field, wait for keyboard, type 7+ characters accurately, tap "Open." For the primary interaction of a scanning app, this was catastrophically slow.

### 1.2 Recommended Library: html5-qrcode (or BarcodeDetector API with polyfill)

**Primary recommendation: progressive enhancement with `BarcodeDetector` API + `html5-qrcode` fallback.**

Rationale for the layered approach:

| Option | Pros | Cons |
|--------|------|------|
| **BarcodeDetector API** (native) | Zero bundle cost, hardware-accelerated, fastest decode, supported on Chrome Android 83+, Safari 17.2+ | Not available on Firefox, older Safari. No iOS Safari before 17.2. |
| **html5-qrcode** (wrapper around zxing-js) | Broad browser support, handles camera lifecycle, ~45KB gzipped, active maintenance | Heavier than native, JavaScript decode is slower than hardware |
| **zxing-js** (raw) | Full barcode format support | Requires manual camera lifecycle management, large bundle |
| **js-qr** | Tiny (~20KB), simple API | QR only, no EAN/UPC, requires manual camera management |

**Implementation strategy:**

```
if ('BarcodeDetector' in window) {
  // Use native BarcodeDetector with getUserMedia
  // Formats: ['qr_code', 'ean_13', 'upc_a', 'code_128']
} else {
  // Fall back to html5-qrcode
  // This covers Firefox, older iOS Safari
}
```

This keeps the bundle lean for the majority of mobile users (Chrome Android + Safari 17.2+) while maintaining universal compatibility.

### 1.3 Barcode Format Support

The system mentions manufacturer barcodes in the unknown-code flow. Support these formats:

| Format | Use Case | Priority |
|--------|----------|----------|
| QR Code | Smart DB stickers (primary) | Required |
| EAN-13 | European manufacturer barcodes on components | Required |
| UPC-A | US manufacturer barcodes | Required |
| Code 128 | Shipping labels, industrial barcodes | Nice to have |
| Data Matrix | Small PCB component labels | Future |

### 1.4 Permission Flow

**First-time camera access:**

1. User taps the Scan button (large, prominent, see section 5).
2. Before requesting `getUserMedia`, show a brief inline explanation: "Smart DB needs camera access to scan QR stickers." This sets up the browser's permission dialog with context.
3. Call `navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })`.
4. If granted: open viewfinder immediately. Store the permission state in `localStorage` so future sessions skip the explanation.
5. If denied: show an inline recovery card with two options:
   - "Open device settings" (deep-link where possible, or instructions)
   - "Type code manually" (reveals the text input, auto-focused)
6. If `NotAllowedError` (user dismissed without choosing): show the explanation again with a "Try again" button.

**Returning users:** Skip the explanation, go directly to viewfinder. The browser remembers the permission grant.

**HTTPS requirement:** `getUserMedia` requires a secure context. The Vite dev server at `http://localhost:5173` works, but production MUST be HTTPS. Add a check on mount:

```typescript
if (location.protocol !== 'https:' && location.hostname !== 'localhost') {
  // Show warning: "Camera scanning requires HTTPS"
}
```

### 1.5 Scanner UX: Hybrid Viewfinder

**Not full-screen. Not a tiny button. A collapsible viewfinder panel.**

The viewfinder should be:
- **Positioned at the top of the scan flow**, replacing the current text input + button when active.
- **Height: 45vh** (approximately 300px on an iPhone SE, 360px on iPhone 14). This leaves room below for the result card / assignment form.
- **Aspect ratio: unconstrained width, constrained height.** Let it fill the available width minus padding.
- **Viewfinder overlay:** A subtle bracket/crosshair in the center. Not a full box -- just four corner brackets. This communicates "point here" without obscuring the view.
- **Torch toggle:** A small flashlight icon in the bottom-right corner of the viewfinder. Makerspaces have inconsistent lighting; this is essential.
- **Camera flip:** A small camera-flip icon in the bottom-left. Rarely needed (environment camera is default) but required for accessibility.

**State transitions:**

```
[Scan Tab Active] --> tap "Scan" button --> [Viewfinder Open, camera streaming]
[Viewfinder Open] --> QR detected --> [Viewfinder stays open, result slides up from below]
[Result visible] --> tap "Scan Next" --> [Result clears, viewfinder refocuses]
[Viewfinder Open] --> tap "Type manually" --> [Viewfinder closes, text input appears]
[Viewfinder Open] --> tap X or navigate away --> [Viewfinder closes, camera stream stops]
```

### 1.6 Continuous Scanning: Yes, With Cooldown

For rapid intake of 30 items, the camera MUST stay open between scans. Closing and reopening the camera between every item adds 1-2 seconds per cycle (camera initialization). Over 30 items, that's a full minute wasted.

**Continuous mode behavior:**
- After a successful decode, pause detection for 800ms (prevents double-scan of the same code).
- Show the decoded value in a toast overlay on the viewfinder (e.g., "QR-1042" with a green check).
- After 800ms, resume detection. If the same code is still in frame, ignore it. Only trigger on a *new* code.
- The result card / form slides up below the viewfinder simultaneously.

**Duplicate suppression:**
- Keep a `Set<string>` of the last 5 scanned codes with timestamps.
- If the same code is detected within 3 seconds, suppress it.
- If detected after 3 seconds, treat it as intentional re-scan.

### 1.7 Haptic and Audio Feedback

**On successful decode:**
- Haptic: `navigator.vibrate(50)` -- a single short pulse. Not a pattern, not long. Just a click.
- Audio: A short, clean beep (200ms, 880Hz sine wave). Pre-generate this with `AudioContext` rather than loading an audio file. Keep it under 1KB.
- Visual: Brief green flash on the viewfinder border (100ms CSS transition).

**On error (unknown code):**
- Haptic: `navigator.vibrate([50, 50, 50])` -- three short pulses.
- No audio (errors should not be punishing in a noisy makerspace).
- Visual: Brief red flash on the viewfinder border.

**User control:** Provide a setting to disable sound/vibration. Some makerspaces are quiet zones.

### 1.8 Manual Fallback

The text input MUST remain available for:
- Desktop browsers without cameras
- Users who denied camera permission and cannot recover
- Testing and development
- Scanning codes that are too damaged for camera decode but can be read by eye

**Placement:** Below the viewfinder, collapsed by default when camera is active. A "Type code manually" link at the bottom of the viewfinder expands it. On desktop (detected via `matchMedia('(hover: hover)')` or absence of camera), the text input is the default and the viewfinder is hidden behind a "Use camera" button.

### 1.9 Lighting and Focus Considerations

**Torch API:**
```typescript
const track = stream.getVideoTracks()[0];
const capabilities = track.getCapabilities();
if (capabilities.torch) {
  track.applyConstraints({ advanced: [{ torch: true }] });
}
```

This works on most Android devices. iOS Safari does not support the torch constraint as of early 2026, but the native camera handles exposure well enough.

**Focus/distance:**
- QR stickers on small objects: recommend QR codes be at least 15mm x 15mm.
- At arm's length (~30cm), this is resolvable by all modern phone cameras.
- The `BarcodeDetector` API works on individual video frames, so autofocus handles distance automatically.
- For very small or distant codes, use `<video>` constraints: `{ video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } } }`. Higher resolution means smaller QR codes are decodable.

**Makerspace lighting:**
- Metal shelving creates harsh shadows. The torch toggle handles this.
- Fluorescent lighting causes flicker on some cameras. Request 30fps minimum: `{ frameRate: { min: 30 } }`.
- Glossy sticker surfaces cause reflections. QR stickers should be matte finish (this is a physical recommendation, not a software one).

---

## 2. SCREEN LAYOUT ANALYSIS

### 2.1 Current Layout on a 375x667 Phone (iPhone SE)

Measuring the current CSS against a 375px viewport:

**Header/hero section (`.hero`):**
- At `max-width: 900px`, the media query fires and `.hero` goes to `grid-template-columns: 1fr` (single column).
- The `h1` at `clamp(2.3rem, 4vw, 4.3rem)` resolves to ~2.3rem = ~37px. With `line-height: 0.95` and the text "Fast intake, durable inventory." wrapping to ~2 lines, the h1 alone is ~70px.
- `.eyebrow` ("Smart DB"): ~18px height + margin.
- `.lede` paragraph: ~3 lines at 1.05rem, roughly 63px.
- `.status-card`: pill + paragraph + small + logout button. Approximately 120px.
- **Total hero height: ~290-320px.** That is 44-48% of the visible viewport consumed before any functional content.

**Metrics bar (`.metrics`):**
- Media query collapses to `grid-template-columns: 1fr`. Five metrics stack vertically.
- Each metric card: label (~18px) + number (~32px) + padding (2 x 16px) = ~82px.
- Five stacked: **~430px of metrics** (plus gaps). This alone exceeds the viewport height.

**Problem:** On mobile, the user must scroll past 750+ pixels of header and metrics before reaching the scan input. The most critical interaction element is completely below the fold.

**Panel layout (`.layout`):**
- Also collapses to single column. The four panels stack: QR Batch, Scan, Merge, Recent Events.
- QR Batch panel (admin task) appears BEFORE the scan panel.
- The scan input is approximately 800-900px from the top of the page on first load.

**Scan result + form after scanning:**
- The label-mode form contains: search input, picker grid, location, kind, initial status/level, canonical name, category, countable, notes, submit button. That is approximately 10-12 form fields in a 2-column grid that collapses to 1 column on mobile.
- After scanning, the result card renders INSIDE the scan panel. The form is roughly 1200-1400px from the top of the page.
- With the mobile keyboard open (~260px on iPhone), the visible area above the keyboard is ~407px. The form field the user tapped is likely not visible without scrolling.

### 2.2 Keyboard Interaction Analysis

When the user taps any input field on mobile:
- The keyboard occupies ~40% of the screen (260-280px on iPhone, 300px on Android).
- Remaining visible area: ~387-407px on iPhone SE.
- iOS Safari also has a toolbar bar (~44px), leaving ~343px of actual content.
- The part-type search input is inside the scan panel, which is inside the layout, which is below the hero and metrics. When the keyboard opens, the browser scrolls to make the focused input visible, but the picker results below the input are likely pushed off-screen. The user types a search query but cannot see the results without dismissing the keyboard or scrolling.

**This is a critical usability failure for the hot path.**

### 2.3 Content Below the Fold at Initial Load

On a 375x667 phone, only the header (hero) is visible on initial load. Everything else -- metrics, all four panels, all forms -- requires scrolling. The user has zero indication of what the app does or what to do next without scrolling.

### 2.4 Proposed Mobile Layout

Completely restructure the mobile layout:

```
+----------------------------------+
| [Smart DB]    [Status] [Logout]  |  <- Compact header: 48px
+----------------------------------+
| [ Metrics: horizontal scroll ]   |  <- Optional, swipeable: 64px
+----------------------------------+
|                                  |
|     [  Camera Viewfinder  ]      |  <- 45vh viewfinder
|     [    or Scan Input    ]      |
|                                  |
+----------------------------------+
|  [Scan Result / Form Area]       |  <- Scrollable content area
|  (Part type picker, fields)      |
|                                  |
+----------------------------------+
| [Scan]    [History]    [Admin]   |  <- Fixed bottom nav: 56px
+----------------------------------+
```

Key changes:
1. **Header collapses to a single line** (48px): "Smart DB" left, status pill center, logout button right.
2. **Metrics become a horizontal scroll strip** (64px), or are removed entirely from the scan view and placed in a dashboard tab.
3. **Scan is the first and primary content**, not the second panel.
4. **Bottom navigation** with three tabs: Scan (primary), History (recent events), Admin (QR batches, merge). The scan tab is always the default.
5. **QR Batch and Merge panels** are moved entirely out of the scan flow and into the Admin tab.

---

## 3. TOUCH TARGET AUDIT

### 3.1 Apple's Minimum: 44x44 Points. Google's: 48x48dp.

Every interactive element analysis:

#### Buttons (general)

**Current CSS (line 200-205, 212-216):**
```css
input, select, textarea, button {
  border-radius: 0.85rem;
  border: 1px solid rgba(34, 54, 83, 0.14);
  padding: 0.8rem 0.9rem;
}
```

Padding of 0.8rem = 12.8px top/bottom. With font-size inherited at ~16px and line-height 1.5, the content height is 24px. Total height: 24 + 12.8 + 12.8 = ~50px. **PASS** for height.

Width depends on content, but buttons like "Open" next to the scan input have minimal text. With padding 0.9rem = 14.4px left/right, the "Open" button is approximately: "Open" text width (~40px) + 28.8px padding = ~69px wide. **PASS**.

#### Picker Buttons (`.picker button`)

**Current CSS (line 224-231):**
```css
.picker button {
  flex: 1 1 180px;
  text-align: left;
  min-height: 4.2rem;   /* 67.2px */
  background: rgba(255, 255, 255, 0.92);
  color: #132033;
  border: 1px solid rgba(34, 54, 83, 0.12);
}
```

`min-height: 4.2rem` = 67.2px. **PASS** for height.

`flex: 1 1 180px` means each button is at least 180px wide on a 375px screen. With container padding (~20px each side), available width is ~335px. Two buttons of 180px = 360px, which exceeds 335px, so they will wrap to one per row. Each button will be ~335px wide. **PASS** for width on mobile.

**Gap between picker buttons:** 0.65rem = 10.4px. With buttons being full-width on mobile (one per row), vertical gap of 10.4px is adequate but tight. Apple recommends 8px minimum between targets. **MARGINAL PASS** but should increase to 12px.

#### Select Dropdowns

Native mobile select elements invoke the OS picker overlay (scroll wheel on iOS, dropdown on Android). The select element itself needs to meet touch target size, but the actual selection happens in the OS overlay. Current styling gives them the same padding as buttons (0.8rem), so the trigger area is ~50px tall. **PASS**.

However, there are **too many selects** in the assign form. The user must interact with: Kind (select), Initial status/level (select), Countable (select). On mobile, each select requires: tap to open, scroll to value, tap to confirm. That's 3 OS overlay interactions in addition to the text inputs. Consider reducing these with smarter defaults (see section 4).

#### Form Labels

Labels are styled with `font-size: 0.9rem` (14.4px) and `color: #425066`. The label text is NOT a tap target (the associated input is). However, since labels use `display: grid` with `gap: 0.35rem`, the label text and input are visually grouped. The 0.35rem (5.6px) gap between label text and input is acceptable.

#### Scan Form Submit Button ("Open")

The scan form uses `grid-template-columns: minmax(0, 1fr) auto`. The "Open" button takes auto width. On mobile with the keyboard open, this button may be hard to reach. **RECOMMENDATION:** Make the scan auto-submit on Enter key (already works via form submit) and consider removing the explicit "Open" button on mobile, replacing it with an auto-scan-on-enter behavior, or move it to a more accessible position.

#### Logout Button (inside status-card)

This is a standard button inside the `.status-card`. In the proposed compact header, this becomes an icon button. Icon buttons MUST be at least 44x44px even if the visible icon is smaller. Use padding to expand the touch area.

#### Banner Dismiss

Banners (`.banner`) currently have no dismiss mechanism. They persist until the next action changes the message state. On mobile, banners consume ~50-60px of vertical space that could show scan results. **RECOMMENDATION:** Add a close/dismiss button (X icon, 44x44px touch target) or auto-dismiss after 3 seconds with a CSS transition.

### 3.2 Elements That FAIL Touch Target Guidelines

1. **No explicit failures at 44px minimum**, but several marginal cases:
   - Picker button vertical gap (10.4px) should be 12px+
   - Banner lacks dismiss affordance entirely
   - The scan input "Open" button, while sized correctly, is in an awkward position relative to the keyboard

2. **Conceptual failures** (not size, but reachability):
   - The scan input at 800-900px scroll depth is unreachable without deliberate scrolling
   - Form fields inside the label-mode result card are 1200px+ from top, requiring extensive scrolling while holding a phone and a part

---

## 4. RAPID INTAKE FLOW

### 4.1 Current Tap Count: Scan to Labeled (Existing Part Type)

Currently, to scan and label one item with an existing part type:

1. Scroll down to find the scan input (~2-3 swipes)
2. Tap scan input (keyboard opens)
3. Type the code: e.g., "QR-1042" (7 keystrokes minimum)
4. Tap "Open" button or hit Enter (1 tap)
5. Wait for scan response
6. Scroll down to see the result card (1-2 swipes)
7. Optionally type in search to filter part types (N keystrokes)
8. Scroll through picker buttons to find the right part type
9. Tap the part type button (1 tap)
10. Scroll to check/edit location field (1 swipe)
11. Optionally edit location
12. Scroll to find the "Assign QR" button (1 swipe)
13. Tap "Assign QR" (1 tap)
14. Wait for assignment response

**Minimum interactions: 3 swipes + 7 keystrokes + 3 taps = high friction.**
**Estimated time per item: 25-40 seconds.**
**30 items: 12-20 minutes.** Far too slow.

### 4.2 Optimized Tap Count: Camera Scan to Labeled

With camera scanning and the proposed layout:

1. Point phone at QR sticker (0 taps -- camera is already open in continuous mode)
2. Wait for decode + haptic feedback (~200ms)
3. API scan fires automatically
4. Result card slides up below viewfinder with part type suggestions
5. Tap the correct part type (1 tap)
6. Tap "Assign" (1 tap) -- or, if location and defaults are acceptable, this could be a single "Assign as [Part Type] at [Location]" confirmation button

**Minimum interactions: 0 keystrokes + 2 taps.**
**Estimated time per item: 3-5 seconds** (dominated by pointing the camera).
**30 items: 1.5-2.5 minutes.**

### 4.3 "Same as Last" / Repeat Pattern

When labeling 10 identical items (e.g., 10 Arduino Nanos from the same shipment):

**After the first assignment, show a sticky "quick assign" bar:**

```
+----------------------------------------+
| Repeat: Arduino Nano @ Buffer Room A   |
| [Assign Same]              [Change]    |
+----------------------------------------+
```

This bar appears at the top of the result area whenever:
- The previous action was a successful assignment
- The current scan result is `label` mode (unassigned QR)

Tapping "Assign Same" immediately submits the assignment with the same part type, location, entity kind, and defaults as the last assignment. No form interaction required.

**Tap count for items 2-10: 0 keystrokes + 1 tap ("Assign Same").**
**Time per item: 2-3 seconds** (point camera + tap).
**10 identical items: 25-35 seconds total** (5 seconds for the first, 2-3 each for the rest).

### 4.4 Recent Part Types Pinning

The label search already shows `suggestions` from the server (the 12 most recently updated part types). This is good. Enhance it:

1. **Client-side MRU list:** Maintain a `localStorage` list of the last 10 part types the user assigned. Order: most recently used first.
2. **Show MRU at the top of the picker**, separated by a subtle divider from the server suggestions.
3. **Label the sections:** "Recent" and "All" (or "Suggestions").
4. The MRU list persists across sessions. This means a user who labels Arduino Nanos every Tuesday will see "Arduino Nano" at the top of their picker every Tuesday.

### 4.5 Location Persistence

**Current default:** `"Buffer Room A"` (hardcoded in `defaultAssignForm`).

**Proposed:** Persist the last-used location in `localStorage`. On each assignment, update the stored location. The next assignment form pre-fills with this location.

**Additional enhancement:** Maintain a short MRU list of locations (last 5). Show them as tappable chips above the location text input:

```
+-------------------------------------------+
| Location                                  |
| [Buffer Room A] [Workshop B] [Storage C]  |
| [________________________________]        |
+-------------------------------------------+
```

Tapping a chip fills the input. This eliminates typing for repeated locations.

### 4.6 Scan Queue

If the user scans faster than the server responds (e.g., rapid continuous scanning), the current implementation aborts the previous scan request:

```typescript
// legacy frontend scan shell
scanAbortRef.current?.abort();
scanRequestRef.current += 1;
const requestId = scanRequestRef.current;
const controller = new AbortController();
scanAbortRef.current = controller;
```

This means only the latest scan is processed. For rapid intake this is correct -- the user cares about the item currently in their hand, not the one they accidentally scanned 500ms ago.

**However**, for a power-user "scan everything then label later" workflow, a scan queue would be valuable:
- Maintain an ordered list of scanned codes.
- Show a counter: "3 scanned, 0 labeled."
- Allow the user to process them in order.

**Recommendation:** Defer the queue to v2. For v1, the "cancel previous, process latest" pattern is correct and simpler. The continuous scanning with quick-assign handles the primary use case.

### 4.7 Success State Duration

**Current behavior:** Success banner (`{message}`) persists until the next action sets a new message or error. It has no timeout.

**Problem:** The banner consumes vertical space indefinitely and pushes content down.

**Proposed:**
- Auto-dismiss success banners after 2 seconds with a fade-out animation.
- During rapid intake, suppress verbose success messages entirely. Instead, show a brief toast overlay on the viewfinder: a green check with the code (e.g., "QR-1042 assigned") that fades after 1.5 seconds.
- Error banners should NOT auto-dismiss. They require acknowledgement.

### 4.8 Auto-Advance After Assignment

After successful assignment:
1. The success toast appears on the viewfinder (camera never closed).
2. The result card clears after 1 second.
3. The camera resumes scanning automatically.
4. The "quick assign" bar appears with the repeat option.

The user does not need to take any action to start scanning the next item. The camera is always ready.

---

## 5. NAVIGATION PROPOSAL

### 5.1 Current: Single Scrollable Page

All four panels (QR Batch, Scan, Merge, Recent Events) are on a single page, visible simultaneously. On desktop with the 2-column grid, this works. On mobile, it creates a page that is 4000+ pixels tall with no hierarchy.

### 5.2 Proposed: Bottom Tab Navigation

```
+----------------------------------+
|                                  |
|        [Active Tab Content]      |
|                                  |
+----------------------------------+
| [Scan]    [Activity]   [Admin]   |
+----------------------------------+
```

**Tab 1: Scan (default, primary)**
- Camera viewfinder (or text input on desktop)
- Scan result card (unknown, label, or interact)
- Assignment form / event form as needed
- Quick-assign repeat bar
- This tab contains the entire hot path

**Tab 2: Activity**
- Dashboard metrics (compact horizontal row)
- Recent events list
- Part-DB connection status
- Pull-to-refresh to reload

**Tab 3: Admin**
- QR batch registration
- Part type merge
- These are low-frequency tasks

### 5.3 Bottom Nav Bar Specification

- Fixed position at viewport bottom.
- Height: 56px (includes safe area padding for iPhone home indicator).
- Background: semi-transparent with backdrop blur (matches the glassmorphic style in the current CSS).
- Three items, evenly spaced.
- Each item: icon (24x24) + label (10px). Total tap target: minimum 48x48px, but the entire third-width of the bar is tappable.
- The Scan tab icon should be visually dominant (larger, colored) to draw the user's eye.

### 5.4 Floating Action Button (FAB) Alternative

An alternative to the tab bar: a single persistent FAB for scanning, with other content accessible via a hamburger or settings menu.

**Not recommended.** The FAB works for apps with one primary action (e.g., compose in email). Smart DB has two hot paths (label and interact) that share the scan entry point, plus a meaningful activity feed. A tab bar communicates the full app structure better.

### 5.5 Progressive Disclosure Within the Scan Tab

The assignment form (label mode) currently shows ALL fields at once: search, picker, location, kind, status/level, canonical name, category, countable, notes. On mobile, this is overwhelming and most fields have acceptable defaults.

**Proposed: two-tier form.**

**Tier 1 (always visible):**
- Part type picker (search + buttons, showing MRU first)
- Location (pre-filled with last-used, chips for recent)
- "Assign" button

**Tier 2 (expandable via "More options" link):**
- Entity kind (instance/bulk)
- Initial status/level
- New canonical name
- Category
- Countable toggle
- Notes

For the common case (assigning a known part type at a known location), the user only interacts with Tier 1. For the first-time or unusual case, Tier 2 expands inline.

---

## 6. INTERACTION PATTERNS FOR EACH FLOW

### 6.1 Login

**Current UX:** A single password input for the Part-DB API token. Pasting a long API token on mobile involves: long-press input, tap "Paste" from context menu. This is acceptable but not ideal.

**Recommendations:**

1. **QR code login.** Add a second login method: scan a QR code that encodes the Part-DB API token. The QR could be generated from Part-DB's settings page or from a printed card. This eliminates the need to copy-paste a token on mobile. The login screen shows both options: "Paste token" and "Scan token QR."

2. **Token persistence.** The current implementation stores the token in `localStorage` and restores it on mount. This is correct. The token persists until Part-DB revokes it or the user logs out. No "remember me" toggle needed; the default behavior IS "remember me."

3. **Login screen layout.** The current login screen has a full hero section with explanatory text. On mobile, simplify:
   - App logo/name (compact)
   - "Scan token QR" button (primary, large)
   - "Or paste token" collapsible section
   - Error message area

### 6.2 QR Batch Registration

**This is an admin task, almost always done at a desk.**

Mobile optimization is low priority. Move it to the Admin tab. The form is simple (3 inputs + button) and works fine with native mobile controls.

**One improvement:** Add a confirmation dialog before registering 500 QR codes. A mistyped start number could create a conflicting range. The current implementation just fires the request.

### 6.3 Scan to Label (Intake) -- THE Hot Path

**Full optimized flow:**

```
State: Camera viewfinder is active (continuous mode)
Step 1: User points camera at QR sticker on physical object
Step 2: Camera decodes QR --> haptic buzz, green flash on viewfinder
Step 3: POST /api/scan fires automatically with decoded value
Step 4: Server returns "label" mode with suggestions
Step 5: Below viewfinder, result card slides up:
        +--------------------------------------+
        | Assign QR-1042                       |
        +--------------------------------------+
        | [Repeat: Arduino Nano @ Room A]      |  <-- if previous assignment exists
        +--------------------------------------+
        | Recent: [Arduino Nano] [JST XH]      |
        | All:    [search________________]     |
        |         [PLA Filament] [Cotton]      |
        |         [Capacitor 100uF] [...]      |
        +--------------------------------------+
        | Location: [Buffer Room A_________]   |
        | [Room A] [Workshop B] [Storage C]    |
        +--------------------------------------+
        | [        Assign QR        ]          |
        | [More options v]                     |
        +--------------------------------------+
Step 6: User taps part type button (1 tap)
Step 7: User taps "Assign QR" (1 tap)
        OR taps "Repeat" (1 tap, skips step 6)
Step 8: POST /api/assignments fires
Step 9: Success toast on viewfinder, result card clears
Step 10: Camera resumes scanning automatically
```

**Tap count: 2 taps for new part type, 1 tap for repeat.**

### 6.4 Scan to Interact (Lifecycle Event) -- Second Hot Path

```
State: Camera viewfinder is active
Step 1: User points camera at QR sticker
Step 2: Camera decodes --> haptic, green flash
Step 3: POST /api/scan fires
Step 4: Server returns "interact" mode
Step 5: Result card slides up:
        +--------------------------------------+
        | Arduino Nano @ Workshop B            |
        | Status: available                    |
        +--------------------------------------+
        | Quick actions:                       |
        | [Moved] [Checked Out] [Returned]     |
        | [Consumed] [Damaged] [Lost]          |
        +--------------------------------------+
        | Location: [Workshop B________]       |
        +--------------------------------------+
        | [More: assignee, notes v]            |
        +--------------------------------------+
        | Recent events:                       |
        | labeled by admin @ 2024-01-15        |
        | moved by admin @ 2024-01-16          |
        +--------------------------------------+
```

**Key change:** Replace the event `<select>` dropdown with **large tap buttons** for each available action. This eliminates: tap to open select, scroll to find action, tap to select. Instead: single tap on the desired action.

For "moved" events (the most common), tapping "Moved" could immediately submit with the current location, or if the location has changed, show a location input first.

**Quick flow for "moved":**
1. Scan item (0 taps, continuous mode)
2. Tap "Moved" (1 tap)
3. If location is unchanged: submits immediately (0 additional taps)
4. If location changed: location input appears, user edits, taps "Confirm" (2 additional taps)

**Quick flow for "checked_out":**
1. Scan item (0 taps)
2. Tap "Checked Out" (1 tap)
3. Assignee defaults to logged-in user. Submit immediately. (0 additional taps if default is correct)
4. If different assignee: assignee input appears, user edits, taps "Confirm" (2 additional taps)

### 6.5 Merge (Admin Task)

Move to Admin tab. The two-picker pattern (dropdown for source, search for destination) works but is confusing because the user must understand "provisional" vs "canonical."

**Improvement:** Rename the UI labels:
- "Provisional source" --> "Merge FROM (the duplicate)"
- "Canonical destination" --> "Merge INTO (the correct one)"

Add a visual arrow or diagram showing the merge direction.

On mobile, the merge picker buttons will be full-width (one per row), which is actually fine for this task since it's not time-sensitive.

---

## 7. GESTURE MAP

### 7.1 Supported Gestures

| Gesture | Where | Action |
|---------|-------|--------|
| **Tap** | Everywhere | Primary interaction for all buttons, inputs, picker items |
| **Swipe left/right** | Bottom tab bar | Switch between Scan / Activity / Admin tabs |
| **Swipe down** | Activity tab (top) | Pull-to-refresh: reload dashboard and recent events |
| **Swipe down** | Viewfinder area | Close viewfinder, show text input |
| **Swipe up** | Result card | Expand result card to full height (when content is truncated) |
| **Long press** | Picker button (part type) | Show part type details: full name, category, aliases, notes, image |
| **Long press** | Event in history list | Show full event details: from/to state, actor, notes, timestamp |
| **Pinch to zoom** | Not supported | Unnecessary; the viewfinder handles its own zoom via camera controls |

### 7.2 Gestures NOT Supported (and Why)

- **Swipe to dismiss results:** Risky for accidental dismissal while holding a part. Require explicit tap on X or "Scan Next."
- **Shake to undo:** Too easy to trigger accidentally in a makerspace where things get bumped.
- **3D Touch / Force Touch:** Deprecated on modern iPhones and never available on Android.
- **Double-tap:** No clear use case that isn't better served by a single tap.

### 7.3 Pull-to-Refresh Implementation

Use the native browser pull-to-refresh where available (CSS `overscroll-behavior-y: contain` to control it). Or implement a custom pull-to-refresh for the Activity tab:

- Threshold: 60px pull distance.
- Visual: spinning indicator at the top.
- Action: calls `loadAuthenticatedData()`.
- Disabled during pending actions.

---

## 8. FEEDBACK AND STATUS COMMUNICATION

### 8.1 Loading States

| Context | Current | Proposed |
|---------|---------|----------|
| Initial data load | No indicator | Skeleton screens for metrics and event list |
| Scan in flight | `pendingAction === "scan"` disables button, text changes to "Opening..." | Viewfinder shows a scanning animation (pulsing brackets); no button to disable |
| Assignment in flight | Button shows "Assigning..." | Button shows spinner + "Assigning...", form fields become read-only (not just button disabled) |
| Event in flight | Button shows "Logging..." | Same as assignment |
| Search in flight | No indicator | Subtle spinner in the search input's right edge |

### 8.2 Success States

- **Toast overlay** (for scan and rapid intake): green check + code, positioned over the viewfinder, fades after 1.5s. Does not block interaction.
- **Inline confirmation** (for assignment and events): brief green highlight on the form area, then auto-clear after 2s.
- **Persistent message** (for batch registration, merge): standard banner that auto-dismisses after 4s (these are less frequent operations).

### 8.3 Error States

- **Scan errors** (unknown code, network failure): inline card below viewfinder with red border. Stays until next scan.
- **Form validation errors:** inline under the specific field, not a banner. Color: red text below the offending input.
- **Network errors:** banner at the top of the current tab, with retry button.
- **Auth errors (401):** immediate redirect to login screen with explanation.

### 8.4 Empty States

- **No events yet:** "No activity yet. Scan a QR code to get started." with an illustration or icon of a QR code.
- **No part types:** "No part types in the catalog. Create one during your first assignment."
- **No provisional types (merge tab):** "No provisional types to merge. Everything is canonical." with a success indicator.

### 8.5 Connection Status

The current Part-DB connection status (`.pill.ok` / `.pill.warn`) is buried in the hero section. On mobile:

- Move to the compact header bar, as a small colored dot next to "Smart DB."
- Green dot: Part-DB connected.
- Yellow dot: Part-DB degraded.
- Red dot: Network error / Smart DB middleware unreachable.
- Tapping the dot shows a brief tooltip with the status message.

---

## 9. ACCESSIBILITY NOTES

### 9.1 Screen Reader (VoiceOver / TalkBack)

**Current gaps:**
- Success/error banners are plain `<p>` elements with no `aria-live` region. Screen readers will not announce them.
- The picker buttons have no `role` attribute. They should be `role="radio"` within a `role="radiogroup"` since only one can be selected.
- The viewfinder (when implemented) needs an accessible label: `aria-label="QR code scanner viewfinder"`.
- Scan results changing dynamically need `aria-live="polite"` on the result container.

**Required changes:**

1. **Banner announcements:**
   ```html
   <div role="status" aria-live="polite" aria-atomic="true">
     {message && <p className="banner success">{message}</p>}
   </div>
   <div role="alert" aria-live="assertive" aria-atomic="true">
     {error && <p className="banner error">{error}</p>}
   </div>
   ```

2. **Part type picker:**
   ```html
   <div role="radiogroup" aria-label="Select part type">
     <button role="radio" aria-checked={isSelected} ...>
   ```

3. **Camera viewfinder:** When a code is detected, announce it:
   ```html
   <div aria-live="assertive" className="sr-only">
     Scanned code: QR-1042. Result: unassigned QR ready for labeling.
   </div>
   ```

4. **Loading states:** Add `aria-busy="true"` to forms during submission.

5. **Tab navigation:** The bottom tab bar should use `role="tablist"` with `role="tab"` on each item and `role="tabpanel"` on the content areas. Manage `aria-selected` state.

### 9.2 Reduced Motion

Respect `prefers-reduced-motion`:
- Disable the viewfinder pulse/scanning animation.
- Replace slide-up transitions with instant appearance.
- Replace fade-out toasts with instant removal after timeout.
- Keep haptic feedback (it's tactile, not visual motion).

### 9.3 Color Contrast

Current color scheme audit:
- `.eyebrow` color `#8b5a16` on background `~#fff8eb`: contrast ratio ~4.3:1. **MARGINAL** for small text (needs 4.5:1 for AA). Darken to `#7a4e10` for 5.1:1.
- `.lede` inherits `#132033` on `~#fff8eb`: contrast ratio ~14:1. **PASS**.
- `.pill.ok` text `#215b2f` on `#d7efdd`: contrast ratio ~5.2:1. **PASS**.
- `.pill.warn` text `#8a5312` on `#f4dfbd`: contrast ratio ~4.6:1. **PASS** but marginal.
- Label text `#425066` on `~#fffcf7`: contrast ratio ~6.7:1. **PASS**.
- Metric label `#6d7485` on `~#fffcf7`: contrast ratio ~4.0:1. **FAIL** for small text (0.78rem). Darken to `#5a6270` for 5.1:1.
- Picker span and event-list secondary text `#5f6774` on `~#fff`: contrast ratio ~4.8:1. **PASS**.

### 9.4 Focus Management

**Current:** `scanInputRef.current?.focus()` after auth and after mutations. This is good for desktop but on mobile, calling `.focus()` on an input opens the keyboard, which may be unwanted after assignment completion (the user wants to scan next, not type).

**Proposed:** After assignment/event success in camera mode, do NOT focus any input. The camera is already active. Focus management applies only to the manual text-input mode.

### 9.5 High Contrast / Dark Mode

The current CSS uses `color-scheme: light` only. For makerspace use, dark mode is not critical (most makerspaces are well-lit). However, the current light background with subtle gradients can wash out in bright sunlight. Consider adding a high-contrast mode that uses solid white backgrounds and darker borders.

---

## 10. IMPLEMENTATION PRIORITY

### Phase 1: Unblock the Hot Path (Critical)

1. **Add camera scanning** with `BarcodeDetector` + `html5-qrcode` fallback.
2. **Restructure mobile layout** with bottom tab navigation and scan-first architecture.
3. **Implement quick-assign repeat bar** for rapid intake of identical items.
4. **Collapse assign form** to two tiers (essential fields visible, rest expandable).
5. **Replace event type select** with tap-target action buttons.
6. **Persist last-used location** in localStorage.

### Phase 2: Polish the Experience

7. Add haptic/audio feedback on scan.
8. Implement MRU part type list with localStorage persistence.
9. Add toast notifications instead of persistent banners.
10. Add location chips (MRU locations).
11. Add pull-to-refresh on Activity tab.
12. Implement QR code login.

### Phase 3: Accessibility and Robustness

13. Add all ARIA attributes (live regions, radiogroup, etc.).
14. Fix color contrast issues.
15. Add reduced-motion support.
16. Add offline queue / service worker for network resilience.
17. Add torch toggle for camera viewfinder.

---

## Summary of Key Metrics

| Metric | Current | Proposed |
|--------|---------|----------|
| Time to first scan interaction | ~5 swipes + typing | 0 (camera auto-opens on Scan tab) |
| Taps per item (existing part type) | 7+ keystrokes + 3+ taps | 2 taps |
| Taps per item (repeat part type) | Same as above | 1 tap |
| 30 items labeled | 12-20 minutes | 1.5-2.5 minutes |
| Scroll depth to scan input | ~800px | 0px (scan is the default view) |
| Admin clutter on scan screen | 2 panels visible (batch, merge) | 0 (moved to Admin tab) |
| Camera permission UX | N/A | Contextual request with fallback |
| Success feedback mechanism | Persistent banner | Auto-dismiss toast overlay |
