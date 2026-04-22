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
import type { InventorySummaryRow, PartTypeItemsResponse } from "../api";
import type { CameraScannerSnapshot } from "./services/camera-scanner-service";
import type {
  AssignFormState,
  EventFormState,
  SearchState,
} from "./presentation-helpers";

export type PendingAction =
  | "login"
  | "logout"
  | "batch"
  | "scan"
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

export type CorrectionAction = "reassign" | "editShared" | "reverseIngest" | null;

export interface CorrectionUiState {
  readonly scanCode: string;
  readonly target: Extract<ScanResponse, { mode: "interact" }> | null;
  readonly targetError: string | null;
  readonly history: readonly CorrectionEvent[];
  readonly historyError: string | null;
  readonly search: SearchState;
  readonly replacementPartTypeId: string;
  readonly action: CorrectionAction;
  readonly reason: string;
  readonly sharedCanonicalName: string;
  readonly sharedCategory: string;
  readonly sharedExpectedUpdatedAt: string;
}

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
  readonly correctionUi: CorrectionUiState;
  readonly provisionalPartTypes: readonly PartType[];
  readonly labelSearch: SearchState;
  readonly mergeSearch: SearchState;
  readonly scanResult: ScanResponse | null;
  readonly batchForm: RegisterQrBatchRequest;
  readonly assignForm: AssignFormState;
  readonly eventForm: EventFormState;
  readonly scanCode: string;
  readonly scanMode: "increment" | "inspect";
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

export const defaultCorrectionUiState: CorrectionUiState = {
  scanCode: "",
  target: null,
  targetError: null,
  history: [],
  historyError: null,
  search: {
    query: "",
    results: [],
    status: "idle",
    error: null,
  },
  replacementPartTypeId: "",
  action: null,
  reason: "",
  sharedCanonicalName: "",
  sharedCategory: "",
  sharedExpectedUpdatedAt: "",
};

export const defaultCameraState: CameraScannerSnapshot = {
  phase: "idle",
  supported: true,
  permissionState: "unknown",
  lastResult: null,
  activeStream: false,
  videoBound: false,
  failure: null,
};
