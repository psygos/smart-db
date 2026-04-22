import {
  type BulkAssignQrsRequest,
  type BulkMoveEntitiesRequest,
  type BulkReverseIngestRequest,
  type BulkEntityTarget,
  type BulkReverseIngestTarget,
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
  getAssignFormIssues,
  type SearchState,
} from "./presentation-helpers";
import { authMachine } from "./machines/auth-machine";
import type { RewriteFailure } from "./errors";
import { bulkQueueMachine } from "./machines/bulk-queue-machine";
import { scanSessionMachine } from "./machines/scan-session-machine";
import {
  parseAssignForm,
  parseBatchForm,
  parseBulkAssignForm,
  parseBulkDeleteForm,
  parseBulkMoveForm,
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
  defaultBulkLabelForm,
  defaultBulkQueueState,
  defaultCameraState,
  defaultInventoryReverseSelection,
  defaultScanEditState,
  defaultScanLocationsState,
  defaultScanMode,
  defaultEventForm,
  defaultInventoryUiState,
  defaultPathPickerState,
  defaultSearchState,
  makeReassignForm,
  type AuthViewState,
  type BulkAssignedQueueRow,
  type BulkDeleteEligibility,
  type BulkQueueAction,
  type BulkQueueRow,
  type BulkUnlabeledQueueRow,
  type BulkQueueUiState,
  type OneByOneScanBehavior,
  type PendingAction,
  type RewriteUiState,
  type ScanEditAction,
  type ScanEditForm,
  type ScanEditState,
  type InventoryReverseTarget,
  type ScanModeState,
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

type SearchSurface = "label" | "merge" | "bulkLabel" | "edit";

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
    scanEdit: defaultScanEditState,
    scanLocations: defaultScanLocationsState,
    correctionLog: [],
    correctionLogError: null,
    inventoryReverseSelection: defaultInventoryReverseSelection,
    provisionalPartTypes: [],
    labelSearch: defaultSearchState,
    mergeSearch: defaultSearchState,
    scanResult: null,
    batchForm: defaultBatchForm,
    assignForm: defaultAssignForm,
    eventForm: defaultEventForm,
    scanCode: "",
    scanMode: this.restoreScanMode(),
    bulkQueue: defaultBulkQueueState,
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
  private readonly bulkQueueActor = createActor(bulkQueueMachine, {
    input: {
      action: defaultBulkQueueState.action,
    },
  });
  private readonly authAbortController = new AbortController();
  private readonly searchControllers: Record<SearchSurface, AbortController | null> = {
    label: null,
    merge: null,
    bulkLabel: null,
    edit: null,
  };
  private readonly searchRequestIds: Record<SearchSurface, number> = {
    label: 0,
    merge: 0,
    bulkLabel: 0,
    edit: 0,
  };
  private scanLocationsAbortController: AbortController | null = null;
  private scanLocationsRequestId = 0;
  private inventoryQueryRenderTimer: number | null = null;
  private renderSuppressed = false;
  private readonly cameraService = new CameraScannerService({
    onScan: (code) => {
      void this.handleCameraScan(code);
    },
  });
  private scanAbortController: AbortController | null = null;
  private scanRequestId = 0;
  private preferredOneByOneBehavior: OneByOneScanBehavior =
    defaultScanMode.kind === "oneByOne" ? defaultScanMode.behavior : "viewOnly";
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
    this.bulkQueueActor.subscribe((snapshot) => {
      const status = snapshot.matches("submitting")
        ? "submitting"
        : snapshot.matches("failed")
          ? "failed"
          : snapshot.matches("ready")
            ? "ready"
            : "empty";
      this.patch({
        bulkQueue: {
          ...this.state.bulkQueue,
          action: snapshot.context.action,
          kind: snapshot.context.kind,
          rows: snapshot.context.rows,
          summary: summarizeBulkQueue(snapshot.context.rows),
          failure: snapshot.context.failure,
          status,
        },
      });
    });
    this.authActor.start();
    this.scanActor.start();
    this.bulkQueueActor.start();

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
    this.searchControllers.bulkLabel?.abort();
    this.searchControllers.edit?.abort();
    this.scanLocationsAbortController?.abort();
    if (this.inventoryQueryRenderTimer !== null) {
      window.clearTimeout(this.inventoryQueryRenderTimer);
      this.inventoryQueryRenderTimer = null;
    }
    this.scanAbortController?.abort();
    this.authActor.stop();
    this.scanActor.stop();
    this.bulkQueueActor.stop();
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
          const nextTab = actionEl.dataset.tab as TabId;
          // Leaving scan with an active camera would leak the MediaStream and
          // leave the scan loop ticking against a soon-to-be-detached video
          // element (renderScanTab() stops emitting #rewrite-camera-video
          // outside the scan tab). Tear it down before the re-render.
          if (nextTab !== "scan" && this.cameraService.getSnapshot().activeStream) {
            this.cameraService.stop();
            void this.cameraService.attachVideoElement(null);
          }
          this.patch({ activeTab: nextTab });
        }
        break;
      case "register-unknown":
        if (actionEl.dataset.code) {
          this.handleRegisterUnknown(actionEl.dataset.code);
        }
        break;
      case "set-scan-mode-kind":
        if (actionEl.dataset.scanModeKind === "oneByOne" || actionEl.dataset.scanModeKind === "bulk") {
          this.setTopLevelScanMode(actionEl.dataset.scanModeKind);
        }
        break;
      case "set-scan-behavior":
        if (actionEl.dataset.scanBehavior === "increment" || actionEl.dataset.scanBehavior === "viewOnly") {
          this.setOneByOneBehavior(actionEl.dataset.scanBehavior);
        }
        break;
      case "set-bulk-action":
        if (actionEl.dataset.bulkAction === "label" || actionEl.dataset.bulkAction === "move" || actionEl.dataset.bulkAction === "delete") {
          this.setBulkQueueAction(actionEl.dataset.bulkAction);
        }
        break;
      case "set-assign-mode":
        if (actionEl.dataset.assignMode === "existing" || actionEl.dataset.assignMode === "new") {
          this.setAssignMode(actionEl.dataset.assignMode);
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
          const knownKey = kind === "category" ? "knownCategories" : "knownLocations";
          const cur = this.state[pickerKey];
          const leaf = cur.createName.trim();
          if (!leaf) break;
          const parent = cur.createParent.trim();
          const full = parent === "" ? leaf : `${parent} / ${leaf}`;
          const existingKnown = this.state[knownKey];
          const nextKnown = existingKnown.includes(full)
            ? existingKnown
            : [...existingKnown, full].sort();
          this.patch({
            assignForm: { ...this.state.assignForm, [formKey]: full },
            [pickerKey]: { ...cur, open: false, createOpen: false, createParent: "", createName: "", query: "" },
            [knownKey]: nextKnown,
          } as Partial<RewriteUiState>);
          if (kind === "category") {
            void api.createCategory(full);
          } else {
            void api.createLocation(full);
          }
        }
        break;
      }
      case "tree-pick-bulk-label-location":
        this.patch({
          bulkQueue: {
            ...this.state.bulkQueue,
            labelForm: {
              ...this.state.bulkQueue.labelForm,
              location: actionEl.dataset.location ?? "",
            },
          },
        });
        break;
      case "tree-pick-scan-edit-category": {
        const edit = this.state.scanEdit;
        if (edit.status !== "open" || edit.form.action !== "editShared") {
          break;
        }
        this.patch({
          scanEdit: {
            ...edit,
            form: {
              ...edit.form,
              sharedCategory: actionEl.dataset.category ?? "",
            },
            dirty: true,
          },
        });
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
      case "inventory-reverse-toggle":
        if (
          actionEl.dataset.partTypeId &&
          actionEl.dataset.id &&
          actionEl.dataset.qrCode &&
          (actionEl.dataset.kind === "instance" || actionEl.dataset.kind === "bulk")
        ) {
          this.toggleInventoryReverseTarget(actionEl.dataset.partTypeId, {
            kind: actionEl.dataset.kind,
            id: actionEl.dataset.id,
            qrCode: actionEl.dataset.qrCode,
          });
        }
        break;
      case "inventory-reverse-clear":
        this.patch({ inventoryReverseSelection: defaultInventoryReverseSelection });
        break;
      case "open-part-detail":
        if (actionEl.dataset.partTypeId) {
          void this.openPartDetail(actionEl.dataset.partTypeId);
        }
        break;
      case "close-part-detail":
        this.patch({
          inventoryUi: { ...this.state.inventoryUi, detailPartTypeId: null },
        });
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
      case "open-correction-on-scan":
        if (actionEl.dataset.qrCode) {
          void this.openCorrectionOnScan(actionEl.dataset.qrCode);
        }
        break;
      case "scan-edit-open":
        this.openScanEdit("reassign");
        break;
      case "scan-edit-open-reverse":
        this.openScanEdit("reverseIngest");
        break;
      case "scan-edit-open-shared":
        this.openScanEdit("editShared");
        break;
      case "scan-edit-close":
        this.closeScanEdit();
        break;
      case "set-scan-edit-action":
        if (
          actionEl.dataset.scanEditAction === "reassign" ||
          actionEl.dataset.scanEditAction === "editShared" ||
          actionEl.dataset.scanEditAction === "reverseIngest"
        ) {
          this.setScanEditAction(actionEl.dataset.scanEditAction);
        }
        break;
      case "select-scan-edit-part":
        if (actionEl.dataset.partId) {
          this.selectScanEditReplacementPart(actionEl.dataset.partId);
        }
        break;
      case "bulk-queue-decrement":
        if (actionEl.dataset.code) {
          this.bulkQueueActor.send({ type: "QUEUE.ROW_DECREMENT_REQUESTED", code: actionEl.dataset.code });
        }
        break;
      case "bulk-queue-remove":
        if (actionEl.dataset.code) {
          this.bulkQueueActor.send({ type: "QUEUE.ROW_REMOVE_REQUESTED", code: actionEl.dataset.code });
        }
        break;
      case "bulk-queue-clear":
        this.clearBulkQueue();
        break;
      case "set-bulk-label-mode":
        if (actionEl.dataset.assignMode === "existing" || actionEl.dataset.assignMode === "new") {
          this.setBulkLabelMode(actionEl.dataset.assignMode);
        }
        break;
      case "set-bulk-label-entity-kind":
        if (actionEl.dataset.entityKind === "instance" || actionEl.dataset.entityKind === "bulk") {
          this.setBulkLabelEntityKind(actionEl.dataset.entityKind);
        }
        break;
      case "set-bulk-label-countability":
        if (actionEl.dataset.countable === "true" || actionEl.dataset.countable === "false") {
          this.setBulkLabelCountability(actionEl.dataset.countable === "true");
        }
        break;
      case "select-bulk-label-part":
        if (actionEl.dataset.partId) {
          this.selectBulkLabelPartType(actionEl.dataset.partId);
        }
        break;
      case "create-bulk-label-variant":
        if (actionEl.dataset.partId) {
          this.createBulkLabelVariant(actionEl.dataset.partId);
        }
        break;
      case "pick-bulk-label-known-location":
        if (actionEl.dataset.location) {
          this.patch({
            bulkQueue: {
              ...this.state.bulkQueue,
              labelForm: {
                ...this.state.bulkQueue.labelForm,
                location: actionEl.dataset.location,
              },
            },
          });
        }
        break;
      case "pick-bulk-label-known-category":
        if (actionEl.dataset.category) {
          this.patch({
            bulkQueue: {
              ...this.state.bulkQueue,
              labelForm: {
                ...this.state.bulkQueue.labelForm,
                category: actionEl.dataset.category,
              },
            },
          });
        }
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
      case "assign":
        void this.handleAssign();
        break;
      case "bulk-label":
        void this.handleBulkAssign();
        break;
      case "bulk-move":
        void this.handleBulkMove();
        break;
      case "bulk-delete":
        void this.handleBulkDelete();
        break;
      case "event":
        void this.handleRecordEvent();
        break;
      case "batch":
        void this.handleRegisterBatch();
        break;
      case "scan-edit-reassign":
        void this.handleScanEditReassign();
        break;
      case "scan-edit-shared":
        void this.handleScanEditEditShared();
        break;
      case "scan-edit-reverse":
        void this.handleScanEditReverseIngest();
        break;
      case "inventory-reverse":
        void this.handleInventoryReverseIngest();
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
      case "bulkLabelSearch.query":
        this.patch({
          bulkQueue: {
            ...this.state.bulkQueue,
            labelSearch: {
              ...this.state.bulkQueue.labelSearch,
              query: String(rawValue),
            },
          },
        });
        void this.performSearch("bulkLabel", String(rawValue));
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
      case "inventory.query": {
        // Typing the inventory filter on a catalogue with 200+ part types
        // used to rebuild the whole list DOM each keystroke. Update the state
        // immediately (input stays responsive because focus is restored after
        // render), but defer the actual re-render until typing settles so the
        // expensive filter loop runs once per burst instead of per keypress.
        this.renderSuppressed = true;
        try {
          this.patch({
            inventoryUi: {
              ...this.state.inventoryUi,
              query: String(rawValue),
            },
          });
        } finally {
          this.renderSuppressed = false;
        }
        if (this.inventoryQueryRenderTimer !== null) {
          window.clearTimeout(this.inventoryQueryRenderTimer);
        }
        this.inventoryQueryRenderTimer = window.setTimeout(() => {
          this.inventoryQueryRenderTimer = null;
          this.render();
        }, 150);
        return;
      }
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
        } else if (name.startsWith("bulkLabel.")) {
          this.updateBulkLabelForm(name, rawValue);
        } else if (name.startsWith("bulkMove.")) {
          this.updateBulkMoveForm(name, rawValue);
        } else if (name.startsWith("bulkDelete.")) {
          this.updateBulkDeleteForm(name, rawValue);
        } else if (name.startsWith("event.")) {
          this.updateEventForm(name, rawValue);
        } else if (name.startsWith("scanEdit.")) {
          this.updateScanEditForm(name, rawValue);
        } else if (name === "inventoryReverse.reason") {
          this.patch({
            inventoryReverseSelection: {
              ...this.state.inventoryReverseSelection,
              reason: String(rawValue),
            },
          });
        }
    }
  }

  private toggleInventoryReverseTarget(partTypeId: string, target: InventoryReverseTarget): void {
    const current = this.state.inventoryReverseSelection;
    const basePartType = current.partTypeId === partTypeId ? partTypeId : partTypeId;
    const baseTargets =
      current.partTypeId === partTypeId ? current.targets : [];
    const key = `${target.kind}:${target.id}`;
    const exists = baseTargets.some((row) => `${row.kind}:${row.id}` === key);
    const nextTargets = exists
      ? baseTargets.filter((row) => `${row.kind}:${row.id}` !== key)
      : [...baseTargets, target];
    this.patch({
      inventoryReverseSelection: {
        partTypeId: nextTargets.length > 0 ? basePartType : null,
        targets: nextTargets,
        reason: current.partTypeId === partTypeId ? current.reason : "",
      },
    });
  }

  private async handleInventoryReverseIngest(): Promise<void> {
    const selection = this.state.inventoryReverseSelection;
    if (!selection.partTypeId || selection.targets.length === 0) {
      return;
    }
    if (!selection.reason.trim()) {
      this.addToast("Enter a reason before reversing.", "error");
      return;
    }
    if (
      typeof window !== "undefined" &&
      !window.confirm(
        selection.targets.length === 1
          ? `Reverse ingest of ${selection.targets[0]!.qrCode}? The QR will return to printed.`
          : `Reverse ingest of ${selection.targets.length} items? Each QR will return to printed.`,
      )
    ) {
      return;
    }

    this.patch({ pendingAction: "correct" as PendingAction });
    try {
      await api.bulkReverseIngest({
        targets: selection.targets.map((row) => ({
          assignedKind: row.kind,
          assignedId: row.id,
          qrCode: row.qrCode,
        })),
        reason: selection.reason.trim(),
      });
      this.addToast(
        selection.targets.length === 1
          ? `Reversed ${selection.targets[0]!.qrCode}. The QR is back to printed.`
          : `Reversed ${selection.targets.length} items. Their QRs are back to printed.`,
        "success",
      );
      const expandedId = selection.partTypeId;
      this.patch({ inventoryReverseSelection: defaultInventoryReverseSelection });
      await this.loadAuthenticatedData();
      if (expandedId && this.state.inventoryUi.expandedId === expandedId) {
        await this.refreshInventoryDetail(expandedId);
      }
    } catch (caught) {
      if (!this.handleApiFailure(caught)) {
        this.addToast(errorMessage(caught), "error");
      }
    } finally {
      this.patch({ pendingAction: null });
    }
  }

  private async refreshInventoryDetail(partTypeId: string): Promise<void> {
    try {
      const data = await api.getPartTypeItems(partTypeId);
      const nextItems = new Map(this.state.inventoryUi.expandedItems);
      nextItems.set(partTypeId, data);
      const nextErrors = new Map(this.state.inventoryUi.expandedErrors);
      nextErrors.delete(partTypeId);
      this.patch({
        inventoryUi: {
          ...this.state.inventoryUi,
          expandedItems: nextItems,
          expandedErrors: nextErrors,
        },
      });
    } catch (caught) {
      if (this.handleApiFailure(caught)) return;
      const nextErrors = new Map(this.state.inventoryUi.expandedErrors);
      nextErrors.set(partTypeId, errorMessage(caught));
      this.patch({
        inventoryUi: {
          ...this.state.inventoryUi,
          expandedErrors: nextErrors,
        },
      });
    }
  }

  private updateScanEditForm(name: string, rawValue: string | boolean): void {
    const edit = this.state.scanEdit;
    if (edit.status !== "open") {
      return;
    }
    const value = String(rawValue);

    if (name === "scanEdit.reason") {
      this.patchScanEditForm({ reason: value } as Partial<ScanEditForm>);
      return;
    }

    if (edit.form.action === "reassign" && name === "scanEditSearch.query") {
      this.patch({
        scanEdit: {
          ...edit,
          form: {
            ...edit.form,
            search: { ...edit.form.search, query: value },
          },
          dirty: true,
        },
      });
      void this.performSearch("edit", value);
      return;
    }

    if (edit.form.action === "editShared") {
      if (name === "scanEdit.sharedCanonicalName") {
        this.patchScanEditForm({ sharedCanonicalName: value } as Partial<ScanEditForm>);
        return;
      }
      if (name === "scanEdit.sharedCategory") {
        this.patchScanEditForm({ sharedCategory: value } as Partial<ScanEditForm>);
        return;
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

  private updateBulkLabelForm(name: string, rawValue: string | boolean): void {
    const value = String(rawValue);
    const next = { ...this.state.bulkQueue.labelForm };
    switch (name) {
      case "bulkLabel.canonicalName":
        next.canonicalName = value;
        break;
      case "bulkLabel.category":
        next.category = value;
        break;
      case "bulkLabel.unitSymbol":
        next.unitSymbol = value;
        break;
      case "bulkLabel.initialQuantity":
        next.initialQuantity = value;
        break;
      case "bulkLabel.location":
        next.location = value;
        break;
      case "bulkLabel.minimumQuantity":
        next.minimumQuantity = value;
        break;
      case "bulkLabel.notes":
        next.notes = value;
        break;
      case "bulkLabel.initialStatus":
        next.initialStatus = value as typeof next.initialStatus;
        break;
      default:
        return;
    }
    this.patch({
      bulkQueue: {
        ...this.state.bulkQueue,
        labelForm: next,
      },
    });
  }

  private updateBulkMoveForm(name: string, rawValue: string | boolean): void {
    const value = String(rawValue);
    if (name !== "bulkMove.location" && name !== "bulkMove.notes") {
      return;
    }

    this.patch({
      bulkQueue: {
        ...this.state.bulkQueue,
        moveForm: {
          ...this.state.bulkQueue.moveForm,
          [name === "bulkMove.location" ? "location" : "notes"]: value,
        },
      },
    });
  }

  private updateBulkDeleteForm(name: string, rawValue: string | boolean): void {
    if (name !== "bulkDelete.reason") {
      return;
    }

    this.patch({
      bulkQueue: {
        ...this.state.bulkQueue,
        deleteForm: {
          reason: String(rawValue),
        },
      },
    });
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
    this.searchControllers.bulkLabel?.abort();
    this.searchControllers.edit?.abort();
    this.scanLocationsAbortController?.abort();
    this.scanAbortController?.abort();
    this.bulkQueueActor.send({ type: "QUEUE.CLEAR_REQUESTED" });
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
      scanEdit: defaultScanEditState,
      provisionalPartTypes: [],
      labelSearch: defaultSearchState,
      mergeSearch: defaultSearchState,
      scanResult: null,
      batchForm: defaultBatchForm,
      assignForm: defaultAssignForm,
      eventForm: defaultEventForm,
      scanCode: "",
      scanMode: defaultScanMode,
      bulkQueue: {
        ...defaultBulkQueueState,
        labelSearch: {
          ...defaultSearchState,
          results: [],
        },
      },
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
      categoriesResult,
      inventoryResult,
      correctionLogResult,
    ] = await Promise.allSettled([
      api.getDashboard(),
      api.getPartDbStatus(),
      canAccessAdmin ? api.getPartDbSyncStatus() : Promise.resolve(null),
      canAccessAdmin ? api.getPartDbSyncFailures() : Promise.resolve([]),
      canAccessAdmin ? api.getProvisionalPartTypes() : Promise.resolve([]),
      api.searchPartTypes(""),
      canAccessAdmin ? api.getLatestQrBatch() : Promise.resolve(null),
      api.getKnownLocations(),
      api.getKnownCategories(),
      api.getInventorySummary(),
      canAccessAdmin ? api.listCorrectionEvents(50) : Promise.resolve([]),
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
      categoriesResult,
      inventoryResult,
      correctionLogResult,
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
      categoriesResult,
      inventoryResult,
      correctionLogResult,
    ].filter((result): result is PromiseRejectedResult => result.status === "rejected");

    const patch: RewritePatch = {};

    if (dashboardResult.status === "fulfilled") {
      patch.dashboard = dashboardResult.value;
    }
    if (locationsResult.status === "fulfilled") {
      patch.knownLocations = locationsResult.value;
    }
    if (categoriesResult.status === "fulfilled") {
      patch.knownCategories = categoriesResult.value;
    }
    if (inventoryResult.status === "fulfilled") {
      patch.inventorySummary = inventoryResult.value;
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
      patch.bulkQueue = {
        ...this.state.bulkQueue,
        labelSearch: this.state.bulkQueue.labelSearch.query
          ? this.state.bulkQueue.labelSearch
          : {
              ...this.state.bulkQueue.labelSearch,
              results: partTypesResult.value,
              status: "idle",
              error: null,
            },
      };
    }

    if (correctionLogResult.status === "fulfilled") {
      patch.correctionLog = correctionLogResult.value;
      patch.correctionLogError = null;
    } else {
      patch.correctionLogError = errorMessage(correctionLogResult.reason);
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

  private async performSearch(surface: SearchSurface, query: string): Promise<void> {
    this.searchControllers[surface]?.abort();
    this.searchRequestIds[surface] += 1;
    const requestId = this.searchRequestIds[surface];
    const controller = new AbortController();
    this.searchControllers[surface] = controller;

    const current = this.readSearchState(surface);
    if (current === null) {
      return;
    }
    this.writeSearchState(surface, { ...current, query, status: "loading", error: null });

    try {
      const results = await api.searchPartTypes(query, controller.signal);
      if (requestId !== this.searchRequestIds[surface]) {
        return;
      }
      this.writeSearchState(surface, { query, results, status: "idle", error: null });
    } catch (caught) {
      if (controller.signal.aborted) {
        return;
      }
      if (this.handleApiFailure(caught)) {
        return;
      }
      this.writeSearchState(surface, {
        ...current,
        query,
        status: "error",
        error: errorMessage(caught),
      });
      this.addToast(errorMessage(caught), "error");
    }
  }

  private readSearchState(surface: SearchSurface): SearchState | null {
    switch (surface) {
      case "label":
        return this.state.labelSearch;
      case "merge":
        return this.state.mergeSearch;
      case "bulkLabel":
        return this.state.bulkQueue.labelSearch;
      case "edit":
        if (this.state.scanEdit.status !== "open" || this.state.scanEdit.form.action !== "reassign") {
          return null;
        }
        return this.state.scanEdit.form.search;
    }
  }

  private writeSearchState(surface: SearchSurface, next: SearchState): void {
    switch (surface) {
      case "label":
        this.patch({ labelSearch: next });
        return;
      case "merge":
        this.patch({ mergeSearch: next });
        return;
      case "bulkLabel":
        this.patch({
          bulkQueue: { ...this.state.bulkQueue, labelSearch: next },
        });
        return;
      case "edit": {
        const edit = this.state.scanEdit;
        if (edit.status !== "open" || edit.form.action !== "reassign") {
          return;
        }
        this.patch({
          scanEdit: {
            ...edit,
            form: { ...edit.form, search: next },
          },
        });
        return;
      }
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
        autoIncrement:
          this.state.scanMode.kind === "oneByOne" &&
          this.state.scanMode.behavior === "increment",
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
    const nextHistory = this.buildNextScanHistory(response);
    if (response.mode === "unknown") {
      this.scanActor.send({ type: "LOOKUP.UNKNOWN", code: response.code });
      this.patch({ scanResult: response, scanHistory: nextHistory });
      return;
    }
    if (response.mode === "label") {
      this.scanActor.send({ type: "LOOKUP.LABEL", qrCode: response.qrCode.code });
      const prefill = this.state.lastAssignment;
      this.patch({
        scanResult: response,
        scanHistory: nextHistory,
        assignForm: {
          ...defaultAssignForm,
          qrCode: response.qrCode.code,
          partTypeMode: prefill ? "existing" : defaultAssignForm.partTypeMode,
          existingPartTypeId: prefill?.partTypeId ?? defaultAssignForm.existingPartTypeId,
          location: prefill?.location ?? "",
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
    void this.loadScanLocations(response.entity.partType.id);
    if (response.entity.targetType === "bulk" && (response as { autoIncremented?: boolean }).autoIncremented) {
      this.addToast(`+1 ${response.entity.partType.canonicalName} (now ${response.entity.quantity ?? "?"})`, "success");
    }
  }

  private async loadScanLocations(partTypeId: string): Promise<void> {
    this.scanLocationsAbortController?.abort();
    const controller = new AbortController();
    this.scanLocationsAbortController = controller;
    this.scanLocationsRequestId += 1;
    const requestId = this.scanLocationsRequestId;

    this.patch({
      scanLocations: { status: "loading", partTypeId },
    });

    try {
      const data = await api.getPartTypeItems(partTypeId);
      if (requestId !== this.scanLocationsRequestId) {
        return;
      }
      this.patch({
        scanLocations: { status: "ready", partTypeId, data },
      });
    } catch (caught) {
      if (controller.signal.aborted) {
        return;
      }
      if (requestId !== this.scanLocationsRequestId) {
        return;
      }
      if (this.handleApiFailure(caught)) {
        return;
      }
      this.patch({
        scanLocations: {
          status: "error",
          partTypeId,
          message: errorMessage(caught),
        },
      });
    }
  }

  private async handleBulkQueueScan(
    code: string,
    options: { source?: "manual" | "camera" } = {},
  ): Promise<void> {
    const { source = "manual" } = options;
    this.scanAbortController?.abort();
    this.scanRequestId += 1;
    const requestId = this.scanRequestId;
    const controller = new AbortController();
    this.scanAbortController = controller;

    if (source === "camera") {
      this.patch({ cameraLookupCode: code });
    }
    this.patch({ pendingAction: "scan" });

    try {
      const response = await api.scan(code, {
        signal: controller.signal,
        autoIncrement: false,
      });
      if (requestId !== this.scanRequestId) {
        return;
      }

      this.applyBulkQueueScanResponse(response);
    } catch (caught) {
      if (controller.signal.aborted) {
        return;
      }
      if (this.handleApiFailure(caught)) {
        return;
      }

      const failure: RewriteFailure = {
        kind: "unexpected",
        operation: "bulk.collect",
        message: errorMessage(caught),
        retryability: "never",
        details: { machine: "bulkQueue" },
        cause: caught,
      };
      this.bulkQueueActor.send({ type: "QUEUE.ROW_REJECTED", failure });
      this.addToast(failure.message, "error");
    } finally {
      if (source === "camera" && requestId === this.scanRequestId) {
        this.patch({ cameraLookupCode: null });
      }
      if (requestId === this.scanRequestId) {
        this.patch({ pendingAction: null });
      }
    }
  }

  private applyBulkQueueScanResponse(response: ScanResponse): void {
    const nextHistory = this.buildNextScanHistory(response);
    const accepted = this.buildBulkQueueRow(response);
    if (!accepted.ok) {
      this.bulkQueueActor.send({ type: "QUEUE.ROW_REJECTED", failure: accepted.error });
      this.patch({ scanHistory: nextHistory });
      this.addToast(accepted.error.message, "error");
      return;
    }

    const duplicate = this.state.bulkQueue.rows.find((row) => row.code === accepted.value.code);
    this.bulkQueueActor.send({ type: "QUEUE.ROW_ACCEPTED", row: accepted.value });
    this.patch({ scanHistory: nextHistory });

    this.addToast(
      duplicate
        ? `Collapsed duplicate scan for ${accepted.value.code} · ${duplicate.count + 1} scans`
        : this.describeBulkQueueAcceptance(accepted.value),
      duplicate ? "info" : "success",
    );
  }

  private buildNextScanHistory(response: ScanResponse) {
    const historyCode =
      response.mode === "unknown"
        ? response.code
        : response.qrCode.code;
    return [
      { code: historyCode, mode: response.mode, timestamp: new Date().toISOString() },
      ...this.state.scanHistory,
    ].slice(0, 20);
  }

  private buildBulkQueueRow(response: ScanResponse): { ok: true; value: BulkQueueRow } | { ok: false; error: RewriteFailure } {
    if (this.state.scanMode.kind !== "bulk") {
      return {
        ok: false,
        error: this.createBulkQueueFailure("bulk_queue_mode_mismatch", "Bulk queueing is only available while bulk mode is active."),
      };
    }

    const action = this.state.scanMode.action;
    const timestamp = new Date().toISOString();

    if (response.mode === "unknown") {
      return {
        ok: false,
        error: this.createBulkQueueFailure(
          "bulk_queue_mode_mismatch",
          action === "label"
            ? "Bulk label only accepts printed Smart DB labels."
            : "Bulk move/delete only accepts already assigned Smart DB labels.",
        ),
      };
    }

    if (response.qrCode.batchId === "external") {
      return {
        ok: false,
        error: this.createBulkQueueFailure(
          "bulk_queue_external_unsupported",
          "Bulk queue v1 only accepts Smart DB labels, not external/manufacturer barcodes.",
        ),
      };
    }

    if (action === "label") {
      if (response.mode !== "label") {
        return {
          ok: false,
          error: this.createBulkQueueFailure("bulk_queue_mode_mismatch", "Bulk label only accepts printed, unassigned Smart DB labels."),
        };
      }
      if (this.state.bulkQueue.kind && this.state.bulkQueue.kind !== "unlabeled") {
        return {
          ok: false,
          error: this.createBulkQueueFailure("bulk_queue_mixed_kind", "This queue already contains assigned items. Clear it before bulk labeling."),
        };
      }

      return {
        ok: true,
        value: {
          kind: "unlabeled",
          code: response.qrCode.code,
          batchId: response.qrCode.batchId,
          count: 1,
          firstSeenAt: timestamp,
          lastSeenAt: timestamp,
        } satisfies BulkUnlabeledQueueRow,
      };
    }

    if (response.mode !== "interact") {
      return {
        ok: false,
        error: this.createBulkQueueFailure("bulk_queue_mode_mismatch", "Bulk move/delete only accepts assigned Smart DB labels."),
      };
    }

    if (this.state.bulkQueue.kind && this.state.bulkQueue.kind !== "assigned") {
      return {
        ok: false,
        error: this.createBulkQueueFailure("bulk_queue_mixed_kind", "This queue already contains unlabeled items. Clear it before bulk moving or deleting."),
      };
    }

    const deleteEligibility = this.getBulkDeleteEligibility(response);
    if (action === "delete" && deleteEligibility.status === "ineligible") {
      return {
        ok: false,
        error: this.createBulkQueueFailure("bulk_queue_ineligible", deleteEligibility.reason),
      };
    }

    return {
      ok: true,
      value: {
        kind: "assigned",
        code: response.qrCode.code,
        count: 1,
        firstSeenAt: timestamp,
        lastSeenAt: timestamp,
        targetType: response.entity.targetType,
        targetId: response.entity.id,
        partTypeId: response.entity.partType.id,
        partTypeName: response.entity.partType.canonicalName,
        location: response.entity.location,
        deleteEligibility,
      } satisfies BulkAssignedQueueRow,
    };
  }

  private getBulkDeleteEligibility(
    response: Extract<ScanResponse, { mode: "interact" }>,
  ): BulkDeleteEligibility {
    return response.recentEvents.length === 1 && response.recentEvents[0]?.event === "labeled"
      ? { status: "eligible" }
      : {
          status: "ineligible",
          reason: "Bulk delete only supports fresh ingests whose history is still just the original labeled event.",
        };
  }

  private createBulkQueueFailure(code: Extract<RewriteFailure, { kind: "domain" }>["code"], message: string): RewriteFailure {
    return {
      kind: "domain",
      operation: "bulk.collect",
      code,
      message,
      retryability: "never",
      details: {
        machine: "bulkQueue",
        state: this.state.bulkQueue.status,
      },
    };
  }

  private describeBulkQueueAcceptance(row: BulkQueueRow): string {
    if (row.kind === "unlabeled") {
      return `${row.code} queued for bulk label`;
    }
    return `${row.code} queued for bulk ${this.state.bulkQueue.action}`;
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
    if (this.state.scanMode.kind === "bulk") {
      await this.handleBulkQueueScan(code);
      return;
    }
    await this.performScan(code);
  }

  private handleCameraScanNext(): void {
    this.clearCurrentScanWorkspace();
    void this.startCamera();
  }

  private async handleCameraScan(code: string): Promise<void> {
    if (this.state.pendingAction !== null) {
      this.addToast("Finish the current action first", "error");
      return;
    }

    if (
      this.state.scanMode.kind === "oneByOne" &&
      hasInProgressScanWork(
        this.state.scanResult,
        this.state.assignForm,
        this.state.labelSearch.query,
        this.state.eventForm,
      )
    ) {
      this.addToast("Clear the current scan first", "error");
      return;
    }

    if (this.state.scanMode.kind === "bulk") {
      await this.handleBulkQueueScan(code, { source: "camera" });
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

    // Yield a microtask so the new innerHTML is observable before we query
    // for #rewrite-camera-video. Without this, the querySelector can race
    // the DOM mutation on some render stacks and return null, leaving the
    // stream running with no sink attached.
    await Promise.resolve();

    const video = this.root.querySelector<HTMLVideoElement>("#rewrite-camera-video");
    if (video && this.cameraService.getSnapshot().activeStream) {
      await this.cameraService.attachVideoElement(video);
    }
  }

  private interactTarget(): Extract<ScanResponse, { mode: "interact" }> | null {
    const scanResult = this.state.scanResult;
    if (!scanResult || scanResult.mode !== "interact") {
      return null;
    }
    return scanResult;
  }

  private async openCorrectionOnScan(qrCode: string): Promise<void> {
    this.patch({
      activeTab: "scan",
      scanEdit: defaultScanEditState,
      scanCode: qrCode,
    });
    await this.performScan(qrCode, { silent: false });
  }

  private openScanEdit(action: ScanEditAction = "reassign"): void {
    const target = this.interactTarget();
    if (!target) {
      return;
    }
    if (action === "reverseIngest" && "canReverseIngest" in target && !target.canReverseIngest) {
      return;
    }
    if (action === "editShared" && "canEditSharedType" in target && !target.canEditSharedType) {
      return;
    }

    const form = this.buildScanEditForm(action, target);
    this.scanActor.send({ type: "EDIT.OPEN", editKind: action });
    this.patch({
      scanEdit: {
        status: "open",
        form,
        history: [],
        historyError: null,
        dirty: false,
      },
    });
    void this.loadScanEditHistory(target.entity.targetType, target.entity.id);
  }

  private buildScanEditForm(
    action: ScanEditAction,
    target: Extract<ScanResponse, { mode: "interact" }>,
  ): ScanEditForm {
    if (action === "reassign") {
      return {
        action: "reassign",
        search: {
          query: "",
          results: [...this.state.catalogSuggestions],
          status: "idle",
          error: null,
        },
        replacementPartTypeId: "",
        reason: "",
      };
    }
    if (action === "editShared") {
      return {
        action: "editShared",
        sharedCanonicalName: target.entity.partType.canonicalName,
        sharedCategory: formatCategoryPath(target.entity.partType.categoryPath),
        sharedExpectedUpdatedAt: target.entity.partType.updatedAt,
        reason: "",
      };
    }
    return { action: "reverseIngest", reason: "" };
  }

  private closeScanEdit(): void {
    this.searchControllers.edit?.abort();
    if (this.state.scanEdit.status === "open") {
      this.scanActor.send({ type: "EDIT.CLOSE" });
    }
    this.patch({ scanEdit: defaultScanEditState });
  }

  private setScanEditAction(action: ScanEditAction): void {
    const edit = this.state.scanEdit;
    const target = this.interactTarget();
    if (edit.status !== "open" || !target) {
      return;
    }

    let form: ScanEditForm;
    if (action === "reassign") {
      form = {
        action: "reassign",
        search: {
          query: "",
          results: [...this.state.catalogSuggestions],
          status: "idle",
          error: null,
        },
        replacementPartTypeId: "",
        reason: "",
      };
    } else if (action === "editShared") {
      form = {
        action: "editShared",
        sharedCanonicalName: target.entity.partType.canonicalName,
        sharedCategory: formatCategoryPath(target.entity.partType.categoryPath),
        sharedExpectedUpdatedAt: target.entity.partType.updatedAt,
        reason: "",
      };
    } else {
      form = {
        action: "reverseIngest",
        reason: "",
      };
    }

    this.patch({
      scanEdit: {
        status: "open",
        form,
        history: edit.history,
        historyError: edit.historyError,
        dirty: false,
      },
    });
  }

  private selectScanEditReplacementPart(partId: string): void {
    const edit = this.state.scanEdit;
    if (edit.status !== "open" || edit.form.action !== "reassign") {
      return;
    }
    this.patch({
      scanEdit: {
        ...edit,
        form: { ...edit.form, replacementPartTypeId: partId },
        dirty: true,
      },
    });
  }

  private patchScanEditForm(update: Partial<ScanEditForm>): void {
    const edit = this.state.scanEdit;
    if (edit.status !== "open") {
      return;
    }
    const merged = { ...edit.form, ...update } as ScanEditForm;
    this.patch({
      scanEdit: {
        ...edit,
        form: merged,
        dirty: true,
      },
    });
  }

  private async loadScanEditHistory(targetType: "instance" | "bulk", targetId: string): Promise<void> {
    try {
      const history = await api.getCorrectionHistory({ targetType, targetId });
      const edit = this.state.scanEdit;
      if (edit.status !== "open") {
        return;
      }
      this.patch({
        scanEdit: { ...edit, history, historyError: null },
      });
    } catch (caught) {
      if (this.handleApiFailure(caught)) {
        return;
      }
      const edit = this.state.scanEdit;
      if (edit.status !== "open") {
        return;
      }
      this.patch({
        scanEdit: { ...edit, history: [], historyError: errorMessage(caught) },
      });
    }
  }

  private async handleScanEditReassign(): Promise<void> {
    const target = this.interactTarget();
    const edit = this.state.scanEdit;
    if (!target || edit.status !== "open" || edit.form.action !== "reassign") {
      this.addToast("Scan an ingested item first.", "error");
      return;
    }

    const parsed = parseReassignPartTypeForm({
      targetType: target.entity.targetType,
      targetId: target.entity.id,
      fromPartTypeId: target.entity.partType.id,
      toPartTypeId: edit.form.replacementPartTypeId,
      reason: edit.form.reason,
    });
    if (!parsed.ok) {
      this.addToast(this.failureMessage(parsed.error), "error");
      return;
    }

    this.scanActor.send({ type: "EDIT.SUBMIT_REQUESTED" });
    this.patch({ pendingAction: "correct" as PendingAction });
    try {
      await api.reassignEntityPartType(parsed.value);
      this.scanActor.send({ type: "EDIT.SUCCEEDED", editKind: "reassign" });
      const refreshed = await api.scan(target.qrCode.code, { autoIncrement: false });
      this.patch({
        scanResult: refreshed,
        scanEdit: defaultScanEditState,
      });
      this.addToast("Item corrected to the replacement part type.", "success");
      await this.loadAuthenticatedData();
    } catch (caught) {
      this.scanActor.send({
        type: "EDIT.FAILED",
        failure: {
          kind: "unexpected",
          operation: "correction.reassignEntityPartType",
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

  private async handleScanEditEditShared(): Promise<void> {
    const target = this.interactTarget();
    const edit = this.state.scanEdit;
    if (!target || edit.status !== "open" || edit.form.action !== "editShared") {
      this.addToast("Scan an ingested item first.", "error");
      return;
    }

    const parsed = parseEditPartTypeDefinitionForm({
      partTypeId: target.entity.partType.id,
      expectedUpdatedAt: edit.form.sharedExpectedUpdatedAt,
      canonicalName: edit.form.sharedCanonicalName,
      category: edit.form.sharedCategory,
      reason: edit.form.reason,
    });
    if (!parsed.ok) {
      this.addToast(this.failureMessage(parsed.error), "error");
      return;
    }

    const conflicts = findSharedTypeConflictCandidates(
      this.state.inventorySummary,
      target.entity.partType.id,
      edit.form.sharedCanonicalName,
      edit.form.sharedCategory,
    );
    if (conflicts.length > 0) {
      this.addToast(
        `A part type named '${conflicts[0]!.canonicalName}' already exists in ${conflicts[0]!.categoryPath.join(" / ")}. Use 'Fix this item only' to reassign this scan instead of renaming the shared type.`,
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

    this.scanActor.send({ type: "EDIT.SUBMIT_REQUESTED" });
    this.patch({ pendingAction: "correct" as PendingAction });
    try {
      await api.editPartTypeDefinition(parsed.value);
      this.scanActor.send({ type: "EDIT.SUCCEEDED", editKind: "editShared" });
      const refreshed = await api.scan(target.qrCode.code, { autoIncrement: false });
      this.patch({
        scanResult: refreshed,
        scanEdit: defaultScanEditState,
      });
      this.addToast("Shared part type updated.", "success");
      await this.loadAuthenticatedData();
    } catch (caught) {
      this.scanActor.send({
        type: "EDIT.FAILED",
        failure: {
          kind: "unexpected",
          operation: "correction.editPartTypeDefinition",
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

  private async handleScanEditReverseIngest(): Promise<void> {
    const target = this.interactTarget();
    const edit = this.state.scanEdit;
    if (!target || edit.status !== "open" || edit.form.action !== "reverseIngest") {
      this.addToast("Scan an ingested item first.", "error");
      return;
    }
    if (
      typeof window !== "undefined" &&
      !window.confirm("Reverse this ingest? The QR/Data Matrix will return to printed state, while the correction audit remains.")
    ) {
      return;
    }

    const parsed = parseReverseIngestForm({
      qrCode: target.qrCode.code,
      assignedKind: target.entity.targetType,
      assignedId: target.entity.id,
      reason: edit.form.reason,
    });
    if (!parsed.ok) {
      this.addToast(this.failureMessage(parsed.error), "error");
      return;
    }

    this.scanActor.send({ type: "EDIT.SUBMIT_REQUESTED" });
    this.patch({ pendingAction: "correct" as PendingAction });
    try {
      await api.reverseIngestAssignment(parsed.value);
      this.scanActor.send({ type: "EDIT.SUCCEEDED", editKind: "reverseIngest" });
      this.patch({
        scanResult: null,
        scanEdit: defaultScanEditState,
      });
      this.addToast("Ingest reversed. The item is no longer assigned.", "success");
      await this.loadAuthenticatedData();
    } catch (caught) {
      this.scanActor.send({
        type: "EDIT.FAILED",
        failure: {
          kind: "unexpected",
          operation: "correction.reverseIngest",
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

  private async handleBulkAssign(): Promise<void> {
    if (this.state.scanMode.kind !== "bulk" || this.state.scanMode.action !== "label") {
      this.addToast("Switch to bulk label before submitting a bulk label batch.", "error");
      return;
    }

    this.patch({ pendingAction: "bulk" });
    this.bulkQueueActor.send({ type: "QUEUE.SUBMIT_REQUESTED" });
    try {
      const parsed = parseBulkAssignForm({
        ...this.state.bulkQueue.labelForm,
        qrs: this.state.bulkQueue.rows.map((row) => row.code),
      });
      if (!parsed.ok) {
        this.bulkQueueActor.send({ type: "QUEUE.SUBMIT_FAILED", failure: parsed.error });
        this.addToast(this.failureMessage(parsed.error), "error");
        return;
      }

      const response = await api.bulkAssignQrs(parsed.value);
      this.bulkQueueActor.send({ type: "QUEUE.SUBMIT_SUCCEEDED" });
      this.clearBulkQueue("label");
      this.addToast(`Bulk labeled ${response.processedCount} Smart DB labels.`, "success");
      await this.loadAuthenticatedData();
    } catch (caught) {
      const failure = this.createBulkSubmitFailure("bulk.assign", caught);
      this.bulkQueueActor.send({ type: "QUEUE.SUBMIT_FAILED", failure });
      if (!this.handleApiFailure(caught)) {
        this.addToast(failure.message, "error");
      }
    } finally {
      this.patch({ pendingAction: null });
    }
  }

  private async handleBulkMove(): Promise<void> {
    if (this.state.scanMode.kind !== "bulk" || this.state.scanMode.action !== "move") {
      this.addToast("Switch to bulk move before submitting a bulk move batch.", "error");
      return;
    }

    this.patch({ pendingAction: "bulk" });
    this.bulkQueueActor.send({ type: "QUEUE.SUBMIT_REQUESTED" });
    try {
      const parsed = parseBulkMoveForm({
        targets: this.buildBulkMoveTargets(),
        location: this.state.bulkQueue.moveForm.location,
        notes: this.state.bulkQueue.moveForm.notes,
      });
      if (!parsed.ok) {
        this.bulkQueueActor.send({ type: "QUEUE.SUBMIT_FAILED", failure: parsed.error });
        this.addToast(this.failureMessage(parsed.error), "error");
        return;
      }

      const response = await api.bulkMoveEntities(parsed.value);
      this.bulkQueueActor.send({ type: "QUEUE.SUBMIT_SUCCEEDED" });
      this.clearBulkQueue("move");
      this.addToast(`Bulk moved ${response.processedCount} Smart DB labels.`, "success");
      await this.loadAuthenticatedData();
    } catch (caught) {
      const failure = this.createBulkSubmitFailure("bulk.move", caught);
      this.bulkQueueActor.send({ type: "QUEUE.SUBMIT_FAILED", failure });
      if (!this.handleApiFailure(caught)) {
        this.addToast(failure.message, "error");
      }
    } finally {
      this.patch({ pendingAction: null });
    }
  }

  private async handleBulkDelete(): Promise<void> {
    if (this.state.scanMode.kind !== "bulk" || this.state.scanMode.action !== "delete") {
      this.addToast("Switch to bulk delete before submitting a bulk delete batch.", "error");
      return;
    }
    if (
      this.state.authState.status !== "authenticated" ||
      !hasSmartDbRole(this.state.authState.session.roles, smartDbRoles.admin)
    ) {
      this.addToast("Bulk delete requires Smart DB admin access.", "error");
      return;
    }
    if (
      typeof window !== "undefined" &&
      !window.confirm("Reverse every eligible ingest in this bulk queue? The correction audit will be preserved.")
    ) {
      return;
    }

    this.patch({ pendingAction: "bulk" });
    this.bulkQueueActor.send({ type: "QUEUE.SUBMIT_REQUESTED" });
    try {
      const parsed = parseBulkDeleteForm({
        targets: this.buildBulkDeleteTargets(),
        reason: this.state.bulkQueue.deleteForm.reason,
      });
      if (!parsed.ok) {
        this.bulkQueueActor.send({ type: "QUEUE.SUBMIT_FAILED", failure: parsed.error });
        this.addToast(this.failureMessage(parsed.error), "error");
        return;
      }

      const response = await api.bulkReverseIngest(parsed.value);
      this.bulkQueueActor.send({ type: "QUEUE.SUBMIT_SUCCEEDED" });
      this.clearBulkQueue("delete");
      this.addToast(`Bulk deleted ${response.processedCount} fresh ingests.`, "success");
      await this.loadAuthenticatedData();
    } catch (caught) {
      const failure = this.createBulkSubmitFailure("bulk.delete", caught);
      this.bulkQueueActor.send({ type: "QUEUE.SUBMIT_FAILED", failure });
      if (!this.handleApiFailure(caught)) {
        this.addToast(failure.message, "error");
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

  private async openPartDetail(partTypeId: string): Promise<void> {
    this.patch({
      inventoryUi: { ...this.state.inventoryUi, detailPartTypeId: partTypeId },
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
        inventoryUi: { ...this.state.inventoryUi, expandedItems, expandedErrors },
      });
    } catch (caught) {
      const expandedErrors = new Map(this.state.inventoryUi.expandedErrors);
      expandedErrors.set(partTypeId, errorMessage(caught));
      this.patch({
        inventoryUi: { ...this.state.inventoryUi, expandedErrors },
      });
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

  private setBulkLabelMode(mode: "existing" | "new"): void {
    if (mode === "existing") {
      this.patch({
        bulkQueue: {
          ...this.state.bulkQueue,
          labelForm: {
            ...this.state.bulkQueue.labelForm,
            partTypeMode: "existing",
            canonicalName: "",
            category: "",
          },
        },
      });
      return;
    }

    this.patch({
      bulkQueue: {
        ...this.state.bulkQueue,
        labelForm: {
          ...this.state.bulkQueue.labelForm,
          partTypeMode: "new",
          existingPartTypeId: "",
        },
      },
    });
  }

  private setBulkLabelEntityKind(kind: "instance" | "bulk"): void {
    this.patch({
      bulkQueue: {
        ...this.state.bulkQueue,
        labelForm: {
          ...this.state.bulkQueue.labelForm,
          entityKind: kind,
          countable: kind === "instance" ? true : this.state.bulkQueue.labelForm.countable,
        },
      },
    });
  }

  private setBulkLabelCountability(countable: boolean): void {
    const nextUnit = countable && !getMeasurementUnitBySymbol(this.state.bulkQueue.labelForm.unitSymbol)?.isInteger
      ? "pcs"
      : this.state.bulkQueue.labelForm.unitSymbol;
    this.patch({
      bulkQueue: {
        ...this.state.bulkQueue,
        labelForm: {
          ...this.state.bulkQueue.labelForm,
          entityKind: "bulk",
          countable,
          unitSymbol: nextUnit,
        },
      },
    });
  }

  private selectBulkLabelPartType(partId: string): void {
    const selected = this.state.bulkQueue.labelSearch.results.find((partType) => partType.id === partId) ??
      this.state.catalogSuggestions.find((partType) => partType.id === partId);
    if (!selected) {
      return;
    }

    this.patch({
      bulkQueue: {
        ...this.state.bulkQueue,
        labelForm: {
          ...this.state.bulkQueue.labelForm,
          entityKind: selected.countable
            ? this.state.bulkQueue.labelForm.entityKind
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
      },
    });
  }

  private createBulkLabelVariant(partId: string): void {
    const selected = this.state.bulkQueue.labelSearch.results.find((partType) => partType.id === partId) ??
      this.state.catalogSuggestions.find((partType) => partType.id === partId);
    if (!selected) {
      return;
    }

    this.patch({
      bulkQueue: {
        ...this.state.bulkQueue,
        labelForm: {
          ...this.state.bulkQueue.labelForm,
          partTypeMode: "new",
          existingPartTypeId: "",
          canonicalName: selected.canonicalName,
          category: formatCategoryPath(selected.categoryPath),
          countable: selected.countable,
          entityKind: selected.countable ? this.state.bulkQueue.labelForm.entityKind : "bulk",
          unitSymbol: selected.unit.symbol,
        },
      },
    });
  }

  private setTopLevelScanMode(kind: "oneByOne" | "bulk"): void {
    if (kind === "oneByOne") {
      this.clearBulkQueue();
      this.scanActor.send({ type: "SCAN.CLEAR_REQUESTED" });
      this.patch({
        scanMode: {
          kind: "oneByOne",
          behavior: this.preferredOneByOneBehavior,
        },
        lastAssignment: null,
        scanHistory: [],
      });
      return;
    }

    this.clearCurrentScanWorkspace();
    this.patch({
      scanMode: {
        kind: "bulk",
        action: this.state.bulkQueue.action,
      },
    });
  }

  private setOneByOneBehavior(behavior: OneByOneScanBehavior): void {
    this.preferredOneByOneBehavior = behavior;
    this.patch({
      scanMode: {
        kind: "oneByOne",
        behavior,
      },
    });
  }

  private setBulkQueueAction(action: BulkQueueAction): void {
    this.clearBulkQueue(action);
    this.patch({
      scanMode: {
        kind: "bulk",
        action,
      },
    });
  }

  private restoreScanMode(): ScanModeState {
    return defaultScanMode;
  }

  private clearCurrentScanWorkspace(): void {
    this.cameraService.stop();
    this.scanActor.send({ type: "SCAN.CLEAR_REQUESTED" });
    this.patch({
      cameraLookupCode: null,
      scanCode: "",
      scanResult: null,
      assignForm: defaultAssignForm,
      eventForm: defaultEventForm,
      labelSearch: defaultSearchState,
      scanHistory: [],
      lastAssignment: null,
    });
  }

  private clearBulkQueue(action: BulkQueueAction = this.state.bulkQueue.action): void {
    this.bulkQueueActor.send({ type: "QUEUE.ACTION_CHANGED", action });
    this.patch({
      bulkQueue: {
        ...defaultBulkQueueState,
        action,
        labelSearch: {
          ...defaultSearchState,
          results: [...this.state.catalogSuggestions],
        },
      },
    });
  }

  private buildBulkMoveTargets(): BulkEntityTarget[] {
    return this.state.bulkQueue.rows
      .filter((row): row is BulkAssignedQueueRow => row.kind === "assigned")
      .map((row) => ({
        targetType: row.targetType,
        targetId: row.targetId,
        qrCode: row.code,
      }));
  }

  private buildBulkDeleteTargets(): BulkReverseIngestTarget[] {
    return this.state.bulkQueue.rows
      .filter((row): row is BulkAssignedQueueRow => row.kind === "assigned")
      .map((row) => ({
        assignedKind: row.targetType,
        assignedId: row.targetId,
        qrCode: row.code,
      }));
  }

  private createBulkSubmitFailure(
    operation: "bulk.assign" | "bulk.move" | "bulk.delete",
    caught: unknown,
  ): RewriteFailure {
    if (caught instanceof ApiClientError && caught.code === "conflict") {
      return {
        kind: "conflict",
        operation,
        code: "stale_state",
        message: errorMessage(caught),
        retryability: "after-user-action",
        details: {
          targetId: null,
        },
      };
    }

    return {
      kind: "unexpected",
      operation,
      message: errorMessage(caught),
      retryability: "never",
      details: {
        machine: "bulkQueue",
      },
      cause: caught,
    };
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
    const scrollY = window.scrollY;
    const scrollKeys = this.captureScrollPositions();

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
    this.restoreScrollPositions(scrollKeys);
    if (window.scrollY !== scrollY) {
      window.scrollTo({ top: scrollY, left: 0, behavior: "instant" as ScrollBehavior });
    }
  }

  private captureScrollPositions(): Map<string, number> {
    const map = new Map<string, number>();
    this.root.querySelectorAll<HTMLElement>("[data-scroll-key]").forEach((el) => {
      const key = el.dataset.scrollKey;
      if (key && el.scrollTop > 0) {
        map.set(key, el.scrollTop);
      }
    });
    return map;
  }

  private restoreScrollPositions(map: Map<string, number>): void {
    if (map.size === 0) {
      return;
    }
    map.forEach((top, key) => {
      const el = this.root.querySelector<HTMLElement>(`[data-scroll-key="${CSS.escape(key)}"]`);
      if (el) {
        el.scrollTop = top;
      }
    });
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

function summarizeBulkQueue(rows: readonly BulkQueueRow[]) {
  const totalScanCount = rows.reduce((sum, row) => sum + row.count, 0);
  return {
    uniqueLabelCount: rows.length,
    totalScanCount,
    duplicateScanCount: totalScanCount - rows.length,
  };
}
