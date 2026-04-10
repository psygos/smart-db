import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  DashboardSummary,
  PartDbConnectionStatus,
  PartDbSyncBackfillResponse,
  PartDbSyncDrainResponse,
  PartDbSyncFailure,
  PartDbSyncStatusResponse,
  PartType,
  QrBatch,
  ScanResponse,
} from "@smart-db/contracts";

const apiMock = vi.hoisted(() => ({
  loginUrl: vi.fn(),
  downloadQrBatchLabelsPdf: vi.fn(),
  getSession: vi.fn(),
  logout: vi.fn(),
  hydrateSessionToken: vi.fn(),
  clearSessionToken: vi.fn(),
  getDashboard: vi.fn(),
  getPartDbStatus: vi.fn(),
  getPartDbSyncStatus: vi.fn(),
  getPartDbSyncFailures: vi.fn(),
  getLatestQrBatch: vi.fn(),
  getProvisionalPartTypes: vi.fn(),
  searchPartTypes: vi.fn(),
  registerQrBatch: vi.fn(),
  scan: vi.fn(),
  assignQr: vi.fn(),
  recordEvent: vi.fn(),
  mergePartTypes: vi.fn(),
  voidQr: vi.fn(),
  approvePartType: vi.fn(),
  drainPartDbSync: vi.fn(),
  backfillPartDbSync: vi.fn(),
  retryPartDbSync: vi.fn(),
}));

vi.mock("./api", () => ({
  ApiClientError: class ApiClientError extends Error {
    constructor(
      readonly code: string,
      message: string,
      readonly details: Record<string, unknown> = {},
    ) {
      super(message);
    }
  },
  clearSessionToken: apiMock.clearSessionToken,
  downloadQrBatchLabelsPdf: apiMock.downloadQrBatchLabelsPdf,
  hydrateSessionToken: apiMock.hydrateSessionToken,
  loginUrl: apiMock.loginUrl,
  api: apiMock,
}));

import SmartApp from "./SmartApp";

const dashboard: DashboardSummary = {
  partTypeCount: 2,
  instanceCount: 3,
  bulkStockCount: 1,
  provisionalCount: 1,
  unassignedQrCount: 5,
  recentEvents: [
    {
      id: "event-1",
      targetType: "instance",
      targetId: "instance-1",
      event: "moved",
      fromState: "available",
      toState: "available",
      location: "Shelf B",
      actor: "lab-admin",
      notes: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  ],
};

const partDbStatus: PartDbConnectionStatus = {
  configured: false,
  connected: false,
  baseUrl: null,
  tokenLabel: null,
  userLabel: null,
  message: "Part-DB credentials are not configured.",
  discoveredResources: {
    tokenInfoPath: "/api/tokens/current",
    openApiPath: "/api/docs.json",
    partsPath: null,
    partLotsPath: null,
    storageLocationsPath: null,
  },
};

const partDbSyncStatus: PartDbSyncStatusResponse = {
  enabled: false,
  pending: 0,
  inFlight: 0,
  failedLast24h: 0,
  deadTotal: 0,
};

const partDbSyncFailures: PartDbSyncFailure[] = [];

const partType: PartType = {
  id: "part-1",
  canonicalName: "Arduino Uno R3",
  category: "Microcontrollers",
  categoryPath: ["Electronics", "Microcontrollers"],
  aliases: ["uno r3"],
  imageUrl: null,
  notes: null,
  countable: true,
  unit: {
    symbol: "pcs",
    name: "Pieces",
    isInteger: true,
  },
  needsReview: true,
  partDbPartId: null,
  partDbCategoryId: null,
  partDbUnitId: null,
  partDbSyncStatus: "never",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const bulkType: PartType = {
  ...partType,
  id: "part-2",
  canonicalName: "M3 Screw",
  category: "Fasteners",
  categoryPath: ["Hardware", "Fasteners"],
  countable: false,
};

const latestBatch: QrBatch = {
  id: "batch-latest",
  prefix: "QR",
  startNumber: 1001,
  endNumber: 1024,
  actor: "labeler",
  createdAt: "2026-01-01T00:00:00.000Z",
};

beforeEach(() => {
  for (const mock of Object.values(apiMock)) {
    mock.mockReset();
  }
  apiMock.loginUrl.mockReturnValue("http://localhost:4000/api/auth/login?returnTo=http%3A%2F%2Flocalhost%3A5173%2F");
  apiMock.downloadQrBatchLabelsPdf.mockResolvedValue(undefined);
  apiMock.getSession.mockResolvedValue({
    subject: null,
    username: "labeler",
    name: null,
    email: null,
    roles: ["smartdb.admin", "smartdb.labeler"],
    issuedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: null,
  });
  apiMock.logout.mockResolvedValue({ ok: true, redirectUrl: null });
  apiMock.getDashboard.mockResolvedValue(dashboard);
  apiMock.getPartDbStatus.mockResolvedValue(partDbStatus);
  apiMock.getPartDbSyncStatus.mockResolvedValue(partDbSyncStatus);
  apiMock.getPartDbSyncFailures.mockResolvedValue(partDbSyncFailures);
  apiMock.getLatestQrBatch.mockResolvedValue(latestBatch);
  apiMock.getProvisionalPartTypes.mockResolvedValue([partType]);
  apiMock.searchPartTypes.mockResolvedValue([partType]);
  apiMock.registerQrBatch.mockResolvedValue({
    batch: {
      id: "batch-1",
      prefix: "QR",
      startNumber: 1001,
      endNumber: 1500,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    created: 500,
    skipped: 0,
  });
  apiMock.assignQr.mockResolvedValue({
    id: "instance-1",
    targetType: "instance",
    qrCode: "QR-1001",
    partType,
    location: "Shelf A",
    state: "available",
    assignee: null,
  });
  apiMock.recordEvent.mockResolvedValue({
    id: "event-2",
    targetType: "instance",
    targetId: "instance-1",
    event: "checked_out",
    fromState: "available",
    toState: "checked_out",
    location: "Workbench",
    actor: "lab-admin",
    notes: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  apiMock.mergePartTypes.mockResolvedValue({
    ...partType,
    needsReview: false,
  });
  apiMock.voidQr.mockResolvedValue({
    code: "QR-1001",
    batchId: "batch-1",
    status: "voided",
    assignedKind: null,
    assignedId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  apiMock.approvePartType.mockResolvedValue({
    ...partType,
    needsReview: false,
  });
  apiMock.drainPartDbSync.mockResolvedValue({
    claimed: 0,
    delivered: 0,
    failed: 0,
  } satisfies PartDbSyncDrainResponse);
  apiMock.backfillPartDbSync.mockResolvedValue({
    queuedPartTypes: 0,
    queuedLots: 0,
    skipped: 0,
  } satisfies PartDbSyncBackfillResponse);
  apiMock.retryPartDbSync.mockResolvedValue(undefined);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

describe("App", () => {
  it("renders the login shell when the session is missing", async () => {
    const AuthError = (await import("./api")).ApiClientError;
    apiMock.getSession.mockRejectedValueOnce(new AuthError("unauthenticated", "Authentication is required."));

    render(<SmartApp />);

    expect(await screen.findByText("Sign In With Makerspace SSO")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Continue With SSO" })).toHaveAttribute(
      "href",
      "http://localhost:4000/api/auth/login?returnTo=http%3A%2F%2Flocalhost%3A5173%2F",
    );
  });

  it("renders an SSO login link from the login shell", async () => {
    const AuthError = (await import("./api")).ApiClientError;
    apiMock.getSession.mockRejectedValueOnce(new AuthError("unauthenticated", "Authentication is required."));

    render(<SmartApp />);

    expect(await screen.findByRole("link", { name: "Continue With SSO" })).toHaveAttribute(
      "href",
      "http://localhost:4000/api/auth/login?returnTo=http%3A%2F%2Flocalhost%3A5173%2F",
    );
  });

  it("hides admin navigation and skips admin-only fetches for non-admin sessions", async () => {
    apiMock.getSession.mockResolvedValueOnce({
      subject: null,
      username: "labeler",
      name: null,
      email: null,
      roles: ["smartdb.labeler"],
      issuedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: null,
    });

    render(<SmartApp />);

    expect(await screen.findByPlaceholderText("Scan or type a QR / barcode")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Admin" })).not.toBeInTheDocument();
    expect(apiMock.getProvisionalPartTypes).not.toHaveBeenCalled();
    expect(apiMock.getLatestQrBatch).not.toHaveBeenCalled();
  });

  it("shows sync health in the header and humanized failures in the admin tab", async () => {
    const user = userEvent.setup();
    apiMock.getPartDbStatus.mockResolvedValue({
      ...partDbStatus,
      configured: true,
      connected: true,
      baseUrl: "https://partdb.example.com",
      message: "Connected.",
    });
    apiMock.getPartDbSyncStatus.mockResolvedValue({
      enabled: true,
      pending: 1,
      inFlight: 1,
      failedLast24h: 1,
      deadTotal: 0,
    });
    apiMock.getPartDbSyncFailures.mockResolvedValue([
      {
        id: "sync-1",
        operation: "create_part",
        status: "failed",
        targetTable: "part_types",
        targetRowId: "part-1",
        attemptCount: 2,
        nextAttemptAt: "2026-01-01T00:01:00.000Z",
        lastFailureAt: "2026-01-01T00:00:30.000Z",
        lastError: {
          kind: "validation",
          violations: [{ propertyPath: "name", message: "This value is already used." }],
        },
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ] satisfies PartDbSyncFailure[]);

    render(<SmartApp />);

    expect(await screen.findByText("Part-DB linked")).toBeInTheDocument();
    expect(await screen.findByText("Sync needs retry")).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Admin" }));

    expect(await screen.findByText("Part-DB rejected the payload: name This value is already used.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Queue backfill" }));
    expect(apiMock.backfillPartDbSync).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Retry sync" }));
    expect(apiMock.retryPartDbSync).toHaveBeenCalledWith("sync-1");
  });

  it("surfaces session-restore failures and stays on the login shell", async () => {
    const AuthError = (await import("./api")).ApiClientError;
    apiMock.getSession.mockRejectedValueOnce(new AuthError("integration", "zitadel offline"));

    render(<SmartApp />);

    expect(await screen.findByText("Sign In With Makerspace SSO")).toBeInTheDocument();
    expect((await screen.findAllByText("zitadel offline")).length).toBeGreaterThan(0);
  });

  it("falls back to the login shell when the session is invalid", async () => {
    const AuthError = (await import("./api")).ApiClientError;
    apiMock.getSession.mockRejectedValueOnce(new AuthError("unauthenticated", "token expired"));

    render(<SmartApp />);

    expect(await screen.findByText("Sign In With Makerspace SSO")).toBeInTheDocument();
  });

  it("ignores aborted session restoration during unmount", async () => {
    const pendingSession = deferred<{
      username: string;
      issuedAt: string;
      expiresAt: string | null;
    }>();
    apiMock.getSession.mockReturnValueOnce(pendingSession.promise);

    const rendered = render(<SmartApp />);
    rendered.unmount();
    pendingSession.reject(new DOMException("aborted", "AbortError"));
    await Promise.resolve();

    expect(apiMock.logout).not.toHaveBeenCalled();
  });

  it("shows the upstream token expiry when Part-DB reports one", async () => {
    apiMock.getSession.mockResolvedValueOnce({
      subject: null,
      username: "labeler",
      name: null,
      email: null,
      roles: ["smartdb.admin", "smartdb.labeler"],
      issuedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-01-02T00:00:00.000Z",
    });

    render(<SmartApp />);

    expect(await screen.findByText(/Token\/session expires at 2026-01-02T00:00:00.000Z/)).toBeInTheDocument();
  });

  it("logs out and clears the authenticated shell", async () => {
    const user = userEvent.setup();
    render(<SmartApp />);
    await screen.findByRole("button", { name: "Logout" });

    await user.click(screen.getByRole("button", { name: "Logout" }));

    expect(apiMock.logout).toHaveBeenCalled();
    expect(await screen.findByText("Sign In With Makerspace SSO")).toBeInTheDocument();
  });

  it("still clears auth state when logout fails for a non-auth reason", async () => {
    const user = userEvent.setup();
    apiMock.logout.mockRejectedValueOnce(new Error("logout failed"));

    render(<SmartApp />);
    await screen.findByRole("button", { name: "Logout" });
    await user.click(screen.getByRole("button", { name: "Logout" }));

    expect(await screen.findByText("Sign In With Makerspace SSO")).toBeInTheDocument();
    expect(await screen.findByText("logout failed")).toBeInTheDocument();
  });

  it("renders the dashboard and registers QR batches", async () => {
    const user = userEvent.setup();
    render(<SmartApp />);

    expect(await screen.findByRole("button", { name: "Logout" })).toBeInTheDocument();
    expect(screen.getByText("Part-DB degraded")).toBeInTheDocument();
    expect(screen.getByText("Unassigned QRs")).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Admin" }));
    expect(screen.getByText(/batch-latest/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Download PDF Labels" })).toBeInTheDocument();
    expect(screen.getByLabelText("Prefix")).toHaveValue("QR");
    expect(screen.getByLabelText("Start number")).toHaveValue(1025);
    await user.clear(screen.getByLabelText("Prefix"));
    await user.type(screen.getByLabelText("Prefix"), "LAB");
    await user.clear(screen.getByLabelText("Start number"));
    await user.type(screen.getByLabelText("Start number"), "2001");
    await user.clear(screen.getByLabelText("Count"));
    await user.type(screen.getByLabelText("Count"), "25");
    await user.click(screen.getByRole("button", { name: "Register batch" }));
    await waitFor(() => {
      expect(apiMock.registerQrBatch).toHaveBeenCalledWith({
        prefix: "LAB",
        startNumber: 2001,
        count: 25,
      });
    });
    expect(await screen.findByText(/Registered 500 QR codes/)).toBeInTheDocument();
  });

  it("updates the latest batch card after successful registration", async () => {
    const user = userEvent.setup();
    apiMock.getLatestQrBatch
      .mockResolvedValueOnce(latestBatch)
      .mockResolvedValueOnce({
        id: "batch-new",
        prefix: "LAB",
        startNumber: 5001,
        endNumber: 5025,
        actor: "labeler",
        createdAt: "2026-01-02T00:00:00.000Z",
      });
    apiMock.registerQrBatch.mockResolvedValueOnce({
      batch: {
        id: "batch-new",
        prefix: "LAB",
        startNumber: 5001,
        endNumber: 5025,
        actor: "labeler",
        createdAt: "2026-01-02T00:00:00.000Z",
      },
      created: 25,
      skipped: 0,
    });

    render(<SmartApp />);
    await screen.findByRole("button", { name: "Logout" });
    await user.click(screen.getByRole("tab", { name: "Admin" }));
    await user.clear(screen.getByLabelText("Prefix"));
    await user.type(screen.getByLabelText("Prefix"), "LAB");
    await user.clear(screen.getByLabelText("Start number"));
    await user.type(screen.getByLabelText("Start number"), "5001");
    await user.clear(screen.getByLabelText("Count"));
    await user.type(screen.getByLabelText("Count"), "25");
    await user.click(screen.getByRole("button", { name: "Register batch" }));

    await waitFor(() => {
      expect(screen.getByText(/25 labels · created by/)).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "Download PDF Labels" })).toBeInTheDocument();
  });

  it("auto-increments batch start number after successful registration", async () => {
    const user = userEvent.setup();
    render(<SmartApp />);
    await screen.findByRole("button", { name: "Logout" });
    await user.click(screen.getByRole("tab", { name: "Admin" }));
    await user.click(screen.getByRole("button", { name: "Register batch" }));

    await waitFor(() => {
      expect(apiMock.registerQrBatch).toHaveBeenCalled();
    });
    await screen.findByText(/Registered 500 QR codes/);

    expect((screen.getByLabelText("Start number") as HTMLInputElement).value).toBe("1501");
  });

  it("shows unknown scan results and scan failures", async () => {
    const user = userEvent.setup();
    apiMock.scan
      .mockResolvedValueOnce({
        mode: "unknown",
        code: "EAN-1234",
        partDb: {
          configured: false,
          connected: false,
          message: "Not configured",
        },
      } satisfies ScanResponse)
      .mockRejectedValueOnce(new Error("scanner offline"));

    render(<SmartApp />);
    await screen.findByRole("button", { name: "Logout" });

    await user.type(screen.getByPlaceholderText("Scan or type a QR / barcode"), "EAN-1234");
    await user.click(screen.getByRole("button", { name: "Open" }));
    expect(await screen.findByText("EAN-1234 is unknown to Smart DB")).toBeInTheDocument();

    await user.clear(screen.getByPlaceholderText("Scan or type a QR / barcode"));
    await user.type(screen.getByPlaceholderText("Scan or type a QR / barcode"), "QR-FAIL");
    await user.click(screen.getByRole("button", { name: "Open" }));
    expect(await screen.findByText("scanner offline")).toBeInTheDocument();
  });

  it("drops back to login when a scan returns an unauthenticated error", async () => {
    const AuthError = (await import("./api")).ApiClientError;
    const user = userEvent.setup();
    apiMock.scan.mockRejectedValueOnce(new AuthError("unauthenticated", "token expired"));

    render(<SmartApp />);
    await screen.findByRole("button", { name: "Logout" });
    await user.type(screen.getByPlaceholderText("Scan or type a QR / barcode"), "QR-401");
    await user.click(screen.getByRole("button", { name: "Open" }));

    expect(await screen.findByText("Sign In With Makerspace SSO")).toBeInTheDocument();
  });

  it("drops back to login when predictive search becomes unauthenticated", async () => {
    const AuthError = (await import("./api")).ApiClientError;
    const user = userEvent.setup();
    apiMock.searchPartTypes
      .mockResolvedValueOnce([partType])
      .mockRejectedValueOnce(new AuthError("unauthenticated", "token expired"));

    render(<SmartApp />);
    await screen.findByRole("button", { name: "Logout" });
    apiMock.scan.mockResolvedValueOnce({
      mode: "label",
      qrCode: {
        code: "QR-SEARCH",
        batchId: "batch-1",
        status: "printed",
        assignedKind: null,
        assignedId: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      suggestions: [partType],
      partDb: {
        configured: false,
        connected: false,
        message: "Not configured",
      },
    } satisfies ScanResponse);
    await user.type(screen.getByPlaceholderText("Scan or type a QR / barcode"), "QR-SEARCH");
    await user.click(screen.getByRole("button", { name: "Open" }));

    const heading = await screen.findByText("Assign QR-SEARCH");
    const assignCard = heading.closest(".result-card");
    if (!assignCard) {
      throw new Error("assign card was not rendered");
    }

    await user.type(within(assignCard).getByLabelText("Search existing part types"), "bad");
    expect(await screen.findByText("Sign In With Makerspace SSO")).toBeInTheDocument();
  });

  it("restores default suggestions when a predictive-search query is cleared", async () => {
    const user = userEvent.setup();
    apiMock.searchPartTypes.mockResolvedValueOnce([partType]).mockResolvedValueOnce([bulkType]);
    apiMock.scan.mockResolvedValueOnce({
      mode: "label",
      qrCode: {
        code: "QR-CLEAR",
        batchId: "batch-1",
        status: "printed",
        assignedKind: null,
        assignedId: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      suggestions: [partType],
      partDb: {
        configured: false,
        connected: false,
        message: "Not configured",
      },
    } satisfies ScanResponse);

    render(<SmartApp />);
    await screen.findByRole("button", { name: "Logout" });
    await user.type(screen.getByPlaceholderText("Scan or type a QR / barcode"), "QR-CLEAR");
    await user.click(screen.getByRole("button", { name: "Open" }));

    const heading = await screen.findByText("Assign QR-CLEAR");
    const card = heading.closest(".result-card");
    if (!card) {
      throw new Error("assign card was not rendered");
    }

    fireEvent.change(within(card).getByLabelText("Search existing part types"), {
      target: { value: "bulk" },
    });
    expect(await within(card).findByRole("radio", { name: /M3 Screw/ })).toBeInTheDocument();

    fireEvent.change(within(card).getByLabelText("Search existing part types"), {
      target: { value: "" },
    });
    expect(await within(card).findByRole("radio", { name: /Arduino Uno R3/ })).toBeInTheDocument();
  });

  it("surfaces batch registration failures", async () => {
    const user = userEvent.setup();
    apiMock.registerQrBatch.mockRejectedValueOnce(new Error("batch failed"));

    render(<SmartApp />);
    await screen.findByRole("button", { name: "Logout" });
    await user.click(screen.getByRole("tab", { name: "Admin" }));
    await user.click(screen.getByRole("button", { name: "Register batch" }));
    expect(await screen.findByText("batch failed")).toBeInTheDocument();
  });

  it("runs the label flow and assigns an existing part type", async () => {
    const user = userEvent.setup();
    apiMock.scan
      .mockResolvedValueOnce({
        mode: "label",
        qrCode: {
          code: "QR-1001",
          batchId: "batch-1",
          status: "printed",
          assignedKind: null,
          assignedId: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        suggestions: [partType],
        partDb: {
          configured: false,
          connected: false,
          message: "Not configured",
        },
      } satisfies ScanResponse)
      .mockResolvedValueOnce({
        mode: "interact",
        qrCode: {
          code: "QR-1001",
          batchId: "batch-1",
          status: "assigned",
          assignedKind: "instance",
          assignedId: "instance-1",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        entity: {
          id: "instance-1",
          targetType: "instance",
          qrCode: "QR-1001",
          partType,
          location: "Shelf A",
          state: "available",
          assignee: null,
        },
        recentEvents: [],
        availableActions: [
          "moved",
          "checked_out",
          "returned",
          "consumed",
          "damaged",
          "lost",
          "disposed",
        ],
        partDb: {
          configured: false,
          connected: false,
          message: "Not configured",
        },
      } satisfies ScanResponse);

    render(<SmartApp />);
    await screen.findByRole("button", { name: "Logout" });

    await user.type(screen.getByPlaceholderText("Scan or type a QR / barcode"), "QR-1001");
    await user.click(screen.getByRole("button", { name: "Open" }));
    const assignHeading = await screen.findByText("Assign QR-1001");
    expect(assignHeading).toBeInTheDocument();
    const assignCard = assignHeading.closest(".result-card");
    if (!assignCard) {
      throw new Error("assign card was not rendered");
    }
    await user.click(within(assignCard).getByRole("radio", { name: /Arduino Uno R3/ }));
    await user.click(within(assignCard).getByRole("button", { name: "More options" }));
    await user.selectOptions(within(assignCard).getByLabelText("Initial status"), "damaged");
    await user.click(screen.getByRole("button", { name: "Assign QR" }));

    await waitFor(() => {
      expect(apiMock.assignQr).toHaveBeenCalledWith({
        qrCode: "QR-1001",
        entityKind: "instance",
        location: "Buffer Room A",
        notes: null,
        partType: {
          kind: "existing",
          existingPartTypeId: "part-1",
        },
        initialStatus: "damaged",
      });
    });
    expect(await screen.findByText(/Assigned QR-1001 to inventory/)).toBeInTheDocument();
  });

  it("supports manual search and new bulk labeling", async () => {
    const user = userEvent.setup();
    apiMock.searchPartTypes
      .mockResolvedValueOnce([bulkType])
      .mockResolvedValueOnce([bulkType]);
    apiMock.scan
      .mockResolvedValueOnce({
        mode: "label",
        qrCode: {
          code: "QR-1006",
          batchId: "batch-1",
          status: "printed",
          assignedKind: null,
          assignedId: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        suggestions: [bulkType],
        partDb: {
          configured: false,
          connected: false,
          message: "Not configured",
        },
      } satisfies ScanResponse)
      .mockResolvedValueOnce({
        mode: "interact",
        qrCode: {
          code: "QR-1006",
          batchId: "batch-1",
          status: "assigned",
          assignedKind: "bulk",
          assignedId: "bulk-1",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        entity: {
          id: "bulk-1",
          targetType: "bulk",
          qrCode: "QR-1006",
          partType: bulkType,
          location: "Fastener wall",
          state: "4 pcs on hand",
          assignee: null,
          quantity: 4,
          minimumQuantity: 2,
        },
        recentEvents: [],
        availableActions: ["moved", "restocked", "consumed", "stocktaken", "adjusted"],
        partDb: {
          configured: false,
          connected: false,
          message: "Not configured",
        },
      } satisfies ScanResponse);

    render(<SmartApp />);
    await screen.findByRole("button", { name: "Logout" });

    await user.type(screen.getByPlaceholderText("Scan or type a QR / barcode"), "QR-1006");
    await user.click(screen.getByRole("button", { name: "Open" }));
    const assignHeading = await screen.findByText("Assign QR-1006");
    const assignCard = assignHeading.closest(".result-card");
    if (!assignCard) {
      throw new Error("assign card was not rendered");
    }

    await user.click(within(assignCard).getByRole("radio", { name: /M3 Screw/ }));
    await user.type(within(assignCard).getByLabelText("Search existing part types"), "screw");
    await waitFor(() => {
      expect(apiMock.searchPartTypes).toHaveBeenLastCalledWith(
        "screw",
        expect.any(AbortSignal),
      );
    });
    await user.click(within(assignCard).getByRole("radio", { name: "Create new type" }));
    await user.clear(within(assignCard).getByLabelText(/^Location/));
    await user.type(within(assignCard).getByLabelText(/^Location/), "Fastener wall");
    await user.click(within(assignCard).getByRole("button", { name: "More options" }));
    await user.selectOptions(within(assignCard).getByLabelText("Kind"), "bulk");
    await user.selectOptions(within(assignCard).getByLabelText("Unit"), "g");
    await user.clear(within(assignCard).getByLabelText(/^Starting quantity/));
    await user.type(within(assignCard).getByLabelText(/^Starting quantity/), "4.5");
    await user.clear(within(assignCard).getByLabelText(/^Low-stock threshold/));
    await user.type(within(assignCard).getByLabelText(/^Low-stock threshold/), "2.25");
    await user.type(within(assignCard).getByLabelText(/^New canonical name/), "M3 Screw");
    await user.clear(within(assignCard).getByLabelText(/^Category/));
    await user.type(within(assignCard).getByLabelText(/^Category/), "Fasteners");
    await user.selectOptions(within(assignCard).getByLabelText("Countable"), "false");
    await user.type(within(assignCard).getByLabelText("Notes"), "drawer stock");
    await user.click(within(assignCard).getByRole("button", { name: "Assign QR" }));

    await waitFor(() => {
      expect(apiMock.assignQr).toHaveBeenCalledWith({
        qrCode: "QR-1006",
        entityKind: "bulk",
        location: "Fastener wall",
        notes: "drawer stock",
        partType: {
          kind: "new",
          canonicalName: "M3 Screw",
          category: "Fasteners",
          aliases: [],
          notes: null,
          imageUrl: null,
          countable: false,
          unit: {
            symbol: "g",
            name: "Grams",
            isInteger: false,
          },
        },
        initialQuantity: 4.5,
        minimumQuantity: 2.25,
      });
    });
  });

  it("surfaces search and assignment failures during labeling", async () => {
    const user = userEvent.setup();
    apiMock.searchPartTypes
      .mockResolvedValueOnce([partType])
      .mockRejectedValueOnce(new Error("search failed"));
    apiMock.assignQr.mockRejectedValueOnce(new Error("assign failed"));
    apiMock.scan.mockResolvedValueOnce({
      mode: "label",
      qrCode: {
        code: "QR-1007",
        batchId: "batch-1",
        status: "printed",
        assignedKind: null,
        assignedId: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      suggestions: [],
      partDb: {
        configured: false,
        connected: false,
        message: "Not configured",
      },
    } satisfies ScanResponse);

    render(<SmartApp />);
    await screen.findByRole("button", { name: "Logout" });
    await user.type(screen.getByPlaceholderText("Scan or type a QR / barcode"), "QR-1007");
    await user.click(screen.getByRole("button", { name: "Open" }));
    const assignHeading = await screen.findByText("Assign QR-1007");
    const assignCard = assignHeading.closest(".result-card");
    if (!assignCard) {
      throw new Error("assign card was not rendered");
    }

    await user.type(within(assignCard).getByLabelText("Search existing part types"), "broken");
    expect(await screen.findByText("search failed")).toBeInTheDocument();
    await user.click(within(assignCard).getByRole("radio", { name: "Create new type" }));
    await user.type(within(assignCard).getByLabelText(/^New canonical name/), "Widget");
    await user.type(within(assignCard).getByLabelText(/^Category/), "Misc");
    await user.click(within(assignCard).getByRole("button", { name: "Assign QR" }));
    expect(await screen.findByText("assign failed")).toBeInTheDocument();
  });

  it("runs the interaction flow and logs a stock event", async () => {
    const user = userEvent.setup();
    apiMock.scan
      .mockResolvedValueOnce({
        mode: "interact",
        qrCode: {
          code: "QR-1001",
          batchId: "batch-1",
          status: "assigned",
          assignedKind: "instance",
          assignedId: "instance-1",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        entity: {
          id: "instance-1",
          targetType: "instance",
          qrCode: "QR-1001",
          partType,
          location: "Shelf A",
          state: "available",
          assignee: null,
        },
        recentEvents: [dashboard.recentEvents[0]],
        availableActions: [
          "moved",
          "checked_out",
          "returned",
          "consumed",
          "damaged",
          "lost",
          "disposed",
        ],
        partDb: {
          configured: false,
          connected: false,
          message: "Not configured",
        },
      } satisfies ScanResponse)
      .mockResolvedValueOnce({
        mode: "interact",
        qrCode: {
          code: "QR-1001",
          batchId: "batch-1",
          status: "assigned",
          assignedKind: "instance",
          assignedId: "instance-1",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        entity: {
          id: "instance-1",
          targetType: "instance",
          qrCode: "QR-1001",
          partType,
          location: "Workbench",
          state: "checked_out",
          assignee: "Ayesha",
        },
        recentEvents: [],
        availableActions: [
          "moved",
          "checked_out",
          "returned",
          "consumed",
          "damaged",
          "lost",
          "disposed",
        ],
        partDb: {
          configured: false,
          connected: false,
          message: "Not configured",
        },
      } satisfies ScanResponse);

    render(<SmartApp />);
    await screen.findByRole("button", { name: "Logout" });

    await user.type(screen.getByPlaceholderText("Scan or type a QR / barcode"), "QR-1001");
    await user.click(screen.getByRole("button", { name: "Open" }));
    expect(await screen.findByText(/Arduino Uno R3 · QR-1001/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Check out" }));
    await user.type(screen.getByLabelText("Assignee"), "Ayesha");
    await user.clear(screen.getByLabelText("Location"));
    await user.type(screen.getByLabelText("Location"), "Workbench");
    await user.click(screen.getByRole("button", { name: "Confirm Check out" }));

    await waitFor(() => {
      expect(apiMock.recordEvent).toHaveBeenCalledWith({
        targetType: "instance",
        targetId: "instance-1",
        event: "checked_out",
        location: "Workbench",
        notes: null,
        assignee: "Ayesha",
      });
    });
    expect(await screen.findByText(/Saved Check out/)).toBeInTheDocument();
  });

  it("covers bulk interaction controls and record failures", async () => {
    const user = userEvent.setup();
    apiMock.recordEvent.mockRejectedValueOnce(new Error("event failed"));
    apiMock.scan.mockResolvedValueOnce({
      mode: "interact",
      qrCode: {
        code: "QR-1006",
        batchId: "batch-1",
        status: "assigned",
        assignedKind: "bulk",
        assignedId: "bulk-1",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      entity: {
        id: "bulk-1",
        targetType: "bulk",
        qrCode: "QR-1006",
        partType: bulkType,
        location: "Fastener wall",
        state: "10 pcs on hand",
        assignee: null,
        quantity: 10,
        minimumQuantity: 2,
      },
      recentEvents: [],
      availableActions: ["moved", "restocked", "consumed", "stocktaken", "adjusted"],
      partDb: {
        configured: false,
        connected: false,
        message: "Not configured",
      },
    } satisfies ScanResponse);

    render(<SmartApp />);
    await screen.findByRole("button", { name: "Logout" });
    await user.type(screen.getByPlaceholderText("Scan or type a QR / barcode"), "QR-1006");
    await user.click(screen.getByRole("button", { name: "Open" }));
    const interactHeading = await screen.findByText(/M3 Screw · QR-1006/);
    expect(interactHeading).toBeInTheDocument();
    const interactCard = interactHeading.closest(".result-card");
    if (!interactCard) {
      throw new Error("interact card was not rendered");
    }

    await user.click(within(interactCard).getByRole("button", { name: "Stocktake" }));
    await user.clear(within(interactCard).getByLabelText(/^Quantity on hand/));
    await user.type(within(interactCard).getByLabelText(/^Quantity on hand/), "0");
    await user.type(within(interactCard).getByLabelText("Notes"), "used up");
    await user.click(within(interactCard).getByRole("button", { name: "Confirm Stocktake" }));

    await waitFor(() => {
      expect(apiMock.recordEvent).toHaveBeenCalledWith({
        targetType: "bulk",
        targetId: "bulk-1",
        event: "stocktaken",
        location: "Fastener wall",
        notes: "used up",
        quantity: 0,
      });
    });
    expect(await screen.findByText("event failed")).toBeInTheDocument();
  });

  it("merges provisional part types and surfaces action errors", async () => {
    const user = userEvent.setup();
    apiMock.mergePartTypes.mockRejectedValueOnce(new Error("merge failed"));
    vi.spyOn(window, "confirm").mockReturnValue(true);

    render(<SmartApp />);
    await screen.findByRole("button", { name: "Logout" });
    await user.click(screen.getByRole("tab", { name: "Admin" }));

    await user.selectOptions(screen.getByLabelText("Provisional source"), "part-1");
    await user.click(screen.getAllByRole("radio", { name: /Arduino Uno R3/ })[0]);
    await user.click(screen.getByRole("button", { name: "Merge provisional type" }));
    expect(await screen.findByText("merge failed")).toBeInTheDocument();
  });

  it("surfaces generic refresh failures and shows empty events fallback", async () => {
    const user = userEvent.setup();
    apiMock.getDashboard.mockRejectedValueOnce("not-an-error");

    render(<SmartApp />);
    expect(await screen.findByText("Something went wrong.")).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Activity" }));
    expect(await screen.findByText("No events yet.")).toBeInTheDocument();
  });

  it("drops back to login when authenticated bootstrap data refresh becomes unauthenticated", async () => {
    const AuthError = (await import("./api")).ApiClientError;
    apiMock.getDashboard.mockRejectedValueOnce(new AuthError("unauthenticated", "token expired"));

    render(<SmartApp />);

    expect(await screen.findByText("Sign In With Makerspace SSO")).toBeInTheDocument();
  });

  it("shows early merge validation and merge success", async () => {
    const user = userEvent.setup();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    apiMock.getPartDbStatus.mockResolvedValue({
      ...partDbStatus,
      configured: true,
      connected: true,
      baseUrl: "https://partdb.example.com",
      message: "Part-DB connection looks healthy.",
    });
    apiMock.getProvisionalPartTypes.mockResolvedValue([partType]);
    apiMock.searchPartTypes.mockResolvedValue([partType]);
    apiMock.mergePartTypes.mockResolvedValue({
      ...partType,
      needsReview: false,
    });

    render(<SmartApp />);
    expect(await screen.findByText("Part-DB linked")).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Admin" }));
    await user.click(screen.getByRole("button", { name: "Merge provisional type" }));
    expect(await screen.findByText("Select both a provisional source and a canonical destination.")).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("Provisional source"), "part-1");
    await user.type(screen.getByLabelText("Find canonical destination"), "arduino");
    await waitFor(() => {
      expect(apiMock.searchPartTypes).toHaveBeenLastCalledWith(
        "arduino",
        expect.any(AbortSignal),
      );
    });
    await user.click(screen.getAllByRole("radio", { name: /Arduino Uno R3/ })[0]);
    await user.click(screen.getByRole("button", { name: "Merge provisional type" }));
    expect(await screen.findByText("Merged provisional part type into canonical record.")).toBeInTheDocument();
  });

  it("shows merge-search errors and aborts merge search on logout", async () => {
    const user = userEvent.setup();
    apiMock.searchPartTypes
      .mockResolvedValueOnce([partType])
      .mockRejectedValueOnce(new Error("merge search failed"));

    render(<SmartApp />);
    await screen.findByRole("button", { name: "Logout" });
    await user.click(screen.getByRole("tab", { name: "Admin" }));

    await user.type(screen.getByLabelText("Find canonical destination"), "cable");
    expect(await screen.findByText("merge search failed")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Logout" }));
    expect(await screen.findByText("Sign In With Makerspace SSO")).toBeInTheDocument();
  });

  it("renders null event deltas as 'none'", async () => {
    const user = userEvent.setup();
    apiMock.getDashboard.mockResolvedValueOnce({
      ...dashboard,
      recentEvents: [
        {
          ...dashboard.recentEvents[0],
          fromState: null,
          toState: null,
        },
      ],
    });
    apiMock.scan.mockResolvedValueOnce({
      mode: "interact",
      qrCode: {
        code: "QR-1008",
        batchId: "batch-1",
        status: "assigned",
        assignedKind: "instance",
        assignedId: "instance-8",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      entity: {
        id: "instance-8",
        targetType: "instance",
        qrCode: "QR-1008",
        partType,
        location: "Shelf A",
        state: "available",
        assignee: null,
      },
      recentEvents: [
        {
          ...dashboard.recentEvents[0],
          id: "event-null",
          fromState: null,
          toState: null,
        },
      ],
      availableActions: [
        "moved",
        "checked_out",
        "returned",
        "consumed",
        "damaged",
        "lost",
        "disposed",
      ],
      partDb: {
        configured: false,
        connected: false,
        message: "Not configured",
      },
    } satisfies ScanResponse);

    render(<SmartApp />);
    await screen.findByRole("button", { name: "Logout" });
    await user.click(screen.getByRole("tab", { name: "Activity" }));
    expect(await screen.findAllByText(/none → none/)).not.toHaveLength(0);

    await user.click(screen.getByRole("tab", { name: "Scan" }));
    await user.type(screen.getByPlaceholderText("Scan or type a QR / barcode"), "QR-1008");
    await user.click(screen.getByRole("button", { name: "Open" }));
    expect(await screen.findAllByText(/none → none/)).not.toHaveLength(0);
  });

  it("ignores stale and aborted scan responses", async () => {
    const user = userEvent.setup();
    const firstScan = deferred<ScanResponse>();
    const secondScan = deferred<ScanResponse>();
    apiMock.scan
      .mockReturnValueOnce(firstScan.promise)
      .mockReturnValueOnce(secondScan.promise);

    render(<SmartApp />);
    await screen.findByRole("button", { name: "Logout" });

    await user.type(screen.getByPlaceholderText("Scan or type a QR / barcode"), "QR-OLD");
    fireEvent.submit(screen.getByPlaceholderText("Scan or type a QR / barcode").closest("form")!);
    await user.clear(screen.getByPlaceholderText("Scan or type a QR / barcode"));
    await user.type(screen.getByPlaceholderText("Scan or type a QR / barcode"), "QR-NEW");
    fireEvent.submit(screen.getByPlaceholderText("Scan or type a QR / barcode").closest("form")!);

    firstScan.reject(new DOMException("aborted", "AbortError"));
    secondScan.resolve({
      mode: "unknown",
      code: "QR-NEW",
      partDb: {
        configured: false,
        connected: false,
        message: "Not configured",
      },
    });

    expect(await screen.findByText("QR-NEW is unknown to Smart DB")).toBeInTheDocument();
    expect(screen.queryByText("QR-OLD is unknown to Smart DB")).toBeNull();
    expect(screen.queryByText("aborted")).toBeNull();
  });

  it("ignores stale scan responses that resolve after a newer scan wins", async () => {
    const user = userEvent.setup();
    const firstScan = deferred<ScanResponse>();
    const secondScan = deferred<ScanResponse>();
    apiMock.scan
      .mockReturnValueOnce(firstScan.promise)
      .mockReturnValueOnce(secondScan.promise);

    render(<SmartApp />);
    await screen.findByRole("button", { name: "Logout" });

    await user.type(screen.getByPlaceholderText("Scan or type a QR / barcode"), "QR-OLD");
    fireEvent.submit(screen.getByPlaceholderText("Scan or type a QR / barcode").closest("form")!);
    await user.clear(screen.getByPlaceholderText("Scan or type a QR / barcode"));
    await user.type(screen.getByPlaceholderText("Scan or type a QR / barcode"), "QR-NEW");
    fireEvent.submit(screen.getByPlaceholderText("Scan or type a QR / barcode").closest("form")!);

    secondScan.resolve({
      mode: "unknown",
      code: "QR-NEW",
      partDb: {
        configured: false,
        connected: false,
        message: "Not configured",
      },
    });
    expect(await screen.findByText("QR-NEW is unknown to Smart DB")).toBeInTheDocument();

    firstScan.resolve({
      mode: "unknown",
      code: "QR-OLD",
      partDb: {
        configured: false,
        connected: false,
        message: "Not configured",
      },
    });

    await waitFor(() => {
      expect(screen.queryByText("QR-OLD is unknown to Smart DB")).toBeNull();
    });
  });

  it("ignores stale predictive-search responses that resolve after a newer query wins", async () => {
    const user = userEvent.setup();
    const firstSearch = deferred<PartType[]>();
    const secondSearch = deferred<PartType[]>();
    apiMock.searchPartTypes
      .mockResolvedValueOnce([partType])
      .mockReturnValueOnce(firstSearch.promise)
      .mockReturnValueOnce(secondSearch.promise);
    apiMock.scan.mockResolvedValueOnce({
      mode: "label",
      qrCode: {
        code: "QR-STALE",
        batchId: "batch-1",
        status: "printed",
        assignedKind: null,
        assignedId: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      suggestions: [partType],
      partDb: {
        configured: false,
        connected: false,
        message: "Not configured",
      },
    } satisfies ScanResponse);

    render(<SmartApp />);
    await screen.findByRole("button", { name: "Logout" });
    await user.type(screen.getByPlaceholderText("Scan or type a QR / barcode"), "QR-STALE");
    await user.click(screen.getByRole("button", { name: "Open" }));

    const heading = await screen.findByText("Assign QR-STALE");
    const card = heading.closest(".result-card");
    if (!card) {
      throw new Error("assign card was not rendered");
    }

    fireEvent.change(within(card).getByLabelText("Search existing part types"), {
      target: { value: "old" },
    });
    fireEvent.change(within(card).getByLabelText("Search existing part types"), {
      target: { value: "new" },
    });

    secondSearch.resolve([bulkType]);
    expect(await within(card).findByRole("radio", { name: /M3 Screw/ })).toBeInTheDocument();
    firstSearch.resolve([partType]);
    await waitFor(() => {
      expect(within(card).queryByRole("button", { name: /Arduino Uno R3/ })).toBeNull();
    });
  });

  it("shows scan history in the Activity tab after scanning", async () => {
    const user = userEvent.setup();
    apiMock.scan.mockResolvedValueOnce({
      mode: "unknown",
      code: "QR-HIST-1",
      partDb: { configured: false, connected: false, message: "Not configured" },
    } satisfies ScanResponse);

    render(<SmartApp />);
    await screen.findByRole("button", { name: "Logout" });
    await user.type(screen.getByPlaceholderText("Scan or type a QR / barcode"), "QR-HIST-1");
    await user.click(screen.getByRole("button", { name: "Open" }));
    await screen.findByText("QR-HIST-1 is unknown to Smart DB");

    await user.click(screen.getByRole("tab", { name: "Activity" }));
    expect(await screen.findByText("Recent Scans")).toBeInTheDocument();
    expect(screen.getByText("QR-HIST-1")).toBeInTheDocument();
  });

  it("shows an offline banner when the network is unavailable", async () => {
    Object.defineProperty(navigator, "onLine", { value: false, writable: true, configurable: true });

    render(<SmartApp />);
    await screen.findByRole("button", { name: "Logout" });
    expect(screen.getByText("You appear to be offline.")).toBeInTheDocument();

    Object.defineProperty(navigator, "onLine", { value: true, writable: true, configurable: true });
  });

  it("approves a provisional part type via 'Keep As-Is'", async () => {
    const user = userEvent.setup();
    render(<SmartApp />);
    await screen.findByRole("button", { name: "Logout" });
    await user.click(screen.getByRole("tab", { name: "Admin" }));

    await user.selectOptions(screen.getByLabelText("Provisional source"), "part-1");
    await user.click(screen.getByRole("button", { name: "Keep As-Is" }));

    await waitFor(() => {
      expect(apiMock.approvePartType).toHaveBeenCalledWith("part-1");
    });
    expect(await screen.findByText("Approved provisional part type.")).toBeInTheDocument();
  });

  it("repeats the last assignment using 'Assign Same'", async () => {
    const user = userEvent.setup();
    const labelResponse = {
      mode: "label" as const,
      qrCode: {
        code: "QR-2001",
        batchId: "batch-1",
        status: "printed" as const,
        assignedKind: null,
        assignedId: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      suggestions: [partType],
      partDb: { configured: false as const, connected: false as const, message: "Not configured" },
    } satisfies ScanResponse;
    apiMock.scan
      .mockResolvedValueOnce(labelResponse)
      .mockResolvedValueOnce({
        mode: "interact",
        qrCode: { ...labelResponse.qrCode, status: "assigned", assignedKind: "instance", assignedId: "instance-1" },
        entity: { id: "instance-1", targetType: "instance", qrCode: "QR-2001", partType, location: "Shelf A", state: "available", assignee: null },
        recentEvents: [],
        availableActions: ["moved", "checked_out"],
        partDb: labelResponse.partDb,
      } satisfies ScanResponse)
      .mockResolvedValueOnce({
        ...labelResponse,
        qrCode: { ...labelResponse.qrCode, code: "QR-2002" },
      } satisfies ScanResponse)
      .mockResolvedValueOnce({
        mode: "interact",
        qrCode: { ...labelResponse.qrCode, code: "QR-2002", status: "assigned", assignedKind: "instance", assignedId: "instance-2" },
        entity: { id: "instance-2", targetType: "instance", qrCode: "QR-2002", partType, location: "Buffer Room A", state: "available", assignee: null },
        recentEvents: [],
        availableActions: ["moved", "checked_out"],
        partDb: labelResponse.partDb,
      } satisfies ScanResponse);

    render(<SmartApp />);
    await screen.findByRole("button", { name: "Logout" });

    // First label + assign
    await user.type(screen.getByPlaceholderText("Scan or type a QR / barcode"), "QR-2001");
    await user.click(screen.getByRole("button", { name: "Open" }));
    const assignHeading = await screen.findByText("Assign QR-2001");
    const card = assignHeading.closest(".result-card")!;
    await user.click(within(card).getByRole("radio", { name: /Arduino Uno R3/ }));
    await user.click(screen.getByRole("button", { name: "Assign QR" }));
    await waitFor(() => { expect(apiMock.assignQr).toHaveBeenCalledTimes(1); });

    // Second label scan — should show "Assign Same" bar
    await user.clear(screen.getByPlaceholderText("Scan or type a QR / barcode"));
    await user.type(screen.getByPlaceholderText("Scan or type a QR / barcode"), "QR-2002");
    await user.click(screen.getByRole("button", { name: "Open" }));
    const sameBtn = await screen.findByRole("button", { name: /Assign Same/ });
    expect(sameBtn).toBeInTheDocument();

    apiMock.assignQr.mockResolvedValueOnce({
      id: "instance-2", targetType: "instance", qrCode: "QR-2002", partType, location: "Buffer Room A", state: "available", assignee: null,
    });
    await user.click(sameBtn);
    await waitFor(() => {
      expect(apiMock.assignQr).toHaveBeenCalledTimes(2);
      expect(apiMock.assignQr).toHaveBeenLastCalledWith(expect.objectContaining({
        qrCode: "QR-2002",
        partType: { kind: "existing", existingPartTypeId: "part-1" },
      }));
    });
  });

  it("reuses the server-assigned part type id for 'Assign Same' after creating a new part type", async () => {
    const user = userEvent.setup();
    const createdPartType: PartType = {
      ...partType,
      id: "part-created",
      canonicalName: "Fresh Widget",
      category: "Widgets",
    };
    const firstLabelResponse = {
      mode: "label",
      qrCode: {
        code: "QR-3001",
        batchId: "batch-1",
        status: "printed",
        assignedKind: null,
        assignedId: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      suggestions: [],
      partDb: {
        configured: false,
        connected: false,
        message: "Not configured",
      },
    } satisfies ScanResponse;

    apiMock.scan
      .mockResolvedValueOnce(firstLabelResponse)
      .mockResolvedValueOnce({
        mode: "interact",
        qrCode: {
          ...firstLabelResponse.qrCode,
          status: "assigned",
          assignedKind: "instance",
          assignedId: "instance-3001",
        },
        entity: {
          id: "instance-3001",
          targetType: "instance",
          qrCode: "QR-3001",
          partType: createdPartType,
          location: "Shelf Z",
          state: "available",
          assignee: null,
        },
        recentEvents: [],
        availableActions: ["moved", "checked_out"],
        partDb: firstLabelResponse.partDb,
      } satisfies ScanResponse)
      .mockResolvedValueOnce({
        ...firstLabelResponse,
        qrCode: { ...firstLabelResponse.qrCode, code: "QR-3002" },
      } satisfies ScanResponse)
      .mockResolvedValueOnce({
        mode: "interact",
        qrCode: {
          ...firstLabelResponse.qrCode,
          code: "QR-3002",
          status: "assigned",
          assignedKind: "instance",
          assignedId: "instance-3002",
        },
        entity: {
          id: "instance-3002",
          targetType: "instance",
          qrCode: "QR-3002",
          partType: createdPartType,
          location: "Shelf Z",
          state: "available",
          assignee: null,
        },
        recentEvents: [],
        availableActions: ["moved", "checked_out"],
        partDb: firstLabelResponse.partDb,
      } satisfies ScanResponse);

    apiMock.assignQr
      .mockResolvedValueOnce({
        id: "instance-3001",
        targetType: "instance",
        qrCode: "QR-3001",
        partType: createdPartType,
        location: "Shelf Z",
        state: "available",
        assignee: null,
      })
      .mockResolvedValueOnce({
        id: "instance-3002",
        targetType: "instance",
        qrCode: "QR-3002",
        partType: createdPartType,
        location: "Shelf Z",
        state: "available",
        assignee: null,
      });

    render(<SmartApp />);
    await screen.findByRole("button", { name: "Logout" });

    await user.type(screen.getByPlaceholderText("Scan or type a QR / barcode"), "QR-3001");
    await user.click(screen.getByRole("button", { name: "Open" }));
    const assignHeading = await screen.findByText("Assign QR-3001");
    const assignCard = assignHeading.closest(".result-card");
    if (!assignCard) {
      throw new Error("assign card was not rendered");
    }

    await user.click(within(assignCard).getByRole("radio", { name: "Create new type" }));
    await user.type(within(assignCard).getByLabelText(/^New canonical name/), "Fresh Widget");
    await user.clear(within(assignCard).getByLabelText(/^Category/));
    await user.type(within(assignCard).getByLabelText(/^Category/), "Widgets");
    await user.clear(within(assignCard).getByLabelText(/^Location/));
    await user.type(within(assignCard).getByLabelText(/^Location/), "Shelf Z");
    await user.click(within(assignCard).getByRole("button", { name: "Assign QR" }));
    await waitFor(() => {
      expect(apiMock.assignQr).toHaveBeenCalledTimes(1);
    });

    await user.clear(screen.getByPlaceholderText("Scan or type a QR / barcode"));
    await user.type(screen.getByPlaceholderText("Scan or type a QR / barcode"), "QR-3002");
    await user.click(screen.getByRole("button", { name: "Open" }));
    const sameBtn = await screen.findByRole("button", { name: /Assign Same/ });
    await user.click(sameBtn);

    await waitFor(() => {
      expect(apiMock.assignQr).toHaveBeenCalledTimes(2);
      expect(apiMock.assignQr).toHaveBeenLastCalledWith(expect.objectContaining({
        qrCode: "QR-3002",
        partType: { kind: "existing", existingPartTypeId: "part-created" },
      }));
    });
  });

  it("ignores aborted predictive-search failures", async () => {
    const user = userEvent.setup();
    const firstSearch = deferred<PartType[]>();
    const secondSearch = deferred<PartType[]>();
    apiMock.searchPartTypes
      .mockResolvedValueOnce([partType])
      .mockReturnValueOnce(firstSearch.promise)
      .mockReturnValueOnce(secondSearch.promise);
    apiMock.scan.mockResolvedValueOnce({
      mode: "label",
      qrCode: {
        code: "QR-ABORT",
        batchId: "batch-1",
        status: "printed",
        assignedKind: null,
        assignedId: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      suggestions: [partType],
      partDb: {
        configured: false,
        connected: false,
        message: "Not configured",
      },
    } satisfies ScanResponse);

    render(<SmartApp />);
    await screen.findByRole("button", { name: "Logout" });
    await user.type(screen.getByPlaceholderText("Scan or type a QR / barcode"), "QR-ABORT");
    await user.click(screen.getByRole("button", { name: "Open" }));

    const heading = await screen.findByText("Assign QR-ABORT");
    const card = heading.closest(".result-card");
    if (!card) {
      throw new Error("assign card was not rendered");
    }

    fireEvent.change(within(card).getByLabelText("Search existing part types"), {
      target: { value: "old" },
    });
    fireEvent.change(within(card).getByLabelText("Search existing part types"), {
      target: { value: "new" },
    });

    firstSearch.reject(new DOMException("aborted", "AbortError"));
    secondSearch.resolve([bulkType]);
    expect(await within(card).findByRole("radio", { name: /M3 Screw/ })).toBeInTheDocument();
    expect(screen.queryByText("aborted")).toBeNull();
  });
});
