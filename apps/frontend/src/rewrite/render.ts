import {
  hasSmartDbRole,
  instanceStatuses,
  measurementUnitCatalog,
  smartDbRoles,
  type PartType,
} from "@smart-db/contracts";
import {
  actionLabel,
  describePartDbSyncFailure,
  formatCategoryPath,
  formatQuantity,
  formatTimestamp,
  getAssignFormIssues,
  getEventFormIssues,
  quantityInputStep,
} from "./presentation-helpers";
import { attr, checked, disabled, escapeHtml, joinHtml, selected } from "./html";
import type { RewriteUiState, TabId, ToastRecord } from "./ui-state";
import { findSharedTypeConflictCandidates, getPartDbHealthPill, getPartDbSyncPill } from "./view-helpers";

export function renderApp(state: RewriteUiState): string {
  if (state.authState.status === "checking") {
    return `
      <div class="shell">
        <p class="eyebrow">Smart DB</p>
        <p class="muted-copy">Checking session...</p>
      </div>
    `;
  }

  if (state.authState.status !== "authenticated") {
    return `
      <div class="shell">
        <header class="hero">
          <div>
            <p class="eyebrow">Smart DB</p>
            <h1>Sign In With Makerspace SSO</h1>
            <p class="lede">
              Smart DB authenticates through your Makerspace identity provider
              and keeps inventory credentials out of the browser.
            </p>
          </div>
          <div class="status-card">
            <div class="pill warn">Authentication Required</div>
            <p>
              You will be redirected to Zitadel and returned here with a secure
              session.
            </p>
          </div>
        </header>

        ${state.authState.error ? `<p class="banner error">${escapeHtml(state.authState.error)}</p>` : ""}
        ${renderToasts(state.toasts)}

        <section class="panel">
          ${renderPanelTitle(
            "Makerspace Login",
            "Use your Makerspace SSO account. Smart DB uses a server-side session cookie instead of storing bearer tokens in the browser.",
          )}
          <div class="stack">
            <a
              class="button-link"
              data-action="login"
              href="#"
            >
              Continue With SSO
            </a>
          </div>
        </section>
      </div>
    `;
  }

  const isAdmin = hasSmartDbRole(state.authState.session.roles, smartDbRoles.admin);
  const partDbHealth = getPartDbHealthPill(state.partDbStatus);
  const partDbSync = isAdmin ? getPartDbSyncPill(state.partDbSyncStatus) : null;

  return `
    <div class="shell">
      <header class="header-bar">
        <strong class="header-brand">Smart DB</strong>
        <div class="header-status">
          <span class="header-user">${escapeHtml(state.authState.session.username)}</span>
          <div class="pill ${partDbHealth.tone}">${escapeHtml(partDbHealth.label)}</div>
          ${partDbSync ? `<div class="pill ${partDbSync.tone}">${escapeHtml(partDbSync.label)}</div>` : ""}
        </div>
        <button
          type="button"
          data-action="logout"
          ${disabled(state.pendingAction === "logout")}
        >
          ${state.pendingAction === "logout" ? "..." : "Logout"}
        </button>
      </header>

      ${renderToasts(state.toasts)}

      ${!state.isOnline ? `<p class="banner error">You appear to be offline.</p>` : ""}
      ${state.sessionExpiringSoon ? `<p class="banner error">Session expires soon.</p>` : ""}
      ${state.refreshError ? `<p class="banner error">${escapeHtml(state.refreshError)}</p>` : ""}

      <section class="metrics">
        ${renderMetric("Part types", state.dashboard?.partTypeCount ?? 0)}
        ${renderMetric("Instances", state.dashboard?.instanceCount ?? 0)}
        ${renderMetric("Bulk bins", state.dashboard?.bulkStockCount ?? 0)}
        ${renderMetric("Provisional", state.dashboard?.provisionalCount ?? 0)}
        ${renderMetric("Unassigned QRs", state.dashboard?.unassignedQrCount ?? 0)}
      </section>

      <main class="layout">
        ${state.activeTab === "scan" ? renderScanTab(state) : ""}
        ${state.activeTab === "inventory" ? renderInventoryTab(state) : ""}
        ${state.activeTab === "activity" ? renderActivityTab(state) : ""}
        ${state.activeTab === "admin" && isAdmin ? renderAdminTab(state) : ""}
      </main>

      ${renderTabBar(state.activeTab, isAdmin ? ["scan", "inventory", "activity", "admin"] : ["scan", "inventory", "activity"])}
    </div>
  `;
}

function renderPanelTitle(title: string, copy: string): string {
  return `
    <div class="panel-title">
      <h2>${escapeHtml(title)}</h2>
      <p>${escapeHtml(copy)}</p>
    </div>
  `;
}

function renderMetric(label: string, value: number): string {
  return `
    <article class="metric">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
    </article>
  `;
}

function renderToasts(toasts: readonly ToastRecord[]): string {
  if (toasts.length === 0) {
    return "";
  }

  return `
    <div class="toast-container">
      ${toasts.map((toast) => `
        <div class="toast toast-${toast.type}" role="${toast.type === "error" ? "alert" : "status"}">
          <span class="toast-icon" aria-hidden="true">${toast.type === "success" ? "✓" : toast.type === "error" ? "!" : "i"}</span>
          <span class="toast-message">${escapeHtml(toast.message)}</span>
          <button type="button" class="toast-close" data-action="dismiss-toast" data-toast-id="${attr(toast.id)}" aria-label="Dismiss">×</button>
        </div>
      `).join("")}
    </div>
  `;
}

function renderTabBar(activeTab: TabId, tabs: readonly TabId[]): string {
  const labels: Record<TabId, string> = {
    scan: "Scan",
    inventory: "Stock",
    activity: "Activity",
    admin: "Admin",
  };

  return `
    <nav class="tab-bar" role="tablist" aria-label="Primary navigation">
      ${tabs.map((tab) => `
        <button
          type="button"
          role="tab"
          id="tab-${tab}"
          class="${activeTab === tab ? "active" : ""}"
          aria-selected="${String(activeTab === tab)}"
          aria-controls="panel-${tab}"
          tabIndex="${activeTab === tab ? "0" : "-1"}"
          data-action="change-tab"
          data-tab="${tab}"
        >
          ${labels[tab]}
        </button>
      `).join("")}
    </nav>
  `;
}

function renderScanTab(state: RewriteUiState): string {
  const assignIssues = getAssignFormIssues(state.assignForm);
  const bulkAssignIssues = getAssignFormIssues({
    ...state.bulkQueue.labelForm,
    qrCode: "__bulk__",
  });
  const eventIssues = getEventFormIssues(state.eventForm);
  const isOneByOne = state.scanMode.kind === "oneByOne";
  const cameraBlockedReason =
    state.pendingAction !== null
      ? "Finish the current action before scanning another item."
      : isOneByOne && state.scanResult
        ? "Finish or clear the current scan form before scanning another item."
        : null;
  const labelOptions =
    state.labelSearch.query.trim() || state.labelSearch.results.length > 0
      ? state.labelSearch.results
      : state.scanResult?.mode === "label"
        ? state.scanResult.suggestions
        : state.catalogSuggestions;
  const bulkLabelOptions =
    state.bulkQueue.labelSearch.query.trim() || state.bulkQueue.labelSearch.results.length > 0
      ? state.bulkQueue.labelSearch.results
      : state.catalogSuggestions;
  const selectedMeasurementUnit =
    measurementUnitCatalog.find((unit) => unit.symbol === state.assignForm.unitSymbol) ??
    measurementUnitCatalog[0];
  const bulkUnitSymbol =
    state.scanResult?.mode === "interact" && state.scanResult.entity.targetType === "bulk"
      ? state.scanResult.entity.partType.unit.symbol
      : selectedMeasurementUnit.symbol;
  const bulkQuantityStep =
    state.scanResult?.mode === "interact" && state.scanResult.entity.targetType === "bulk"
      ? quantityInputStep(state.scanResult.entity.partType.unit.isInteger)
      : quantityInputStep(selectedMeasurementUnit.isInteger);

  return `
    <section id="panel-scan" role="tabpanel" aria-labelledby="tab-scan" class="panel">
      ${renderPanelTitle("Scan", "Scan a sticker to assign it, update it, or look up what it belongs to.")}
      ${renderScanner(state, state.cameraLookupCode !== null, cameraBlockedReason)}
      <form class="scan-form" data-form="scan">
        <label class="sr-only" for="scan-code-input">Scan or type a QR / barcode</label>
        <input
          id="scan-code-input"
          name="scanCode"
          aria-label="Scan or type a QR / barcode"
          placeholder="Scan or type a QR / barcode"
          value="${attr(state.scanCode)}"
          autocomplete="off"
        />
        <button type="submit" ${disabled(state.pendingAction !== null)}>
          ${state.pendingAction === "scan" ? "Opening..." : state.scanMode.kind === "bulk" ? "Add" : "Open"}
        </button>
      </form>

      <div class="scan-mode-bar">
        <button
          type="button"
          class="scan-mode-btn ${state.scanMode.kind === "oneByOne" ? "active" : ""}"
          data-action="set-scan-mode-kind"
          data-scan-mode-kind="oneByOne"
        >
          <span class="scan-mode-icon">◇</span>
          One-by-one
        </button>
        <button
          type="button"
          class="scan-mode-btn ${state.scanMode.kind === "bulk" ? "active" : ""}"
          data-action="set-scan-mode-kind"
          data-scan-mode-kind="bulk"
        >
          <span class="scan-mode-icon">≡</span>
          Bulk
        </button>
      </div>

      ${state.scanMode.kind === "oneByOne" ? `
        <div class="scan-mode-bar">
          <button
            type="button"
            class="scan-mode-btn ${state.scanMode.behavior === "viewOnly" ? "active" : ""}"
            data-action="set-scan-behavior"
            data-scan-behavior="viewOnly"
          >
            <span class="scan-mode-icon">◇</span>
            View only
          </button>
          <button
            type="button"
            class="scan-mode-btn ${state.scanMode.behavior === "increment" ? "active" : ""}"
            data-action="set-scan-behavior"
            data-scan-behavior="increment"
          >
            <span class="scan-mode-icon">+1</span>
            Auto-count
          </button>
        </div>
      ` : `
        <div class="scan-mode-bar">
          <button
            type="button"
            class="scan-mode-btn ${state.bulkQueue.action === "label" ? "active" : ""}"
            data-action="set-bulk-action"
            data-bulk-action="label"
          >
            <span class="scan-mode-icon">#</span>
            Bulk label
          </button>
          <button
            type="button"
            class="scan-mode-btn ${state.bulkQueue.action === "move" ? "active" : ""}"
            data-action="set-bulk-action"
            data-bulk-action="move"
          >
            <span class="scan-mode-icon">→</span>
            Bulk move
          </button>
          <button
            type="button"
            class="scan-mode-btn ${state.bulkQueue.action === "delete" ? "active" : ""}"
            data-action="set-bulk-action"
            data-bulk-action="delete"
          >
            <span class="scan-mode-icon">×</span>
            Bulk delete
          </button>
        </div>
      `}

      <div aria-live="polite">
        ${state.scanMode.kind === "oneByOne" && state.scanResult?.mode === "unknown" ? `
          <div class="result-card">
            <h3>${escapeHtml(state.scanResult.code)} is unknown to Smart DB</h3>
            <p>
              Register this barcode to start tracking it. Future scans will
              automatically increment the quantity on hand.
            </p>
            <button type="button" data-action="register-unknown" data-code="${attr(state.scanResult.code)}" ${disabled(state.pendingAction !== null)} style="margin-top:0.75rem;">
              Register this barcode
            </button>
            <small style="display:block;margin-top:0.5rem">${escapeHtml(state.scanResult.partDb.message)}</small>
          </div>
        ` : ""}

        ${state.scanMode.kind === "oneByOne" && state.scanResult?.mode === "label" ? renderLabelCard(state, labelOptions, assignIssues) : ""}
        ${state.scanMode.kind === "oneByOne" && state.scanResult?.mode === "interact" ? renderInteractCard(state, eventIssues, bulkQuantityStep, bulkUnitSymbol) : ""}
        ${state.scanMode.kind === "bulk" ? renderBulkQueueCard(state, bulkLabelOptions, bulkAssignIssues) : ""}

        ${state.scanMode.kind === "oneByOne" && state.scanResult && !state.cameraLookupCode ? `
          <button
            type="button"
            class="scan-next-bottom"
            data-action="scan-next"
            ${disabled(state.pendingAction !== null)}
          >
            Scan next item
          </button>
        ` : ""}
      </div>
    </section>
  `;
}

function renderScanner(state: RewriteUiState, isLookingUp: boolean, blockedReason: string | null): string {
  if (!state.camera.supported) {
    return "";
  }

  return `
    <div class="qr-scanner">
      ${blockedReason ? `<p class="banner error">${escapeHtml(blockedReason)}</p>` : ""}
      ${state.camera.phase === "denied" || state.camera.phase === "failure" ? `<p class="banner error">${escapeHtml(state.camera.failure?.message ?? "Camera unavailable. Use manual input instead.")}</p>` : ""}
      ${!state.camera.activeStream && state.camera.lastResult ? `
        <div class="scan-status" aria-live="polite">
          <strong>Detected ${escapeHtml(state.camera.lastResult)}</strong>
          <p>${escapeHtml(isLookingUp ? `Looking up ${state.camera.lastResult}...` : "Ready to scan the next item.")}</p>
        </div>
      ` : ""}
      ${!state.camera.activeStream && (state.camera.permissionState !== "granted" || !state.camera.lastResult) ? `
        <button
          type="button"
          class="camera-btn"
          data-action="camera-start"
          ${disabled(Boolean(blockedReason) || isLookingUp)}
        >
          <span class="camera-ascii" aria-hidden="true">┌──────────┐
│  ◉  ▣▣  │
└──────────┘</span>
          <span>${state.camera.permissionState === "granted" ? "Switch to camera" : "Tap to scan"}</span>
        </button>
      ` : ""}
      <div class="viewfinder"${state.camera.activeStream ? "" : " hidden"}>
        <video id="rewrite-camera-video" playsinline muted autoplay></video>
        <div class="viewfinder-guide"></div>
        ${state.camera.lastResult && state.camera.activeStream ? `<div class="scan-flash"></div>` : ""}
      </div>
      ${state.camera.activeStream ? `<button type="button" data-action="camera-stop">Switch to manual input</button>` : ""}
      ${!state.camera.activeStream && state.camera.lastResult && !isLookingUp ? `
        <button type="button" data-action="camera-scan-next" ${disabled(Boolean(blockedReason))}>Scan next</button>
      ` : ""}
    </div>
  `;
}

function renderBulkQueueCard(
  state: RewriteUiState,
  labelOptions: readonly PartType[],
  assignIssues: ReturnType<typeof getAssignFormIssues>,
): string {
  const summary = state.bulkQueue.summary;

  return `
    <div class="result-card">
      <h3>${escapeHtml(bulkActionHeading(state.bulkQueue.action))}</h3>
      <p class="muted-copy">
        ${escapeHtml(`${summary.uniqueLabelCount} unique labels · ${summary.totalScanCount} scans${summary.duplicateScanCount > 0 ? ` · ${summary.duplicateScanCount} duplicates collapsed` : ""}`)}
      </p>
      ${state.bulkQueue.failure ? `<p class="banner error">${escapeHtml(state.bulkQueue.failure.message)}</p>` : ""}
      ${state.bulkQueue.rows.length === 0 ? `
        <p class="muted-copy">${escapeHtml(emptyBulkQueueCopy(state.bulkQueue.action))}</p>
      ` : `
        <div class="event-list">
          <ul class="activity-list">
            ${state.bulkQueue.rows.map((row) => `
              <li class="activity-row">
                <div>
                  <strong>${escapeHtml(row.code)}</strong>
                  <div class="activity-detail">
                    ${row.kind === "unlabeled"
                      ? escapeHtml(`Printed label · batch ${row.batchId}`)
                      : escapeHtml(`${row.partTypeName} · ${row.location} · ${row.targetType}`)}
                  </div>
                </div>
                <div style="display:flex;gap:0.5rem;align-items:center">
                  <span class="pill info">${escapeHtml(`×${row.count}`)}</span>
                  <button type="button" data-action="bulk-queue-decrement" data-code="${attr(row.code)}">-1</button>
                  <button type="button" data-action="bulk-queue-remove" data-code="${attr(row.code)}">Remove</button>
                </div>
              </li>
            `).join("")}
          </ul>
        </div>
      `}
      <button type="button" data-action="bulk-queue-clear" ${disabled(state.pendingAction !== null || state.bulkQueue.rows.length === 0)} style="margin-top:1rem">
        Clear queue
      </button>
      ${state.bulkQueue.action === "label" ? renderBulkLabelForm(state, labelOptions, assignIssues) : ""}
      ${state.bulkQueue.action === "move" ? renderBulkMoveForm(state) : ""}
      ${state.bulkQueue.action === "delete" ? renderBulkDeleteForm(state) : ""}
    </div>
  `;
}

function renderBulkLabelForm(
  state: RewriteUiState,
  labelOptions: readonly PartType[],
  assignIssues: ReturnType<typeof getAssignFormIssues>,
): string {
  const form = state.bulkQueue.labelForm;
  const selectedPartType =
    labelOptions.find((partType) => partType.id === form.existingPartTypeId) ??
    state.catalogSuggestions.find((partType) => partType.id === form.existingPartTypeId);

  return `
    <form class="form-grid" data-form="bulk-label" style="margin-top:1rem">
      <div class="wide mode-toggle" role="radiogroup" aria-label="Bulk label type mode">
        <button type="button" role="radio" class="${form.partTypeMode === "existing" ? "selected" : ""}" aria-checked="${String(form.partTypeMode === "existing")}" data-action="set-bulk-label-mode" data-assign-mode="existing">Use existing type</button>
        <button type="button" role="radio" class="${form.partTypeMode === "new" ? "selected" : ""}" aria-checked="${String(form.partTypeMode === "new")}" data-action="set-bulk-label-mode" data-assign-mode="new">Create new type</button>
      </div>
      ${form.partTypeMode === "existing" ? `
        <label class="wide">
          Search existing part types
          <input name="bulkLabelSearch.query" value="${attr(state.bulkQueue.labelSearch.query)}" placeholder="Arduino, JST, PLA, cotton..." />
        </label>
        ${state.bulkQueue.labelSearch.error ? `<p class="banner error wide">${escapeHtml(state.bulkQueue.labelSearch.error)}</p>` : ""}
        ${assignIssues.existingPartTypeId ? `<p class="field-error wide">${escapeHtml(assignIssues.existingPartTypeId)}</p>` : ""}
        <div class="wide picker" role="radiogroup" aria-label="Existing part types">
          ${labelOptions.length > 0 ? labelOptions.map((partType) => `
            <button
              type="button"
              role="radio"
              aria-checked="${String(form.existingPartTypeId === partType.id)}"
              class="${form.existingPartTypeId === partType.id ? "selected" : ""}"
              data-action="select-bulk-label-part"
              data-part-id="${attr(partType.id)}"
            >
              <strong>${escapeHtml(partType.canonicalName)}</strong>
              <span>${escapeHtml(formatCategoryPath(partType.categoryPath))}</span>
            </button>
          `).join("") : `<p class="muted-copy">No matching part types yet.</p>`}
        </div>
        ${selectedPartType ? `
          <button type="button" class="disclosure wide" data-action="create-bulk-label-variant" data-part-id="${attr(selectedPartType.id)}">
            Create a variant of "${escapeHtml(selectedPartType.canonicalName)}"
          </button>
        ` : ""}
      ` : `
        <label class="wide">
          New canonical name
          <input name="bulkLabel.canonicalName" value="${attr(form.canonicalName)}" placeholder="Arduino Uno R3" />
          ${assignIssues.canonicalName ? `<span class="field-error">${escapeHtml(assignIssues.canonicalName)}</span>` : ""}
        </label>
        <label class="wide">
          Category path
          <input name="bulkLabel.category" value="${attr(form.category)}" placeholder="Electronics / Resistors / SMD 0603" />
          ${assignIssues.category ? `<span class="field-error">${escapeHtml(assignIssues.category)}</span>` : ""}
        </label>
      `}
      ${form.partTypeMode === "existing" && selectedPartType?.countable ? `
        <div class="wide mode-toggle" role="radiogroup" aria-label="Inventory entry">
          <button type="button" role="radio" aria-checked="${String(form.entityKind === "instance")}" class="${form.entityKind === "instance" ? "selected" : ""}" data-action="set-bulk-label-entity-kind" data-entity-kind="instance">Tracked unit</button>
          <button type="button" role="radio" aria-checked="${String(form.entityKind === "bulk")}" class="${form.entityKind === "bulk" ? "selected" : ""}" data-action="set-bulk-label-entity-kind" data-entity-kind="bulk">Bulk pool</button>
        </div>
      ` : ""}
      ${form.partTypeMode === "new" && form.entityKind === "bulk" ? `
        <div class="wide mode-toggle" role="radiogroup" aria-label="Part type kind">
          <button type="button" role="radio" aria-checked="${String(form.countable)}" class="${form.countable ? "selected" : ""}" data-action="set-bulk-label-countability" data-countable="true">Piece-counted</button>
          <button type="button" role="radio" aria-checked="${String(!form.countable)}" class="${!form.countable ? "selected" : ""}" data-action="set-bulk-label-countability" data-countable="false">Measured</button>
        </div>
      ` : ""}
      <label class="wide">
        Location
        <input name="bulkLabel.location" value="${attr(form.location)}" placeholder="Shelf A" />
        ${assignIssues.location ? `<span class="field-error">${escapeHtml(assignIssues.location)}</span>` : ""}
      </label>
      ${state.knownLocations.length > 0 ? `
        <div class="wide picker" role="listbox" aria-label="Known locations">
          ${state.knownLocations.map((location) => `
            <button type="button" role="option" aria-selected="${String(form.location === location)}" class="${form.location === location ? "selected" : ""}" data-action="pick-bulk-label-known-location" data-location="${attr(location)}">
              <strong>${escapeHtml(location)}</strong>
            </button>
          `).join("")}
        </div>
      ` : ""}
      <label class="wide">
        Notes
        <textarea name="bulkLabel.notes">${escapeHtml(form.notes)}</textarea>
      </label>
      ${form.entityKind === "instance" ? `
        <label>
          Initial status
          <select name="bulkLabel.initialStatus">
            ${instanceStatuses.map((status) => `<option value="${status}"${selected(status === form.initialStatus)}>${escapeHtml(status)}</option>`).join("")}
          </select>
        </label>
      ` : `
        <label>
          Unit of measure
          <select name="bulkLabel.unitSymbol">
            ${measurementUnitCatalog.filter((unit) => (form.countable ? unit.isInteger : true)).map((unit) => `
              <option value="${attr(unit.symbol)}"${selected(unit.symbol === form.unitSymbol)}>${escapeHtml(unit.name)} (${escapeHtml(unit.symbol)})</option>
            `).join("")}
          </select>
        </label>
        <label>
          Starting quantity
          <input type="number" min="${(measurementUnitCatalog.find((unit) => unit.symbol === form.unitSymbol) ?? measurementUnitCatalog[0]).isInteger ? "1" : "0.000001"}" inputmode="decimal" name="bulkLabel.initialQuantity" value="${attr(form.initialQuantity)}" step="${quantityInputStep((measurementUnitCatalog.find((unit) => unit.symbol === form.unitSymbol) ?? measurementUnitCatalog[0]).isInteger)}" placeholder="${(measurementUnitCatalog.find((unit) => unit.symbol === form.unitSymbol) ?? measurementUnitCatalog[0]).isInteger ? "1" : "0.1"}" />
          ${assignIssues.initialQuantity ? `<span class="field-error">${escapeHtml(assignIssues.initialQuantity)}</span>` : ""}
        </label>
        <label>
          Low-stock threshold
          <input type="number" min="0" inputmode="decimal" name="bulkLabel.minimumQuantity" value="${attr(form.minimumQuantity)}" step="${quantityInputStep((measurementUnitCatalog.find((unit) => unit.symbol === form.unitSymbol) ?? measurementUnitCatalog[0]).isInteger)}" placeholder="Optional" />
          ${assignIssues.minimumQuantity ? `<span class="field-error">${escapeHtml(assignIssues.minimumQuantity)}</span>` : ""}
        </label>
      `}
      <button type="submit" ${disabled(state.pendingAction !== null || state.bulkQueue.rows.length === 0 || Object.keys(assignIssues).length > 0)}>
        ${state.pendingAction === "bulk" ? "Labeling..." : `Label ${state.bulkQueue.summary.uniqueLabelCount} labels`}
      </button>
    </form>
  `;
}

function renderBulkMoveForm(state: RewriteUiState): string {
  return `
    <form class="form-grid" data-form="bulk-move" style="margin-top:1rem">
      <label class="wide">
        Destination location
        <input name="bulkMove.location" value="${attr(state.bulkQueue.moveForm.location)}" placeholder="Shelf B" />
      </label>
      <label class="wide">
        Notes
        <textarea name="bulkMove.notes">${escapeHtml(state.bulkQueue.moveForm.notes)}</textarea>
      </label>
      <button type="submit" ${disabled(state.pendingAction !== null || state.bulkQueue.rows.length === 0 || state.bulkQueue.moveForm.location.trim().length === 0)}>
        ${state.pendingAction === "bulk" ? "Moving..." : `Move ${state.bulkQueue.summary.uniqueLabelCount} labels`}
      </button>
    </form>
  `;
}

function renderBulkDeleteForm(state: RewriteUiState): string {
  return `
    <form class="form-grid" data-form="bulk-delete" style="margin-top:1rem">
      <p class="banner error wide">Bulk delete reverses fresh ingests only and preserves the correction audit trail.</p>
      <label class="wide">
        Reason
        <textarea name="bulkDelete.reason">${escapeHtml(state.bulkQueue.deleteForm.reason)}</textarea>
      </label>
      <button type="submit" ${disabled(state.pendingAction !== null || state.bulkQueue.rows.length === 0 || state.bulkQueue.deleteForm.reason.trim().length === 0)}>
        ${state.pendingAction === "bulk" ? "Deleting..." : `Delete ${state.bulkQueue.summary.uniqueLabelCount} ingests`}
      </button>
    </form>
  `;
}

function renderLabelCard(
  state: RewriteUiState,
  labelOptions: readonly PartType[],
  assignIssues: ReturnType<typeof getAssignFormIssues>,
): string {
  return `
    <div class="result-card">
      <h3>Assign ${escapeHtml(state.scanResult?.mode === "label" ? state.scanResult.qrCode.code : "")}</h3>
      ${state.lastAssignment ? `
        <div class="assign-same-bar">
          <button type="button" data-action="assign-same" ${disabled(state.pendingAction !== null)}>
            Assign Same (${escapeHtml(state.lastAssignment.partTypeName)} · ${escapeHtml(state.lastAssignment.location)})
          </button>
        </div>
      ` : ""}
      <form class="form-grid" data-form="assign">
        <div class="wide mode-toggle" role="radiogroup" aria-label="Part type mode">
          <button type="button" role="radio" class="${state.assignForm.partTypeMode === "existing" ? "selected" : ""}" aria-checked="${String(state.assignForm.partTypeMode === "existing")}" data-action="set-assign-mode" data-assign-mode="existing">Use existing type</button>
          <button type="button" role="radio" class="${state.assignForm.partTypeMode === "new" ? "selected" : ""}" aria-checked="${String(state.assignForm.partTypeMode === "new")}" data-action="set-assign-mode" data-assign-mode="new">Create new type</button>
        </div>
        ${state.assignForm.partTypeMode === "existing" ? renderExistingPartTypePicker(state, labelOptions, assignIssues) : renderNewPartTypeForm(state, assignIssues)}
        ${renderSharedAssignFields(state, assignIssues)}
        <button type="submit" ${disabled(state.pendingAction !== null || Object.keys(assignIssues).length > 0)}>
          ${state.pendingAction === "assign" ? "Assigning..." : "Assign QR"}
        </button>
      </form>
    </div>
  `;
}

function renderExistingPartTypePicker(
  state: RewriteUiState,
  labelOptions: readonly PartType[],
  assignIssues: ReturnType<typeof getAssignFormIssues>,
): string {
  const selected =
    labelOptions.find((partType) => partType.id === state.assignForm.existingPartTypeId) ??
    state.catalogSuggestions.find((partType) => partType.id === state.assignForm.existingPartTypeId);

  return `
    <label class="wide">
      Search existing part types
      <input name="labelSearch.query" value="${attr(state.labelSearch.query)}" placeholder="Arduino, JST, PLA, cotton..." />
    </label>
    ${state.labelSearch.error ? `<p class="banner error wide">${escapeHtml(state.labelSearch.error)}</p>` : ""}
    ${assignIssues.existingPartTypeId ? `<p class="field-error wide">${escapeHtml(assignIssues.existingPartTypeId)}</p>` : ""}
    <div class="wide picker" role="radiogroup" aria-label="Existing part types">
      ${labelOptions.length > 0 ? labelOptions.map((partType) => `
        <button
          key="${attr(partType.id)}"
          type="button"
          role="radio"
          aria-checked="${String(state.assignForm.existingPartTypeId === partType.id)}"
          class="${state.assignForm.existingPartTypeId === partType.id ? "selected" : ""}"
          data-action="select-existing-part"
          data-part-id="${attr(partType.id)}"
        >
          <strong>${escapeHtml(partType.canonicalName)}</strong>
          <span>${escapeHtml(formatCategoryPath(partType.categoryPath))}</span>
        </button>
      `).join("") : `<p class="muted-copy">No matching part types yet.</p>`}
    </div>
    ${selected?.countable ? `
      <div class="wide mode-toggle" role="radiogroup" aria-label="Inventory entry">
        <button type="button" role="radio" aria-checked="${String(state.assignForm.entityKind === "instance")}" class="${state.assignForm.entityKind === "instance" ? "selected" : ""}" data-action="set-entity-kind" data-entity-kind="instance">Tracked unit</button>
        <button type="button" role="radio" aria-checked="${String(state.assignForm.entityKind === "bulk")}" class="${state.assignForm.entityKind === "bulk" ? "selected" : ""}" data-action="set-entity-kind" data-entity-kind="bulk">Bulk pool</button>
      </div>
    ` : selected ? `
      <p class="muted-copy">Measured part types always use a bulk pool.</p>
    ` : ""}
    ${selected ? `
      <button type="button" class="disclosure wide" data-action="create-variant" data-part-id="${attr(selected.id)}">
        Create a variant of "${escapeHtml(selected.canonicalName)}"
      </button>
    ` : ""}
    ${selected && state.assignForm.entityKind === "bulk" ? `
      <label class="wide">
        Starting quantity (${escapeHtml(selected.unit.symbol)})
        <input
          type="number"
          min="${selected.unit.isInteger ? "1" : "0.000001"}"
          inputmode="decimal"
          name="assign.initialQuantity"
          value="${attr(state.assignForm.initialQuantity)}"
          step="${quantityInputStep(selected.unit.isInteger)}"
          placeholder="${selected.unit.isInteger ? "1" : "0.1"}"
        />
        ${assignIssues.initialQuantity ? `<span class="field-error">${escapeHtml(assignIssues.initialQuantity)}</span>` : ""}
      </label>
      <label class="wide">
        Low-stock threshold (${escapeHtml(selected.unit.symbol)})
        <input
          type="number"
          min="0"
          inputmode="decimal"
          name="assign.minimumQuantity"
          value="${attr(state.assignForm.minimumQuantity)}"
          step="${quantityInputStep(selected.unit.isInteger)}"
          placeholder="Optional"
        />
        ${assignIssues.minimumQuantity ? `<span class="field-error">${escapeHtml(assignIssues.minimumQuantity)}</span>` : ""}
      </label>
    ` : ""}
  `;
}

function renderNewPartTypeForm(
  state: RewriteUiState,
  assignIssues: ReturnType<typeof getAssignFormIssues>,
): string {
  return `
    <label class="wide">
      New canonical name
      <input name="assign.canonicalName" value="${attr(state.assignForm.canonicalName)}" placeholder="Arduino Uno R3" />
      ${assignIssues.canonicalName ? `<span class="field-error">${escapeHtml(assignIssues.canonicalName)}</span>` : ""}
    </label>
    <label class="wide">
      Category path
      <input name="assign.category" value="${attr(state.assignForm.category)}" placeholder="Electronics / Resistors / SMD 0603" />
      <small style="margin-top:0.3rem;text-transform:none;letter-spacing:0;font-family:var(--font-sans)">Use <code>/</code> for sub-categories. Each level is created in Part-DB.</small>
      ${assignIssues.category ? `<span class="field-error">${escapeHtml(assignIssues.category)}</span>` : ""}
    </label>
    ${state.knownCategories.length > 0 ? `
      <div class="wide picker" role="listbox" aria-label="Known categories">
        ${filterKnownValues(state.knownCategories, state.assignForm.category).map((cat) => {
          const segments = cat.split(" / ");
          const leaf = segments[segments.length - 1] ?? cat;
          return `
            <button type="button" role="option" aria-selected="${String(state.assignForm.category === cat)}" class="${state.assignForm.category === cat ? "selected" : ""}" data-action="pick-known-category" data-category="${attr(cat)}">
              <strong>${escapeHtml(leaf)}</strong>
              <span>${escapeHtml(cat)}</span>
            </button>
          `;
        }).join("")}
      </div>
    ` : ""}
    <div class="wide mode-toggle" role="radiogroup" aria-label="Tracking mode">
      <button type="button" role="radio" aria-checked="${String(state.assignForm.entityKind === "instance")}" class="${state.assignForm.entityKind === "instance" ? "selected" : ""}" data-action="set-entity-kind" data-entity-kind="instance">Tracked unit</button>
      <button type="button" role="radio" aria-checked="${String(state.assignForm.entityKind === "bulk")}" class="${state.assignForm.entityKind === "bulk" ? "selected" : ""}" data-action="set-entity-kind" data-entity-kind="bulk">Bulk pool</button>
    </div>
    ${state.assignForm.entityKind === "bulk" ? `
      <div class="wide mode-toggle" role="radiogroup" aria-label="Part type kind">
        <button type="button" role="radio" aria-checked="${String(state.assignForm.countable)}" class="${state.assignForm.countable ? "selected" : ""}" data-action="set-bulk-countability" data-countable="true">Piece-counted</button>
        <button type="button" role="radio" aria-checked="${String(!state.assignForm.countable)}" class="${!state.assignForm.countable ? "selected" : ""}" data-action="set-bulk-countability" data-countable="false">Measured</button>
      </div>
      <label>
        Unit of measure
        <select name="assign.unitSymbol">
          ${measurementUnitCatalog.filter((unit) => (state.assignForm.countable ? unit.isInteger : true)).map((unit) => `
            <option value="${attr(unit.symbol)}"${selected(unit.symbol === state.assignForm.unitSymbol)}>${escapeHtml(unit.name)} (${escapeHtml(unit.symbol)})</option>
          `).join("")}
        </select>
      </label>
      <label>
        Starting quantity
        <input type="number" min="${(measurementUnitCatalog.find((unit) => unit.symbol === state.assignForm.unitSymbol) ?? measurementUnitCatalog[0]).isInteger ? "1" : "0.000001"}" inputmode="decimal" name="assign.initialQuantity" value="${attr(state.assignForm.initialQuantity)}" step="${quantityInputStep((measurementUnitCatalog.find((unit) => unit.symbol === state.assignForm.unitSymbol) ?? measurementUnitCatalog[0]).isInteger)}" placeholder="${(measurementUnitCatalog.find((unit) => unit.symbol === state.assignForm.unitSymbol) ?? measurementUnitCatalog[0]).isInteger ? "1" : "0.1"}" />
        ${assignIssues.initialQuantity ? `<span class="field-error">${escapeHtml(assignIssues.initialQuantity)}</span>` : ""}
      </label>
    ` : ""}
  `;
}

function renderSharedAssignFields(
  state: RewriteUiState,
  assignIssues: ReturnType<typeof getAssignFormIssues>,
): string {
  const selectedMeasurementUnit =
    measurementUnitCatalog.find((unit) => unit.symbol === state.assignForm.unitSymbol) ??
    measurementUnitCatalog[0];
  return `
    <label class="wide">
      Location
      <input name="assign.location" value="${attr(state.assignForm.location)}" placeholder="e.g. Shelf A · Bin 7" autocomplete="off" />
      ${assignIssues.location ? `<span class="field-error">${escapeHtml(assignIssues.location)}</span>` : ""}
    </label>
    ${state.knownLocations.length > 0 ? `
      <div class="wide picker" role="listbox" aria-label="Known locations">
        ${filterKnownValues(state.knownLocations, state.assignForm.location).map((location) => `
          <button type="button" role="option" aria-selected="${String(state.assignForm.location === location)}" class="${state.assignForm.location === location ? "selected" : ""}" data-action="pick-known-location" data-location="${attr(location)}">
            <strong>${escapeHtml(location)}</strong>
            <span>existing location</span>
          </button>
        `).join("")}
      </div>
    ` : ""}
    ${state.assignForm.entityKind === "instance" ? `
      <label>
        Initial status
        <select name="assign.initialStatus">
          ${instanceStatuses.map((status) => `<option value="${status}"${selected(status === state.assignForm.initialStatus)}>${escapeHtml(status)}</option>`).join("")}
        </select>
      </label>
    ` : `
      <label>
        Low-stock threshold
        <input type="number" min="0" inputmode="decimal" name="assign.minimumQuantity" value="${attr(state.assignForm.minimumQuantity)}" step="${quantityInputStep(selectedMeasurementUnit.isInteger)}" placeholder="Optional" />
        ${assignIssues.minimumQuantity ? `<span class="field-error">${escapeHtml(assignIssues.minimumQuantity)}</span>` : ""}
      </label>
    `}
    <label class="wide">
      Notes
      <textarea name="assign.notes">${escapeHtml(state.assignForm.notes)}</textarea>
    </label>
  `;
}

function renderInteractCard(
  state: RewriteUiState,
  eventIssues: ReturnType<typeof getEventFormIssues>,
  bulkQuantityStep: "1" | "any",
  bulkUnitSymbol: string,
): string {
  if (!state.scanResult || state.scanResult.mode !== "interact") {
    return "";
  }

  return `
    <div class="result-card">
      <h3>${escapeHtml(state.scanResult.entity.partType.canonicalName)}</h3>
      <p class="muted-copy">
        ${escapeHtml(state.scanResult.entity.qrCode)} · ${escapeHtml(state.scanResult.entity.targetType)} in ${escapeHtml(state.scanResult.entity.location)}
      </p>
      ${state.scanResult.entity.targetType === "bulk" && state.scanResult.entity.quantity !== null ? `
        <div class="quantity-display">
          <span class="quantity-label">On hand</span>
          <span class="quantity-value">${escapeHtml(formatQuantity(state.scanResult.entity.quantity))}<span class="quantity-unit">${escapeHtml(state.scanResult.entity.partType.unit.symbol)}</span></span>
          ${state.scanResult.entity.minimumQuantity !== null ? `<span class="quantity-threshold">min ${escapeHtml(formatQuantity(state.scanResult.entity.minimumQuantity))} ${escapeHtml(state.scanResult.entity.partType.unit.symbol)}</span>` : ""}
        </div>
      ` : `<p>Current state: <strong>${escapeHtml(state.scanResult.entity.state)}</strong></p>`}
      <p class="muted-copy" style="font-size:0.78rem">Part-DB sync: ${escapeHtml(state.scanResult.entity.partDbSyncStatus)}</p>
      <div class="action-buttons">
        ${state.scanResult.availableActions.map((action) => `
          <button type="button" aria-pressed="${String(state.eventForm.event === action)}" class="${state.eventForm.event === action ? "selected" : ""}" data-action="select-event-action" data-event="${attr(action)}">${escapeHtml(actionLabel(action))}</button>
        `).join("")}
      </div>
      <form class="form-grid" data-form="event">
        ${(state.eventForm.event === "moved" || state.eventForm.event === "checked_out") ? `
          <label>
            Location
            <input name="event.location" value="${attr(state.eventForm.location)}" />
            ${eventIssues.location ? `<span class="field-error">${escapeHtml(eventIssues.location)}</span>` : ""}
          </label>
          ${state.eventForm.event === "moved" && state.scanResult.entity.targetType === "bulk" ? `
            <label>
              Units to move
              <input type="number" min="0" step="${bulkQuantityStep}" inputmode="decimal" name="event.splitQuantity" value="${attr(state.eventForm.splitQuantity)}" placeholder="All (${escapeHtml(state.scanResult.entity.quantity ?? 0)})" />
              <small style="margin-top:0.2rem;text-transform:none;letter-spacing:0;font-family:var(--font-sans)">Leave empty to move the entire bin.</small>
              ${eventIssues.splitQuantity ? `<span class="field-error">${escapeHtml(eventIssues.splitQuantity)}</span>` : ""}
            </label>
          ` : ""}
        ` : ""}
        ${state.eventForm.event === "checked_out" ? `
          <label>
            Assignee
            <input name="event.assignee" value="${attr(state.eventForm.assignee)}" />
          </label>
        ` : ""}
        ${(state.eventForm.event === "restocked" || state.eventForm.event === "consumed" || state.eventForm.event === "adjusted") && state.scanResult.entity.targetType === "bulk" ? `
          <label>
            ${escapeHtml(state.eventForm.event === "adjusted" ? `Adjustment (${bulkUnitSymbol})` : `Quantity change (${bulkUnitSymbol})`)}
            <input type="number" step="${bulkQuantityStep}" inputmode="decimal" name="event.quantityDelta" value="${attr(state.eventForm.quantityDelta)}" />
            ${eventIssues.quantityDelta ? `<span class="field-error">${escapeHtml(eventIssues.quantityDelta)}</span>` : ""}
          </label>
        ` : ""}
        ${state.eventForm.event === "stocktaken" && state.scanResult.entity.targetType === "bulk" ? `
          <label>
            Quantity on hand (${escapeHtml(bulkUnitSymbol)})
            <input type="number" min="0" step="${bulkQuantityStep}" inputmode="decimal" name="event.quantity" value="${attr(state.eventForm.quantity)}" />
            ${eventIssues.quantity ? `<span class="field-error">${escapeHtml(eventIssues.quantity)}</span>` : ""}
          </label>
        ` : ""}
        <label class="wide">
          Notes
          <textarea name="event.notes">${escapeHtml(state.eventForm.notes)}</textarea>
          ${eventIssues.notes ? `<span class="field-error">${escapeHtml(eventIssues.notes)}</span>` : ""}
        </label>
        <button type="submit" ${disabled(state.pendingAction !== null || Object.keys(eventIssues).length > 0)}>
          ${state.pendingAction === "event" ? "Saving..." : escapeHtml(`Confirm ${actionLabel(state.eventForm.event)}`)}
        </button>
      </form>
      ${renderScanLocations(state)}
      <div class="event-list">
        ${state.scanResult.recentEvents.map((stockEvent) => `
          <article>
            <strong>${escapeHtml(actionLabel(stockEvent.event))}</strong>
            <span>${escapeHtml(stockEvent.actor)} · ${escapeHtml(formatTimestamp(stockEvent.createdAt))}</span>
            <small>${escapeHtml(`${stockEvent.fromState ?? "none"} → ${stockEvent.toState ?? "none"}`)}</small>
          </article>
        `).join("")}
      </div>
      ${state.scanEdit.status === "closed"
        ? `<button type="button" class="disclosure" data-action="scan-edit-open" ${disabled(state.pendingAction !== null)}>Edit this part</button>`
        : renderScanEditPanel(state)}
    </div>
  `;
}

function renderScanLocations(state: RewriteUiState): string {
  if (!state.scanResult || state.scanResult.mode !== "interact") {
    return "";
  }
  const locations = state.scanLocations;
  const currentPartTypeId = state.scanResult.entity.partType.id;
  const scannedId = state.scanResult.entity.id;
  const unit = state.scanResult.entity.partType.unit;

  if (locations.status === "idle") {
    return "";
  }
  if (locations.partTypeId !== currentPartTypeId) {
    return "";
  }
  if (locations.status === "loading") {
    return `<p class="muted-copy" style="margin-top:0.5rem">Loading other locations...</p>`;
  }
  if (locations.status === "error") {
    return `<p class="banner error" style="margin-top:0.5rem">${escapeHtml(locations.message)}</p>`;
  }
  const { bulkStocks, instances } = locations.data;
  const total = bulkStocks.length + instances.length;
  if (total <= 1) {
    return `<p class="muted-copy" style="margin-top:0.5rem">No other ${escapeHtml(state.scanResult.entity.partType.canonicalName)} on record.</p>`;
  }

  return `
    <section class="scan-locations" aria-label="Other locations for this part" style="margin-top:0.75rem">
      <p class="muted-copy">At ${total} places:</p>
      <ul class="inventory-detail-list">
        ${bulkStocks.map((bulk) => `
          <li class="inventory-detail-item${bulk.id === scannedId ? " selected" : ""}">
            <code>${escapeHtml(bulk.qrCode)}</code>
            <span>${escapeHtml(bulk.location)}</span>
            <strong>${escapeHtml(String(bulk.quantity))} ${escapeHtml(unit.symbol)}</strong>
          </li>
        `).join("")}
        ${instances.map((instance) => `
          <li class="inventory-detail-item${instance.id === scannedId ? " selected" : ""}">
            <code>${escapeHtml(instance.qrCode)}</code>
            <span>${escapeHtml(instance.location)}</span>
            <strong>${escapeHtml(instance.status)}</strong>
            ${instance.assignee ? `<span>${escapeHtml(instance.assignee)}</span>` : ""}
          </li>
        `).join("")}
      </ul>
    </section>
  `;
}

function renderScanEditPanel(state: RewriteUiState): string {
  if (state.scanEdit.status !== "open" || !state.scanResult || state.scanResult.mode !== "interact") {
    return "";
  }
  const edit = state.scanEdit;
  const target = state.scanResult;
  const targetEntity = target.entity;

  return `
    <section class="scan-edit-panel" aria-label="Edit this part">
      <div class="scan-edit-header">
        <strong>Edit</strong>
        <button type="button" class="disclosure" data-action="scan-edit-close" ${disabled(state.pendingAction !== null)}>Close</button>
      </div>
      <p class="muted-copy">
        Category: ${escapeHtml(formatCategoryPath(targetEntity.partType.categoryPath))}
      </p>
      <div class="wide mode-toggle" role="radiogroup" aria-label="Edit action">
        <button type="button" role="radio" aria-checked="${String(edit.form.action === "reassign")}" class="${edit.form.action === "reassign" ? "selected" : ""}" data-action="set-scan-edit-action" data-scan-edit-action="reassign">Fix this item only</button>
        <button type="button" role="radio" aria-checked="${String(edit.form.action === "editShared")}" class="${edit.form.action === "editShared" ? "selected" : ""}" data-action="set-scan-edit-action" data-scan-edit-action="editShared">Rename shared type</button>
        <button type="button" role="radio" aria-checked="${String(edit.form.action === "reverseIngest")}" class="${edit.form.action === "reverseIngest" ? "selected" : ""}" data-action="set-scan-edit-action" data-scan-edit-action="reverseIngest">Reverse ingest</button>
      </div>

      ${edit.form.action === "reassign" ? renderScanEditReassignForm(state, edit.form, targetEntity) : ""}
      ${edit.form.action === "editShared" ? renderScanEditSharedForm(state, edit.form, targetEntity) : ""}
      ${edit.form.action === "reverseIngest" ? renderScanEditReverseForm(state, edit.form) : ""}

      ${edit.history.length > 0 || edit.historyError ? `
        <div class="event-list" style="margin-top:1rem">
          ${edit.historyError ? `<p class="banner error">${escapeHtml(edit.historyError)}</p>` : ""}
          ${edit.history.map((event) => `
            <article>
              <strong>${escapeHtml(correctionLabel(event.correctionKind))}</strong>
              <span>${escapeHtml(event.actor)} · ${escapeHtml(formatTimestamp(event.createdAt))}</span>
              <small>${escapeHtml(event.reason)}</small>
            </article>
          `).join("")}
        </div>
      ` : ""}
    </section>
  `;
}

function renderScanEditReassignForm(
  state: RewriteUiState,
  form: Extract<RewriteUiState["scanEdit"], { status: "open" }>["form"] & { action: "reassign" },
  targetEntity: Extract<RewriteUiState["scanResult"], { mode: "interact" }>["entity"],
): string {
  const compatibleReplacementTypes = (form.search.results.length > 0 ? form.search.results : state.catalogSuggestions)
    .filter((partType) => partType.id !== targetEntity.partType.id)
    .filter((partType) => {
      if (targetEntity.targetType === "instance") {
        return partType.countable;
      }
      return !partType.countable || partType.unit.isInteger;
    });

  return `
    <form class="form-grid" data-form="scan-edit-reassign">
      <label class="wide">
        Find replacement part type
        <input name="scanEditSearch.query" value="${attr(form.search.query)}" placeholder="Search existing type" />
      </label>
      ${form.search.error ? `<p class="banner error wide">${escapeHtml(form.search.error)}</p>` : ""}
      <div class="wide picker" role="radiogroup" aria-label="Replacement part type">
        ${compatibleReplacementTypes.map((partType) => `
          <button type="button" role="radio" aria-checked="${String(form.replacementPartTypeId === partType.id)}" class="${form.replacementPartTypeId === partType.id ? "selected" : ""}" data-action="select-scan-edit-part" data-part-id="${attr(partType.id)}">
            <strong>${escapeHtml(partType.canonicalName)}</strong>
            <span>${escapeHtml(formatCategoryPath(partType.categoryPath))}</span>
          </button>
        `).join("")}
      </div>
      <label class="wide">
        Reason
        <textarea name="scanEdit.reason">${escapeHtml(form.reason)}</textarea>
      </label>
      <button type="submit" ${disabled(state.pendingAction !== null)}>${state.pendingAction === "correct" ? "Saving..." : "Reassign this scan"}</button>
    </form>
  `;
}

function renderScanEditSharedForm(
  state: RewriteUiState,
  form: Extract<RewriteUiState["scanEdit"], { status: "open" }>["form"] & { action: "editShared" },
  targetEntity: Extract<RewriteUiState["scanResult"], { mode: "interact" }>["entity"],
): string {
  const usage = state.inventorySummary.find((row) => row.id === targetEntity.partType.id) ?? null;
  const sharedEditConflicts = findSharedTypeConflictCandidates(
    state.inventorySummary,
    targetEntity.partType.id,
    form.sharedCanonicalName,
    form.sharedCategory,
  );

  return `
    <form class="form-grid" data-form="scan-edit-shared">
      <p class="banner error wide">
        This renames the shared catalog type itself, not just the scanned item.
        ${usage ? escapeHtml(` It is currently linked to ${usage.instanceCount} tracked items and ${usage.bins} bulk bins.`) : ""}
      </p>
      <label class="wide">
        Shared canonical name
        <input name="scanEdit.sharedCanonicalName" value="${attr(form.sharedCanonicalName)}" />
      </label>
      <label class="wide">
        Shared category path
        <input name="scanEdit.sharedCategory" value="${attr(form.sharedCategory)}" />
      </label>
      ${sharedEditConflicts.length > 0 ? `
        <div class="wide">
          <p class="banner error">A matching part type already exists. Use 'Fix this item only' to reassign this scan instead of renaming the shared type.</p>
          <div class="picker" role="listbox" aria-label="Existing matching part types">
            ${sharedEditConflicts.map((match) => `
              <button type="button" role="option" data-action="select-scan-edit-part" data-part-id="${attr(match.id)}">
                <strong>${escapeHtml(match.canonicalName)}</strong>
                <span>${escapeHtml(formatCategoryPath(match.categoryPath))}</span>
              </button>
            `).join("")}
          </div>
        </div>
      ` : ""}
      <label class="wide">
        Reason
        <textarea name="scanEdit.reason">${escapeHtml(form.reason)}</textarea>
      </label>
      <button type="submit" ${disabled(state.pendingAction !== null || sharedEditConflicts.length > 0)}>${state.pendingAction === "correct" ? "Saving..." : "Rename shared type"}</button>
    </form>
  `;
}

function renderScanEditReverseForm(
  state: RewriteUiState,
  form: Extract<RewriteUiState["scanEdit"], { status: "open" }>["form"] & { action: "reverseIngest" },
): string {
  return `
    <form class="form-grid" data-form="scan-edit-reverse">
      <p class="banner error">Reverse ingest only when this was the original intake mistake. Historical lifecycle events remain in the audit trail.</p>
      <label class="wide">
        Reason
        <textarea name="scanEdit.reason">${escapeHtml(form.reason)}</textarea>
      </label>
      <button type="submit" ${disabled(state.pendingAction !== null)}>${state.pendingAction === "correct" ? "Reversing..." : "Reverse ingest"}</button>
    </form>
  `;
}

function renderInventoryTab(state: RewriteUiState): string {
  const rows = state.inventorySummary.filter((row) => {
    if (!state.inventoryUi.showEmpty && row.bins === 0 && row.instanceCount === 0) {
      return false;
    }
    const query = state.inventoryUi.query.trim().toLowerCase();
    if (!query) {
      return true;
    }
    const blob = [
      row.canonicalName,
      row.categoryPath.join(" / "),
      row.unit.symbol,
    ].join(" ").toLowerCase();
    return blob.includes(query);
  });

  const groups = new Map<string, typeof rows>();
  for (const row of rows) {
    const top = row.categoryPath[0] ?? "Uncategorized";
    const existing = groups.get(top) ?? [];
    existing.push(row);
    groups.set(top, existing);
  }

  return `
    <section id="panel-inventory" role="tabpanel" aria-labelledby="tab-inventory" class="panel">
      <div class="stock-controls">
        <input type="search" aria-label="Filter inventory" name="inventory.query" value="${attr(state.inventoryUi.query)}" placeholder="Search..." />
        <label class="inventory-toggle">
          <input type="checkbox" name="inventory.showEmpty"${checked(state.inventoryUi.showEmpty)} />
          Show empty
        </label>
      </div>
      ${rows.length === 0 ? `<p class="muted-copy">No inventory entries match your filter.</p>` : Array.from(groups.entries()).sort((a, b) => a[0].localeCompare(b[0])).map(([top, items]) => `
        <section class="inventory-group">
          <h3 class="inventory-group-title"><span>${escapeHtml(top)}</span><span class="inventory-group-count">${items.length}</span></h3>
          <ul class="inventory-list">
            ${items.map((row) => {
              const subPath = row.categoryPath.slice(1).join(" / ");
              const isStocked = row.bins > 0 || row.instanceCount > 0;
              const isExpanded = state.inventoryUi.expandedId === row.id;
              const expandedItems = isExpanded ? state.inventoryUi.expandedItems.get(row.id) ?? null : null;
              const expandedError = isExpanded ? state.inventoryUi.expandedErrors.get(row.id) ?? null : null;
              return `
                <li>
                  <button type="button" class="inventory-row ${isStocked ? "stocked" : "empty"} ${isExpanded ? "expanded" : ""}" data-action="toggle-inventory-expand" data-part-type-id="${attr(row.id)}" aria-expanded="${String(isExpanded)}">
                    <div class="inventory-row-name">
                      <strong>${escapeHtml(row.canonicalName)}</strong>
                      ${subPath ? `<span>${escapeHtml(subPath)}</span>` : ""}
                    </div>
                    <div class="inventory-row-quantity">
                      ${row.countable
                        ? row.onHand > 0
                          ? `<span class="qty-value">${row.instanceCount}</span><span class="qty-unit">tracked · ${escapeHtml(formatQuantity(row.onHand))} ${escapeHtml(row.unit.symbol)} pooled</span>`
                          : `<span class="qty-value">${row.instanceCount}</span><span class="qty-unit">tracked</span>`
                        : `<span class="qty-value">${escapeHtml(formatQuantity(row.onHand))}</span><span class="qty-unit">${escapeHtml(row.unit.symbol)}</span>`}
                    </div>
                  </button>
                  ${isExpanded ? `
                    <div class="inventory-row-detail">
                      ${expandedError ? `<p class="banner error">${escapeHtml(expandedError)}</p>` : expandedItems && (expandedItems.bulkStocks.length > 0 || expandedItems.instances.length > 0) ? `
                        <ul class="inventory-detail-list">
                          ${expandedItems.bulkStocks.map((bulk) => `
                            <li class="inventory-detail-item">
                              <code>${escapeHtml(bulk.qrCode)}</code>
                              <span>${escapeHtml(bulk.location)}</span>
                              <strong>${escapeHtml(formatQuantity(bulk.quantity))} ${escapeHtml(row.unit.symbol)}</strong>
                            </li>
                          `).join("")}
                          ${expandedItems.instances.map((instance) => `
                            <li class="inventory-detail-item">
                              <code>${escapeHtml(instance.qrCode)}</code>
                              <span>${escapeHtml(instance.location)}</span>
                              <strong>${escapeHtml(instance.status)}</strong>
                              ${instance.assignee ? `<span>${escapeHtml(instance.assignee)}</span>` : ""}
                            </li>
                          `).join("")}
                        </ul>
                      ` : `<p class="muted-copy">No items assigned to this part type.</p>`}
                    </div>
                  ` : ""}
                </li>
              `;
            }).join("")}
          </ul>
        </section>
      `).join("")}
    </section>
  `;
}

function renderActivityTab(state: RewriteUiState): string {
  const events = state.dashboard?.recentEvents ?? [];
  return `
    <section id="panel-activity" role="tabpanel" aria-labelledby="tab-activity" class="panel">
      <header class="activity-header">
        <p class="eyebrow">Activity</p>
        <h2>Recent events</h2>
      </header>
      ${events.length === 0 && state.scanHistory.length === 0 ? `<p class="activity-empty">No activity yet. Events appear here as you scan and update inventory.</p>` : ""}
      ${events.length > 0 ? `
        <ul class="activity-list">
          ${events.map((event) => `
            <li class="activity-item">
              <div class="activity-item-header">
                <span class="activity-action">${escapeHtml(`${actionLabel(event.event)} by ${event.actor ?? "system"}`)}</span>
                <span class="activity-time">${escapeHtml(formatTimestamp(event.createdAt))}</span>
              </div>
              ${event.partName ? `<span class="activity-item-name">${escapeHtml(event.partName)}</span>` : ""}
              <span class="activity-detail">${escapeHtml(buildActivityDetail(event))}</span>
            </li>
          `).join("")}
        </ul>
      ` : ""}
      ${state.scanHistory.length > 0 ? `
        <h3 class="activity-section-title">This session</h3>
        <ul class="activity-list">
          ${state.scanHistory.map((entry, index) => `
            <li class="activity-item">
              <div class="activity-item-header">
                <code class="activity-code">${escapeHtml(entry.code)}</code>
                <span class="activity-time">${escapeHtml(formatTimestamp(entry.timestamp))}</span>
              </div>
              <span class="activity-detail">${escapeHtml(scanModeLabel(entry.mode))}</span>
            </li>
          `).join("")}
        </ul>
      ` : ""}
    </section>
  `;
}

function renderAdminTab(state: RewriteUiState): string {
  const syncEnabled = state.partDbSyncStatus?.enabled ?? false;
  const mergeOptions = state.mergeSearch.results.length > 0 ? state.mergeSearch.results : state.catalogSuggestions;
  const isDownloadingLabels = state.downloadingBatchId === state.latestBatch?.id;

  return `
    <section id="panel-admin" role="tabpanel" aria-labelledby="tab-admin">
      <section class="panel">
        ${renderPanelTitle("Part-DB sync", "SmartDB remains writable while sync catches up in the background.")}
        <div class="sync-status-grid">
          <div class="sync-status-card"><strong>Queued</strong><span>${state.partDbSyncStatus?.pending ?? 0}</span></div>
          <div class="sync-status-card"><strong>In flight</strong><span>${state.partDbSyncStatus?.inFlight ?? 0}</span></div>
          <div class="sync-status-card"><strong>Recent failures</strong><span>${state.partDbSyncStatus?.failedLast24h ?? 0}</span></div>
          <div class="sync-status-card"><strong>Dead</strong><span>${state.partDbSyncStatus?.deadTotal ?? 0}</span></div>
        </div>
        <div class="sync-actions">
          <button type="button" data-action="sync-drain" ${disabled(!syncEnabled || state.pendingAction !== null)}>${state.pendingAction === "sync" ? "Syncing..." : "Run sync now"}</button>
          <button type="button" data-action="sync-backfill" ${disabled(!syncEnabled || state.pendingAction !== null)}>${state.pendingAction === "sync" ? "Queuing..." : "Queue backfill"}</button>
        </div>
        ${!syncEnabled ? `<p class="muted-copy">Background sync is disabled for this deployment.</p>` : state.partDbSyncFailures.length > 0 ? `
          <div class="event-list">
            ${state.partDbSyncFailures.map((failure) => `
              <article>
                <strong>${escapeHtml(failure.operation)}</strong>
                <span>${escapeHtml(`${failure.status} · attempt ${failure.attemptCount}`)}</span>
                <small>Last failure ${escapeHtml(formatTimestamp(failure.lastFailureAt ?? failure.createdAt))}</small>
                <small>${escapeHtml(describePartDbSyncFailure(failure))}</small>
                <button type="button" data-action="sync-retry" data-sync-id="${attr(failure.id)}" ${disabled(state.pendingAction !== null)}>Retry sync</button>
              </article>
            `).join("")}
          </div>
        ` : `<p class="muted-copy">No recent sync failures.</p>`}
      </section>

      <section class="panel">
        ${renderPanelTitle("Print QR batches", state.authState.status === "authenticated" ? `Pre-register sticker ranges. This batch will be attributed to ${state.authState.session.username}.` : "Pre-register sticker ranges.")}
        <p class="muted-copy batch-preview">Next range preview: ${escapeHtml(state.batchForm.prefix)}-${state.batchForm.startNumber} to ${escapeHtml(state.batchForm.prefix)}-${state.batchForm.startNumber + state.batchForm.count - 1} (${state.batchForm.count} labels)</p>
        ${state.latestBatch ? `
          <div class="latest-batch-card">
            <div>
              <strong>Latest batch</strong>
              <p>${escapeHtml(`${state.latestBatch.id} · ${state.latestBatch.prefix}-${state.latestBatch.startNumber} to ${state.latestBatch.prefix}-${state.latestBatch.endNumber}`)}</p>
              <small>${escapeHtml(`${state.latestBatch.endNumber - state.latestBatch.startNumber + 1} labels · created by ${state.latestBatch.actor}`)}</small>
            </div>
            <button type="button" data-action="download-labels" ${disabled(isDownloadingLabels)}>${isDownloadingLabels ? "Downloading..." : "Download PDF Labels"}</button>
          </div>
        ` : `<p class="muted-copy">No QR batch has been registered yet.</p>`}
        <form class="form-grid" data-form="batch">
          <label>Prefix<input name="batch.prefix" value="${attr(state.batchForm.prefix)}" maxlength="20" /></label>
          <label>Start number<input name="batch.startNumber" type="number" min="0" value="${attr(state.batchForm.startNumber)}" /></label>
          <label>Count<input name="batch.count" type="number" min="1" max="500" value="${attr(state.batchForm.count)}" /></label>
          <button type="submit" ${disabled(state.pendingAction !== null)}>${state.pendingAction === "batch" ? "Registering..." : "Register batch"}</button>
        </form>
      </section>

      <section class="panel">
        ${renderPanelTitle("Canonicalize provisional types", "Merge cleanup uses its own predictive search state and request ordering.")}
        <div class="stack">
          <label>
            Provisional source
            <select name="merge.sourceId">
              <option value="">Select provisional type</option>
              ${state.provisionalPartTypes.map((partType) => `<option value="${attr(partType.id)}"${selected(state.mergeSourceId === partType.id)}>${escapeHtml(`${partType.canonicalName} · ${formatCategoryPath(partType.categoryPath)}`)}</option>`).join("")}
            </select>
          </label>
          ${state.mergeSourceId ? `<button type="button" data-action="approve-part" data-part-id="${attr(state.mergeSourceId)}" ${disabled(state.pendingAction !== null)}>Keep As-Is</button>` : ""}
          <label>
            Find canonical destination
            <input name="mergeSearch.query" value="${attr(state.mergeSearch.query)}" placeholder="Search existing type" />
          </label>
          ${state.mergeSearch.error ? `<p class="banner error">${escapeHtml(state.mergeSearch.error)}</p>` : ""}
          <div class="picker" role="radiogroup" aria-label="Canonical destination">
            ${mergeOptions.map((partType) => `
              <button type="button" role="radio" aria-checked="${String(state.mergeDestinationId === partType.id)}" class="${state.mergeDestinationId === partType.id ? "selected" : ""}" data-action="select-merge-destination" data-part-id="${attr(partType.id)}">
                <strong>${escapeHtml(partType.canonicalName)}</strong>
                <span>${escapeHtml(formatCategoryPath(partType.categoryPath))}</span>
              </button>
            `).join("")}
          </div>
          <button type="button" data-action="merge-parts" ${disabled(state.pendingAction !== null)}>${state.pendingAction === "merge" ? "Merging..." : "Merge provisional type"}</button>
        </div>
      </section>

    </section>
  `;
}

function filterKnownValues(values: readonly string[], query: string): string[] {
  const normalized = query.trim().toLowerCase();
  const matches = normalized
    ? values.filter((value) => value.toLowerCase().includes(normalized))
    : [...values];
  return matches.slice(0, 6);
}

function buildActivityDetail(event: {
  readonly fromState: string | null;
  readonly toState: string | null;
  readonly location: string | null;
}): string {
  let detail = "";
  if (event.toState && event.fromState) {
    detail = `${event.fromState} → ${event.toState}`;
  } else if (event.toState) {
    detail = event.toState;
  }

  if (event.location) {
    detail = detail ? `${detail} · ${event.location}` : event.location;
  }

  return detail;
}

function scanModeLabel(mode: string): string {
  switch (mode) {
    case "interact":
      return "opened";
    case "label":
      return "ready to assign";
    case "unknown":
      return "unregistered";
    default:
      return mode;
  }
}

function bulkActionHeading(action: "label" | "move" | "delete"): string {
  switch (action) {
    case "label":
      return "Bulk label queue";
    case "move":
      return "Bulk move queue";
    case "delete":
      return "Bulk delete queue";
  }
}

function emptyBulkQueueCopy(action: "label" | "move" | "delete"): string {
  switch (action) {
    case "label":
      return "Scan printed Smart DB labels to build a homogeneous bulk labeling queue.";
    case "move":
      return "Scan assigned Smart DB labels to move several tracked items or bulk bins at once.";
    case "delete":
      return "Scan fresh ingests whose history is still just the original labeled event to reverse them in bulk.";
  }
}

function correctionLabel(kind: string): string {
  switch (kind) {
    case "entity_part_type_reassigned":
      return "Item/bin reassigned";
    case "part_type_definition_edited":
      return "Shared part type edited";
    case "ingest_reversed":
      return "Ingest reversed";
    default:
      return kind;
  }
}
