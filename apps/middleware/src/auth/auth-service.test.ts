import { afterEach, describe, expect, it, vi } from "vitest";
import { UnauthenticatedError } from "@smart-db/contracts";
import { AuthService } from "./auth-service";

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

  it("revalidates every request against Part-DB", async () => {
    const authenticate = vi.fn(async () => ({
      username: "labeler",
      issuedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: null,
    }));
    const service = new AuthService({ authenticate } as never);

    await service.authenticateApiToken("token-cached");
    await service.authenticateApiToken("token-cached");

    expect(authenticate).toHaveBeenCalledTimes(2);
  });

  it("propagates upstream failures after a prior successful validation", async () => {
    const session = {
      username: "labeler",
      issuedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: null,
    };
    const authenticate = vi
      .fn()
      .mockResolvedValueOnce(session)
      .mockRejectedValueOnce(new Error("Part-DB is down"));
    const service = new AuthService({ authenticate } as never);

    await service.authenticateApiToken("token-stale");

    await expect(service.authenticateApiToken("token-stale")).rejects.toThrowError(
      "Part-DB is down",
    );
  });

  it("propagates explicit token rejection from Part-DB", async () => {
    const authenticate = vi
      .fn()
      .mockRejectedValueOnce(new UnauthenticatedError("Part-DB rejected the token (401)."));
    const service = new AuthService({ authenticate } as never);

    await expect(service.authenticateApiToken("token-revoked")).rejects.toThrowError(
      "Part-DB rejected the token (401).",
    );
  });

  it("throws when cache is empty and Part-DB fails", async () => {
    const authenticate = vi.fn().mockRejectedValue(new Error("Part-DB is down"));
    const service = new AuthService({ authenticate } as never);

    await expect(service.authenticateApiToken("token-new")).rejects.toThrowError("Part-DB is down");
  });
});
