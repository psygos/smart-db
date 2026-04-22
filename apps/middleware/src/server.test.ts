import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type BulkAssignQrsResponse,
  type BulkMoveEntitiesResponse,
  type BulkReverseIngestResponse,
  ConflictError,
  type CorrectionEvent,
  type DashboardSummary,
  type EditPartTypeDefinitionResponse,
  type InventoryEntitySummary,
  type PartDbConnectionStatus,
  type PartType,
  type QRCode,
  type ReassignEntityPartTypeResponse,
  type ReverseIngestAssignmentResponse,
  type ScanResponse,
  type StockEvent,
} from "@smart-db/contracts";
import { buildServer } from "./server";

const partType: PartType = {
  id: "part-1",
  canonicalName: "Arduino Uno R3",
  category: "Microcontrollers",
  categoryPath: ["Uncategorized"],
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

const dashboard: DashboardSummary = {
  partTypeCount: 1,
  instanceCount: 1,
  bulkStockCount: 0,
  provisionalCount: 1,
  unassignedQrCount: 4,
  recentEvents: [],
};

const scanResponse: ScanResponse = {
  mode: "unknown",
  code: "EAN-1234",
  partDb: {
    configured: false,
    connected: false,
    message: "Part-DB credentials are not configured.",
  },
};

const entitySummary: InventoryEntitySummary = {
  id: "instance-1",
  targetType: "instance",
  qrCode: "QR-1001",
  partType,
  location: "Shelf A",
  state: "available",
  assignee: null,
  partDbSyncStatus: "never",
  quantity: null,
  minimumQuantity: null,
};

const stockEvent: StockEvent = {
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
};

const correctionEvent: CorrectionEvent = {
  id: "corr-1",
  targetType: "instance",
  targetId: "instance-1",
  correctionKind: "entity_part_type_reassigned",
  actor: "lab-admin",
  reason: "Wrong type",
  before: { partTypeId: "part-1" },
  after: { partTypeId: "part-2" },
  createdAt: "2026-01-01T00:00:00.000Z",
};

const reassignResponse: ReassignEntityPartTypeResponse = {
  entity: entitySummary,
  correctionEvent,
};

const editPartTypeResponse: EditPartTypeDefinitionResponse = {
  partType,
  correctionEvent: {
    ...correctionEvent,
    targetType: "part_type",
    targetId: "part-1",
    correctionKind: "part_type_definition_edited",
  },
};

const reverseIngestResponse: ReverseIngestAssignmentResponse = {
  qrCode: {
    code: "QR-1001",
    batchId: "batch-1",
    status: "printed",
    assignedKind: null,
    assignedId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
  correctionEvent: {
    ...correctionEvent,
    correctionKind: "ingest_reversed",
  },
};

const bulkAssignResponse: BulkAssignQrsResponse = {
  entities: [entitySummary],
  processedCount: 1,
};

const bulkMoveResponse: BulkMoveEntitiesResponse = {
  events: [stockEvent],
  processedCount: 1,
};

const bulkReverseResponse: BulkReverseIngestResponse = {
  qrCodes: [reverseIngestResponse.qrCode],
  correctionEvents: [reverseIngestResponse.correctionEvent],
  processedCount: 1,
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

const authSession = {
  subject: "zitadel-user-1",
  username: "labeler",
  name: "Labeler User",
  email: "labeler@example.com",
  roles: ["smartdb.admin", "smartdb.labeler"],
  issuedAt: "2026-01-01T00:00:00.000Z",
  expiresAt: null,
};

const sessionHeaders = {
  cookie: "smartdb_session=session-1",
  origin: "http://localhost:5173",
};

afterEach(() => {
  vi.restoreAllMocks();
});

function makeConfig() {
  return {
    port: 4100,
    frontendOrigin: "http://localhost:5173",
    publicBaseUrl: "http://localhost:4100",
    dataPath: join(mkdtempSync(join(tmpdir(), "smart-db-server-")), "smart.db"),
    sessionCookieName: "smartdb_session",
    partDb: {
      baseUrl: "https://partdb.example.com",
      publicBaseUrl: "https://partdb.example.com",
      apiToken: "partdb-service-token",
      syncEnabled: false,
    },
    auth: {
      issuer: "https://auth.example.com",
      clientId: "smartdb-client",
      clientSecret: null,
      roleClaim: "smartdb_roles",
      sessionCookieSecret: "test-session-secret",
    },
  };
}

function makeAuthService(overrides: Record<string, unknown> = {}) {
  return {
    startLogin: vi.fn(async () => ({
      authorizationUrl: "https://auth.example.com/oauth/v2/authorize?state=state-1",
      authRequest: "auth-request-cookie",
    })),
    completeLogin: vi.fn(async () => ({
      sessionId: "session-1",
      session: authSession,
      redirectTo: "http://localhost:5173/",
    })),
    getSession: vi.fn((sessionId: string | undefined) =>
      sessionId === "session-1" ? authSession : null,
    ),
    logout: vi.fn(async () => ({ redirectUrl: null })),
    ...overrides,
  } as never;
}

describe("buildServer", () => {
  it("supports auth login, session inspection, logout, and 401s", async () => {
    const authService = makeAuthService();
    const app = await buildServer({
      configOverride: makeConfig(),
      authService,
    });

    const login = await app.inject({
      method: "GET",
      url: "/api/auth/login",
    });
    expect(login.statusCode).toBe(302);
    expect(login.headers.location).toContain("https://auth.example.com/oauth/v2/authorize");
    expect(login.headers["set-cookie"]).toEqual(
      expect.stringContaining("smartdb_auth_request="),
    );

    const missingAuth = await app.inject({
      method: "GET",
      url: "/api/auth/session",
    });
    expect(missingAuth.statusCode).toBe(401);

    const callback = await app.inject({
      method: "GET",
      url: "/api/auth/callback?code=auth-code&state=state-1",
      cookies: {
        smartdb_auth_request: "auth-request-cookie",
      },
    });
    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toBe("http://localhost:5173/");

    const session = await app.inject({
      method: "GET",
      url: "/api/auth/session",
      headers: sessionHeaders,
    });
    expect(session.statusCode).toBe(200);
    expect(session.json()).toMatchObject({
      username: "labeler",
    });

    const logout = await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: sessionHeaders,
    });
    expect(logout.statusCode).toBe(200);
    expect(logout.json()).toEqual({ ok: true, redirectUrl: null });

    // Regression: the browser's logout POST historically carried
    // Content-Type: application/json with no body. Fastify's default JSON
    // parser rejects that with FST_ERR_CTP_EMPTY_JSON_BODY (status 400)
    // before the route runs. A faithful server response is a 400 with the
    // original fastify code, not a 500 "invariant / Unhandled middleware
    // failure" envelope.
    const empty = await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { ...sessionHeaders, "content-type": "application/json" },
    });
    expect(empty.statusCode).toBe(400);
    expect(empty.json().error.code).toBe("FST_ERR_CTP_EMPTY_JSON_BODY");

    expect(authService.startLogin).toHaveBeenCalledTimes(1);
    expect(authService.completeLogin).toHaveBeenCalledTimes(1);
    expect(authService.logout).toHaveBeenCalledTimes(1);

    await app.close();
  });

  it("sanitizes auth callback failures before redirecting back to the frontend", async () => {
    const authService = makeAuthService({
      completeLogin: vi.fn(async () => {
        throw new Error("jwt verification failed");
      }),
    });
    const app = await buildServer({
      configOverride: makeConfig(),
      authService,
    });

    const callback = await app.inject({
      method: "GET",
      url: "/api/auth/callback?code=auth-code&state=state-1",
      cookies: {
        smartdb_auth_request: "auth-request-cookie",
      },
    });

    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toBe(
      "http://localhost:5173/?authError=Sign-in+failed.+Please+try+again.",
    );

    await app.close();
  });

  it("can build a real server with its own inventory service", async () => {
    const app = await buildServer({
      configOverride: makeConfig(),
    });

    const response = await app.inject({
      method: "GET",
      url: "/health",
    });

    expect(response.statusCode).toBe(200);
    await app.close();
  });

  it("can fall back to the module config when no override is provided", async () => {
    const app = await buildServer();
    const response = await app.inject({
      method: "GET",
      url: "/health",
    });

    expect(response.statusCode).toBe(200);
    await app.close();
  });

  it("supports non-test logger configuration paths", async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    const app = await buildServer({
      configOverride: makeConfig(),
    });

    const response = await app.inject({
      method: "GET",
      url: "/health",
    });

    expect(response.statusCode).toBe(200);
    await app.close();
    process.env.NODE_ENV = previousNodeEnv;
  });

  it("returns 403 for admin-only routes when the session lacks the admin role", async () => {
    const authService = makeAuthService({
      getSession: vi.fn((sessionId: string | undefined) =>
        sessionId === "session-1"
          ? {
              ...authSession,
              roles: ["smartdb.labeler"],
            }
          : null,
      ),
    });
    const app = await buildServer({
      configOverride: makeConfig(),
      authService,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/qr-batches",
      payload: {
        startNumber: 1001,
        count: 2,
      },
      headers: sessionHeaders,
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      error: {
        code: "forbidden",
        message: "You do not have permission to perform this action.",
        details: {
          requiredRole: "smartdb.admin",
        },
      },
    });

    await app.close();
  });

  it("exposes partdb sync admin status endpoints", async () => {
    const app = await buildServer({
      configOverride: makeConfig(),
      authService: makeAuthService(),
    });

    const status = await app.inject({
      method: "GET",
      url: "/api/partdb/sync/status",
      headers: sessionHeaders,
    });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toEqual({
      enabled: false,
      pending: 0,
      inFlight: 0,
      failedLast24h: 0,
      deadTotal: 0,
    });

    const failures = await app.inject({
      method: "GET",
      url: "/api/partdb/sync/failures",
      headers: sessionHeaders,
    });
    expect(failures.statusCode).toBe(200);
    expect(failures.json()).toEqual([]);

    const drain = await app.inject({
      method: "POST",
      url: "/api/partdb/sync/drain",
      headers: sessionHeaders,
    });
    expect(drain.statusCode).toBe(200);
    expect(drain.json()).toEqual({
      claimed: 0,
      delivered: 0,
      failed: 0,
    });

    const backfill = await app.inject({
      method: "POST",
      url: "/api/partdb/sync/backfill",
      headers: sessionHeaders,
    });
    expect(backfill.statusCode).toBe(200);
    expect(backfill.json()).toEqual({
      queuedPartTypes: 0,
      queuedLots: 0,
      skipped: 0,
    });

    await app.close();
  });

  it("serves the route surface and delegates to the inventory service", async () => {
    const authService = makeAuthService();
    const voidedQr: QRCode = {
      code: "QR-1001",
      batchId: "batch-1",
      status: "voided",
      assignedKind: null,
      assignedId: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };

    const service = {
      getDashboardSummary: vi.fn(() => dashboard),
      searchPartTypes: vi.fn(() => [partType]),
      getProvisionalPartTypes: vi.fn(() => [partType]),
      registerQrBatch: vi.fn(() => ({
        batch: {
          id: "batch-1",
          prefix: "QR",
          startNumber: 1001,
          endNumber: 1002,
          actor: "lab-admin",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        created: 2,
        skipped: 0,
      })),
      getLatestQrBatch: vi.fn(() => ({
        id: "batch-1",
        prefix: "QR",
        startNumber: 1001,
        endNumber: 1002,
        actor: "lab-admin",
        createdAt: "2026-01-01T00:00:00.000Z",
      })),
      getQrBatchById: vi.fn(() => ({
        id: "batch-1",
        prefix: "QR",
        startNumber: 1001,
        endNumber: 1002,
        actor: "lab-admin",
        createdAt: "2026-01-01T00:00:00.000Z",
      })),
      scanCode: vi.fn(async () => scanResponse),
      assignQr: vi.fn(() => entitySummary),
      bulkAssignQrs: vi.fn(() => bulkAssignResponse),
      recordEvent: vi.fn(() => stockEvent),
      bulkMoveEntities: vi.fn(() => bulkMoveResponse),
      mergePartTypes: vi.fn(() => partType),
      getCorrectionHistory: vi.fn(() => [correctionEvent]),
      reassignEntityPartType: vi.fn(() => reassignResponse),
      editPartTypeDefinition: vi.fn(() => editPartTypeResponse),
      reverseIngestAssignment: vi.fn(() => reverseIngestResponse),
      bulkReverseIngest: vi.fn(() => bulkReverseResponse),
      getPartDbStatus: vi.fn(async () => partDbStatus),
      voidQrCode: vi.fn(() => voidedQr),
      approvePartType: vi.fn(() => ({ ...partType, needsReview: false })),
    };

    const app = await buildServer({
      configOverride: makeConfig(),
      authService,
      inventoryService: service as never,
    });

    await expect(app.inject({ method: "GET", url: "/health" })).resolves.toMatchObject({
      statusCode: 200,
      json: expect.any(Function),
    });
    await expect(app.inject({
      method: "GET",
      url: "/api/dashboard",
      headers: sessionHeaders,
    })).resolves.toMatchObject({
      statusCode: 200,
    });
    await expect(
      app.inject({
        method: "GET",
        url: "/api/part-types/search?q=arduino",
        headers: sessionHeaders,
      }),
    ).resolves.toMatchObject({ statusCode: 200 });
    await expect(
      app.inject({
        method: "GET",
        url: "/api/part-types/provisional",
        headers: sessionHeaders,
      }),
    ).resolves.toMatchObject({ statusCode: 200 });
    await expect(
      app.inject({
        method: "POST",
        url: "/api/qr-batches",
        payload: {
          startNumber: 1001,
          count: 2,
        },
        headers: sessionHeaders,
      }),
    ).resolves.toMatchObject({ statusCode: 200 });
    await expect(
      app.inject({
        method: "POST",
        url: "/api/scan",
        payload: { code: "EAN-1234" },
        headers: sessionHeaders,
      }),
    ).resolves.toMatchObject({ statusCode: 200 });
    await expect(
      app.inject({
        method: "POST",
        url: "/api/assignments",
        payload: {
          qrCode: "QR-1001",
          entityKind: "instance",
          location: "Shelf A",
          partType: {
            kind: "existing",
            existingPartTypeId: "part-1",
          },
        },
        headers: sessionHeaders,
      }),
    ).resolves.toMatchObject({ statusCode: 200 });
    await expect(
      app.inject({
        method: "POST",
        url: "/api/bulk/assign",
        payload: {
          qrs: ["QR-1001"],
          assignment: {
            entityKind: "instance",
            location: "Shelf A",
            partType: {
              kind: "existing",
              existingPartTypeId: "part-1",
            },
          },
        },
        headers: sessionHeaders,
      }),
    ).resolves.toMatchObject({ statusCode: 200 });
    await expect(
      app.inject({
        method: "POST",
        url: "/api/events",
        payload: {
          targetType: "instance",
          targetId: "instance-1",
          event: "moved",
          location: "Shelf B",
        },
        headers: sessionHeaders,
      }),
    ).resolves.toMatchObject({ statusCode: 200 });
    await expect(
      app.inject({
        method: "POST",
        url: "/api/bulk/move",
        payload: {
          targets: [
            {
              targetType: "instance",
              targetId: "instance-1",
              qrCode: "QR-1001",
            },
          ],
          location: "Shelf B",
        },
        headers: sessionHeaders,
      }),
    ).resolves.toMatchObject({ statusCode: 200 });
    await expect(
      app.inject({
        method: "POST",
        url: "/api/part-types/merge",
        payload: {
          sourcePartTypeId: "source",
          destinationPartTypeId: "destination",
        },
        headers: sessionHeaders,
      }),
    ).resolves.toMatchObject({ statusCode: 200 });
    await expect(
      app.inject({
        method: "GET",
        url: "/api/partdb/status",
        headers: sessionHeaders,
      }),
    ).resolves.toMatchObject({
      statusCode: 200,
    });
    await expect(
      app.inject({
        method: "GET",
        url: "/api/qr-batches/latest",
        headers: sessionHeaders,
      }),
    ).resolves.toMatchObject({
      statusCode: 200,
    });
    await expect(
      app.inject({
        method: "POST",
        url: "/api/qr-codes/QR-1001/void",
        payload: {},
        headers: sessionHeaders,
      }),
    ).resolves.toMatchObject({ statusCode: 200 });
    await expect(
      app.inject({
        method: "POST",
        url: "/api/part-types/part-1/approve",
        headers: sessionHeaders,
      }),
    ).resolves.toMatchObject({ statusCode: 200 });
    await expect(
      app.inject({
        method: "GET",
        url: "/api/corrections/history?targetType=instance&targetId=instance-1",
        headers: sessionHeaders,
      }),
    ).resolves.toMatchObject({ statusCode: 200 });
    await expect(
      app.inject({
        method: "POST",
        url: "/api/corrections/reassign-part-type",
        payload: {
          targetType: "instance",
          targetId: "instance-1",
          fromPartTypeId: "part-1",
          toPartTypeId: "part-2",
          reason: "Wrong type",
        },
        headers: sessionHeaders,
      }),
    ).resolves.toMatchObject({ statusCode: 200 });
    await expect(
      app.inject({
        method: "POST",
        url: "/api/corrections/edit-part-type",
        payload: {
          partTypeId: "part-1",
          expectedUpdatedAt: "2026-01-01T00:00:00.000Z",
          canonicalName: "Arduino Uno R3",
          category: "Microcontrollers",
          reason: "Shared fix",
        },
        headers: sessionHeaders,
      }),
    ).resolves.toMatchObject({ statusCode: 200 });
    await expect(
      app.inject({
        method: "POST",
        url: "/api/corrections/reverse-ingest",
        payload: {
          qrCode: "QR-1001",
          assignedKind: "instance",
          assignedId: "instance-1",
          reason: "Wrong ingest",
        },
        headers: sessionHeaders,
      }),
    ).resolves.toMatchObject({ statusCode: 200 });
    await expect(
      app.inject({
        method: "POST",
        url: "/api/bulk/reverse-ingest",
        payload: {
          targets: [
            {
              assignedKind: "instance",
              assignedId: "instance-1",
              qrCode: "QR-1001",
            },
          ],
          reason: "Wrong ingest",
        },
        headers: sessionHeaders,
      }),
    ).resolves.toMatchObject({ statusCode: 200 });
    await expect(
      app.inject({
        method: "GET",
        url: "/api/qr-batches/batch-1/labels.pdf",
        headers: sessionHeaders,
      }),
    ).resolves.toMatchObject({
      statusCode: 200,
      headers: expect.objectContaining({
        "content-type": expect.stringContaining("application/pdf"),
      }),
    });

    expect(service.searchPartTypes).toHaveBeenCalledWith("arduino");
    expect(service.voidQrCode).toHaveBeenCalledWith("QR-1001", "labeler");
    expect(service.approvePartType).toHaveBeenCalledWith("part-1");
    expect(service.getCorrectionHistory).toHaveBeenCalledWith("instance", "instance-1");
    expect(service.bulkAssignQrs).toHaveBeenCalled();
    expect(service.bulkMoveEntities).toHaveBeenCalled();
    expect(service.reassignEntityPartType).toHaveBeenCalled();
    expect(service.editPartTypeDefinition).toHaveBeenCalled();
    expect(service.reverseIngestAssignment).toHaveBeenCalled();
    expect(service.bulkReverseIngest).toHaveBeenCalled();
    await app.close();
  });

  it("maps parse failures and domain failures to structured HTTP errors", async () => {
    const authService = makeAuthService();
    const service = {
      getDashboardSummary: vi.fn(() => {
        throw new Error("boom");
      }),
      searchPartTypes: vi.fn(() => []),
      getProvisionalPartTypes: vi.fn(() => []),
      registerQrBatch: vi.fn(() => {
        throw new ConflictError("Batch already exists.");
      }),
      getLatestQrBatch: vi.fn(() => null),
      getQrBatchById: vi.fn(() => {
        throw new ConflictError("unused");
      }),
      scanCode: vi.fn(async () => scanResponse),
      assignQr: vi.fn(() => entitySummary),
      bulkAssignQrs: vi.fn(() => bulkAssignResponse),
      recordEvent: vi.fn(() => stockEvent),
      bulkMoveEntities: vi.fn(() => bulkMoveResponse),
      mergePartTypes: vi.fn(() => partType),
      bulkReverseIngest: vi.fn(() => bulkReverseResponse),
      getPartDbStatus: vi.fn(async () => partDbStatus),
    };

    const app = await buildServer({
      configOverride: makeConfig(),
      authService,
      inventoryService: service as never,
    });

    const parseFailure = await app.inject({
      method: "POST",
      url: "/api/qr-batches",
      payload: {
        startNumber: 1001,
        count: 0,
      },
      headers: sessionHeaders,
    });
    expect(parseFailure.statusCode).toBe(400);
    expect(parseFailure.json()).toEqual({
      error: {
        code: "parse_input",
        message: "Could not parse register QR batch request.",
        details: expect.objectContaining({
          context: "register QR batch request",
        }),
      },
    });

    const domainFailure = await app.inject({
      method: "POST",
      url: "/api/qr-batches",
      payload: {
        startNumber: 1001,
        count: 2,
      },
      headers: sessionHeaders,
    });
    expect(domainFailure.statusCode).toBe(409);
    expect(domainFailure.json()).toEqual({
      error: {
        code: "conflict",
        message: "Batch already exists.",
        details: {},
      },
    });

    const invariantFailure = await app.inject({
      method: "GET",
      url: "/api/dashboard",
      headers: sessionHeaders,
    });
    expect(invariantFailure.statusCode).toBe(500);
    expect(invariantFailure.json()).toEqual({
      error: {
        code: "invariant",
        message: "Unhandled middleware failure.",
        details: {},
      },
    });

    await app.close();
  });
});
