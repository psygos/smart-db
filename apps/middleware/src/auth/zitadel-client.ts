import { createHash, randomBytes } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { IntegrationError } from "@smart-db/contracts";

interface ZitadelClientConfig {
  issuer: string | null;
  clientId: string | null;
  clientSecret?: string | null;
  roleClaim?: string | null;
}

interface OidcDiscoveryDocument {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  end_session_endpoint?: string;
}

export interface AuthorizationRequest {
  state: string;
  nonce: string;
  codeVerifier: string;
  redirectUri: string;
  scopes?: string[];
}

export interface ExchangedIdentity {
  subject: string;
  username: string;
  name: string | null;
  email: string | null;
  roles: string[];
  idToken: string;
  expiresAt: string | null;
}

interface TokenResponse {
  id_token?: string;
}

export class ZitadelClient {
  private discoveryPromise: Promise<OidcDiscoveryDocument> | null = null;

  constructor(private readonly config: ZitadelClientConfig) {}

  async authorizationUrl(request: AuthorizationRequest): Promise<string> {
    const discovery = await this.discovery();
    const scopes = request.scopes?.length ? request.scopes : ["openid", "profile", "email"];
    const url = new URL(discovery.authorization_endpoint);
    url.searchParams.set("client_id", this.required("clientId"));
    url.searchParams.set("redirect_uri", request.redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", scopes.join(" "));
    url.searchParams.set("state", request.state);
    url.searchParams.set("nonce", request.nonce);
    url.searchParams.set("code_challenge", codeChallenge(request.codeVerifier));
    url.searchParams.set("code_challenge_method", "S256");
    return url.toString();
  }

  async exchangeAuthorizationCode(
    code: string,
    codeVerifier: string,
    redirectUri: string,
    expectedNonce: string,
  ): Promise<ExchangedIdentity> {
    const discovery = await this.discovery();
    const response = await fetch(discovery.token_endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: this.required("clientId"),
        ...(this.config.clientSecret ? { client_secret: this.config.clientSecret } : {}),
        code,
        redirect_uri: redirectUri,
        code_verifier: codeVerifier,
      }),
    }).catch((error) => {
      throw new IntegrationError(
        "Zitadel",
        error instanceof Error ? error.message : "Failed to exchange authorization code.",
      );
    });

    if (!response.ok) {
      throw new IntegrationError("Zitadel", `token exchange failed (${response.status}).`);
    }

    const payload = await response.json() as TokenResponse;
    if (!payload.id_token) {
      throw new IntegrationError("Zitadel", "token response did not contain an id_token.");
    }

    return this.verifyIdToken(payload.id_token, expectedNonce, discovery);
  }

  async logoutUrl(idTokenHint: string | null): Promise<string | null> {
    if (!idTokenHint) {
      return null;
    }

    const discovery = await this.discovery();
    if (!discovery.end_session_endpoint) {
      return null;
    }

    const url = new URL(discovery.end_session_endpoint);
    url.searchParams.set("id_token_hint", idTokenHint);
    return url.toString();
  }

  static randomToken(bytes: number = 32): string {
    return randomBytes(bytes).toString("base64url");
  }

  private async verifyIdToken(
    idToken: string,
    expectedNonce: string,
    discovery: OidcDiscoveryDocument,
  ): Promise<ExchangedIdentity> {
    const jwks = createRemoteJWKSet(new URL(discovery.jwks_uri));
    const verification = await jwtVerify(idToken, jwks, {
      issuer: discovery.issuer,
      audience: this.required("clientId"),
    }).catch((error) => {
      throw new IntegrationError(
        "Zitadel",
        error instanceof Error ? error.message : "Failed to verify id token.",
      );
    });

    if (verification.payload.nonce !== expectedNonce) {
      throw new IntegrationError("Zitadel", "id token nonce did not match the authorization request.");
    }

    return mapIdentity(verification.payload, this.config.roleClaim, idToken);
  }

  private async discovery(): Promise<OidcDiscoveryDocument> {
    if (!this.discoveryPromise) {
      const issuer = this.required("issuer").replace(/\/$/, "");
      this.discoveryPromise = fetch(`${issuer}/.well-known/openid-configuration`)
        .then(async (response) => {
          if (!response.ok) {
            throw new IntegrationError("Zitadel", `discovery failed (${response.status}).`);
          }
          return response.json() as Promise<OidcDiscoveryDocument>;
        })
        .catch((error) => {
          this.discoveryPromise = null;
          throw new IntegrationError(
            "Zitadel",
            error instanceof Error ? error.message : "Failed to fetch discovery document.",
          );
        });
    }

    return this.discoveryPromise;
  }

  private required(key: "issuer" | "clientId"): string {
    const value = this.config[key];
    if (!value) {
      throw new IntegrationError("Zitadel", `${key} is not configured.`);
    }

    return value;
  }
}

export const zitadelClientInternals = {
  codeChallenge,
  extractRoles,
};

function codeChallenge(codeVerifier: string): string {
  return createHash("sha256").update(codeVerifier).digest("base64url");
}

function mapIdentity(payload: JWTPayload, roleClaim: string | null | undefined, idToken: string): ExchangedIdentity {
  const subject = typeof payload.sub === "string" ? payload.sub : null;
  if (!subject) {
    throw new IntegrationError("Zitadel", "id token did not contain a subject.");
  }

  const username = firstString(payload.preferred_username, payload.email, payload.sub);
  const expiresAt =
    typeof payload.exp === "number"
      ? new Date(payload.exp * 1000).toISOString()
      : null;

  return {
    subject,
    username,
    name: typeof payload.name === "string" ? payload.name : null,
    email: typeof payload.email === "string" ? payload.email : null,
    roles: extractRoles(payload, roleClaim),
    idToken,
    expiresAt,
  };
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }

  throw new IntegrationError("Zitadel", "id token did not contain a usable username.");
}

function extractRoles(payload: JWTPayload, roleClaim: string | null | undefined): string[] {
  if (!roleClaim) {
    return [];
  }

  const raw = payload[roleClaim];
  if (!raw) {
    return [];
  }

  if (Array.isArray(raw)) {
    return Array.from(new Set(raw.flatMap(extractRolesFromArrayItem))).sort((left, right) =>
      left.localeCompare(right),
    );
  }

  if (typeof raw === "object") {
    return Object.keys(raw as Record<string, unknown>).sort((left, right) => left.localeCompare(right));
  }

  if (typeof raw === "string") {
    return [raw];
  }

  return [];
}

function extractRolesFromArrayItem(item: unknown): string[] {
  if (typeof item === "string") {
    return [item];
  }

  if (item && typeof item === "object") {
    return Object.keys(item as Record<string, unknown>);
  }

  return [];
}
