// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

describe("frontend api helpers in node", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("treats the token store as empty when window is unavailable", async () => {
    const apiModule = await import("./api");

    expect(apiModule.hydrateSessionToken()).toBeNull();
    apiModule.clearSessionToken();
    expect(apiModule.hydrateSessionToken()).toBeNull();
  });

  it("makes unauthenticated node requests without a browser token and passes scan abort signals", async () => {
    const apiModule = await import("./api");
    const controller = new AbortController();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          partTypeCount: 1,
          instanceCount: 1,
          bulkStockCount: 0,
          provisionalCount: 0,
          unassignedQrCount: 0,
          recentEvents: [],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          mode: "unknown",
          code: "QR-1",
          partDb: {
            configured: false,
            connected: false,
            message: "Not configured",
          },
        }),
      });
    vi.stubGlobal("fetch", fetch);

    await apiModule.api.getDashboard();
    await apiModule.api.scan("QR-1", { signal: controller.signal });

    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      headers: expect.not.objectContaining({
        Authorization: expect.any(String),
      }),
    });
    expect(fetch.mock.calls[0]?.[1]?.signal).toBeDefined();
    expect(fetch.mock.calls[1]?.[1]?.signal).toBeDefined();
  });
});
