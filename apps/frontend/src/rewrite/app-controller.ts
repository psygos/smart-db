import {
  hasSmartDbRole,
  type CorrectionEvent,
  getMeasurementUnitBySymbol,
  sanitizeScannedCode,
  smartDbRoles,
  type AuthSession,
  type PartType,
  type ScanResponse,
} from "@smart-db/contracts";
import { createActor, type SnapshotFrom } from "xstate";
import {
  ApiClientError,
  api,
  downloadQrBatchLabelsPdf,
  loginUrl,
} from "../api";
import {
  actionLabel,
  errorMessage,
  formatCategoryPath,
} from "./presentation-helpers";
import { authMachine } from "./machines/auth-machine";
import type { RewriteFailure } from "./errors";
import { scanSessionMachine } from "./machines/scan-session-machine";
import {
  parseAssignForm,
  parseBatchForm,
  parseEditPartTypeDefinitionForm,
  type EventCommand,
  parseEventForm,
  parseMergeForm,
  parseReassignPartTypeForm,
  parseReverseIngestForm,
} from "./parsers";
import { renderApp } from "./render";
import { CameraScannerService } from "./services/camera-scanner-service";
import {
  defaultAssignForm,
  defaultBatchForm,
  defaultCameraState,
  defaultCorrectionUiState,
  defaultEventForm,
  defaultInventoryUiState,
  defaultPathPickerState,
  defaultSearchState,
  type AuthViewState,
  type PendingAction,
  type RewriteUiState,
  type TabId,
  type ToastRecord,
} from "./ui-state";
import {
  buildDefaultEventFormForEntity,
  consumeAuthError,
  findSharedTypeConflictCandidates,
  hasInProgressScanWork,
} from "./view-helpers";

interface FocusSnapshot {
  readonly key: string;
  readonly selectionStart: number | null;
  readonly selectionEnd: number | null;
}

type RewritePatch = {
  -readonly [K in keyof RewriteUiState]?: RewriteUiState[K];
};

export class RewriteAppController {
  private state: RewriteUiState = {
    theme: this.restoreTheme(),
    authState: {
      status: "checking",
      session: null,
      error: null,
    },
    dashboard: null,
    partDbStatus: null,
    partDbSyncStatus: null,
    partDbSyncFailures: [],
    latestBatch: null,
    catalogSuggestions: [],
    knownLocations: [],
    knownCategories: [],
    inventorySummary: [],
    inventoryUi: defaultInventoryUiState,
    correctionUi: defaultCorrectionUiState,
    provisionalPartTypes: [],
    labelSearch: defaultSearchState,
    mergeSearch: defaultSearchState,
    scanResult: null,
    batchForm: defaultBatchForm,
    assignForm: defaultAssignForm,
    eventForm: defaultEventForm,
    scanCode: "",
    scanMode: this.restoreScanMode(),
    scanHistory: [],
    lastAssignment: null,
    camera: defaultCameraState,
    cameraLookupCode: null,
    mergeSourceId: "",
    mergeDestinationId: "",
    pendingAction: null,
    downloadingBatchId: null,
    activeTab: "scan",
    toasts: [],
    isOnline: typeof navigator === "undefined" ? true : navigator.onLine,
    sessionExpiringSoon: false,
    refreshError: null,
    categoryPicker: defaultPathPickerState,
    locationPicker: defaultPathPickerState,
  };

  private readonly authActor = createActor(authMachine, { input: {} });
  private readonly scanActor = createActor(scanSessionMachine, { input: {} });
  private readonly authAbortController = new AbortController();
  private readonly searchControllers: Record<"label" | "merge" | "correction", AbortController | null> = {
    label: null,
    merge: null,
    correction: null,
  };
  private readonly searchRequestIds: Record<"label" | "merge" | "correction", number> = {
    label: 0,
    merge: 0,
    correction: 0,
  };
  private renderSuppressed = false;
  private readonly cameraService = new CameraScannerService({
    onScan: (code) => {
      void this.handleCameraScan(code);
    },
  });
  private scanAbortController: AbortController | null = null;
  private scanRequestId = 0;
  private toastTimers = new Map<string, number>();
  private pollTimer: number | null = null;
  private sessionTimer: number | null = null;

  constructor(private readonly root: HTMLElement) {}

  start(): void {
    this.authActor.subscribe((snapshot) => {
      this.patch({
        authState: this.mapAuthSnapshot(snapshot),
      });
    });
    this.cameraService.subscribe((snapshot) => {
      this.patch({
        camera: snapshot,
      });
    });
    this.authActor.start();
    this.scanActor.start();

    this.root.addEventListener("click", this.handleClick);
    this.root.addEventListener("submit", this.handleSubmit);
    this.root.addEventListener("input", this.handleInput);
    this.root.addEventListener("change", this.handleChange);
    this.root.addEventListener("keydown", this.handleKeyDown);
    window.addEventListener("online", this.handleOnline);
    window.addEventListener("offline", this.handleOffline);

    this.applyThemeToDOM(this.state.theme);
    this.render();
    void this.restoreSession(this.authAbortController.signal, consumeAuthError());
  }

  dispose(): void {
    this.authAbortController.abort();
    this.cameraService.destroy();
    this.searchControllers.label?.abort();
    this.searchControllers.merge?.abort();
    this.scanAbortController?.abort();
    this.authActor.stop();
    this.scanActor.stop();
    if (this.pollTimer !== null) {
      window.clearInterval(this.pollTimer);
    }
    if (this.sessionTimer !== null) {
      window.clearInterval(this.sessionTimer);
    }
    for (const timer of this.toastTimers.values()) {
      window.clearTimeout(timer);
    }
    this.root.removeEventListener("click", this.handleClick);
    this.root.removeEventListener("submit", this.handleSubmit);
    this.root.removeEventListener("input", this.handleInput);
    this.root.removeEventListener("change", this.handleChange);
    this.root.removeEventListener("keydown", this.handleKeyDown);
    window.removeEventListener("online", this.handleOnline);
    window.removeEventListener("offline", this.handleOffline);
  }

  private readonly handleOnline = () => {
    this.patch({ isOnline: true });
  };

  private readonly handleOffline = () => {
    this.patch({ isOnline: false });
  };

  private readonly handleClick = (event: Event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }

    const actionEl = target.closest<HTMLElement>("[data-action]");
    if (!actionEl) {
      return;
    }

    const action = actionEl.dataset.action;
    if (!action) {
      return;
    }

    event.preventDefault();

    switch (action) {
      case "login":
        void this.handleLogin();
        break;
      case "logout":
        void this.handleLogout();
        break;
      case "toggle-theme":
        this.setTheme(this.state.theme === "dark" ? "light" : "dark");
        break;
      case "dismiss-toast":
        if (actionEl.dataset.toastId) {
          this.dismissToast(actionEl.dataset.toastId);
        }
        break;
      case "change-tab":
        if (actionEl.dataset.tab) {
          this.patch({ activeTab: actionEl.dataset.tab as TabId });
        }
        break;
      case "scan-next":
        this.handleScanNext();
        break;
      case "register-unknown":
        if (actionEl.dataset.code) {
          this.handleRegisterUnknown(actionEl.dataset.code);
        }
        break;
      case "assign-same":
        void this.handleAssignSame();
        break;
      case "set-scan-mode":
        if (actionEl.dataset.scanMode === "increment" || actionEl.dataset.scanMode === "inspect") {
          this.setScanMode(actionEl.dataset.scanMode);
        }
        break;
      case "set-assign-mode":
        if (actionEl.dataset.assignMode === "existing" || actionEl.dataset.assignMode === "new") {
          this.setAssignMode(actionEl.dataset.assignMode);
        }
        break;
      case "set-correction-action":
        if (
          actionEl.dataset.correctionAction === "reassign" ||
          actionEl.dataset.correctionAction === "editShared" ||
          actionEl.dataset.correctionAction === "reverseIngest"
        ) {
          this.setCorrectionAction(actionEl.dataset.correctionAction);
        }
        break;
      case "select-correction-part":
        if (actionEl.dataset.partId) {
          this.patch({
            correctionUi: {
              ...this.state.correctionUi,
              replacementPartTypeId: actionEl.dataset.partId,
            },
          });
        }
        break;
      case "use-correction-match":
        if (actionEl.dataset.partId) {
          this.patch({
            correctionUi: {
              ...this.state.correctionUi,
              action: "reassign",
              replacementPartTypeId: actionEl.dataset.partId,
              reason: "",
              search: {
                ...this.state.correctionUi.search,
                query: actionEl.dataset.query ?? "",
                results: [...this.state.catalogSuggestions],
                status: "idle",
                error: null,
              },
            },
          });
          void this.performSearch("correction", actionEl.dataset.query ?? "");
        }
        break;
      case "select-existing-part":
        if (actionEl.dataset.partId) {
          this.selectExistingPartType(actionEl.dataset.partId);
        }
        break;
      case "create-variant":
        if (actionEl.dataset.partId) {
          this.createVariant(actionEl.dataset.partId);
        }
        break;
      case "set-entity-kind":
        if (actionEl.dataset.entityKind === "instance" || actionEl.dataset.entityKind === "bulk") {
          this.setAssignEntityKind(actionEl.dataset.entityKind);
        }
        break;
      case "set-bulk-countability":
        if (actionEl.dataset.countable === "true" || actionEl.dataset.countable === "false") {
          this.setBulkCountability(actionEl.dataset.countable === "true");
        }
        break;
      case "toggle-path-picker": {
        const kind = actionEl.dataset.kind;
        if (kind === "category" || kind === "location") {
          const key = kind === "category" ? "categoryPicker" : "locationPicker";
          this.patch({ [key]: { ...this.state[key], open: !this.state[key].open } } as Partial<RewriteUiState>);
        }
        break;
      }
      case "close-path-picker": {
        const kind = actionEl.dataset.kind;
        if (kind === "category" || kind === "location") {
          const key = kind === "category" ? "categoryPicker" : "locationPicker";
          this.patch({ [key]: { ...this.state[key], open: false, createOpen: false } } as Partial<RewriteUiState>);
        }
        break;
      }
      case "toggle-path-expand": {
        const kind = actionEl.dataset.kind;
        const path = actionEl.dataset.path;
        if ((kind === "category" || kind === "location") && typeof path === "string") {
          const key = kind === "category" ? "categoryPicker" : "locationPicker";
          const cur = this.state[key];
          const already = cur.expanded.includes(path);
          const expanded = already ? cur.expanded.filter((p) => p !== path) : [...cur.expanded, path];
          this.patch({ [key]: { ...cur, expanded } } as Partial<RewriteUiState>);
        }
        break;
      }
      case "pick-path-node": {
        const kind = actionEl.dataset.kind;
        const path = actionEl.dataset.path;
        if ((kind === "category" || kind === "location") && typeof path === "string") {
          const pickerKey = kind === "category" ? "categoryPicker" : "locationPicker";
          const formKey = kind === "category" ? "category" : "location";
          this.patch({
            assignForm: { ...this.state.assignForm, [formKey]: path },
            [pickerKey]: { ...this.state[pickerKey], open: false, query: "", createOpen: false },
          } as Partial<RewriteUiState>);
        }
        break;
      }
      case "open-path-create": {
        const kind = actionEl.dataset.kind;
        if (kind === "category" || kind === "location") {
          const key = kind === "category" ? "categoryPicker" : "locationPicker";
          const cur = this.state[key];
          const currentValue = kind === "category" ? this.state.assignForm.category : this.state.assignForm.location;
          this.patch({
            [key]: { ...cur, createOpen: true, createParent: currentValue, createName: "" },
          } as Partial<RewriteUiState>);
        }
        break;
      }
      case "close-path-create": {
        const kind = actionEl.dataset.kind;
        if (kind === "category" || kind === "location") {
          const key = kind === "category" ? "categoryPicker" : "locationPicker";
          this.patch({
            [key]: { ...this.state[key], createOpen: false, createName: "" },
          } as Partial<RewriteUiState>);
        }
        break;
      }
      case "set-path-create-parent": {
        const kind = actionEl.dataset.kind;
        const path = actionEl.dataset.path;
        if ((kind === "category" || kind === "location") && typeof path === "string") {
          const key = kind === "category" ? "categoryPicker" : "locationPicker";
          this.patch({ [key]: { ...this.state[key], createParent: path } } as Partial<RewriteUiState>);
        }
        break;
      }
      case "commit-path-create": {
        const kind = actionEl.dataset.kind;
        if (kind === "category" || kind === "location") {
          const pickerKey = kind === "category" ? "categoryPicker" : "locationPicker";
          const formKey = kind === "category" ? "category" : "location";
          const cur = this.state[pickerKey];
          const leaf = cur.createName.trim();
          if (!leaf) break;
          const parent = cur.createParent.trim();
          const full = parent === "" ? leaf : `${parent} / ${leaf}`;
          this.patch({
            assignForm: { ...this.state.assignForm, [formKey]: full },
            [pickerKey]: { ...cur, open: false, createOpen: false, createParent: "", createName: "", query: "" },
          } as Partial<RewriteUiState>);
        }
        break;
      }
      case "select-event-action":
        if (actionEl.dataset.event) {
          this.patch({
            eventForm: {
              ...this.state.eventForm,
              event: actionEl.dataset.event as typeof this.state.eventForm.event,
            },
          });
        }
        break;
      case "toggle-inventory-expand":
        if (actionEl.dataset.partTypeId) {
          void this.toggleInventoryExpand(actionEl.dataset.partTypeId);
        }
        break;
      case "download-labels":
        void this.handleDownloadLatestBatchLabels();
        break;
      case "sync-drain":
        void this.handleDrainPartDbSync();
        break;
      case "sync-backfill":
        void this.handleBackfillPartDbSync();
        break;
      case "sync-retry":
        if (actionEl.dataset.syncId) {
          void this.handleRetryPartDbSync(actionEl.dataset.syncId);
        }
        break;
      case "approve-part":
        if (actionEl.dataset.partId) {
          void this.handleApprovePartType(actionEl.dataset.partId);
        }
        break;
      case "select-merge-destination":
        if (actionEl.dataset.partId) {
          this.patch({ mergeDestinationId: actionEl.dataset.partId });
        }
        break;
      case "merge-parts":
        void this.handleMergePartTypes();
        break;
      case "camera-start":
        void this.startCamera();
        break;
      case "camera-stop":
        this.cameraService.stop();
        break;
      case "camera-scan-next":
        this.handleCameraScanNext();
        break;
      case "correction-clear":
        this.patch({ correctionUi: defaultCorrectionUiState });
        break;
      default:
        break;
    }
  };

  private readonly handleSubmit = (event: Event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) {
      return;
    }

    const formName = form.dataset.form;
    if (!formName) {
      return;
    }

    event.preventDefault();

    switch (formName) {
      case "scan":
        void this.handleScan();
        break;
      case "correction-scan":
        void this.handleCorrectionScan();
        break;
      case "assign":
        void this.handleAssign();
        break;
      case "event":
        void this.handleRecordEvent();
        break;
      case "batch":
        void this.handleRegisterBatch();
        break;
      case "correction-reassign":
        void this.handleCorrectionReassign();
        break;
      case "correction-edit-shared":
        void this.handleCorrectionEditShared();
        break;
      case "correction-reverse-ingest":
        void this.handleCorrectionReverseIngest();
        break;
      default:
        break;
    }
  };

  private readonly handleInput = (event: Event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement)) {
      return;
    }

    const name = target.name;
    if (!name) {
      return;
    }

    this.applyInput(name, target instanceof HTMLInputElement && target.type === "checkbox" ? target.checked : target.value);
  };

  private readonly handleChange = (event: Event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) {
      return;
    }
    const name = target.name;
    if (!name) {
      return;
    }
    this.applyInput(name, target.type === "checkbox" ? target.checked : target.value);
  };

  private readonly handleKeyDown = (event: KeyboardEvent) => {
    const target = event.target;
    if (!(target instanceof HTMLElement) || target.getAttribute("role") !== "tab") {
      return;
    }

    const tabs = Array.from(this.root.querySelectorAll<HTMLElement>("[role='tab']")).map((element) => element.dataset.tab as TabId).filter(Boolean);
    const currentIndex = tabs.findIndex((tab) => tab === this.state.activeTab);
    let nextIndex: number | null = null;

    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      nextIndex = (currentIndex + 1) % tabs.length;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = tabs.length - 1;
    }

    if (nextIndex !== null) {
      event.preventDefault();
      const nextTab = tabs[nextIndex];
      if (nextTab) {
        this.patch({ activeTab: nextTab });
        window.requestAnimationFrame(() => {
          this.root.querySelector<HTMLElement>(`[data-tab="${nextTab}"]`)?.focus();
        });
      }
    }
  };

  private applyInput(name: string, rawValue: string | boolean): void {
    switch (name) {
      case "scanCode":
        this.patch({ scanCode: String(rawValue) });
        return;
      case "correction.scanCode":
        this.patch({
          correctionUi: {
            ...this.state.correctionUi,
            scanCode: String(rawValue),
          },
        });
        return;
      case "labelSearch.query":
        this.patch({
          labelSearch: {
            ...this.state.labelSearch,
            query: String(rawValue),
          },
        });
        void this.performSearch("label", String(rawValue));
        return;
      case "mergeSearch.query":
        this.patch({
          mergeSearch: {
            ...this.state.mergeSearch,
            query: String(rawValue),
          },
        });
        void this.performSearch("merge", String(rawValue));
        return;
      case "correctionSearch.query":
        this.patch({
          correctionUi: {
            ...this.state.correctionUi,
            search: {
              ...this.state.correctionUi.search,
              query: String(rawValue),
            },
          },
        });
        void this.performSearch("correction", String(rawValue));
        return;
      case "inventory.query":
        this.patch({
          inventoryUi: {
            ...this.state.inventoryUi,
            query: String(rawValue),
          },
        });
        return;
      case "inventory.showEmpty":
        this.patch({
          inventoryUi: {
            ...this.state.inventoryUi,
            showEmpty: Boolean(rawValue),
          },
        });
        return;
      case "pathPicker.category.query":
        this.patch({ categoryPicker: { ...this.state.categoryPicker, query: String(rawValue) } });
        return;
      case "pathPicker.location.query":
        this.patch({ locationPicker: { ...this.state.locationPicker, query: String(rawValue) } });
        return;
      case "pathPicker.category.createName":
        this.patch({ categoryPicker: { ...this.state.categoryPicker, createName: String(rawValue) } });
        return;
      case "pathPicker.location.createName":
        this.patch({ locationPicker: { ...this.state.locationPicker, createName: String(rawValue) } });
        return;
      case "merge.sourceId":
        this.patch({ mergeSourceId: String(rawValue) });
        return;
      case "batch.prefix":
      case "batch.startNumber":
      case "batch.count":
        this.updateBatchForm(name, rawValue);
        return;
      default:
        if (name.startsWith("assign.")) {
          this.updateAssignForm(name, rawValue);
        } else if (name.startsWith("event.")) {
          this.updateEventForm(name, rawValue);
        } else if (name.startsWith("correction.")) {
          this.updateCorrectionForm(name, rawValue);
        }
    }
  }

  private updateBatchForm(name: string, rawValue: string | boolean): void {
    const value = String(rawValue);
    if (name === "batch.prefix") {
      this.patch({
        batchForm: {
          ...this.state.batchForm,
          prefix: value,
        },
      });
      return;
    }

    const parsed = Number(value);
    this.patch({
      batchForm: {
        ...this.state.batchForm,
        [name === "batch.startNumber" ? "startNumber" : "count"]: Number.isFinite(parsed) ? parsed : 0,
      },
    });
  }

  private updateAssignForm(name: string, rawValue: string | boolean): void {
    const value = String(rawValue);
    const next = { ...this.state.assignForm };
    switch (name) {
      case "assign.canonicalName":
        next.canonicalName = value;
        break;
      case "assign.category":
        next.category = value;
        break;
      case "assign.unitSymbol":
        next.unitSymbol = value;
        break;
      case "assign.initialQuantity":
        next.initialQuantity = value;
        break;
      case "assign.location":
        next.location = value;
        break;
      case "assign.minimumQuantity":
        next.minimumQuantity = value;
        break;
      case "assign.notes":
        next.notes = value;
        break;
      case "assign.initialStatus":
        next.initialStatus = value as typeof next.initialStatus;
        break;
      default:
        return;
    }
    this.patch({ assignForm: next });
  }

  private updateEventForm(name: string, rawValue: string | boolean): void {
    const value = String(rawValue);
    const next = { ...this.state.eventForm };
    switch (name) {
      case "event.location":
        next.location = value;
        break;
      case "event.splitQuantity":
        next.splitQuantity = value;
        break;
      case "event.assignee":
        next.assignee = value;
        break;
      case "event.quantityDelta":
        next.quantityDelta = value;
        break;
      case "event.quantity":
        next.quantity = value;
        break;
      case "event.notes":
        next.notes = value;
        break;
      default:
        return;
    }
    this.patch({ eventForm: next });
  }

  private updateCorrectionForm(name: string, rawValue: string | boolean): void {
    const value = String(rawValue);
    const next = { ...this.state.correctionUi };
    switch (name) {
      case "correction.reason":
        next.reason = value;
        break;
      case "correction.sharedCanonicalName":
        next.sharedCanonicalName = value;
        break;
      case "correction.sharedCategory":
        next.sharedCategory = value;
        break;
      default:
        return;
    }
    this.patch({ correctionUi: next });
  }

  private async restoreSession(signal: AbortSignal, authError: string | null): Promise<void> {
    this.authActor.send({ type: "SESSION.MISSING" });
    this.patch({
      authState: {
        status: "checking",
        session: null,
        error: null,
      },
    });
    try {
      const session = await api.getSession(signal);
      this.authActor.send({ type: "SESSION.RESTORED", session });
      if (authError) {
        this.addToast(authError, "error");
      }
      await this.loadAuthenticatedData(session);
      this.startBackgroundTimers();
    } catch (caught) {
      if (signal.aborted) {
        return;
      }
      const unauthenticated = caught instanceof ApiClientError && caught.code === "unauthenticated";
      if (unauthenticated) {
        this.authActor.send({ type: "SESSION.MISSING" });
      } else {
        this.authActor.send({
          type: "AUTH.FAILED",
          failure: {
            kind: "unexpected",
            operation: "session.restore",
            message: errorMessage(caught),
            retryability: "never",
            details: { machine: "auth" },
            cause: caught,
          },
        });
      }
      this.patch({
        authState: {
          status: "unauthenticated",
          session: null,
          error: authError ?? (unauthenticated ? null : errorMessage(caught)),
        },
      });
    }
  }

  private startBackgroundTimers(): void {
    if (this.pollTimer !== null) {
      window.clearInterval(this.pollTimer);
    }
    this.pollTimer = window.setInterval(() => {
      if (this.state.authState.status === "authenticated") {
        void this.loadAuthenticatedData();
      }
    }, 30_000);

    if (this.sessionTimer !== null) {
      window.clearInterval(this.sessionTimer);
    }
    this.sessionTimer = window.setInterval(() => {
      if (this.state.authState.status !== "authenticated") {
        this.patch({ sessionExpiringSoon: false });
        return;
      }
      const expiresAt = this.state.authState.session.expiresAt;
      if (!expiresAt) {
        this.patch({ sessionExpiringSoon: false });
        return;
      }
      const remainingMs = Date.parse(expiresAt) - Date.now();
      const expiringSoon = remainingMs > 0 && remainingMs <= 5 * 60 * 1000;
      this.patch({ sessionExpiringSoon: expiringSoon });
    }, 30_000);
  }

  private resetAuthenticatedView(): void {
    this.cameraService.stop();
    void this.cameraService.attachVideoElement(null);
    this.searchControllers.label?.abort();
    this.searchControllers.merge?.abort();
    this.scanAbortController?.abort();
    this.patch({
      dashboard: null,
      partDbStatus: null,
      partDbSyncStatus: null,
      partDbSyncFailures: [],
      latestBatch: null,
      catalogSuggestions: [],
      knownLocations: [],
      knownCategories: [],
      inventorySummary: [],
      inventoryUi: defaultInventoryUiState,
      correctionUi: defaultCorrectionUiState,
      provisionalPartTypes: [],
      labelSearch: defaultSearchState,
      mergeSearch: defaultSearchState,
      scanResult: null,
      batchForm: defaultBatchForm,
      assignForm: defaultAssignForm,
      eventForm: defaultEventForm,
      scanCode: "",
      scanHistory: [],
      lastAssignment: null,
      cameraLookupCode: null,
      mergeSourceId: "",
      mergeDestinationId: "",
      pendingAction: null,
      downloadingBatchId: null,
      refreshError: null,
      categoryPicker: defaultPathPickerState,
      locationPicker: defaultPathPickerState,
    });
  }

  private handleAuthenticationFailure(caught: unknown): void {
    this.resetAuthenticatedView();
    this.authActor.send({
      type: "AUTH.FAILED",
      failure: {
        kind: "auth",
        operation: "session.restore",
        code: "unauthenticated",
        message: errorMessage(caught),
        retryability: "after-user-action",
        details: { sessionKnown: false },
      },
    });
    this.patch({
      authState: {
        status: "unauthenticated",
        session: null,
        error: errorMessage(caught),
      },
    });
  }

  private handleApiFailure(caught: unknown): boolean {
    if (caught instanceof ApiClientError && caught.code === "unauthenticated") {
      this.handleAuthenticationFailure(caught);
      return true;
    }
    return false;
  }

  private async loadAuthenticatedData(sessionOverride?: AuthSession | null): Promise<void> {
    const activeSession = sessionOverride ?? (this.state.authState.status === "authenticated" ? this.state.authState.session : null);
    const canAccessAdmin = activeSession !== null && hasSmartDbRole(activeSession.roles, smartDbRoles.admin);

    const [
      dashboardResult,
      partDbResult,
      syncStatusResult,
      syncFailuresResult,
      provisionalResult,
      partTypesResult,
      latestBatchResult,
      locationsResult,
      inventoryResult,
    ] = await Promise.allSettled([
      api.getDashboard(),
      api.getPartDbStatus(),
      canAccessAdmin ? api.getPartDbSyncStatus() : Promise.resolve(null),
      canAccessAdmin ? api.getPartDbSyncFailures() : Promise.resolve([]),
      canAccessAdmin ? api.getProvisionalPartTypes() : Promise.resolve([]),
      api.searchPartTypes(""),
      canAccessAdmin ? api.getLatestQrBatch() : Promise.resolve(null),
      api.getKnownLocations(),
      api.getInventorySummary(),
    ]);

    for (const result of [
      dashboardResult,
      partDbResult,
      syncStatusResult,
      syncFailuresResult,
      provisionalResult,
      partTypesResult,
      latestBatchResult,
      locationsResult,
      inventoryResult,
    ]) {
      if (result.status === "rejected" && this.handleApiFailure(result.reason)) {
        return;
      }
    }

    const nonAuthFailures = [
      dashboardResult,
      partDbResult,
      syncStatusResult,
      syncFailuresResult,
      provisionalResult,
      partTypesResult,
      latestBatchResult,
      locationsResult,
      inventoryResult,
    ].filter((result): result is PromiseRejectedResult => result.status === "rejected");

    const patch: RewritePatch = {};

    if (dashboardResult.status === "fulfilled") {
      patch.dashboard = dashboardResult.value;
    }
    if (locationsResult.status === "fulfilled") {
      patch.knownLocations = locationsResult.value;
    }
    if (inventoryResult.status === "fulfilled") {
      patch.inventorySummary = inventoryResult.value;
      patch.knownCategories = Array.from(new Set(inventoryResult.value.map((row) => row.categoryPath.join(" / ")))).sort();
    }
    if (partDbResult.status === "fulfilled") {
      patch.partDbStatus = partDbResult.value;
    }
    if (syncStatusResult.status === "fulfilled") {
      patch.partDbSyncStatus = syncStatusResult.value;
    }
    if (syncFailuresResult.status === "fulfilled") {
      patch.partDbSyncFailures = syncFailuresResult.value;
    }
    if (latestBatchResult.status === "fulfilled") {
      patch.latestBatch = latestBatchResult.value;
    }
    if (provisionalResult.status === "fulfilled") {
      patch.provisionalPartTypes = provisionalResult.value;
    }
    if (partTypesResult.status === "fulfilled") {
      patch.catalogSuggestions = partTypesResult.value;
      patch.mergeSearch = this.state.mergeSearch.query
        ? this.state.mergeSearch
        : { ...this.state.mergeSearch, results: partTypesResult.value, status: "idle", error: null };
      patch.labelSearch = this.state.labelSearch.query
        ? this.state.labelSearch
        : { ...this.state.labelSearch, results: partTypesResult.value, status: "idle", error: null };
    }

    patch.refreshError =
      nonAuthFailures.length > 0
        ? `Some data could not be refreshed: ${errorMessage(nonAuthFailures[0]!.reason)}`
        : null;

    this.patch(patch);

    if (latestBatchResult.status === "fulfilled" && latestBatchResult.value) {
      const latestBatch = latestBatchResult.value;
      if (
        this.state.batchForm.prefix === defaultBatchForm.prefix &&
        this.state.batchForm.startNumber === defaultBatchForm.startNumber &&
        this.state.batchForm.count === defaultBatchForm.count
      ) {
        this.patch({
          batchForm: {
            ...this.state.batchForm,
            prefix: latestBatch.prefix,
            startNumber: latestBatch.endNumber + 1,
          },
        });
      }
    }
  }

  private async handleLogin(): Promise<void> {
    this.patch({ pendingAction: "login" });
    if (typeof window !== "undefined") {
      window.location.assign(loginUrl(window.location.href));
    }
  }

  private async handleLogout(): Promise<void> {
    this.patch({ pendingAction: "logout" });
    this.authActor.send({ type: "LOGOUT.REQUESTED" });
    let loggedOut = false;
    try {
      const response = await api.logout();
      if (typeof window !== "undefined" && response.redirectUrl) {
        window.location.assign(response.redirectUrl);
        return;
      }
      this.resetAuthenticatedView();
      this.authActor.send({ type: "LOGOUT.SUCCEEDED" });
      loggedOut = true;
    } catch (caught) {
      if (caught instanceof ApiClientError && caught.code === "unauthenticated") {
        this.resetAuthenticatedView();
        this.authActor.send({ type: "LOGOUT.SUCCEEDED" });
        loggedOut = true;
      } else if (!this.handleApiFailure(caught)) {
        this.authActor.send({
          type: "LOGOUT.FAILED",
          failure: {
            kind: "unexpected",
            operation: "session.logout",
            message: errorMessage(caught),
            retryability: "never",
            details: { machine: "auth" },
            cause: caught,
          },
        });
        this.addToast(errorMessage(caught), "error");
        this.authActor.send({ type: "FAILURE.ACKNOWLEDGED" });
      }
    } finally {
      this.patch({
        pendingAction: null,
        ...(loggedOut
          ? {
              authState: {
                status: "unauthenticated",
                session: null,
                error: null,
              } as const,
            }
          : {}),
      });
    }
  }

  private async performSearch(surface: "label" | "merge" | "correction", query: string): Promise<void> {
    this.searchControllers[surface]?.abort();
    this.searchRequestIds[surface] += 1;
    const requestId = this.searchRequestIds[surface];
    const controller = new AbortController();
    this.searchControllers[surface] = controller;

    const current =
      surface === "label"
        ? this.state.labelSearch
        : surface === "merge"
          ? this.state.mergeSearch
          : this.state.correctionUi.search;
    this.patch({
      ...(surface === "correction"
        ? {
            correctionUi: {
              ...this.state.correctionUi,
              search: {
                ...current,
                query,
                status: "loading",
                error: null,
              },
            },
          }
        : {
            [surface === "label" ? "labelSearch" : "mergeSearch"]: {
              ...current,
              query,
              status: "loading",
              error: null,
            },
          }),
    } as Partial<RewriteUiState>);

    try {
      const results = await api.searchPartTypes(query, controller.signal);
      if (requestId !== this.searchRequestIds[surface]) {
        return;
      }
      this.patch({
        ...(surface === "correction"
          ? {
              correctionUi: {
                ...this.state.correctionUi,
                search: {
                  query,
                  results,
                  status: "idle",
                  error: null,
                },
              },
            }
          : {
              [surface === "label" ? "labelSearch" : "mergeSearch"]: {
                query,
                results,
                status: "idle",
                error: null,
              },
            }),
      } as Partial<RewriteUiState>);
    } catch (caught) {
      if (controller.signal.aborted) {
        return;
      }
      if (this.handleApiFailure(caught)) {
        return;
      }
      this.patch({
        ...(surface === "correction"
          ? {
              correctionUi: {
                ...this.state.correctionUi,
                search: {
                  ...current,
                  query,
                  status: "error",
                  error: errorMessage(caught),
                },
              },
            }
          : {
              [surface === "label" ? "labelSearch" : "mergeSearch"]: {
                ...current,
                query,
                status: "error",
                error: errorMessage(caught),
              },
            }),
      } as Partial<RewriteUiState>);
      this.addToast(errorMessage(caught), "error");
    }
  }

  private async performScan(code: string, options: { silent?: boolean; source?: "manual" | "camera" } = {}): Promise<void> {
    const { silent = false, source = "manual" } = options;
    this.scanAbortController?.abort();
    this.scanRequestId += 1;
    const requestId = this.scanRequestId;
    const controller = new AbortController();
    this.scanAbortController = controller;

    this.scanActor.send({ type: "LOOKUP.REQUESTED", code, source });

    if (source === "camera") {
      this.patch({ cameraLookupCode: code });
    }
    if (!silent) {
      this.patch({ pendingAction: "scan" });
    }

    try {
      const scanOptions: { signal: AbortSignal; autoIncrement: boolean } = {
        signal: controller.signal,
        autoIncrement: this.state.scanMode === "increment",
      };
      const response = await api.scan(code, scanOptions);
      if (requestId !== this.scanRequestId) {
        return;
      }

      this.applyScanResponse(response, code);
    } catch (caught) {
      if (controller.signal.aborted) {
        return;
      }
      if (this.handleApiFailure(caught)) {
        return;
      }
      this.scanActor.send({
        type: "LOOKUP.FAILED",
        failure: {
          kind: "unexpected",
          operation: "scan.lookup",
          message: errorMessage(caught),
          retryability: "never",
          details: { machine: "scanSession" },
          cause: caught,
        },
      });
      this.addToast(errorMessage(caught), "error");
    } finally {
      if (source === "camera" && requestId === this.scanRequestId) {
        this.patch({ cameraLookupCode: null });
      }
      if (!silent && requestId === this.scanRequestId) {
        this.patch({ pendingAction: null });
      }
    }
  }

  private applyScanResponse(response: ScanResponse, code: string): void {
    const historyCode =
      response.mode === "unknown"
        ? response.code
        : response.qrCode.code;
    const nextHistory = [
      { code: historyCode, mode: response.mode, timestamp: new Date().toISOString() },
      ...this.state.scanHistory,
    ].slice(0, 20);
    if (response.mode === "unknown") {
      this.scanActor.send({ type: "LOOKUP.UNKNOWN", code: response.code });
      this.patch({ scanResult: response, scanHistory: nextHistory });
      return;
    }
    if (response.mode === "label") {
      this.scanActor.send({ type: "LOOKUP.LABEL", qrCode: response.qrCode.code });
      this.patch({
        scanResult: response,
        scanHistory: nextHistory,
        assignForm: {
          ...defaultAssignForm,
          qrCode: response.qrCode.code,
          location: this.state.lastAssignment?.location ?? "",
        },
        labelSearch: {
          query: "",
          results: response.suggestions,
          status: "idle",
          error: null,
        },
      });
      return;
    }
    if (response.entity.targetType === "instance") {
      this.scanActor.send({
        type: "LOOKUP.INSTANCE",
        qrCode: response.qrCode.code,
        targetId: response.entity.id,
      });
    } else {
      this.scanActor.send({
        type: "LOOKUP.BULK",
        qrCode: response.qrCode.code,
        targetId: response.entity.id,
      });
    }
    this.patch({
      scanResult: response,
      scanHistory: nextHistory,
      eventForm: buildDefaultEventFormForEntity(response.entity),
    });
    if (response.entity.targetType === "bulk" && (response as { autoIncremented?: boolean }).autoIncremented) {
      this.addToast(`+1 ${response.entity.partType.canonicalName} (now ${response.entity.quantity ?? "?"})`, "success");
    }
  }

  private async handleRegisterBatch(): Promise<void> {
    this.patch({ pendingAction: "batch" });
    try {
      const parsed = parseBatchForm(this.state.batchForm);
      if (!parsed.ok) {
        this.addToast(this.failureMessage(parsed.error), "error");
        return;
      }
      const response = await api.registerQrBatch(parsed.value);
      this.addToast(`Registered ${response.created} QR codes${response.skipped ? ` (${response.skipped} duplicates skipped)` : ""}`, "success");
      this.patch({
        latestBatch: response.batch,
        batchForm: {
          ...this.state.batchForm,
          prefix: response.batch.prefix,
          startNumber: response.batch.endNumber + 1,
        },
      });
      await this.loadAuthenticatedData();
    } catch (caught) {
      if (!this.handleApiFailure(caught)) {
        this.addToast(errorMessage(caught), "error");
      }
    } finally {
      this.patch({ pendingAction: null });
    }
  }

  private async handleDownloadLatestBatchLabels(): Promise<void> {
    if (!this.state.latestBatch) {
      return;
    }
    this.patch({ downloadingBatchId: this.state.latestBatch.id });
    try {
      await downloadQrBatchLabelsPdf(this.state.latestBatch.id);
    } catch (caught) {
      if (!this.handleApiFailure(caught)) {
        this.addToast(errorMessage(caught), "error");
      }
    } finally {
      this.patch({ downloadingBatchId: null });
    }
  }

  private async handleDrainPartDbSync(): Promise<void> {
    this.patch({ pendingAction: "sync" });
    try {
      const result = await api.drainPartDbSync();
      this.addToast(`Sync drained · ${result.delivered} delivered${result.failed ? `, ${result.failed} failed` : ""}`, result.failed ? "info" : "success");
      await this.loadAuthenticatedData();
    } catch (caught) {
      if (!this.handleApiFailure(caught)) {
        this.addToast(errorMessage(caught), "error");
      }
    } finally {
      this.patch({ pendingAction: null });
    }
  }

  private async handleBackfillPartDbSync(): Promise<void> {
    this.patch({ pendingAction: "sync" });
    try {
      const result = await api.backfillPartDbSync();
      this.addToast(`Backfill queued · ${result.queuedPartTypes} parts, ${result.queuedLots} lots`, "success");
      await this.loadAuthenticatedData();
    } catch (caught) {
      if (!this.handleApiFailure(caught)) {
        this.addToast(errorMessage(caught), "error");
      }
    } finally {
      this.patch({ pendingAction: null });
    }
  }

  private async handleRetryPartDbSync(id: string): Promise<void> {
    this.patch({ pendingAction: "sync" });
    try {
      await api.retryPartDbSync(id);
      this.addToast("Retry queued", "info");
      await this.loadAuthenticatedData();
    } catch (caught) {
      if (!this.handleApiFailure(caught)) {
        this.addToast(errorMessage(caught), "error");
      }
    } finally {
      this.patch({ pendingAction: null });
    }
  }

  private async handleScan(): Promise<void> {
    const code = sanitizeScannedCode(this.state.scanCode);
    if (!code) return;
    this.patch({ scanCode: "" });
    await this.performScan(code);
  }

  private handleScanNext(): void {
    this.cameraService.stop();
    this.patch({
      cameraLookupCode: null,
      scanCode: "",
      scanResult: null,
      assignForm: defaultAssignForm,
      eventForm: defaultEventForm,
      labelSearch: defaultSearchState,
    });
  }

  private handleCameraScanNext(): void {
    this.handleScanNext();
    void this.startCamera();
  }

  private async handleCameraScan(code: string): Promise<void> {
    if (this.state.pendingAction !== null) {
      this.addToast("Finish the current action first", "error");
      return;
    }

    if (hasInProgressScanWork(
      this.state.scanResult,
      this.state.assignForm,
      this.state.labelSearch.query,
      this.state.eventForm,
    )) {
      this.addToast("Clear the current scan first", "error");
      return;
    }

    await this.performScan(code, { source: "camera" });
  }

  private async startCamera(): Promise<void> {
    if (this.state.pendingAction !== null) {
      this.addToast("Finish the current action before scanning another item.", "error");
      return;
    }

    // Suppress renders during start() — it emits multiple snapshot updates
    // that would each trigger innerHTML replacement, destroying the video element.
    this.renderSuppressed = true;

    const result = await this.cameraService.start();

    this.renderSuppressed = false;

    if (!result.ok) {
      this.render();
      this.addToast(result.failure.message, "error");
      return;
    }

    // Render once with final camera state. This creates the video element.
    this.render();

    // Attach the fresh video element and bind the stream.
    // Use a microtask to ensure the DOM has settled.
    const video = this.root.querySelector<HTMLVideoElement>("#rewrite-camera-video");
    if (video && this.cameraService.getSnapshot().activeStream) {
      await this.cameraService.attachVideoElement(video);
    }
  }

  private setCorrectionAction(action: "reassign" | "editShared" | "reverseIngest"): void {
    this.patch({
      correctionUi: {
        ...this.state.correctionUi,
        action,
        reason: "",
        replacementPartTypeId: "",
        search:
          action === "reassign"
            ? {
                ...this.state.correctionUi.search,
                query: "",
                results: [...this.state.catalogSuggestions],
                status: "idle",
                error: null,
              }
            : this.state.correctionUi.search,
      },
    });
  }

  private async handleCorrectionScan(): Promise<void> {
    const code = sanitizeScannedCode(this.state.correctionUi.scanCode);
    if (!code) {
      return;
    }

    try {
      const response = await api.scan(code, { autoIncrement: false });
      if (response.mode !== "interact") {
        this.patch({
          correctionUi: {
            ...defaultCorrectionUiState,
            scanCode: code,
            targetError: "Only already-ingested assigned items can be corrected.",
          },
        });
        return;
      }

      const history = await api.getCorrectionHistory({
        targetType: response.entity.targetType,
        targetId: response.entity.id,
      }).catch((caught) => {
        return this.handleApiFailure(caught)
          ? []
          : (() => {
              this.addToast(errorMessage(caught), "error");
              return [];
            })();
      });

      this.patch({
        correctionUi: {
          ...defaultCorrectionUiState,
          scanCode: code,
          target: response,
          history,
          action: "reassign",
          search: {
            query: "",
            results: [...this.state.catalogSuggestions],
            status: "idle",
            error: null,
          },
          sharedCanonicalName: response.entity.partType.canonicalName,
          sharedCategory: formatCategoryPath(response.entity.partType.categoryPath),
          sharedExpectedUpdatedAt: response.entity.partType.updatedAt,
        },
      });
    } catch (caught) {
      if (!this.handleApiFailure(caught)) {
        this.patch({
          correctionUi: {
            ...defaultCorrectionUiState,
            scanCode: code,
            targetError: errorMessage(caught),
          },
        });
      }
    }
  }

  private async handleCorrectionReassign(): Promise<void> {
    const target = this.state.correctionUi.target;
    if (!target) {
      this.addToast("Scan an ingested item first.", "error");
      return;
    }

    this.patch({ pendingAction: "correct" as PendingAction });
    try {
      const parsed = parseReassignPartTypeForm({
        targetType: target.entity.targetType,
        targetId: target.entity.id,
        fromPartTypeId: target.entity.partType.id,
        toPartTypeId: this.state.correctionUi.replacementPartTypeId,
        reason: this.state.correctionUi.reason,
      });
      if (!parsed.ok) {
        this.addToast(this.failureMessage(parsed.error), "error");
        return;
      }

      const response = await api.reassignEntityPartType(parsed.value);
      const refreshedTarget = await api.scan(target.qrCode.code, { autoIncrement: false });
      const history = await api.getCorrectionHistory({
        targetType: target.entity.targetType,
        targetId: target.entity.id,
      });

      this.patch({
        correctionUi: {
          ...this.state.correctionUi,
          target: refreshedTarget.mode === "interact" ? refreshedTarget : this.state.correctionUi.target,
          history,
          action: null,
          reason: "",
          replacementPartTypeId: "",
          sharedCanonicalName: response.entity.partType.canonicalName,
          sharedCategory: formatCategoryPath(response.entity.partType.categoryPath),
          sharedExpectedUpdatedAt: response.entity.partType.updatedAt,
        },
      });
      this.addToast("Item corrected to the replacement part type.", "success");
      await this.loadAuthenticatedData();
    } catch (caught) {
      if (!this.handleApiFailure(caught)) {
        this.addToast(errorMessage(caught), "error");
      }
    } finally {
      this.patch({ pendingAction: null });
    }
  }

  private async handleCorrectionEditShared(): Promise<void> {
    const target = this.state.correctionUi.target;
    if (!target) {
      this.addToast("Scan an ingested item first.", "error");
      return;
    }

    this.patch({ pendingAction: "correct" as PendingAction });
    try {
      const parsed = parseEditPartTypeDefinitionForm({
        partTypeId: target.entity.partType.id,
        expectedUpdatedAt: this.state.correctionUi.sharedExpectedUpdatedAt,
        canonicalName: this.state.correctionUi.sharedCanonicalName,
        category: this.state.correctionUi.sharedCategory,
        reason: this.state.correctionUi.reason,
      });
      if (!parsed.ok) {
        this.addToast(this.failureMessage(parsed.error), "error");
        return;
      }

      const conflicts = this.findCorrectionSharedEditConflicts();
      if (conflicts.length > 0) {
        this.addToast(
          `A part type named '${conflicts[0]!.canonicalName}' already exists in ${conflicts[0]!.categoryPath.join(" / ")}. Use 'Fix this item/bin only' to reassign this scanned item instead of renaming the shared type.`,
          "error",
        );
        return;
      }

      const usage = this.state.inventorySummary.find((row) => row.id === target.entity.partType.id);
      const linkedCount = (usage?.bins ?? 0) + (usage?.instanceCount ?? 0);
      if (
        typeof window !== "undefined" &&
        !window.confirm(
          linkedCount > 0
            ? `Rename the shared type '${target.entity.partType.canonicalName}' for ${linkedCount} linked inventory rows? This is not item-only.`
            : `Rename the shared type '${target.entity.partType.canonicalName}'? This changes the catalog definition itself, not just the scanned item.`,
        )
      ) {
        return;
      }

      const response = await api.editPartTypeDefinition(parsed.value);
      const refreshedTarget = await api.scan(target.qrCode.code, { autoIncrement: false });
      this.patch({
        correctionUi: {
          ...this.state.correctionUi,
          target: refreshedTarget.mode === "interact" ? refreshedTarget : this.state.correctionUi.target,
          action: null,
          reason: "",
          sharedCanonicalName: response.partType.canonicalName,
          sharedCategory: formatCategoryPath(response.partType.categoryPath),
          sharedExpectedUpdatedAt: response.partType.updatedAt,
        },
      });
      this.addToast("Shared part type updated.", "success");
      await this.loadAuthenticatedData();
    } catch (caught) {
      if (!this.handleApiFailure(caught)) {
        this.addToast(errorMessage(caught), "error");
      }
    } finally {
      this.patch({ pendingAction: null });
    }
  }

  private async handleCorrectionReverseIngest(): Promise<void> {
    const target = this.state.correctionUi.target;
    if (!target) {
      this.addToast("Scan an ingested item first.", "error");
      return;
    }
    if (typeof window !== "undefined" && !window.confirm("Reverse this ingest? The QR/Data Matrix will return to printed state, while the correction audit remains.")) {
      return;
    }

    this.patch({ pendingAction: "correct" as PendingAction });
    try {
      const parsed = parseReverseIngestForm({
        qrCode: target.qrCode.code,
        assignedKind: target.entity.targetType,
        assignedId: target.entity.id,
        reason: this.state.correctionUi.reason,
      });
      if (!parsed.ok) {
        this.addToast(this.failureMessage(parsed.error), "error");
        return;
      }

      await api.reverseIngestAssignment(parsed.value);
      this.patch({ correctionUi: defaultCorrectionUiState });
      this.addToast("Ingest reversed. The item is no longer assigned.", "success");
      await this.loadAuthenticatedData();
    } catch (caught) {
      if (!this.handleApiFailure(caught)) {
        this.addToast(errorMessage(caught), "error");
      }
    } finally {
      this.patch({ pendingAction: null });
    }
  }

  private handleRegisterUnknown(code: string): void {
    this.scanActor.send({ type: "UNKNOWN.PROMOTED_TO_INTAKE" });
    this.patch({
      scanResult: {
        mode: "label",
        qrCode: {
          code,
          batchId: "external",
          status: "printed",
          assignedKind: null,
          assignedId: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        suggestions: [...this.state.catalogSuggestions],
        partDb: { configured: false, connected: false, message: "" },
      },
      assignForm: {
        ...defaultAssignForm,
        qrCode: code,
        entityKind: "bulk",
        countable: false,
        unitSymbol: "kg",
      },
      labelSearch: {
        query: "",
        results: [...this.state.catalogSuggestions],
        status: "idle",
        error: null,
      },
    });
  }

  private async handleAssign(): Promise<void> {
    this.patch({ pendingAction: "assign" });
    this.scanActor.send({ type: "ASSIGN.PARSE_REQUESTED" });
    try {
      const parsed = parseAssignForm(this.state.assignForm);
      if (!parsed.ok) {
        this.scanActor.send({ type: "ASSIGN.FAILED", failure: parsed.error });
        this.addToast(this.failureMessage(parsed.error), "error");
        return;
      }
      const request = parsed.value;
      this.scanActor.send({ type: "ASSIGN.SUBMIT_REQUESTED" });
      const response = await api.assignQr(request);
      this.scanActor.send({
        type: "ASSIGN.SUCCEEDED",
        targetType: response.targetType,
        qrCode: request.qrCode,
        targetId: response.id,
        lastAssignment: {
          partTypeName: response.partType.canonicalName,
          partTypeId: response.partType.id,
          location: response.location,
        },
      });
      this.addToast(`${response.partType.canonicalName} assigned to ${request.qrCode}`, "success");
      this.patch({
        lastAssignment: {
          partTypeName: response.partType.canonicalName,
          partTypeId: response.partType.id,
          location: response.location,
        },
        assignForm: defaultAssignForm,
        scanCode: "",
      });
      await this.performScan(request.qrCode, { silent: true });
      this.patch({ scanCode: "" });
      await this.loadAuthenticatedData();
    } catch (caught) {
      this.scanActor.send({
        type: "ASSIGN.FAILED",
        failure: {
          kind: "unexpected",
          operation: "scan.assign",
          message: errorMessage(caught),
          retryability: "never",
          details: { machine: "scanSession" },
          cause: caught,
        },
      });
      if (!this.handleApiFailure(caught)) {
        this.addToast(errorMessage(caught), "error");
      }
    } finally {
      this.patch({ pendingAction: null });
    }
  }

  private async handleAssignSame(): Promise<void> {
    if (!this.state.lastAssignment || !this.state.scanResult || this.state.scanResult.mode !== "label") {
      return;
    }
    this.patch({ pendingAction: "assign" });
    this.scanActor.send({ type: "ASSIGN.PARSE_REQUESTED" });
    try {
      const parsed = parseAssignForm({
        ...defaultAssignForm,
        qrCode: this.state.scanResult.qrCode.code,
        partTypeMode: "existing",
        existingPartTypeId: this.state.lastAssignment.partTypeId,
        location: this.state.lastAssignment.location,
      });
      if (!parsed.ok) {
        this.scanActor.send({ type: "ASSIGN.FAILED", failure: parsed.error });
        this.addToast(this.failureMessage(parsed.error), "error");
        return;
      }
      const request = parsed.value;
      this.scanActor.send({ type: "ASSIGN.SUBMIT_REQUESTED" });
      const response = await api.assignQr(request);
      this.scanActor.send({
        type: "ASSIGN.SUCCEEDED",
        targetType: response.targetType,
        qrCode: request.qrCode,
        targetId: response.id,
        lastAssignment: {
          partTypeName: response.partType.canonicalName,
          partTypeId: response.partType.id,
          location: response.location,
        },
      });
      this.addToast(`${response.partType.canonicalName} assigned to ${request.qrCode}`, "success");
      this.patch({
        lastAssignment: {
          partTypeName: response.partType.canonicalName,
          partTypeId: response.partType.id,
          location: response.location,
        },
        assignForm: defaultAssignForm,
        scanCode: "",
      });
      await this.performScan(request.qrCode, { silent: true });
      this.patch({ scanCode: "" });
      await this.loadAuthenticatedData();
    } catch (caught) {
      this.scanActor.send({
        type: "ASSIGN.FAILED",
        failure: {
          kind: "unexpected",
          operation: "scan.assign",
          message: errorMessage(caught),
          retryability: "never",
          details: { machine: "scanSession" },
          cause: caught,
        },
      });
      if (!this.handleApiFailure(caught)) {
        this.addToast(errorMessage(caught), "error");
      }
    } finally {
      this.patch({ pendingAction: null });
    }
  }

  private async handleRecordEvent(): Promise<void> {
    this.patch({ pendingAction: "event" });
    this.scanActor.send({ type: "EVENT.PARSE_REQUESTED", targetType: this.state.eventForm.targetType });
    let parsedCommand: EventCommand | null = null;
    try {
      const parsed = parseEventForm(this.state.eventForm);
      if (!parsed.ok) {
        const failureEventType =
          this.state.eventForm.event === "moved" &&
          this.state.eventForm.targetType === "bulk" &&
          this.state.eventForm.splitQuantity.trim() !== ""
            ? "SPLIT.FAILED"
            : "EVENT.FAILED";
        this.scanActor.send({ type: failureEventType, failure: parsed.error } as const);
        this.addToast(this.failureMessage(parsed.error), "error");
        return;
      }
      parsedCommand = parsed.value;

      if (parsedCommand.kind === "split") {
        this.scanActor.send({ type: "SPLIT.PARSE_REQUESTED" });
        this.scanActor.send({ type: "SPLIT.SUBMIT_REQUESTED" });
        const splitResult = await api.splitBulkStock(this.state.eventForm.targetId, parsedCommand.request);
        this.scanActor.send({
          type: "SPLIT.SUCCEEDED",
          qrCode: this.state.scanResult?.mode === "interact" ? this.state.scanResult.qrCode.code : this.state.eventForm.targetId,
          targetId: splitResult.source.id,
        });
        this.addToast(`Moved ${parsedCommand.request.quantity} to ${parsedCommand.request.destinationLocation} (source: ${splitResult.source.quantity}, dest: ${splitResult.destination.quantity})`, "success");
      } else {
        this.scanActor.send({ type: "EVENT.SUBMIT_REQUESTED", targetType: this.state.eventForm.targetType });
        const response = await api.recordEvent(parsedCommand.request);
        this.scanActor.send({
          type: "EVENT.SUCCEEDED",
          targetType: parsedCommand.request.targetType,
          targetId: parsedCommand.request.targetId,
          qrCode: this.state.scanResult?.mode === "interact" ? this.state.scanResult.qrCode.code : parsedCommand.request.targetId,
        });
        this.addToast(`${actionLabel(response.event)} recorded`, "success");
      }

      if (this.state.scanResult?.mode === "interact") {
        await this.performScan(this.state.scanResult.qrCode.code, { silent: true });
      }
      await this.loadAuthenticatedData();
    } catch (caught) {
      if (parsedCommand?.kind === "split") {
        this.scanActor.send({
          type: "SPLIT.FAILED",
          failure: {
            kind: "unexpected",
            operation: "scan.splitBulk",
            message: errorMessage(caught),
            retryability: "never",
            details: { machine: "scanSession" },
            cause: caught,
          },
        });
      } else {
        this.scanActor.send({
          type: "EVENT.FAILED",
          failure: {
            kind: "unexpected",
            operation: "scan.recordEvent",
            message: errorMessage(caught),
            retryability: "never",
            details: { machine: "scanSession" },
            cause: caught,
          },
        });
      }
      if (!this.handleApiFailure(caught)) {
        this.addToast(errorMessage(caught), "error");
      }
    } finally {
      this.patch({ pendingAction: null });
    }
  }

  private async handleApprovePartType(id: string): Promise<void> {
    try {
      await api.approvePartType(id);
      this.addToast("Part type approved", "success");
      this.patch({ mergeSourceId: "" });
      await this.loadAuthenticatedData();
    } catch (caught) {
      if (!this.handleApiFailure(caught)) {
        this.addToast(errorMessage(caught), "error");
      }
    }
  }

  private async handleMergePartTypes(): Promise<void> {
    if (typeof window !== "undefined" && !window.confirm("Merge this provisional type into the canonical record? This cannot be undone.")) {
      return;
    }

    this.patch({ pendingAction: "merge" });
    try {
      const parsed = parseMergeForm({
        sourcePartTypeId: this.state.mergeSourceId,
        destinationPartTypeId: this.state.mergeDestinationId,
        aliasLabel: null,
      });
      if (!parsed.ok) {
        this.addToast(this.failureMessage(parsed.error), "error");
        return;
      }
      await api.mergePartTypes(parsed.value);
      this.addToast("Part types merged", "success");
      this.patch({
        mergeSourceId: "",
        mergeDestinationId: "",
      });
      await this.loadAuthenticatedData();
    } catch (caught) {
      if (!this.handleApiFailure(caught)) {
        this.addToast(errorMessage(caught), "error");
      }
    } finally {
      this.patch({ pendingAction: null });
    }
  }

  private async toggleInventoryExpand(partTypeId: string): Promise<void> {
    if (this.state.inventoryUi.expandedId === partTypeId) {
      this.patch({
        inventoryUi: {
          ...this.state.inventoryUi,
          expandedId: null,
        },
      });
      return;
    }

    this.patch({
      inventoryUi: {
        ...this.state.inventoryUi,
        expandedId: partTypeId,
      },
    });

    if (this.state.inventoryUi.expandedItems.has(partTypeId)) {
      return;
    }

    try {
      const items = await api.getPartTypeItems(partTypeId);
      const expandedItems = new Map(this.state.inventoryUi.expandedItems);
      const expandedErrors = new Map(this.state.inventoryUi.expandedErrors);
      expandedItems.set(partTypeId, items);
      expandedErrors.delete(partTypeId);
      this.patch({
        inventoryUi: {
          ...this.state.inventoryUi,
          expandedId: partTypeId,
          expandedItems,
          expandedErrors,
        },
      });
    } catch (caught) {
      const expandedErrors = new Map(this.state.inventoryUi.expandedErrors);
      expandedErrors.set(partTypeId, errorMessage(caught));
      this.patch({
        inventoryUi: {
          ...this.state.inventoryUi,
          expandedId: partTypeId,
          expandedErrors,
        },
      });
    }
  }

  private setAssignMode(mode: "existing" | "new"): void {
    if (mode === "existing") {
      this.patch({
        assignForm: {
          ...this.state.assignForm,
          partTypeMode: "existing",
          canonicalName: "",
          category: "",
        },
      });
      return;
    }
    this.patch({
      assignForm: {
        ...this.state.assignForm,
        partTypeMode: "new",
        existingPartTypeId: "",
      },
    });
  }

  private setAssignEntityKind(kind: "instance" | "bulk"): void {
    this.patch({
      assignForm: {
        ...this.state.assignForm,
        entityKind: kind,
        countable: kind === "instance" ? true : this.state.assignForm.countable,
      },
    });
  }

  private setBulkCountability(countable: boolean): void {
    const nextUnit = countable && !getMeasurementUnitBySymbol(this.state.assignForm.unitSymbol)?.isInteger
      ? "pcs"
      : this.state.assignForm.unitSymbol;
    this.patch({
      assignForm: {
        ...this.state.assignForm,
        entityKind: "bulk",
        countable,
        unitSymbol: nextUnit,
      },
    });
  }

  private selectExistingPartType(partId: string): void {
    const selected = this.state.labelSearch.results.find((partType) => partType.id === partId) ??
      this.state.catalogSuggestions.find((partType) => partType.id === partId);
    if (!selected) {
      return;
    }

    this.patch({
      assignForm: {
        ...this.state.assignForm,
        entityKind: selected.countable
          ? this.state.assignForm.entityKind
          : "bulk",
        partTypeMode: "existing",
        existingPartTypeId: selected.id,
        canonicalName: "",
        category: formatCategoryPath(selected.categoryPath),
        countable: selected.countable,
        unitSymbol: selected.unit.symbol,
        initialStatus: "available",
        initialQuantity: "1",
        minimumQuantity: "",
      },
    });
  }

  private createVariant(partId: string): void {
    const selected = this.state.labelSearch.results.find((partType) => partType.id === partId) ??
      this.state.catalogSuggestions.find((partType) => partType.id === partId);
    if (!selected) {
      return;
    }

    this.patch({
      assignForm: {
        ...this.state.assignForm,
        partTypeMode: "new",
        existingPartTypeId: "",
        canonicalName: selected.canonicalName,
        category: formatCategoryPath(selected.categoryPath),
        countable: selected.countable,
        entityKind: selected.countable ? this.state.assignForm.entityKind : "bulk",
        unitSymbol: selected.unit.symbol,
      },
    });
  }

  private setScanMode(mode: "increment" | "inspect"): void {
    try {
      localStorage.setItem("smartdb:scanMode", mode);
    } catch {}
    this.patch({ scanMode: mode });
  }

  private restoreScanMode(): "increment" | "inspect" {
    // Always start in view-only mode. User opts into auto-count per session.
    return "inspect";
  }

  private applyThemeToDOM(theme: "light" | "dark", animated = false): void {
    if (animated) {
      document.documentElement.classList.add("theme-transition");
      window.setTimeout(() => document.documentElement.classList.remove("theme-transition"), 250);
    }
    document.documentElement.classList.toggle("dark", theme === "dark");
    const metaTheme = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    if (metaTheme) metaTheme.content = theme === "dark" ? "#111113" : "#fafafa";
  }

  private setTheme(theme: "light" | "dark"): void {
    try {
      localStorage.setItem("smartdb:theme", theme);
    } catch {}
    this.applyThemeToDOM(theme, true);
    this.patch({ theme });
  }

  private restoreTheme(): "light" | "dark" {
    try {
      const stored = localStorage.getItem("smartdb:theme");
      if (stored === "dark" || stored === "light") return stored;
    } catch {}
    if (window.matchMedia?.("(prefers-color-scheme: dark)").matches) {
      return "dark";
    }
    return "light";
  }

  private addToast(message: string, type: ToastRecord["type"]): void {
    const id = crypto.randomUUID();
    const nextToasts = [...this.state.toasts, { id, type, message }];
    this.patch({ toasts: nextToasts });
    const timer = window.setTimeout(() => {
      this.dismissToast(id);
    }, type === "error" ? 8_000 : 4_000);
    this.toastTimers.set(id, timer);
  }

  private dismissToast(id: string): void {
    const timer = this.toastTimers.get(id);
    if (timer) {
      window.clearTimeout(timer);
      this.toastTimers.delete(id);
    }
    this.patch({
      toasts: this.state.toasts.filter((toast) => toast.id !== id),
    });
  }

  private mapAuthSnapshot(snapshot: SnapshotFrom<typeof authMachine>): AuthViewState {
    if (snapshot.matches("bootstrapping")) {
      return { status: "checking", session: null, error: null };
    }
    if (snapshot.matches("authenticated") && snapshot.context.session) {
      return {
        status: "authenticated",
        session: snapshot.context.session,
        error: null,
      };
    }
    if (snapshot.matches("redirecting")) {
      return { status: "authenticating", session: null, error: null };
    }
    return {
      status: "unauthenticated",
      session: null,
      error: snapshot.context.failure?.message ?? null,
    };
  }

  private failureMessage(failure: RewriteFailure): string {
    return failure.kind === "parse"
      ? failure.issues[0]?.message ?? failure.message
      : failure.message;
  }

  private findCorrectionSharedEditConflicts() {
    const target = this.state.correctionUi.target;
    if (!target) {
      return [];
    }

    return findSharedTypeConflictCandidates(
      this.state.inventorySummary,
      target.entity.partType.id,
      this.state.correctionUi.sharedCanonicalName,
      this.state.correctionUi.sharedCategory,
    );
  }

  private patch(nextPatch: Partial<RewriteUiState>): void {
    this.state = {
      ...this.state,
      ...nextPatch,
    };
    if (!this.renderSuppressed) {
      this.render();
    }
  }

  private render(): void {
    const focusSnapshot = this.captureFocus();

    // If the camera is actively scanning, preserve the live video element.
    // innerHTML replacement would destroy it and kill the stream.
    const liveVideo = this.root.querySelector<HTMLVideoElement>("#rewrite-camera-video");
    const isLive = liveVideo && liveVideo.srcObject;
    if (isLive) {
      liveVideo.remove();
    }

    this.root.innerHTML = renderApp(this.state);

    if (isLive) {
      const placeholder = this.root.querySelector<HTMLVideoElement>("#rewrite-camera-video");
      if (placeholder) {
        placeholder.replaceWith(liveVideo);
      }
    }

    this.restoreFocus(focusSnapshot);
  }

  private captureFocus(): FocusSnapshot | null {
    const active = document.activeElement;
    if (!(active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || active instanceof HTMLSelectElement)) {
      return null;
    }
    const key = active.id ? `#${active.id}` : active.name ? `[name="${CSS.escape(active.name)}"]` : "";
    if (!key) {
      return null;
    }
    return {
      key,
      selectionStart: active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement ? active.selectionStart : null,
      selectionEnd: active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement ? active.selectionEnd : null,
    };
  }

  private restoreFocus(snapshot: FocusSnapshot | null): void {
    if (!snapshot) {
      return;
    }
    const target = this.root.querySelector(snapshot.key);
    if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement)) {
      return;
    }
    target.focus();
    if ((target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) && snapshot.selectionStart !== null && snapshot.selectionEnd !== null) {
      try {
        target.setSelectionRange(snapshot.selectionStart, snapshot.selectionEnd);
      } catch {}
    }
  }
}

export function startRewriteApp(root: HTMLElement): RewriteAppController {
  const controller = new RewriteAppController(root);
  controller.start();
  return controller;
}
