import { afterEach, describe, expect, it, vi } from "vitest";
import { PartDbClient } from "./partdb-client";

const noRetry = { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 };

describe("PartDbClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports an unconfigured status when credentials are missing", async () => {
    const client = new PartDbClient({
      baseUrl: null,
    });

    await expect(client.getConnectionStatus("token")).resolves.toEqual({
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
    });
  });

  it("requires a token when the Part-DB base URL is configured", async () => {
    const client = new PartDbClient({
      baseUrl: "https://partdb.example.com",
      retry: noRetry,
    });

    await expect(client.getConnectionStatus(null)).rejects.toThrowError(
      "Authentication is required.",
    );
  });

  it("discovers token and resource paths on a healthy connection", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          name: "lab token",
          owner: {
            username: "makerspace",
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          paths: {
            "/api/parts": {},
            "/api/part_lots": {},
            "/api/storage_locations": {},
          },
        }),
      });
    vi.stubGlobal("fetch", fetch);

    const client = new PartDbClient({
      baseUrl: "https://partdb.example.com/",
      retry: noRetry,
    });

    await expect(client.getConnectionStatus("secret")).resolves.toEqual({
      configured: true,
      connected: true,
      baseUrl: "https://partdb.example.com",
      tokenLabel: "lab token",
      userLabel: "makerspace",
      message: "Part-DB connection looks healthy.",
      discoveredResources: {
        tokenInfoPath: "/api/tokens/current",
        openApiPath: "/api/docs.json",
        partsPath: "/api/parts",
        partLotsPath: "/api/part_lots",
        storageLocationsPath: "/api/storage_locations",
      },
    });

    expect(fetch).toHaveBeenNthCalledWith(
      1,
      "https://partdb.example.com/api/tokens/current",
      expect.objectContaining({
        headers: expect.objectContaining({
          Accept: "application/json",
          Authorization: "Bearer secret",
        }),
      }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      "https://partdb.example.com/api/docs.json",
      expect.objectContaining({
        headers: expect.objectContaining({
          Accept: "application/vnd.openapi+json",
          Authorization: "Bearer secret",
        }),
      }),
    );
  });

  it("handles owner-less tokens and empty docs payloads", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          name: 42,
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({}),
      });
    vi.stubGlobal("fetch", fetch);

    const client = new PartDbClient({
      baseUrl: "https://partdb.example.com",
      retry: noRetry,
    });

    await expect(client.getConnectionStatus("secret")).resolves.toMatchObject({
      configured: true,
      connected: true,
      tokenLabel: null,
      userLabel: null,
      discoveredResources: {
        partsPath: null,
      },
    });
  });

  it("surfaces rejected tokens and docs lookup gaps without throwing", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue({
        ok: false,
        status: 401,
        json: async () => ({}),
      });
    vi.stubGlobal("fetch", fetch);

    const clientForStatus = new PartDbClient({
      baseUrl: "https://partdb.example.com",
      retry: noRetry,
    });

    await expect(clientForStatus.getConnectionStatus("bad-token")).rejects.toThrowError(
      "Part-DB rejected the token (401).",
    );

    const clientForLookup = new PartDbClient({
      baseUrl: "https://partdb.example.com",
      retry: noRetry,
    });

    await expect(clientForLookup.getLookupSummary("bad-token")).rejects.toThrowError(
      "Part-DB rejected the token (401).",
    );
  });

  it("converts fetch failures into a disconnected status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network down")),
    );

    const client = new PartDbClient({
      baseUrl: "https://partdb.example.com",
      retry: noRetry,
    });

    await expect(client.getConnectionStatus("secret")).resolves.toMatchObject({
      configured: true,
      connected: false,
      message: "Failed to reach Part-DB: network down",
    });
  });

  it("handles non-Error fetch failures", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue("boom"));

    const client = new PartDbClient({
      baseUrl: "https://partdb.example.com",
      retry: noRetry,
    });

    await expect(client.getConnectionStatus("secret")).resolves.toMatchObject({
      configured: true,
      connected: false,
      message: "Failed to reach Part-DB.",
    });
  });

  it("can publish a different user-facing Part-DB URL than the internal upstream URL", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          name: "lab token",
          owner: {
            username: "makerspace",
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          paths: {},
        }),
      });
    vi.stubGlobal("fetch", fetch);

    const client = new PartDbClient({
      baseUrl: "http://partdb:80",
      publicBaseUrl: "https://inventory.example.com:8443/",
      retry: noRetry,
    });

    await expect(client.getConnectionStatus("secret")).resolves.toMatchObject({
      configured: true,
      connected: true,
      baseUrl: "https://inventory.example.com:8443",
    });
  });

  it("prefers collection endpoints over nested subresources during discovery", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          owner: {
            username: "makerspace",
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          paths: {
            "/api/parts/{id}/orderdetails": {},
            "/api/storage_locations/{id}/children": {},
            "/api/parts": {},
            "/api/storage_locations": {},
            "/api/part_lots": {},
          },
        }),
      });
    vi.stubGlobal("fetch", fetch);

    const client = new PartDbClient({
      baseUrl: "https://partdb.example.com",
      retry: noRetry,
    });

    await expect(client.getConnectionStatus("secret")).resolves.toMatchObject({
      discoveredResources: {
        partsPath: "/api/parts",
        partLotsPath: "/api/part_lots",
        storageLocationsPath: "/api/storage_locations",
      },
    });
  });

  it("rejects authentication when Part-DB is not configured or the token owner is missing", async () => {
    const unconfiguredClient = new PartDbClient({
      baseUrl: null,
    });
    await expect(unconfiguredClient.authenticate("token")).rejects.toThrowError(
      "base URL is not configured",
    );

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          name: "token without owner",
        }),
      }),
    );

    const client = new PartDbClient({
      baseUrl: "https://partdb.example.com",
      retry: noRetry,
    });
    await expect(client.authenticate("token")).rejects.toThrowError(
      "token owner could not be determined",
    );
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: async () => ({}),
      }),
    );
    await expect(client.authenticate("bad-token")).rejects.toThrowError(
      "Part-DB rejected the token (401).",
    );
    expect(() => (unconfiguredClient as { normalizedBaseUrl: () => string }).normalizedBaseUrl()).toThrowError(
      "base URL is not configured",
    );
  });

  it("does not retry authenticate calls when token validation transport fails", async () => {
    const fetch = vi.fn().mockRejectedValue(new Error("fetch failed"));
    vi.stubGlobal("fetch", fetch);

    const client = new PartDbClient({
      baseUrl: "https://partdb.example.com",
      retry: {
        maxAttempts: 3,
        baseDelayMs: 0,
        maxDelayMs: 0,
      },
    });

    await expect(client.authenticate("secret")).rejects.toThrowError("fetch failed");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("returns lookup summaries and wraps authenticate fetch failures", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          name: "labeler token",
          owner: {
            username: "labeler",
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          paths: {},
        }),
      })
      .mockRejectedValueOnce(new Error("offline"));
    vi.stubGlobal("fetch", fetch);

    const client = new PartDbClient({
      baseUrl: "https://partdb.example.com",
      retry: noRetry,
    });

    await expect(client.getLookupSummary("token")).resolves.toEqual({
      configured: true,
      connected: true,
      message: "Part-DB connection looks healthy.",
    });
    await expect(client.authenticate("token")).rejects.toThrowError("offline");
  });

  it("uses owner.name as a fallback username and wraps non-Error authenticate failures", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          owner: {
            name: "Labeler Name",
          },
        }),
      })
      .mockRejectedValueOnce("boom");
    vi.stubGlobal("fetch", fetch);

    const client = new PartDbClient({
      baseUrl: "https://partdb.example.com",
      retry: noRetry,
    });

    await expect(client.authenticate("good-token")).resolves.toMatchObject({
      username: "Labeler Name",
    });
    await expect(client.authenticate("bad-token")).rejects.toThrowError(
      "Failed to reach Part-DB.",
    );
  });

  it("retries transient fetch failures before giving up on connection status", async () => {
    let callCount = 0;
    const fetch = vi.fn(async () => {
      callCount += 1;
      if (callCount <= 2) {
        throw new TypeError("fetch failed");
      }
      if (callCount === 3) {
        return {
          ok: true,
          json: async () => ({
            name: "retry token",
            owner: { username: "retrier" },
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({ paths: {} }),
      };
    });
    vi.stubGlobal("fetch", fetch);

    const client = new PartDbClient({
      baseUrl: "https://partdb.example.com",
      retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 },
    });

    await expect(client.getConnectionStatus("token")).resolves.toMatchObject({
      configured: true,
      connected: true,
      tokenLabel: "retry token",
    });
    expect(fetch).toHaveBeenCalledTimes(4);
  });
});
