import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthSession } from "@smart-db/contracts";
import { AuthTokenCache } from "./auth-token-cache";

const session: AuthSession = {
  username: "labeler",
  issuedAt: "2026-01-01T00:00:00.000Z",
  expiresAt: null,
};

afterEach(() => {
  vi.useRealTimers();
});

describe("AuthTokenCache", () => {
  it("returns a cached session within TTL and null after TTL expires", () => {
    vi.useFakeTimers();
    const cache = new AuthTokenCache(1000);
    const hash = AuthTokenCache.hashToken("token-abc");

    expect(cache.get(hash)).toBeNull();

    cache.set(hash, session);
    expect(cache.get(hash)).toEqual(session);

    vi.advanceTimersByTime(1001);
    expect(cache.get(hash)).toBeNull();
  });

  it("produces consistent hashes for the same token", () => {
    const hash1 = AuthTokenCache.hashToken("token-xyz");
    const hash2 = AuthTokenCache.hashToken("token-xyz");
    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(64);
  });
});
