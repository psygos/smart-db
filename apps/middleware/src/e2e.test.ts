import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildServer } from "./server";
import type { FastifyInstance } from "fastify";
const auth = {
  cookie: "smartdb_session=session-1",
  origin: "http://localhost:5173",
};
const authSession = {
  subject: "zitadel-user-1",
  username: "e2e-labeler",
  name: "E2E Labeler",
  email: "e2e@example.com",
  roles: ["smartdb.admin", "smartdb.labeler"],
  issuedAt: "2026-01-01T00:00:00.000Z",
  expiresAt: null,
};

function makeAuthService() {
  return {
    startLogin: vi.fn(async () => ({
      authorizationUrl: "https://auth.example.com/oauth/v2/authorize?state=e2e-state",
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
  } as never;
}

function stubPartDbFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | RequestInfo) => {
      const url = typeof input === "string" ? input : String(input);
      if (url.endsWith("/api/tokens/current")) {
        return {
          ok: true,
          json: async () => ({
            name: "smart-db-service-token",
            owner: { username: "smartdb-service" },
          }),
        };
      }
      if (url.endsWith("/api/docs.json")) {
        return {
          ok: true,
          json: async () => ({
            paths: {
              "/api/parts": {},
              "/api/part_lots": {},
              "/api/storage_locations": {},
            },
          }),
        };
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }),
  );
}

describe("E2E: full intake → lifecycle → merge workflow", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    stubPartDbFetch();
    app = await buildServer({
      configOverride: {
        port: 4200,
        frontendOrigin: "http://localhost:5173",
        publicBaseUrl: "http://localhost:4200",
        dataPath: join(mkdtempSync(join(tmpdir(), "smart-db-e2e-")), "smart.db"),
        sessionCookieName: "smartdb_session",
        partDb: {
          baseUrl: "https://partdb.example.com",
          publicBaseUrl: "https://partdb.example.com",
          apiToken: "partdb-service-token",
        },
        auth: {
          issuer: "https://auth.example.com",
          clientId: "smartdb-client",
          clientSecret: null,
          roleClaim: "smartdb_roles",
          sessionCookieSecret: "test-session-secret",
        },
      },
      authService: makeAuthService(),
    });
  });

  afterAll(async () => {
    await app.close();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("walks the full workflow: auth → batch → scan → assign → interact → merge", async () => {
    const login = await app.inject({
      method: "GET",
      url: "/api/auth/login",
    });
    expect(login.statusCode).toBe(302);

    const callback = await app.inject({
      method: "GET",
      url: "/api/auth/callback?code=auth-code&state=e2e-state",
      cookies: {
        smartdb_auth_request: "auth-request-cookie",
      },
    });
    expect(callback.statusCode).toBe(302);

    const dashboardEmpty = await app.inject({
      method: "GET",
      url: "/api/dashboard",
      headers: auth,
    });
    expect(dashboardEmpty.statusCode).toBe(200);
    expect(dashboardEmpty.json().partTypeCount).toBe(0);

    const batch = await app.inject({
      method: "POST",
      url: "/api/qr-batches",
      payload: { prefix: "E2E", startNumber: 1, count: 5 },
      headers: auth,
    });
    expect(batch.statusCode).toBe(200);
    expect(batch.json().created).toBe(5);

    const latestBatch = await app.inject({
      method: "GET",
      url: "/api/qr-batches/latest",
      headers: auth,
    });
    expect(latestBatch.statusCode).toBe(200);
    expect(latestBatch.json()).toMatchObject({
      id: batch.json().batch.id,
      prefix: "E2E",
      startNumber: 1,
      endNumber: 5,
    });

    const labelsPdf = await app.inject({
      method: "GET",
      url: `/api/qr-batches/${batch.json().batch.id}/labels.pdf`,
      headers: auth,
    });
    expect(labelsPdf.statusCode).toBe(200);
    expect(labelsPdf.headers["content-type"]).toContain("application/pdf");
    expect(Buffer.from(labelsPdf.body).subarray(0, 4).toString("utf8")).toBe("%PDF");

    const scanPrinted = await app.inject({
      method: "POST",
      url: "/api/scan",
      payload: { code: "E2E-1" },
      headers: auth,
    });
    expect(scanPrinted.statusCode).toBe(200);
    expect(scanPrinted.json().mode).toBe("label");

    const scanUnknown = await app.inject({
      method: "POST",
      url: "/api/scan",
      payload: { code: "RANDOM-BARCODE" },
      headers: auth,
    });
    expect(scanUnknown.statusCode).toBe(200);
    expect(scanUnknown.json().mode).toBe("unknown");

    const assignInstance = await app.inject({
      method: "POST",
      url: "/api/assignments",
      payload: {
        qrCode: "E2E-1",
        entityKind: "instance",
        location: "Shelf A",
        notes: "first board",
        partType: {
          kind: "new",
          canonicalName: "Arduino Uno R3",
          category: "Microcontrollers",
          aliases: ["uno r3"],
          countable: true,
        },
      },
      headers: auth,
    });
    expect(assignInstance.statusCode).toBe(200);
    const instanceEntity = assignInstance.json();
    expect(instanceEntity.targetType).toBe("instance");
    expect(instanceEntity.state).toBe("available");

    const scanAssigned = await app.inject({
      method: "POST",
      url: "/api/scan",
      payload: { code: "E2E-1" },
      headers: auth,
    });
    expect(scanAssigned.statusCode).toBe(200);
    expect(scanAssigned.json().mode).toBe("interact");
    expect(scanAssigned.json().recentEvents).toHaveLength(1);
    expect(scanAssigned.json().availableActions).toContain("checked_out");

    const checkout = await app.inject({
      method: "POST",
      url: "/api/events",
      payload: {
        targetType: "instance",
        targetId: instanceEntity.id,
        event: "checked_out",
        location: "Workbench",
        assignee: "Alice",
      },
      headers: auth,
    });
    expect(checkout.statusCode).toBe(200);
    expect(checkout.json().toState).toBe("checked_out");

    const returnEvent = await app.inject({
      method: "POST",
      url: "/api/events",
      payload: {
        targetType: "instance",
        targetId: instanceEntity.id,
        event: "returned",
        location: "Shelf A",
      },
      headers: auth,
    });
    expect(returnEvent.statusCode).toBe(200);
    expect(returnEvent.json().toState).toBe("available");

    const assignBulk = await app.inject({
      method: "POST",
      url: "/api/assignments",
      payload: {
        qrCode: "E2E-2",
        entityKind: "bulk",
        location: "Bin 7",
        initialQuantity: 5,
        partType: {
          kind: "new",
          canonicalName: "M3 Screw",
          category: "Fasteners",
          countable: false,
        },
      },
      headers: auth,
    });
    expect(assignBulk.statusCode).toBe(200);
    expect(assignBulk.json().targetType).toBe("bulk");

    const stocktake = await app.inject({
      method: "POST",
      url: "/api/events",
      payload: {
        targetType: "bulk",
        targetId: assignBulk.json().id,
        event: "stocktaken",
        location: "Bin 7",
        quantity: 5,
      },
      headers: auth,
    });
    expect(stocktake.statusCode).toBe(200);
    expect(stocktake.json().toState).toBe("5 pcs on hand");

    const assignDuplicate = await app.inject({
      method: "POST",
      url: "/api/assignments",
      payload: {
        qrCode: "E2E-3",
        entityKind: "instance",
        location: "Cable shelf",
        partType: {
          kind: "new",
          canonicalName: "USB-C Cable",
          category: "Cables",
          aliases: ["usb c"],
          countable: true,
        },
      },
      headers: auth,
    });
    expect(assignDuplicate.statusCode).toBe(200);

    const assignAlias = await app.inject({
      method: "POST",
      url: "/api/assignments",
      payload: {
        qrCode: "E2E-4",
        entityKind: "instance",
        location: "Cable shelf",
        partType: {
          kind: "new",
          canonicalName: "USB Type C Cable",
          category: "Cables",
          countable: true,
        },
      },
      headers: auth,
    });
    expect(assignAlias.statusCode).toBe(200);

    const merge = await app.inject({
      method: "POST",
      url: "/api/part-types/merge",
      payload: {
        sourcePartTypeId: assignAlias.json().partType.id,
        destinationPartTypeId: assignDuplicate.json().partType.id,
      },
      headers: auth,
    });
    expect(merge.statusCode).toBe(200);
    expect(merge.json().needsReview).toBe(false);
    expect(merge.json().aliases).toContain("USB Type C Cable");

    const search = await app.inject({
      method: "GET",
      url: "/api/part-types/search?q=arduino",
      headers: auth,
    });
    expect(search.statusCode).toBe(200);
    expect(search.json()).toHaveLength(1);

    const provisional = await app.inject({
      method: "GET",
      url: "/api/part-types/provisional",
      headers: auth,
    });
    expect(provisional.statusCode).toBe(200);

    const dashboardFull = await app.inject({
      method: "GET",
      url: "/api/dashboard",
      headers: auth,
    });
    expect(dashboardFull.statusCode).toBe(200);
    const summary = dashboardFull.json();
    expect(summary.instanceCount).toBe(3);
    expect(summary.bulkStockCount).toBe(1);
    expect(summary.recentEvents.length).toBeGreaterThan(0);

    const partDbStatus = await app.inject({
      method: "GET",
      url: "/api/partdb/status",
      headers: auth,
    });
    expect(partDbStatus.statusCode).toBe(200);
    expect(partDbStatus.json().configured).toBe(true);

    const illegalEvent = await app.inject({
      method: "POST",
      url: "/api/events",
      payload: {
        targetType: "instance",
        targetId: instanceEntity.id,
        event: "returned",
        location: "Shelf A",
      },
      headers: auth,
    });
    expect(illegalEvent.statusCode).toBe(409);

    // Void endpoint
    const voidResult = await app.inject({
      method: "POST",
      url: `/api/qr-codes/E2E-5/void`,
      payload: {},
      headers: auth,
    });
    expect(voidResult.statusCode).toBe(200);
    expect(voidResult.json().status).toBe("voided");

    const voidMissing = await app.inject({
      method: "POST",
      url: `/api/qr-codes/MISSING-CODE/void`,
      payload: {},
      headers: auth,
    });
    expect(voidMissing.statusCode).toBe(404);

    // Approve endpoint
    const approveResult = await app.inject({
      method: "POST",
      url: `/api/part-types/${instanceEntity.partType.id}/approve`,
      headers: auth,
    });
    expect(approveResult.statusCode).toBe(200);
    expect(approveResult.json().needsReview).toBe(false);

    const approveMissing = await app.inject({
      method: "POST",
      url: `/api/part-types/missing-id/approve`,
      headers: auth,
    });
    expect(approveMissing.statusCode).toBe(404);

    const selfMerge = await app.inject({
      method: "POST",
      url: "/api/part-types/merge",
      payload: {
        sourcePartTypeId: assignDuplicate.json().partType.id,
        destinationPartTypeId: assignDuplicate.json().partType.id,
      },
      headers: auth,
    });
    expect(selfMerge.statusCode).toBe(400);

    const conflictAssign = await app.inject({
      method: "POST",
      url: "/api/assignments",
      payload: {
        qrCode: "E2E-1",
        entityKind: "instance",
        location: "Shelf B",
        partType: {
          kind: "existing",
          existingPartTypeId: instanceEntity.partType.id,
        },
      },
      headers: auth,
    });
    expect(conflictAssign.statusCode).toBe(409);

    const parseError = await app.inject({
      method: "POST",
      url: "/api/qr-batches",
      payload: { startNumber: 1, count: 0 },
      headers: auth,
    });
    expect(parseError.statusCode).toBe(400);
    expect(parseError.json().error.code).toBe("parse_input");

    const noAuth = await app.inject({
      method: "GET",
      url: "/api/dashboard",
    });
    expect(noAuth.statusCode).toBe(401);

    const logout = await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: auth,
    });
    expect(logout.statusCode).toBe(200);
    expect(logout.json()).toEqual({ ok: true, redirectUrl: null });
  });
});
