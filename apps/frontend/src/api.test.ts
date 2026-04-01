import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ParseInputError } from "@smart-db/contracts";
import {
  ApiClientError,
  api,
  clearSessionToken,
  hydrateSessionToken,
  loginUrl,
  qrBatchLabelsPdfUrl,
  setSessionToken,
} from "./api";

afterEach(() => {
  vi.unstubAllGlobals();
  clearSessionToken();
});

beforeEach(() => {
  clearSessionToken();
});

describe("frontend api", () => {
  it("parses successful responses for every endpoint", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            subject: null,
            username: "labeler",
            name: null,
            email: null,
            roles: [],
            issuedAt: "2026-01-01T00:00:00.000Z",
            expiresAt: null,
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            ok: true,
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            partTypeCount: 1,
            instanceCount: 1,
            bulkStockCount: 0,
            provisionalCount: 1,
            unassignedQrCount: 4,
            recentEvents: [],
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
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
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            id: "batch-latest",
            prefix: "QR",
            startNumber: 1001,
            endNumber: 1024,
            actor: "labeler",
            createdAt: "2026-01-01T00:00:00.000Z",
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => [],
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => [],
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            batch: {
              id: "batch-1",
              prefix: "QR",
              startNumber: 1001,
              endNumber: 1002,
              actor: "labeler",
              createdAt: "2026-01-01T00:00:00.000Z",
            },
            created: 2,
            skipped: 0,
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            mode: "unknown",
            code: "EAN-1234",
            partDb: {
              configured: false,
              connected: false,
              message: "Part-DB credentials are not configured.",
            },
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            id: "instance-1",
            targetType: "instance",
            qrCode: "QR-1001",
            partType: {
              id: "part-1",
              canonicalName: "Arduino Uno R3",
              category: "Microcontrollers",
              aliases: ["uno r3"],
              imageUrl: null,
              notes: null,
              countable: true,
              needsReview: true,
              partDbPartId: null,
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
            location: "Shelf A",
            state: "available",
            assignee: null,
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
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
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            id: "part-1",
            canonicalName: "Arduino Uno R3",
            category: "Microcontrollers",
            aliases: ["uno r3"],
            imageUrl: null,
            notes: null,
            countable: true,
            needsReview: false,
            partDbPartId: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            code: "QR-1001",
            batchId: "batch-1",
            status: "voided",
            assignedKind: null,
            assignedId: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            id: "part-1",
            canonicalName: "Arduino Uno R3",
            category: "Microcontrollers",
            aliases: ["uno r3"],
            imageUrl: null,
            notes: null,
            countable: true,
            needsReview: false,
            partDbPartId: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          }),
        }),
    );

    await expect(api.getSession()).resolves.toMatchObject({
      username: "labeler",
    });
    await expect(api.logout()).resolves.toEqual({ ok: true, redirectUrl: null });
    await expect(api.getDashboard()).resolves.toMatchObject({ partTypeCount: 1 });
    await expect(api.getPartDbStatus()).resolves.toMatchObject({ configured: false });
    await expect(api.getLatestQrBatch()).resolves.toMatchObject({ id: "batch-latest" });
    await expect(api.getProvisionalPartTypes()).resolves.toEqual([]);
    await expect(api.searchPartTypes("arduino")).resolves.toEqual([]);
    await expect(
      api.registerQrBatch({
        prefix: "QR",
        startNumber: 1001,
        count: 2,
      }),
    ).resolves.toMatchObject({ created: 2 });
    await expect(api.scan("EAN-1234")).resolves.toMatchObject({ mode: "unknown" });
    await expect(
      api.assignQr({
        qrCode: "QR-1001",
        entityKind: "instance",
        location: "Shelf A",
        notes: null,
        partType: {
          kind: "existing",
          existingPartTypeId: "part-1",
        },
        initialStatus: "available",
      }),
    ).resolves.toMatchObject({ id: "instance-1" });
    await expect(
      api.recordEvent({
        targetType: "instance",
        targetId: "instance-1",
        event: "moved",
        location: "Shelf B",
        notes: null,
        nextStatus: "available",
        assignee: null,
      }),
    ).resolves.toMatchObject({ id: "event-1" });
    await expect(
      api.mergePartTypes({
        sourcePartTypeId: "source",
        destinationPartTypeId: "destination",
      }),
    ).resolves.toMatchObject({ id: "part-1" });
    await expect(api.voidQr("QR-1001")).resolves.toMatchObject({ status: "voided" });
    await expect(api.approvePartType("part-1")).resolves.toMatchObject({ needsReview: false });

    const fetch = globalThis.fetch as ReturnType<typeof vi.fn>;
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      credentials: "include",
    });
  });

  it("turns structured API failures into readable errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        json: async () => ({
          error: {
            code: "conflict",
            message: "Already assigned.",
            details: {},
          },
        }),
      }),
    );

    const error = await api.getDashboard().catch((caught) => caught);
    expect(error).toBeInstanceOf(ApiClientError);
    expect(error).toMatchObject({
      code: "conflict",
      message: "Already assigned.",
    });
  });

  it("falls back to status-only messages when the error payload is absent or malformed", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 503,
          json: async () => {
            throw new Error("bad json");
          },
        })
        .mockResolvedValueOnce({
          ok: false,
          status: 502,
          json: async () => ({
            no: "shape",
          }),
        }),
    );

    await expect(api.getDashboard()).rejects.toThrowError("Request failed with 503");
    await expect(api.getDashboard()).rejects.toThrowError("Request failed with 502");
  });

  it("throws a parse error when the response shape is wrong", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          partTypeCount: "not-a-number",
        }),
      }),
    );

    await expect(api.getDashboard()).rejects.toThrowError(ParseInputError);
  });

  it("builds a Zitadel login URL and leaves legacy token helpers inert", () => {
    expect(loginUrl("https://smartdb.example.com/app")).toBe(
      `${import.meta.env.VITE_API_BASE_URL ?? "http://localhost:4000"}/api/auth/login?returnTo=${encodeURIComponent("https://smartdb.example.com/app")}`,
    );
    setSessionToken("token-xyz");
    expect(hydrateSessionToken()).toBeNull();
    clearSessionToken();
    expect(hydrateSessionToken()).toBeNull();
  });

  it("builds qr batch pdf URLs", () => {
    expect(qrBatchLabelsPdfUrl("batch-123")).toBe(
      `${import.meta.env.VITE_API_BASE_URL ?? "http://localhost:4000"}/api/qr-batches/batch-123/labels.pdf`,
    );
  });

  it("passes explicit abort signals through search and session calls", async () => {
    const controller = new AbortController();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          username: "labeler",
          issuedAt: "2026-01-01T00:00:00.000Z",
          expiresAt: null,
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [],
      });
    vi.stubGlobal("fetch", fetch);

    await api.getSession(controller.signal);
    await api.searchPartTypes("arduino", controller.signal);

    expect(fetch.mock.calls[0]?.[1]?.signal).toBeDefined();
    expect(fetch.mock.calls[1]?.[1]?.signal).toBeDefined();
  });

  it("includes idempotency keys on mutation requests", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          batch: {
            id: "batch-1",
            prefix: "QR",
            startNumber: 1001,
            endNumber: 1002,
            actor: "labeler",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
          created: 2,
          skipped: 0,
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
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
        }),
      });
    vi.stubGlobal("fetch", fetch);

    await api.registerQrBatch({ prefix: "QR", startNumber: 1001, count: 2 });
    await api.recordEvent({
      targetType: "instance",
      targetId: "instance-1",
      event: "moved",
      location: "Shelf B",
      notes: null,
      nextStatus: "available",
      assignee: null,
    });

    expect(fetch.mock.calls[0]?.[1]?.headers?.["X-Idempotency-Key"]).toBeDefined();
    expect(fetch.mock.calls[1]?.[1]?.headers?.["X-Idempotency-Key"]).toBeDefined();
    expect(fetch.mock.calls[0]?.[1]?.headers?.["X-Idempotency-Key"]).not.toBe(
      fetch.mock.calls[1]?.[1]?.headers?.["X-Idempotency-Key"],
    );
  });

  it("includes a timeout signal even when caller provides no signal", async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        partTypeCount: 0,
        instanceCount: 0,
        bulkStockCount: 0,
        provisionalCount: 0,
        unassignedQrCount: 0,
        recentEvents: [],
      }),
    });
    vi.stubGlobal("fetch", fetch);

    await api.getDashboard();

    expect(fetch.mock.calls[0]?.[1]?.signal).toBeDefined();
  });
});
