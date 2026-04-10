import { afterEach, describe, expect, it, vi } from "vitest";
import { PartDbRestClient } from "./partdb-rest.js";
import { partDbCategoryResponseSchema } from "./partdb-schemas.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("PartDbRestClient", () => {
  it("parses successful JSON responses into Ok results", async () => {
    const client = new PartDbRestClient({
      baseUrl: "https://partdb.example.com",
      apiToken: "token-123",
      timeoutMs: 1000,
      retry: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 200,
        ok: true,
        json: async () => ({
          "@id": "/api/categories/42",
          id: 42,
          name: "SMD",
        }),
      }),
    );

    await expect(
      client.getJson("/api/categories/42", partDbCategoryResponseSchema, {
        resource: "category",
        identifier: "42",
      }),
    ).resolves.toEqual({
      ok: true,
      value: {
        "@id": "/api/categories/42",
        id: 42,
        name: "SMD",
      },
    });
  });

  it("classifies authorization and validation failures", async () => {
    const client = new PartDbRestClient({
      baseUrl: "https://partdb.example.com",
      apiToken: "token-123",
      timeoutMs: 1000,
      retry: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce({
          status: 401,
          ok: false,
          clone() {
            return this;
          },
          json: async () => ({ title: "Unauthorized" }),
          text: async () => "",
          headers: new Headers(),
        })
        .mockResolvedValueOnce({
          status: 422,
          ok: false,
          clone() {
            return this;
          },
          json: async () => ({
            violations: [{ propertyPath: "name", message: "Required" }],
          }),
          text: async () => "",
          headers: new Headers(),
        }),
    );

    const unauthorized = await client.getJson("/api/categories/42", partDbCategoryResponseSchema, {
      resource: "category",
      identifier: "42",
    });
    expect(unauthorized).toMatchObject({
      ok: false,
      error: { kind: "unauthorized", httpStatus: 401 },
    });

    const validation = await client.getJson("/api/categories", partDbCategoryResponseSchema.array(), {
      resource: "category",
    });
    expect(validation).toMatchObject({
      ok: false,
      error: {
        kind: "validation",
        httpStatus: 422,
        violations: [{ propertyPath: "name", message: "Required" }],
      },
    });
  });

  it("classifies rate limiting, schema mismatch, and network failures", async () => {
    const client = new PartDbRestClient({
      baseUrl: "https://partdb.example.com",
      apiToken: "token-123",
      timeoutMs: 1000,
      retry: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce({
          status: 429,
          ok: false,
          clone() {
            return this;
          },
          json: async () => ({}),
          text: async () => "",
          headers: new Headers({ "retry-after": "2" }),
        })
        .mockResolvedValueOnce({
          status: 200,
          ok: true,
          json: async () => ({ id: "not-an-int" }),
        })
        .mockRejectedValueOnce(new TypeError("fetch failed")),
    );

    const rateLimited = await client.getJson("/api/categories", partDbCategoryResponseSchema.array(), {
      resource: "category",
    });
    expect(rateLimited).toMatchObject({
      ok: false,
      error: { kind: "rate_limited", retryAfterMs: 2000 },
    });

    const mismatched = await client.getJson("/api/categories/42", partDbCategoryResponseSchema, {
      resource: "category",
      identifier: "42",
    });
    expect(mismatched).toMatchObject({
      ok: false,
      error: { kind: "schema_mismatch" },
    });

    const network = await client.getJson("/api/categories/42", partDbCategoryResponseSchema, {
      resource: "category",
      identifier: "42",
    });
    expect(network).toMatchObject({
      ok: false,
      error: { kind: "network", retryable: true },
    });
  });
});
