import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IntegrationError, UnauthenticatedError } from "@smart-db/contracts";
import { decodeAuthRequest } from "./auth-cookies.js";
import { AuthService } from "./auth-service";
import { SessionStore } from "./session-store";
import { applyMigrations } from "../db/migrations.js";

describe("AuthService", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    applyMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  it("starts login with a signed auth request and authorization URL", async () => {
    const authorizationUrl = vi.fn(async () => "https://auth.example.com/login");
    const service = new AuthService(
      {
        authorizationUrl,
        exchangeAuthorizationCode: vi.fn(),
        logoutUrl: vi.fn(),
      } as never,
      new SessionStore(db),
      {
        frontendOrigin: "https://smartdb.example.com",
        redirectUri: "https://smartdb.example.com/api/auth/callback",
        sessionCookieSecret: "super-secret",
      },
    );

    const result = await service.startLogin("https://smartdb.example.com/app?tab=scan");
    const decoded = decodeAuthRequest(result.authRequest, "super-secret");

    expect(result.authorizationUrl).toBe("https://auth.example.com/login");
    expect(decoded).toMatchObject({
      returnTo: "https://smartdb.example.com/app?tab=scan",
    });
    expect(authorizationUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        redirectUri: "https://smartdb.example.com/api/auth/callback",
      }),
    );
  });

  it("normalizes external returnTo values back to the frontend origin", async () => {
    const service = new AuthService(
      {
        authorizationUrl: vi.fn(async () => "https://auth.example.com/login"),
        exchangeAuthorizationCode: vi.fn(),
        logoutUrl: vi.fn(),
      } as never,
      new SessionStore(db),
      {
        frontendOrigin: "https://smartdb.example.com",
        redirectUri: "https://smartdb.example.com/api/auth/callback",
        sessionCookieSecret: "super-secret",
      },
    );

    const result = await service.startLogin("https://evil.example.com/phish");
    expect(decodeAuthRequest(result.authRequest, "super-secret")).toMatchObject({
      returnTo: "https://smartdb.example.com/",
    });
  });

  it("rejects login start when the cookie secret is missing", async () => {
    const service = new AuthService(
      {
        authorizationUrl: vi.fn(),
        exchangeAuthorizationCode: vi.fn(),
        logoutUrl: vi.fn(),
      } as never,
      new SessionStore(db),
      {
        frontendOrigin: "https://smartdb.example.com",
        redirectUri: "https://smartdb.example.com/api/auth/callback",
        sessionCookieSecret: null,
      },
    );

    await expect(service.startLogin(null)).rejects.toThrowError(IntegrationError);
  });

  it("completes login and creates a session", async () => {
    const exchangeAuthorizationCode = vi.fn(async () => ({
      subject: "zitadel-user-1",
      username: "labeler",
      name: "Labeler User",
      email: "labeler@example.com",
      roles: ["smartdb.labeler"],
      idToken: "id-token",
      expiresAt: "2030-04-02T00:00:00.000Z",
    }));
    const service = new AuthService(
      {
        authorizationUrl: vi.fn(async () => "https://auth.example.com/login"),
        exchangeAuthorizationCode,
        logoutUrl: vi.fn(async () => "https://auth.example.com/logout"),
      } as never,
      new SessionStore(db),
      {
        frontendOrigin: "https://smartdb.example.com",
        redirectUri: "https://smartdb.example.com/api/auth/callback",
        sessionCookieSecret: "super-secret",
      },
    );

    const started = await service.startLogin("https://smartdb.example.com/app");
    const authRequest = decodeAuthRequest(started.authRequest, "super-secret");
    if (!authRequest) {
      throw new Error("auth request was not decodable");
    }

    const completed = await service.completeLogin(
      {
        code: "auth-code",
        state: authRequest.state,
      },
      started.authRequest,
    );

    expect(completed.redirectTo).toBe("https://smartdb.example.com/app");
    expect(completed.session).toMatchObject({
      subject: "zitadel-user-1",
      username: "labeler",
      roles: ["smartdb.admin", "smartdb.labeler"],
    });
    expect(service.getSession(completed.sessionId)).toMatchObject({
      username: "labeler",
    });
    expect(exchangeAuthorizationCode).toHaveBeenCalledWith(
      "auth-code",
      authRequest.codeVerifier,
      "https://smartdb.example.com/api/auth/callback",
      authRequest.nonce,
    );
  });

  it("returns and deletes sessions on logout", async () => {
    const logoutUrl = vi.fn(async (idTokenHint: string | null) =>
      idTokenHint ? "https://auth.example.com/logout" : null,
    );
    const store = new SessionStore(db);
    const service = new AuthService(
      {
        authorizationUrl: vi.fn(async () => "https://auth.example.com/login"),
        exchangeAuthorizationCode: vi.fn(),
        logoutUrl,
      } as never,
      store,
      {
        frontendOrigin: "https://smartdb.example.com",
        redirectUri: "https://smartdb.example.com/api/auth/callback",
        sessionCookieSecret: "super-secret",
      },
    );
    const stored = store.create({
      subject: "zitadel-user-1",
      username: "labeler",
      name: null,
      email: null,
      roles: [],
      expiresAt: "2030-04-02T00:00:00.000Z",
      idToken: "id-token",
    });

    expect(service.getSession(stored.id)).toMatchObject({ username: "labeler" });
    await expect(service.logout(stored.id)).resolves.toEqual({
      redirectUrl: "https://auth.example.com/logout",
    });
    expect(service.getSession(stored.id)).toBeNull();
    expect(logoutUrl).toHaveBeenCalledWith("id-token");
  });

  it("still completes logout when the identity provider's logoutUrl throws", async () => {
    const logoutUrl = vi.fn(async () => {
      throw new Error("discovery fetch failed");
    });
    const store = new SessionStore(db);
    const service = new AuthService(
      {
        authorizationUrl: vi.fn(async () => "https://auth.example.com/login"),
        exchangeAuthorizationCode: vi.fn(),
        logoutUrl,
      } as never,
      store,
      {
        frontendOrigin: "https://smartdb.example.com",
        redirectUri: "https://smartdb.example.com/api/auth/callback",
        sessionCookieSecret: "super-secret",
      },
    );
    const stored = store.create({
      subject: "zitadel-user-2",
      username: "maker",
      name: null,
      email: null,
      roles: [],
      expiresAt: "2030-04-02T00:00:00.000Z",
      idToken: "id-token-2",
    });

    await expect(service.logout(stored.id)).resolves.toEqual({ redirectUrl: null });
    // The local session is gone regardless of IdP availability.
    expect(service.getSession(stored.id)).toBeNull();
  });

  it("rejects invalid callback state", async () => {
    const service = new AuthService(
      {
        authorizationUrl: vi.fn(async () => "https://auth.example.com/login"),
        exchangeAuthorizationCode: vi.fn(),
        logoutUrl: vi.fn(),
      } as never,
      new SessionStore(db),
      {
        frontendOrigin: "https://smartdb.example.com",
        redirectUri: "https://smartdb.example.com/api/auth/callback",
        sessionCookieSecret: "super-secret",
      },
    );

    const started = await service.startLogin("https://smartdb.example.com/app");
    await expect(service.completeLogin(
      {
        code: "auth-code",
        state: "wrong-state",
      },
      started.authRequest,
    )).rejects.toThrowError(UnauthenticatedError);
  });

  it("rejects stale callback state even if the cookie is otherwise valid", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const service = new AuthService(
      {
        authorizationUrl: vi.fn(async () => "https://auth.example.com/login"),
        exchangeAuthorizationCode: vi.fn(),
        logoutUrl: vi.fn(),
      } as never,
      new SessionStore(db),
      {
        frontendOrigin: "https://smartdb.example.com",
        redirectUri: "https://smartdb.example.com/api/auth/callback",
        sessionCookieSecret: "super-secret",
      },
    );

    const started = await service.startLogin("https://smartdb.example.com/app");
    const authRequest = decodeAuthRequest(started.authRequest, "super-secret");
    if (!authRequest) {
      throw new Error("auth request was not decodable");
    }

    vi.setSystemTime(new Date("2026-01-01T00:11:00.000Z"));
    await expect(service.completeLogin(
      {
        code: "auth-code",
        state: authRequest.state,
      },
      started.authRequest,
    )).rejects.toThrowError("Authentication request expired before callback completed.");
    vi.useRealTimers();
  });
});
