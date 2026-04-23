import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  defaultAssignForm,
  defaultBatchForm,
  defaultBulkQueueState,
  defaultCameraState,
  defaultEventForm,
  defaultInventoryReverseSelection,
  defaultInventoryUiState,
  defaultPathPickerState,
  defaultScanEditState,
  defaultScanLocationsState,
  defaultScanMode,
  defaultSearchState,
  type BulkAssignedQueueRow,
  type RewriteUiState,
} from "./ui-state";
import { buildMotionSnapshot, runPostRenderMotion } from "./motion";
import {
  defaultMeasurementUnit,
  type PartDbLookupSummary,
  type PartType,
  type QRCode,
  type ScanResponse,
} from "@smart-db/contracts";

const anime = vi.hoisted(() => ({
  animate: vi.fn(),
  stagger: vi.fn(() => 0),
}));

vi.mock("animejs", () => ({
  animate: anime.animate,
  stagger: anime.stagger,
}));

const now = "2025-04-23T10:00:00.000Z";
const partDb: PartDbLookupSummary = {
  configured: true,
  connected: true,
  message: "linked",
};

const partType: PartType = {
  id: "part-1",
  canonicalName: "Arduino Uno R3",
  category: "Electronics / Boards",
  categoryPath: ["Electronics", "Boards"],
  aliases: [],
  imageUrl: null,
  notes: null,
  countable: true,
  unit: defaultMeasurementUnit,
  needsReview: false,
  partDbPartId: null,
  partDbCategoryId: null,
  partDbUnitId: null,
  partDbSyncStatus: "never",
  createdAt: now,
  updatedAt: now,
};

const qrCode: QRCode = {
  code: "QRX7-9A2B",
  batchId: "batch-1",
  status: "assigned",
  assignedKind: "instance",
  assignedId: "inst-1",
  createdAt: now,
  updatedAt: now,
};

function makeState(patch: Partial<RewriteUiState> = {}): RewriteUiState {
  return {
    theme: "light",
    authState: {
      status: "authenticated",
      session: {
        subject: null,
        username: "operator",
        name: null,
        email: null,
        roles: [],
        issuedAt: now,
        expiresAt: null,
      },
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
    scanMode: defaultScanMode,
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
    isOnline: true,
    sessionExpiringSoon: false,
    refreshError: null,
    categoryPicker: defaultPathPickerState,
    locationPicker: defaultPathPickerState,
    ...patch,
  };
}

function setReducedMotion(matches: boolean | undefined): void {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: matches === undefined ? undefined : vi.fn(() => ({ matches })),
  });
}

function labelScan(): ScanResponse {
  return {
    mode: "label",
    qrCode: {
      ...qrCode,
      status: "printed",
      assignedKind: null,
      assignedId: null,
    },
    suggestions: [],
    partDb,
  };
}

function interactScan(targetType: "instance" | "bulk"): ScanResponse {
  return {
    mode: "interact",
    qrCode,
    entity: {
      id: targetType === "instance" ? "inst-1" : "bulk-1",
      targetType,
      qrCode: qrCode.code,
      partType,
      location: "Shelf B2",
      state: targetType === "instance" ? "available" : "good",
      assignee: null,
      partDbSyncStatus: "never",
      quantity: targetType === "bulk" ? 12 : null,
      minimumQuantity: targetType === "bulk" ? 2 : null,
    },
    recentEvents: [],
    availableActions: targetType === "instance" ? ["moved"] : ["moved", "restocked"],
    partDb,
    currentBorrow: targetType === "instance" ? null : undefined,
    canReverseIngest: false,
    canEditSharedType: false,
  };
}

function assignedRow(count: number): BulkAssignedQueueRow {
  return {
    kind: "assigned",
    code: "QRX7-9A2B",
    count,
    firstSeenAt: now,
    lastSeenAt: now,
    targetType: "instance",
    targetId: "inst-1",
    partTypeId: "part-1",
    partTypeName: "Arduino Uno R3",
    location: "Shelf B2",
    deleteEligibility: { status: "eligible" },
  };
}

describe("motion", () => {
  beforeEach(() => {
    anime.animate.mockReset();
    anime.stagger.mockClear();
    setReducedMotion(false);
    document.body.innerHTML = "";
  });

  it("builds stable motion keys for scan states", () => {
    expect(buildMotionSnapshot(makeState()).scanKey).toBe("oneByOne:idle");
    expect(buildMotionSnapshot(makeState({ scanResult: { mode: "unknown", code: "NOPE", partDb } })).scanKey).toBe("unknown:NOPE");
    expect(buildMotionSnapshot(makeState({ scanResult: labelScan() })).scanKey).toBe("label:QRX7-9A2B");
    expect(buildMotionSnapshot(makeState({ scanResult: interactScan("instance") })).scanKey).toBe("interact:instance:inst-1:available");
    expect(buildMotionSnapshot(makeState({ scanResult: interactScan("bulk") })).scanKey).toBe("interact:bulk:bulk-1:good");
    expect(buildMotionSnapshot(makeState({
      scanMode: { kind: "bulk", action: "move" },
      bulkQueue: {
        ...defaultBulkQueueState,
        action: "move",
        rows: [assignedRow(2)],
        summary: { uniqueLabelCount: 1, totalScanCount: 2, duplicateScanCount: 1 },
      },
    })).scanKey).toBe("bulk:move:1");
  });

  it("does not animate when reduced motion is requested", () => {
    setReducedMotion(true);
    const root = document.createElement("div");
    root.innerHTML = `<section data-motion-surface="scan"></section>`;

    const snapshot = runPostRenderMotion(root, null, makeState());

    expect(snapshot.scanKey).toBe("oneByOne:idle");
    expect(root.dataset.motionReduced).toBe("true");
    expect(anime.animate).not.toHaveBeenCalled();
  });

  it("animates changed surfaces, scan traces, queue counts, sync, theme, and toasts", () => {
    const root = document.createElement("div");
    root.innerHTML = `
      <div class="app-shell"></div>
      <section data-motion-surface="scan"></section>
      <span class="scan-viewfinder-corner"></span>
      <span class="scan-trace-line"></span>
      <span class="queue-count"></span>
      <span class="queue-row-stepper"><span class="stepper-value">2</span></span>
      <span class="sync-status-card"></span>
      <span class="dash-health-value"></span>
      <div class="toast"></div>
    `;
    const previous = buildMotionSnapshot(makeState({
      activeTab: "dashboard",
      theme: "dark",
      partDbSyncStatus: { enabled: true, pending: 0, inFlight: 0, failedLast24h: 0, deadTotal: 0 },
    }));
    const current = makeState({
      activeTab: "scan",
      theme: "light",
      scanResult: { mode: "unknown", code: "NOPE", partDb },
      bulkQueue: {
        ...defaultBulkQueueState,
        rows: [assignedRow(2)],
        summary: { uniqueLabelCount: 1, totalScanCount: 2, duplicateScanCount: 1 },
      },
      partDbSyncStatus: { enabled: true, pending: 3, inFlight: 0, failedLast24h: 0, deadTotal: 0 },
      toasts: [{ id: "toast-1", type: "info", message: "Queued" }],
    });

    const snapshot = runPostRenderMotion(root, previous, current);

    expect(snapshot.scanKey).toBe("unknown:NOPE");
    expect(root.dataset.motionReduced).toBeUndefined();
    expect(anime.animate.mock.calls.length).toBeGreaterThanOrEqual(6);
    expect(anime.stagger).toHaveBeenCalled();
  });

  it("tolerates missing matchMedia, empty targets, and animation failures", () => {
    setReducedMotion(undefined);
    const emptyRoot = document.createElement("div");
    runPostRenderMotion(emptyRoot, null, makeState());
    runPostRenderMotion(emptyRoot, buildMotionSnapshot(makeState({ theme: "dark" })), makeState({ theme: "light" }));
    expect(anime.animate).not.toHaveBeenCalled();

    const root = document.createElement("div");
    root.innerHTML = `<section data-motion-surface="scan"></section>`;
    anime.animate.mockImplementationOnce(() => {
      throw new Error("animation unavailable");
    });

    expect(() => runPostRenderMotion(root, null, makeState())).not.toThrow();
  });
});
