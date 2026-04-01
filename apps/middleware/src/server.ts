import type { DatabaseSync } from "node:sqlite";
import { InvariantError, UnauthenticatedError, isApplicationError } from "@smart-db/contracts";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import Fastify, { type preHandlerAsyncHookHandler } from "fastify";
import { config, type AppConfig } from "./config.js";
import { AuthService } from "./auth/auth-service.js";
import { SessionStore } from "./auth/session-store.js";
import "./auth/types.js";
import { createDatabase } from "./db/database.js";
import { registerIdempotencyHooks } from "./middleware/idempotency.js";
import { PartDbClient } from "./partdb/partdb-client.js";
import { registerAuthRoutes } from "./routes/auth-routes.js";
import { registerInventoryRoutes } from "./routes/inventory-routes.js";
import { InventoryService } from "./services/inventory-service.js";
import { ZitadelClient } from "./auth/zitadel-client.js";
import { sessionCookieOptions } from "./auth/auth-cookies.js";

interface BuildServerOptions {
  configOverride?: AppConfig;
  authService?: AuthService;
  inventoryService?: InventoryService;
  db?: DatabaseSync;
}

export async function buildServer(options: BuildServerOptions = {}) {
  const activeConfig = options.configOverride ?? config;
  const app = Fastify({
    logger:
      process.env.NODE_ENV === "test"
        ? false
        : {
            redact: {
              paths: [
                "req.headers.authorization",
                "request.headers.authorization",
                "headers.authorization",
              ],
              censor: "[REDACTED]",
            },
          },
  });

  await app.register(cookie);
  await app.register(cors, {
    origin: activeConfig.frontendOrigin,
    credentials: true,
  });

  const db = options.db ?? createDatabase(activeConfig.dataPath);
  const authService =
    options.authService ??
    new AuthService(
      new ZitadelClient(activeConfig.auth),
      new SessionStore(db),
      {
        frontendOrigin: activeConfig.frontendOrigin,
        redirectUri: new URL("/api/auth/callback", activeConfig.publicBaseUrl).toString(),
        sessionCookieSecret: activeConfig.auth.sessionCookieSecret,
      },
    );
  const partDbClient = new PartDbClient(activeConfig.partDb);
  const inventoryService =
    options.inventoryService ??
    new InventoryService(db, partDbClient);

  registerIdempotencyHooks(app, db);

  const requireAuth: preHandlerAsyncHookHandler = async (request, reply) => {
    if (
      request.method !== "GET" &&
      request.method !== "HEAD" &&
      request.headers.origin !== activeConfig.frontendOrigin
    ) {
      throw new UnauthenticatedError("Cross-origin mutation requests are not allowed.");
    }

    const session = authService.getSession(request.cookies[activeConfig.sessionCookieName]);
    if (!session) {
      reply.clearCookie(
        activeConfig.sessionCookieName,
        sessionCookieOptions(activeConfig.publicBaseUrl, null),
      );
      throw new UnauthenticatedError();
    }
    request.authContext = {
      session,
    };
  };

  await registerAuthRoutes(app, activeConfig, authService, requireAuth);
  await registerInventoryRoutes(app, inventoryService, requireAuth);

  app.setErrorHandler((error, _request, reply) => {
    const applicationError = isApplicationError(error)
      ? error
      : new InvariantError("Unhandled middleware failure.", {}, { cause: error });

    reply.status(applicationError.httpStatus).send({
      error: {
        code: applicationError.code,
        message: applicationError.message,
        details: applicationError.details,
      },
    });
  });

  return app;
}
