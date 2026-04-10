import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import {
  configEnvironmentSchema,
  parseWithSchema,
  type ConfigEnvironment,
} from "@smart-db/contracts";

const envPath = fileURLToPath(new URL("../.env", import.meta.url));
export function loadEnvironmentFileIfPresent(path: string = envPath): void {
  if (existsSync(path)) {
    process.loadEnvFile?.(path);
  }
}
loadEnvironmentFileIfPresent();

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
export interface AppConfig {
  port: number;
  frontendOrigin: string;
  publicBaseUrl: string;
  dataPath: string;
  sessionCookieName: string;
  partDb: {
    baseUrl: string | null;
    publicBaseUrl: string | null;
    apiToken: string | null;
    syncEnabled: boolean;
  };
  auth: {
    issuer: string | null;
    clientId: string | null;
    clientSecret: string | null;
    postLogoutRedirectUri: string | null;
    roleClaim: string | null;
    sessionCookieSecret: string | null;
  };
}

export function parseConfig(environment: Partial<Record<keyof ConfigEnvironment, string | number | undefined>>): AppConfig {
  const parsedEnvironment = parseWithSchema(
    configEnvironmentSchema,
    environment,
    "middleware environment",
  );

  return {
    port: parsedEnvironment.PORT,
    frontendOrigin: parsedEnvironment.FRONTEND_ORIGIN,
    publicBaseUrl: parsedEnvironment.PUBLIC_BASE_URL,
    dataPath: parsedEnvironment.SMART_DB_DATA_PATH ?? resolve(repoRoot, "data", "smart.db"),
    sessionCookieName:
      parsedEnvironment.PUBLIC_BASE_URL.startsWith("https://")
        ? "__Host-smartdb_session"
        : "smartdb_session",
    partDb: {
      baseUrl: parsedEnvironment.PARTDB_BASE_URL,
      publicBaseUrl: parsedEnvironment.PARTDB_PUBLIC_BASE_URL,
      apiToken: parsedEnvironment.PARTDB_API_TOKEN,
      syncEnabled: parsedEnvironment.PARTDB_SYNC_ENABLED,
    },
    auth: {
      issuer: parsedEnvironment.ZITADEL_ISSUER,
      clientId: parsedEnvironment.ZITADEL_CLIENT_ID,
      clientSecret: parsedEnvironment.ZITADEL_CLIENT_SECRET,
      postLogoutRedirectUri: parsedEnvironment.ZITADEL_POST_LOGOUT_REDIRECT_URI,
      roleClaim: parsedEnvironment.ZITADEL_ROLE_CLAIM,
      sessionCookieSecret: parsedEnvironment.SESSION_COOKIE_SECRET,
    },
  };
}

export const config = parseConfig({
  PORT: process.env.PORT,
  FRONTEND_ORIGIN: process.env.FRONTEND_ORIGIN,
  PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL,
  SMART_DB_DATA_PATH: process.env.SMART_DB_DATA_PATH,
  PARTDB_BASE_URL: process.env.PARTDB_BASE_URL,
  PARTDB_PUBLIC_BASE_URL: process.env.PARTDB_PUBLIC_BASE_URL,
  PARTDB_API_TOKEN: process.env.PARTDB_API_TOKEN,
  PARTDB_SYNC_ENABLED: process.env.PARTDB_SYNC_ENABLED,
  SESSION_COOKIE_SECRET: process.env.SESSION_COOKIE_SECRET,
  ZITADEL_ISSUER: process.env.ZITADEL_ISSUER,
  ZITADEL_CLIENT_ID: process.env.ZITADEL_CLIENT_ID,
  ZITADEL_CLIENT_SECRET: process.env.ZITADEL_CLIENT_SECRET,
  ZITADEL_POST_LOGOUT_REDIRECT_URI: process.env.ZITADEL_POST_LOGOUT_REDIRECT_URI,
  ZITADEL_ROLE_CLAIM: process.env.ZITADEL_ROLE_CLAIM,
});
