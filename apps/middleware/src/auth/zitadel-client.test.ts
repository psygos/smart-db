import { afterEach, describe, expect, it, vi } from "vitest";
import { IntegrationError } from "@smart-db/contracts";
import { ZitadelClient, zitadelClientInternals } from "./zitadel-client";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ZitadelClient", () => {
  it("builds authorization URLs with PKCE parameters", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        issuer: "https://auth.example.com",
        authorization_endpoint: "https://auth.example.com/oauth/v2/authorize",
        token_endpoint: "https://auth.example.com/oauth/v2/token",
        jwks_uri: "https://auth.example.com/oauth/v2/keys",
      }),
    }));

    const client = new ZitadelClient({
      issuer: "https://auth.example.com",
      clientId: "client-123",
    });

    const url = new URL(await client.authorizationUrl({
      state: "state-1",
      nonce: "nonce-1",
      codeVerifier: "verifier-1",
      redirectUri: "https://smartdb.example.com/api/auth/callback",
    }));

    expect(url.origin + url.pathname).toBe("https://auth.example.com/oauth/v2/authorize");
    expect(url.searchParams.get("client_id")).toBe("client-123");
    expect(url.searchParams.get("state")).toBe("state-1");
    expect(url.searchParams.get("nonce")).toBe("nonce-1");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBe(
      zitadelClientInternals.codeChallenge("verifier-1"),
    );
  });

  it("extracts roles from string arrays and Zitadel role objects", () => {
    expect(
      zitadelClientInternals.extractRoles(
        {
          smartdb_roles: ["smartdb.labeler", "smartdb.admin"],
        },
        "smartdb_roles",
      ),
    ).toEqual(["smartdb.admin", "smartdb.labeler"]);

    expect(
      zitadelClientInternals.extractRoles(
        {
          "urn:zitadel:iam:org:project:roles": [
            {
              "smartdb.viewer": {
                id: "org-1",
              },
            },
            {
              "smartdb.admin": {
                id: "org-1",
              },
            },
          ],
        },
        "urn:zitadel:iam:org:project:roles",
      ),
    ).toEqual(["smartdb.admin", "smartdb.viewer"]);
  });

  it("returns a logout URL when an end-session endpoint is present", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        issuer: "https://auth.example.com",
        authorization_endpoint: "https://auth.example.com/oauth/v2/authorize",
        token_endpoint: "https://auth.example.com/oauth/v2/token",
        jwks_uri: "https://auth.example.com/oauth/v2/keys",
        end_session_endpoint: "https://auth.example.com/oidc/v1/end_session",
      }),
    }));

    const client = new ZitadelClient({
      issuer: "https://auth.example.com",
      clientId: "client-123",
    });

    const url = new URL((await client.logoutUrl("id-token"))!);
    expect(url.origin + url.pathname).toBe("https://auth.example.com/oidc/v1/end_session");
    expect(url.searchParams.get("id_token_hint")).toBe("id-token");
    expect(url.searchParams.get("post_logout_redirect_uri")).toBeNull();
  });

  it("throws when required config is missing", async () => {
    const client = new ZitadelClient({
      issuer: null,
      clientId: null,
    });

    await expect(client.authorizationUrl({
      state: "state-1",
      nonce: "nonce-1",
      codeVerifier: "verifier-1",
      redirectUri: "https://smartdb.example.com/api/auth/callback",
    })).rejects.toThrowError(IntegrationError);
  });

  it("does not poison discovery forever after a transient failure", async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary dns failure"))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          issuer: "https://auth.example.com",
          authorization_endpoint: "https://auth.example.com/oauth/v2/authorize",
          token_endpoint: "https://auth.example.com/oauth/v2/token",
          jwks_uri: "https://auth.example.com/oauth/v2/keys",
        }),
      });
    vi.stubGlobal("fetch", fetch);

    const client = new ZitadelClient({
      issuer: "https://auth.example.com",
      clientId: "client-123",
    });

    await expect(client.authorizationUrl({
      state: "state-1",
      nonce: "nonce-1",
      codeVerifier: "verifier-1",
      redirectUri: "https://smartdb.example.com/api/auth/callback",
    })).rejects.toThrowError("temporary dns failure");

    await expect(client.authorizationUrl({
      state: "state-2",
      nonce: "nonce-2",
      codeVerifier: "verifier-2",
      redirectUri: "https://smartdb.example.com/api/auth/callback",
    })).resolves.toContain("state=state-2");
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
