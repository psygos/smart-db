import { describe, expect, it } from "vitest";
import {
  applicationErrorResponseSchema,
  assignQrRequestSchema,
  configEnvironmentSchema,
  latestQrBatchResponseSchema,
  loginRequestSchema,
  loginResponseSchema,
  logoutResponseSchema,
  mergePartTypesRequestSchema,
  recordEventRequestSchema,
  registerQrBatchRequestSchema,
  scanResponseSchema,
} from "./index";

describe("schemas", () => {
  it("applies defaults to QR batch requests and environment config", () => {
    expect(
      registerQrBatchRequestSchema.parse({
        startNumber: 1001,
        count: 500,
      }),
    ).toEqual({
      prefix: "QR",
      startNumber: 1001,
      count: 500,
    });

    expect(configEnvironmentSchema.parse({})).toEqual({
      PORT: 4000,
      FRONTEND_ORIGIN: "http://localhost:5173",
      PUBLIC_BASE_URL: "http://localhost:4000",
      PARTDB_BASE_URL: null,
      PARTDB_PUBLIC_BASE_URL: null,
      PARTDB_API_TOKEN: null,
      SESSION_COOKIE_SECRET: null,
      ZITADEL_ISSUER: null,
      ZITADEL_CLIENT_ID: null,
      ZITADEL_CLIENT_SECRET: null,
      ZITADEL_POST_LOGOUT_REDIRECT_URI: null,
      ZITADEL_ROLE_CLAIM: null,
    });
  });

  it("rejects out-of-bounds batch count and invalid prefix characters", () => {
    expect(() =>
      registerQrBatchRequestSchema.parse({
        startNumber: 0,
        count: 10001,
      }),
    ).toThrow();

    expect(() =>
      registerQrBatchRequestSchema.parse({
        prefix: "QR!",
        startNumber: 0,
        count: 1,
      }),
    ).toThrow();

    expect(
      registerQrBatchRequestSchema.parse({
        prefix: "QR_2-A",
        startNumber: 0,
        count: 10000,
      }),
    ).toEqual({
      prefix: "QR_2-A",
      startNumber: 0,
      count: 10000,
    });
  });

  it("parses assignment commands as discriminated unions", () => {
    expect(
      assignQrRequestSchema.parse({
        qrCode: "QR-1001",
        entityKind: "instance",
        location: "Shelf A",
        partType: {
          kind: "existing",
          existingPartTypeId: "part-1",
        },
      }),
    ).toEqual({
      qrCode: "QR-1001",
      entityKind: "instance",
      location: "Shelf A",
      notes: null,
      partType: {
        kind: "existing",
        existingPartTypeId: "part-1",
      },
      initialStatus: "available",
    });

    expect(
      assignQrRequestSchema.parse({
        qrCode: "QR-1002",
        entityKind: "bulk",
        location: "Bin 4",
        partType: {
          kind: "new",
          canonicalName: "M3 Screw",
          category: "Fasteners",
          countable: false,
        },
      }),
    ).toEqual({
      qrCode: "QR-1002",
      entityKind: "bulk",
      location: "Bin 4",
      notes: null,
      partType: {
        kind: "new",
        canonicalName: "M3 Screw",
        category: "Fasteners",
        aliases: [],
        notes: null,
        imageUrl: null,
        countable: false,
      },
      initialLevel: "good",
    });
  });

  it("parses lifecycle events, merge requests, responses, and error envelopes", () => {
    expect(
      recordEventRequestSchema.parse({
        targetType: "instance",
        targetId: "instance-1",
        event: "checked_out",
      }),
    ).toEqual({
      targetType: "instance",
      targetId: "instance-1",
      event: "checked_out",
      notes: null,
      location: "Unknown",
      nextStatus: "available",
      assignee: null,
    });

    expect(
      mergePartTypesRequestSchema.parse({
        sourcePartTypeId: "source",
        destinationPartTypeId: "destination",
      }),
    ).toEqual({
      sourcePartTypeId: "source",
      destinationPartTypeId: "destination",
    });

    expect(
      scanResponseSchema.parse({
        mode: "unknown",
        code: "EAN-1234",
        partDb: {
          configured: false,
          connected: false,
          message: "Not configured",
        },
      }),
    ).toEqual({
      mode: "unknown",
      code: "EAN-1234",
      partDb: {
        configured: false,
        connected: false,
        message: "Not configured",
      },
    });

    expect(
      loginRequestSchema.parse({
        apiToken: "token-123",
      }),
    ).toEqual({
      apiToken: "token-123",
    });

    expect(
      loginResponseSchema.parse({
        session: {
          subject: "zitadel-user-1",
          username: "labeler",
          name: "Labeler User",
          email: "labeler@example.com",
          roles: ["smartdb.labeler"],
          issuedAt: "2026-01-01T00:00:00.000Z",
          expiresAt: null,
        },
      }),
    ).toEqual({
      session: {
        subject: "zitadel-user-1",
        username: "labeler",
        name: "Labeler User",
        email: "labeler@example.com",
        roles: ["smartdb.labeler"],
        issuedAt: "2026-01-01T00:00:00.000Z",
        expiresAt: null,
      },
    });

    expect(
      applicationErrorResponseSchema.parse({
        error: {
          code: "unauthenticated",
          message: "Authentication is required.",
          details: {
            source: "partdb",
          },
        },
      }),
    ).toEqual({
      error: {
        code: "unauthenticated",
        message: "Authentication is required.",
        details: {
          source: "partdb",
        },
      },
    });

    expect(
      logoutResponseSchema.parse({
        ok: true,
      }),
    ).toEqual({
      ok: true,
      redirectUrl: null,
    });

    expect(latestQrBatchResponseSchema.parse(null)).toBeNull();
  });
});
