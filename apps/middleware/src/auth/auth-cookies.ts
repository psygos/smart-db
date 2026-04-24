import { createHmac, timingSafeEqual } from "node:crypto";
import type { CookieSerializeOptions } from "@fastify/cookie";

export interface AuthRequestState {
  state: string;
  nonce: string;
  codeVerifier: string;
  returnTo: string;
  createdAt: string;
}

export const authRequestCookieName = "smartdb_auth_request";

export function encodeAuthRequest(state: AuthRequestState, secret: string): string {
  const payload = Buffer.from(JSON.stringify(state)).toString("base64url");
  const signature = sign(payload, secret);
  return `${payload}.${signature}`;
}

export function decodeAuthRequest(value: string | undefined, secret: string): AuthRequestState | null {
  if (!value) {
    return null;
  }

  const [payload, signature] = value.split(".");
  if (!payload || !signature || !verify(payload, signature, secret)) {
    return null;
  }

  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Partial<AuthRequestState>;
    if (
      typeof parsed.state !== "string" ||
      typeof parsed.nonce !== "string" ||
      typeof parsed.codeVerifier !== "string" ||
      typeof parsed.returnTo !== "string" ||
      typeof parsed.createdAt !== "string"
    ) {
      return null;
    }

    return parsed as AuthRequestState;
  } catch {
    return null;
  }
}

export function normalizeReturnTo(candidate: string | null | undefined, frontendOrigin: string): string {
  const fallback = new URL(frontendOrigin);

  if (!candidate) {
    return fallback.toString();
  }

  try {
    const url = new URL(candidate, frontendOrigin);
    if (url.origin !== fallback.origin) {
      return fallback.toString();
    }
    url.searchParams.delete("authError");
    return url.toString();
  } catch {
    return fallback.toString();
  }
}

export function sessionCookieOptions(
  publicBaseUrl: string,
  expiresAt: string | null,
): CookieSerializeOptions {
  const options: CookieSerializeOptions = {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: isSecure(publicBaseUrl),
  };

  if (expiresAt) {
    options.expires = new Date(expiresAt);
  }

  return options;
}

export function transientCookieOptions(publicBaseUrl: string): CookieSerializeOptions {
  return {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: isSecure(publicBaseUrl),
    maxAge: 10 * 60,
  };
}

function isSecure(publicBaseUrl: string): boolean {
  return publicBaseUrl.startsWith("https://");
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function verify(payload: string, signature: string, secret: string): boolean {
  const expected = Buffer.from(sign(payload, secret));
  const actual = Buffer.from(signature);

  if (expected.length !== actual.length) {
    return false;
  }

  return timingSafeEqual(expected, actual);
}
