import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { ParseInputError } from "@smart-db/contracts";
import { loadEnvironmentFileIfPresent, parseConfig } from "./config";

describe("parseConfig", () => {
  it("parses defaults when optional values are absent", () => {
    expect(parseConfig({})).toEqual({
      port: 4000,
      frontendOrigin: "http://localhost:5173",
      publicBaseUrl: "http://localhost:4000",
      dataPath: expect.stringMatching(/data\/smart\.db$/),
      sessionCookieName: "smartdb_session",
      partDb: {
        baseUrl: null,
        publicBaseUrl: null,
        apiToken: null,
        syncEnabled: false,
      },
      auth: {
        issuer: null,
        clientId: null,
        clientSecret: null,
        postLogoutRedirectUri: "http://localhost:4000",
        roleClaim: null,
        sessionCookieSecret: null,
      },
    });
  });

  it("throws a parse error when the environment is malformed", () => {
    expect(() =>
      parseConfig({
        PORT: "nope",
      }),
    ).toThrowError(ParseInputError);

    expect(() =>
      parseConfig({
        PARTDB_SYNC_ENABLED: "not-a-bool",
      }),
    ).toThrowError(ParseInputError);
  });

  it("loads an env file when one is present", () => {
    const directory = mkdtempSync(join(tmpdir(), "smart-db-config-"));
    const file = join(directory, ".env");
    writeFileSync(file, "PORT=4500\n");

    delete process.env.PORT;
    loadEnvironmentFileIfPresent(file);

    expect(process.env.PORT).toBe("4500");
  });
});
