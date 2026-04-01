import { afterEach, describe, expect, it, vi } from "vitest";
import { UnauthenticatedError } from "@smart-db/contracts";
import { AuthService } from "./auth-service";
import { AuthTokenCache } from "./auth-token-cache";

afterEach(() => {
  vi.useRealTimers();
});

describe("AuthService", () => {
  it("authenticates a Part-DB API token through the PartDbClient", async () => {
    const service = new AuthService({
      authenticate: vi.fn(async () => ({
        username: "labeler",
        issuedAt: "2026-01-01T00:00:00.000Z",
        expiresAt: null,
      })),
    } as never);

    await expect(service.authenticateApiToken("token-123")).resolves.toEqual({
      username: "labeler",
      issuedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: null,
    });
  });

  it("extracts bearer tokens and rejects missing or malformed headers", () => {
    const service = new AuthService({ authenticate: vi.fn() } as never);

    expect(service.extractBearerToken("Bearer token-123")).toBe("token-123");
    expect(() => service.extractBearerToken(undefined)).toThrowError(UnauthenticatedError);
    expect(() => service.extractBearerToken("Basic nope")).toThrowError(UnauthenticatedError);
    expect(() => service.extractBearerToken("Bearer ")).toThrowError(UnauthenticatedError);
  });

  it("returns cached session on cache hit without calling Part-DB", async () => {
    const authenticate = vi.fn(async () => ({
      username: "labeler",
      issuedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: null,
    }));
    const service = new AuthService({ authenticate } as never);

    await service.authenticateApiToken("token-cached");
    await service.authenticateApiToken("token-cached");

    expect(authenticate).toHaveBeenCalledTimes(1);
  });

  it("does not fall back once a cached token has expired and Part-DB fails", async () => {
    vi.useFakeTimers();
    const session = {
      username: "labeler",
      issuedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: null,
    };
    const authenticate = vi
      .fn()
      .mockResolvedValueOnce(session)
      .mockRejectedValueOnce(new Error("Part-DB is down"));
    const cache = new AuthTokenCache(100);
    const service = new AuthService({ authenticate } as never, cache);

    await service.authenticateApiToken("token-stale");
    vi.advanceTimersByTime(200);

    await expect(service.authenticateApiToken("token-stale")).rejects.toThrowError(
      "Part-DB is down",
    );
  });

  it("rejects stale cache when Part-DB explicitly rejects the token", async () => {
    vi.useFakeTimers();
    const session = {
      username: "labeler",
      issuedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: null,
    };
    const authenticate = vi
      .fn()
      .mockResolvedValueOnce(session)
      .mockRejectedValueOnce(new UnauthenticatedError("Part-DB rejected the token (401)."));
    const cache = new AuthTokenCache(100);
    const service = new AuthService({ authenticate } as never, cache);

    await service.authenticateApiToken("token-revoked");
    vi.advanceTimersByTime(200);

    await expect(service.authenticateApiToken("token-revoked")).rejects.toThrowError(
      "Part-DB rejected the token (401).",
    );
    expect(cache.get(AuthTokenCache.hashToken("token-revoked"))).toBeNull();
  });

  it("throws when cache is empty and Part-DB fails", async () => {
    const authenticate = vi.fn().mockRejectedValue(new Error("Part-DB is down"));
    const service = new AuthService({ authenticate } as never);

    await expect(service.authenticateApiToken("token-new")).rejects.toThrowError("Part-DB is down");
  });
});
