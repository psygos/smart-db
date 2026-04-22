import type {
  AuthSession,
  CorrectionEvent,
  DashboardSummary,
  PartDbConnectionStatus,
  PartDbSyncFailure,
  PartDbSyncStatusResponse,
  PartType,
  QrBatch,
  RegisterQrBatchRequest,
  ScanResponse,
} from "@smart-db/contracts";
export type ScanEditAction = "reassign" | "editShared" | "reverseIngest";
import type { InventorySummaryRow, PartTypeItemsResponse } from "../api";
import type { CameraScannerSnapshot } from "./services/camera-scanner-service";
import type {
  AssignFormState,
  EventFormState,
  SearchState,
} from "./presentation-helpers";
import type { RewriteFailure } from "./errors";

export type PendingAction =
  | "login"
  | "logout"
  | "batch"
  | "scan"
  | "bulk"
  | "assign"
  | "event"
  | "correct"
  | "merge"
  | "sync"
  | null;

export type AuthViewState =
  | {
      readonly status: "checking" | "authenticating";
      readonly session: null;
      readonly error: string | null;
    }
  | {
      readonly status: "unauthenticated";
      readonly session: null;
      readonly error: string | null;
    }
  | {
      readonly status: "authenticated";
      readonly session: AuthSession;
      readonly error: string | null;
    };

export type TabId = "scan" | "inventory" | "activity" | "dashboard" | "admin";

export interface ToastRecord {
  readonly id: string;
  readonly type: "success" | "error" | "info";
  readonly message: string;
}

export interface LastAssignment {
  readonly partTypeName: string;
  readonly partTypeId: string;
  readonly location: string;
}

export interface ScanHistoryEntry {
  readonly code: string;
  readonly mode: string;
  readonly timestamp: string;
}

export interface InventoryUiState {
  readonly query: string;
  readonly showEmpty: boolean;
  readonly expandedId: string | null;
  readonly expandedItems: ReadonlyMap<string, PartTypeItemsResponse>;
  readonly expandedErrors: ReadonlyMap<string, string>;
  readonly detailPartTypeId: string | null;
}

export interface PathPickerUiState {
  readonly open: boolean;
  readonly query: string;
  readonly expanded: readonly string[];
  readonly createOpen: boolean;
  readonly createParent: string;
  readonly createName: string;
}

export type OneByOneScanBehavior = "increment" | "viewOnly";
export type BulkQueueAction = "label" | "move" | "delete";

export type ScanModeState =
  | {
      readonly kind: "oneByOne";
      readonly behavior: OneByOneScanBehavior;
    }
  | {
      readonly kind: "bulk";
      readonly action: BulkQueueAction;
    };

export interface BulkQueueSummary {
  readonly uniqueLabelCount: number;
  readonly totalScanCount: number;
  readonly duplicateScanCount: number;
}

export interface BulkLabelFormState extends Omit<AssignFormState, "qrCode"> {}

export interface BulkMoveFormState {
  readonly location: string;
  readonly notes: string;
}

export interface BulkDeleteFormState {
  readonly reason: string;
}

export interface BulkUnlabeledQueueRow {
  readonly kind: "unlabeled";
  readonly code: string;
  readonly batchId: string;
  readonly count: number;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
}

export type BulkDeleteEligibility =
  | {
      readonly status: "eligible";
    }
  | {
      readonly status: "ineligible";
      readonly reason: string;
    };

export interface BulkAssignedQueueRow {
  readonly kind: "assigned";
  readonly code: string;
  readonly count: number;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  readonly targetType: "instance" | "bulk";
  readonly targetId: string;
  readonly partTypeId: string;
  readonly partTypeName: string;
  readonly location: string;
  readonly deleteEligibility: BulkDeleteEligibility;
}

export type BulkQueueRow = BulkUnlabeledQueueRow | BulkAssignedQueueRow;

export type BulkQueueStatus = "empty" | "ready" | "submitting" | "failed";

export interface BulkQueueUiState {
  readonly status: BulkQueueStatus;
  readonly action: BulkQueueAction;
  readonly kind: "unlabeled" | "assigned" | null;
  readonly rows: readonly BulkQueueRow[];
  readonly summary: BulkQueueSummary;
  readonly failure: RewriteFailure | null;
  readonly labelForm: BulkLabelFormState;
  readonly labelSearch: SearchState;
  readonly moveForm: BulkMoveFormState;
  readonly deleteForm: BulkDeleteFormState;
}

export type ScanEditForm =
  | {
      readonly action: "reassign";
      readonly search: SearchState;
      readonly replacementPartTypeId: string;
      readonly reason: string;
    }
  | {
      readonly action: "editShared";
      readonly sharedCanonicalName: string;
      readonly sharedCategory: string;
      readonly sharedExpectedUpdatedAt: string;
      readonly reason: string;
    }
  | {
      readonly action: "reverseIngest";
      readonly reason: string;
    };

export interface InventoryReverseTarget {
  readonly kind: "instance" | "bulk";
  readonly id: string;
  readonly qrCode: string;
}

export interface InventoryReverseSelection {
  readonly partTypeId: string | null;
  readonly targets: readonly InventoryReverseTarget[];
  readonly reason: string;
}

export const defaultInventoryReverseSelection: InventoryReverseSelection = {
  partTypeId: null,
  targets: [],
  reason: "",
};

export type ScanLocationsState =
  | { readonly status: "idle" }
  | { readonly status: "loading"; readonly partTypeId: string }
  | {
      readonly status: "ready";
      readonly partTypeId: string;
      readonly data: PartTypeItemsResponse;
    }
  | {
      readonly status: "error";
      readonly partTypeId: string;
      readonly message: string;
    };

export type ScanEditState =
  | { readonly status: "closed" }
  | {
      readonly status: "open";
      readonly form: ScanEditForm;
      readonly history: readonly CorrectionEvent[];
      readonly historyError: string | null;
      readonly dirty: boolean;
    };

export interface RewriteUiState {
  readonly theme: "light" | "dark";
  readonly authState: AuthViewState;
  readonly dashboard: DashboardSummary | null;
  readonly partDbStatus: PartDbConnectionStatus | null;
  readonly partDbSyncStatus: PartDbSyncStatusResponse | null;
  readonly partDbSyncFailures: readonly PartDbSyncFailure[];
  readonly latestBatch: QrBatch | null;
  readonly catalogSuggestions: readonly PartType[];
  readonly knownLocations: readonly string[];
  readonly knownCategories: readonly string[];
  readonly inventorySummary: readonly InventorySummaryRow[];
  readonly inventoryUi: InventoryUiState;
  readonly scanEdit: ScanEditState;
  readonly scanLocations: ScanLocationsState;
  readonly correctionLog: readonly CorrectionEvent[];
  readonly correctionLogError: string | null;
  readonly inventoryReverseSelection: InventoryReverseSelection;
  readonly provisionalPartTypes: readonly PartType[];
  readonly labelSearch: SearchState;
  readonly mergeSearch: SearchState;
  readonly scanResult: ScanResponse | null;
  readonly batchForm: RegisterQrBatchRequest;
  readonly assignForm: AssignFormState;
  readonly eventForm: EventFormState;
  readonly scanCode: string;
  readonly scanMode: ScanModeState;
  readonly bulkQueue: BulkQueueUiState;
  readonly scanHistory: readonly ScanHistoryEntry[];
  readonly lastAssignment: LastAssignment | null;
  readonly camera: CameraScannerSnapshot;
  readonly cameraLookupCode: string | null;
  readonly mergeSourceId: string;
  readonly mergeDestinationId: string;
  readonly pendingAction: PendingAction;
  readonly downloadingBatchId: string | null;
  readonly activeTab: TabId;
  readonly toasts: readonly ToastRecord[];
  readonly isOnline: boolean;
  readonly sessionExpiringSoon: boolean;
  readonly refreshError: string | null;
  readonly categoryPicker: PathPickerUiState;
  readonly locationPicker: PathPickerUiState;
}

export const defaultBatchForm: RegisterQrBatchRequest = {
  prefix: "QR",
  startNumber: 1001,
  count: 25,
};

export const defaultAssignForm: AssignFormState = {
  qrCode: "",
  entityKind: "instance",
  location: "",
  notes: "",
  partTypeMode: "existing",
  existingPartTypeId: "",
  canonicalName: "",
  category: "",
  countable: true,
  unitSymbol: "pcs",
  initialStatus: "available",
  initialQuantity: "1",
  minimumQuantity: "",
};

export const defaultBulkLabelForm: BulkLabelFormState = {
  entityKind: "instance",
  location: "",
  notes: "",
  partTypeMode: "existing",
  existingPartTypeId: "",
  canonicalName: "",
  category: "",
  countable: true,
  unitSymbol: "pcs",
  initialStatus: "available",
  initialQuantity: "1",
  minimumQuantity: "",
};

export const defaultEventForm: EventFormState = {
  targetType: "instance",
  targetId: "",
  event: "moved",
  location: "",
  quantityDelta: "",
  quantity: "",
  quantityIsInteger: true,
  splitQuantity: "",
  assignee: "",
  notes: "",
};

export const defaultSearchState: SearchState = {
  query: "",
  results: [],
  status: "idle",
  error: null,
};

export const defaultScanMode: ScanModeState = {
  kind: "oneByOne",
  behavior: "viewOnly",
};

export const defaultBulkQueueState: BulkQueueUiState = {
  status: "empty",
  action: "label",
  kind: null,
  rows: [],
  summary: {
    uniqueLabelCount: 0,
    totalScanCount: 0,
    duplicateScanCount: 0,
  },
  failure: null,
  labelForm: defaultBulkLabelForm,
  labelSearch: defaultSearchState,
  moveForm: {
    location: "",
    notes: "",
  },
  deleteForm: {
    reason: "",
  },
};

export const defaultInventoryUiState: InventoryUiState = {
  query: "",
  showEmpty: false,
  expandedId: null,
  expandedItems: new Map(),
  expandedErrors: new Map(),
  detailPartTypeId: null,
};

export const defaultPathPickerState: PathPickerUiState = {
  open: false,
  query: "",
  expanded: [],
  createOpen: false,
  createParent: "",
  createName: "",
};

export const defaultScanEditState: ScanEditState = {
  status: "closed",
};

export const defaultScanLocationsState: ScanLocationsState = {
  status: "idle",
};

export function makeReassignForm(): Extract<ScanEditForm, { action: "reassign" }> {
  return {
    action: "reassign",
    search: defaultSearchState,
    replacementPartTypeId: "",
    reason: "",
  };
}

export function makeEditSharedForm(
  canonicalName: string,
  categoryPath: readonly string[],
  expectedUpdatedAt: string,
): Extract<ScanEditForm, { action: "editShared" }> {
  return {
    action: "editShared",
    sharedCanonicalName: canonicalName,
    sharedCategory: categoryPath.join(" / "),
    sharedExpectedUpdatedAt: expectedUpdatedAt,
    reason: "",
  };
}

export function makeReverseIngestForm(): Extract<ScanEditForm, { action: "reverseIngest" }> {
  return {
    action: "reverseIngest",
    reason: "",
  };
}

export const defaultCameraState: CameraScannerSnapshot = {
  phase: "idle",
  supported: true,
  permissionState: "unknown",
  lastResult: null,
  activeStream: false,
  videoBound: false,
  failure: null,
};
