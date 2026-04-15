import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  DashboardSummary,
  PartDbConnectionStatus,
  PartDbSyncStatusResponse,
  PartType,
} from "@smart-db/contracts";
import { defaultCameraState } from "./ui-state";

const apiMock = vi.hoisted(() => ({
  getSession: vi.fn(),
  logout: vi.fn(),
  getDashboard: vi.fn(),
  getPartDbStatus: vi.fn(),
  getPartDbSyncStatus: vi.fn(),
  getPartDbSyncFailures: vi.fn(),
  getLatestQrBatch: vi.fn(),
  getProvisionalPartTypes: vi.fn(),
  searchPartTypes: vi.fn(),
  getKnownLocations: vi.fn(),
  getInventorySummary: vi.fn(),
  registerQrBatch: vi.fn(),
  scan: vi.fn(),
  assignQr: vi.fn(),
  recordEvent: vi.fn(),
  splitBulkStock: vi.fn(),
  retryPartDbSync: vi.fn(),
  backfillPartDbSync: vi.fn(),
  drainPartDbSync: vi.fn(),
  approvePartType: vi.fn(),
  mergePartTypes: vi.fn(),
  getPartTypeItems: vi.fn(),
}));

const apiModuleMocks = vi.hoisted(() => ({
  loginUrl: vi.fn(() => "/login"),
  downloadQrBatchLabelsPdf: vi.fn(),
}));

vi.mock("../api", () => ({
  ApiClientError: class ApiClientError extends Error {
    constructor(
      readonly code: string,
      message: string,
      readonly details: Record<string, unknown> = {},
    ) {
      super(message);
    }
  },
  api: apiMock,
  loginUrl: apiModuleMocks.loginUrl,
  downloadQrBatchLabelsPdf: apiModuleMocks.downloadQrBatchLabelsPdf,
}));

const cameraMocks = vi.hoisted(() => ({
  start: vi.fn().mockResolvedValue({ ok: true }),
  stop: vi.fn(),
  destroy: vi.fn(),
  attach: vi.fn().mockResolvedValue({ ok: true }),
  getSnapshot: vi.fn(() => defaultCameraState),
  subscribe: vi.fn((listener: (snapshot: typeof defaultCameraState) => void) => {
    listener(defaultCameraState);
    return () => {};
  }),
}));

vi.mock("./services/camera-scanner-service", () => ({
  CameraScannerService: class MockCameraScannerService {
    subscribe = cameraMocks.subscribe;
    start = cameraMocks.start;
    stop = cameraMocks.stop;
    destroy = cameraMocks.destroy;
    getSnapshot = cameraMocks.getSnapshot;
    attachVideoElement = cameraMocks.attach;
  },
}));

const dashboard: DashboardSummary = {
  partTypeCount: 2,
  instanceCount: 4,
  bulkStockCount: 1,
  provisionalCount: 1,
  unassignedQrCount: 7,
  recentEvents: [],
};

const partDbStatus: PartDbConnectionStatus = {
  configured: false,
  connected: false,
  baseUrl: null,
  tokenLabel: null,
  userLabel: null,
  message: "Part-DB not configured.",
  discoveredResources: {
    tokenInfoPath: "/api/tokens/current",
    openApiPath: "/api/docs.json",
    partsPath: null,
    partLotsPath: null,
    storageLocationsPath: null,
  },
};

const syncStatus: PartDbSyncStatusResponse = {
  enabled: false,
  pending: 0,
  inFlight: 0,
  failedLast24h: 0,
  deadTotal: 0,
};

const partType: PartType = {
  id: "part-1",
  canonicalName: "Arduino Uno R3",
  category: "Microcontrollers",
  categoryPath: ["Electronics", "Microcontrollers"],
  aliases: [],
  imageUrl: null,
  notes: null,
  countable: true,
  unit: {
    symbol: "pcs",
    name: "Pieces",
    isInteger: true,
  },
  needsReview: false,
  partDbPartId: null,
  partDbCategoryId: null,
  partDbUnitId: null,
  partDbSyncStatus: "never",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const measuredPartType: PartType = {
  ...partType,
  id: "part-bulk-1",
  canonicalName: "Black PLA+",
  category: "3D Printing",
  categoryPath: ["Materials", "3D Printing"],
  countable: false,
  unit: {
    symbol: "kg",
    name: "Kilograms",
    isInteger: false,
  },
};

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("RewriteAppController", () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>';
    vi.clearAllMocks();
    cameraMocks.start.mockResolvedValue({ ok: true });
    cameraMocks.attach.mockResolvedValue({ ok: true });
    cameraMocks.getSnapshot.mockReturnValue(defaultCameraState);
    apiMock.logout.mockResolvedValue({ ok: true, redirectUrl: null });
    apiMock.getDashboard.mockResolvedValue(dashboard);
    apiMock.getPartDbStatus.mockResolvedValue(partDbStatus);
    apiMock.getPartDbSyncStatus.mockResolvedValue(syncStatus);
    apiMock.getPartDbSyncFailures.mockResolvedValue([]);
    apiMock.getLatestQrBatch.mockResolvedValue(null);
    apiMock.getProvisionalPartTypes.mockResolvedValue([]);
    apiMock.searchPartTypes.mockResolvedValue([partType]);
    apiMock.getKnownLocations.mockResolvedValue(["Shelf A"]);
    apiMock.getInventorySummary.mockResolvedValue([]);
    apiMock.registerQrBatch.mockResolvedValue({
      batch: {
        id: "batch-1",
        prefix: "QR",
        startNumber: 1001,
        endNumber: 1025,
        actor: "lab-admin",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      created: 25,
      skipped: 0,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders the SSO shell when the session is missing", async () => {
    const { ApiClientError } = await import("../api");
    const { startRewriteApp } = await import("./app-controller");
    apiMock.getSession.mockRejectedValueOnce(
      new ApiClientError("unauthenticated", "Authentication is required."),
    );

    const controller = startRewriteApp(document.getElementById("root")!);
    await flush();

    expect(document.body.textContent).toContain("Continue With SSO");
    controller.dispose();
  });

  it("renders the authenticated shell and loads inventory data", async () => {
    const { startRewriteApp } = await import("./app-controller");
    apiMock.getSession.mockResolvedValueOnce({
      subject: "user-1",
      username: "lab-admin",
      name: "Lab Admin",
      email: "lab@example.com",
      roles: ["smartdb.admin"],
      issuedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: null,
    });

    const controller = startRewriteApp(document.getElementById("root")!);
    await flush();

    expect(document.body.textContent).toContain("lab-admin");
    expect(document.body.textContent).toContain("Part types");
    expect(document.body.textContent).toContain("2");
    expect(document.querySelector('[data-tab="admin"]')).not.toBeNull();
    controller.dispose();
  });

  it("rejects invalid batch input before calling the API", async () => {
    const { startRewriteApp } = await import("./app-controller");
    apiMock.getSession.mockResolvedValueOnce({
      subject: "user-1",
      username: "lab-admin",
      name: "Lab Admin",
      email: "lab@example.com",
      roles: ["smartdb.admin"],
      issuedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: null,
    });

    const controller = startRewriteApp(document.getElementById("root")!);
    await flush();

    (document.querySelector('[data-tab="admin"]') as HTMLButtonElement).click();
    await flush();

    const countInput = document.querySelector<HTMLInputElement>('input[name="batch.count"]');
    expect(countInput).not.toBeNull();
    countInput!.value = "0";
    countInput!.dispatchEvent(new Event("input", { bubbles: true }));

    const form = document.querySelector<HTMLFormElement>('form[data-form="batch"]');
    expect(form).not.toBeNull();
    form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flush();

    expect(apiMock.registerQrBatch).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Batch size must be between 1 and 500.");
    controller.dispose();
  });

  it("starts the camera service from the scan route when scanning is allowed", async () => {
    const { startRewriteApp } = await import("./app-controller");
    apiMock.getSession.mockResolvedValueOnce({
      subject: "user-1",
      username: "lab-admin",
      name: "Lab Admin",
      email: "lab@example.com",
      roles: ["smartdb.admin"],
      issuedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: null,
    });

    const controller = startRewriteApp(document.getElementById("root")!);
    await flush();

    const cameraButton = document.querySelector<HTMLButtonElement>('[data-action="camera-start"]');
    expect(cameraButton).not.toBeNull();
    cameraButton!.click();
    await flush();

    expect(cameraMocks.start).toHaveBeenCalledTimes(1);
    controller.dispose();
  });

  it("normalizes handheld scanner input before lookup", async () => {
    const { startRewriteApp } = await import("./app-controller");
    apiMock.getSession.mockResolvedValueOnce({
      subject: "user-1",
      username: "lab-admin",
      name: "Lab Admin",
      email: "lab@example.com",
      roles: ["smartdb.admin"],
      issuedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: null,
    });
    apiMock.scan.mockResolvedValueOnce({
      mode: "unknown",
      code: "qr-1001",
      partDb: {
        configured: false,
        connected: false,
        message: "not found",
      },
    });

    const controller = startRewriteApp(document.getElementById("root")!);
    await flush();

    const input = document.querySelector<HTMLInputElement>('input[name="scanCode"]');
    expect(input).not.toBeNull();
    input!.value = "  qr_1001\r\n";
    input!.dispatchEvent(new Event("input", { bubbles: true }));
    const form = document.querySelector<HTMLFormElement>('form[data-form="scan"]');
    expect(form).not.toBeNull();
    form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flush();

    expect(apiMock.scan).toHaveBeenCalledWith(
      "qr-1001",
      expect.objectContaining({ autoIncrement: false }),
    );
    controller.dispose();
  });

  it("requires a positive starting quantity for existing bulk ingest", async () => {
    const { startRewriteApp } = await import("./app-controller");
    apiMock.getSession.mockResolvedValueOnce({
      subject: "user-1",
      username: "lab-admin",
      name: "Lab Admin",
      email: "lab@example.com",
      roles: ["smartdb.admin"],
      issuedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: null,
    });
    apiMock.scan.mockResolvedValueOnce({
      mode: "label",
      qrCode: {
        code: "ESUN-BLACK-PLA",
        batchId: "external",
        status: "printed",
        assignedKind: null,
        assignedId: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      suggestions: [measuredPartType],
      partDb: {
        configured: false,
        connected: false,
        message: "not found",
      },
    });

    const controller = startRewriteApp(document.getElementById("root")!);
    await flush();

    const scanInput = document.querySelector<HTMLInputElement>('input[name="scanCode"]');
    expect(scanInput).not.toBeNull();
    scanInput!.value = "ESUN-BLACK-PLA";
    scanInput!.dispatchEvent(new Event("input", { bubbles: true }));
    const scanForm = document.querySelector<HTMLFormElement>('form[data-form="scan"]');
    expect(scanForm).not.toBeNull();
    scanForm!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flush();

    const selectPart = document.querySelector<HTMLButtonElement>('[data-action="select-existing-part"]');
    expect(selectPart).not.toBeNull();
    selectPart!.click();
    await flush();

    const quantityInput = document.querySelector<HTMLInputElement>('input[name="assign.initialQuantity"]');
    expect(quantityInput).not.toBeNull();
    expect(quantityInput!.value).toBe("0");

    const locationInput = document.querySelector<HTMLInputElement>('input[name="assign.location"]');
    expect(locationInput).not.toBeNull();
    locationInput!.value = "Shelf A";
    locationInput!.dispatchEvent(new Event("input", { bubbles: true }));

    const assignForm = document.querySelector<HTMLFormElement>('form[data-form="assign"]');
    expect(assignForm).not.toBeNull();
    assignForm!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flush();

    expect(apiMock.assignQr).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Starting quantity must be greater than zero.");
    controller.dispose();
  });

  it("stops the camera service during logout cleanup", async () => {
    const { startRewriteApp } = await import("./app-controller");
    apiMock.getSession.mockResolvedValueOnce({
      subject: "user-1",
      username: "lab-admin",
      name: "Lab Admin",
      email: "lab@example.com",
      roles: ["smartdb.admin"],
      issuedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: null,
    });

    const controller = startRewriteApp(document.getElementById("root")!);
    await flush();

    const logoutButton = document.querySelector<HTMLButtonElement>('[data-action="logout"]');
    expect(logoutButton).not.toBeNull();
    logoutButton!.click();
    await flush();

    expect(cameraMocks.stop).toHaveBeenCalled();
    controller.dispose();
  });

  it("keeps the user authenticated when logout fails and surfaces the failure", async () => {
    const { startRewriteApp } = await import("./app-controller");
    apiMock.getSession.mockResolvedValueOnce({
      subject: "user-1",
      username: "lab-admin",
      name: "Lab Admin",
      email: "lab@example.com",
      roles: ["smartdb.admin"],
      issuedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: null,
    });
    apiMock.logout.mockRejectedValueOnce(new Error("logout failed"));

    const controller = startRewriteApp(document.getElementById("root")!);
    await flush();

    const logoutButton = document.querySelector<HTMLButtonElement>('[data-action="logout"]');
    expect(logoutButton).not.toBeNull();
    logoutButton!.click();
    await flush();

    expect(document.body.textContent).toContain("lab-admin");
    expect(document.body.textContent).toContain("logout failed");
    controller.dispose();
  });

  it("surfaces inventory detail fetch failures instead of pretending the part type is empty", async () => {
    const { startRewriteApp } = await import("./app-controller");
    apiMock.getSession.mockResolvedValueOnce({
      subject: "user-1",
      username: "lab-admin",
      name: "Lab Admin",
      email: "lab@example.com",
      roles: ["smartdb.admin"],
      issuedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: null,
    });
    apiMock.getInventorySummary.mockResolvedValueOnce([
      {
        id: "part-1",
        canonicalName: "Arduino Uno R3",
        categoryPath: ["Electronics", "Microcontrollers"],
        unit: { symbol: "pcs", name: "Pieces", isInteger: true },
        countable: true,
        bins: 1,
        instanceCount: 2,
        onHand: 10,
        partDbSyncStatus: "never",
      },
    ]);
    apiMock.getPartTypeItems.mockRejectedValueOnce(new Error("detail load failed"));

    const controller = startRewriteApp(document.getElementById("root")!);
    await flush();

    (document.querySelector('[data-tab="inventory"]') as HTMLButtonElement).click();
    await flush();

    const expandButton = document.querySelector<HTMLButtonElement>('[data-action="toggle-inventory-expand"]');
    expect(expandButton).not.toBeNull();
    expandButton!.click();
    await flush();

    expect(document.body.textContent).toContain("detail load failed");
    controller.dispose();
  });

  it("shows stale-data state when authenticated refresh calls fail", async () => {
    const { startRewriteApp } = await import("./app-controller");
    apiMock.getSession.mockResolvedValueOnce({
      subject: "user-1",
      username: "lab-admin",
      name: "Lab Admin",
      email: "lab@example.com",
      roles: ["smartdb.admin"],
      issuedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: null,
    });
    apiMock.getDashboard.mockRejectedValueOnce(new Error("dashboard refresh failed"));

    const controller = startRewriteApp(document.getElementById("root")!);
    await flush();

    expect(document.body.textContent).toContain("Some data could not be refreshed");
    expect(document.body.textContent).toContain("dashboard refresh failed");
    controller.dispose();
  });
});
