import { randomBytes } from "node:crypto";
import { IntegrationError, UnauthenticatedError, type AuthSession } from "@smart-db/contracts";
import {
  decodeAuthRequest,
  encodeAuthRequest,
  normalizeReturnTo,
  type AuthRequestState,
} from "./auth-cookies.js";
import { SessionStore } from "./session-store.js";
import type { ExchangedIdentity } from "./zitadel-client.js";

interface IdentityProvider {
  authorizationUrl(request: {
    state: string;
    nonce: string;
    codeVerifier: string;
    redirectUri: string;
  }): Promise<string>;
  exchangeAuthorizationCode(
    code: string,
    codeVerifier: string,
    redirectUri: string,
    expectedNonce: string,
  ): Promise<ExchangedIdentity>;
  logoutUrl(idTokenHint: string | null): Promise<string | null>;
}

interface AuthServiceOptions {
  frontendOrigin: string;
  redirectUri: string;
  sessionCookieSecret: string | null;
}

interface LoginStartResult {
  authorizationUrl: string;
  authRequest: string;
}

interface LoginCompletionResult {
  sessionId: string;
  session: AuthSession;
  redirectTo: string;
}

interface LogoutResult {
  redirectUrl: string | null;
}

const authRequestTtlMs = 10 * 60 * 1000;

export class AuthService {
  constructor(
    private readonly identityProvider: IdentityProvider,
    private readonly sessions: SessionStore,
    private readonly options: AuthServiceOptions,
  ) {}

  async startLogin(returnTo: string | null | undefined): Promise<LoginStartResult> {
    const authRequest = {
      state: randomToken(),
      nonce: randomToken(),
      codeVerifier: randomToken(48),
      returnTo: normalizeReturnTo(returnTo, this.options.frontendOrigin),
      createdAt: new Date().toISOString(),
    } satisfies AuthRequestState;

    return {
      authorizationUrl: await this.identityProvider.authorizationUrl({
        state: authRequest.state,
        nonce: authRequest.nonce,
        codeVerifier: authRequest.codeVerifier,
        redirectUri: this.options.redirectUri,
      }),
      authRequest: encodeAuthRequest(authRequest, this.requireSecret()),
    };
  }

  async completeLogin(
    query: { code?: string; state?: string },
    encodedAuthRequest: string | undefined,
  ): Promise<LoginCompletionResult> {
    const code = query.code?.trim();
    const state = query.state?.trim();
    if (!code || !state) {
      throw new UnauthenticatedError("Authorization callback was incomplete.");
    }

    const authRequest = decodeAuthRequest(encodedAuthRequest, this.requireSecret());
    if (!authRequest) {
      throw new UnauthenticatedError("Authentication request could not be verified.");
    }

    if (authRequest.state !== state) {
      throw new UnauthenticatedError("Authentication state did not match.");
    }

    if (Date.now() - Date.parse(authRequest.createdAt) > authRequestTtlMs) {
      throw new UnauthenticatedError("Authentication request expired before callback completed.");
    }

    const identity = await this.identityProvider.exchangeAuthorizationCode(
      code,
      authRequest.codeVerifier,
      this.options.redirectUri,
      authRequest.nonce,
    );

    const sessionRecord = this.sessions.create({
      subject: identity.subject,
      username: identity.username,
      name: identity.name,
      email: identity.email,
      roles: identity.roles,
      expiresAt: identity.expiresAt,
      idToken: identity.idToken,
    });

    return {
      sessionId: sessionRecord.id,
      session: sessionRecord.session,
      redirectTo: authRequest.returnTo,
    };
  }

  getSession(sessionId: string | undefined): AuthSession | null {
    if (!sessionId) {
      return null;
    }

    return this.sessions.get(sessionId)?.session ?? null;
  }

  async logout(sessionId: string | undefined): Promise<LogoutResult> {
    if (!sessionId) {
      return { redirectUrl: null };
    }

    const existing = this.sessions.get(sessionId);
    this.sessions.delete(sessionId);

    // Building the Zitadel end-session URL requires the OIDC discovery doc.
    // If Zitadel is unreachable, misconfigured, or its discovery endpoint
    // errors out, we still want logout to succeed: the local session is
    // already deleted, the HTTP cookie is about to be cleared by the route
    // handler, and the user has no way to reauth against a broken IDP
    // anyway. Surface null redirectUrl on any failure; the client's
    // handleLogout already falls back to resetAuthenticatedView when
    // redirectUrl is empty.
    let redirectUrl: string | null = null;
    try {
      redirectUrl = await this.identityProvider.logoutUrl(existing?.idToken ?? null);
    } catch {
      redirectUrl = null;
    }
    return { redirectUrl };
  }

  private requireSecret(): string {
    if (!this.options.sessionCookieSecret) {
      throw new IntegrationError("Auth", "session cookie secret is not configured.");
    }

    return this.options.sessionCookieSecret;
  }
}

function randomToken(bytes: number = 32): string {
  return randomBytes(bytes).toString("base64url");
}
