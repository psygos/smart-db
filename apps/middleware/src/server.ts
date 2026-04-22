import type { DatabaseSync } from "node:sqlite";
import {
  ForbiddenError,
  hasSmartDbRole,
  InvariantError,
  smartDbRoles,
  type SmartDbRole,
  UnauthenticatedError,
  isApplicationError,
} from "@smart-db/contracts";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import Fastify, { type preHandlerAsyncHookHandler } from "fastify";
import { config, type AppConfig } from "./config.js";
import { AuthService } from "./auth/auth-service.js";
import { SessionStore } from "./auth/session-store.js";
import "./auth/types.js";
import { createDatabase } from "./db/database.js";
import { createIdempotencyHooks } from "./middleware/idempotency.js";
import { PartDbOutbox } from "./outbox/partdb-outbox.js";
import { PartDbOutboxWorker } from "./outbox/partdb-worker.js";
import { PartDbClient } from "./partdb/partdb-client.js";
import { CategoryResolver } from "./partdb/category-resolver.js";
import { LocationResolver } from "./partdb/location-resolver.js";
import { PartDbOperations } from "./partdb/partdb-operations.js";
import { registerAuthRoutes } from "./routes/auth-routes.js";
import { registerInventoryRoutes } from "./routes/inventory-routes.js";
import { registerPartDbAdminRoutes } from "./routes/partdb-admin-routes.js";
import { InventoryService } from "./services/inventory-service.js";
import { ZitadelClient } from "./auth/zitadel-client.js";
import { sessionCookieOptions } from "./auth/auth-cookies.js";
import { PartDbRestClient } from "./partdb/partdb-rest.js";
import { PartDbCategoriesResource } from "./partdb/resources/categories.js";
import { PartDbMeasurementUnitsResource } from "./partdb/resources/measurement-units.js";
import { PartDbPartLotsResource } from "./partdb/resources/part-lots.js";
import { PartDbPartsResource } from "./partdb/resources/parts.js";
import { PartDbStorageLocationsResource } from "./partdb/resources/storage-locations.js";

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
        redirectUri: new URL("api/auth/callback", activeConfig.publicBaseUrl.replace(/\/?$/, "/")).toString(),
        sessionCookieSecret: activeConfig.auth.sessionCookieSecret,
      },
    );
  const partDbClient = new PartDbClient(activeConfig.partDb);
  const syncEnabled =
    activeConfig.partDb.syncEnabled &&
    Boolean(activeConfig.partDb.baseUrl) &&
    Boolean(activeConfig.partDb.apiToken);
  const partDbOutbox = syncEnabled ? new PartDbOutbox(db) : null;
  const partDbWorker = syncEnabled
    ? new PartDbOutboxWorker(
        partDbOutbox!,
        new PartDbOperations(
          new CategoryResolver(
            db,
            new PartDbCategoriesResource(
              new PartDbRestClient({
                baseUrl: activeConfig.partDb.baseUrl!,
                apiToken: activeConfig.partDb.apiToken!,
              }),
            ),
          ),
          new PartDbMeasurementUnitsResource(
            new PartDbRestClient({
              baseUrl: activeConfig.partDb.baseUrl!,
              apiToken: activeConfig.partDb.apiToken!,
            }),
          ),
          new PartDbPartsResource(
            new PartDbRestClient({
              baseUrl: activeConfig.partDb.baseUrl!,
              apiToken: activeConfig.partDb.apiToken!,
            }),
          ),
          new PartDbPartLotsResource(
            new PartDbRestClient({
              baseUrl: activeConfig.partDb.baseUrl!,
              apiToken: activeConfig.partDb.apiToken!,
            }),
          ),
          new PartDbStorageLocationsResource(
            new PartDbRestClient({
              baseUrl: activeConfig.partDb.baseUrl!,
              apiToken: activeConfig.partDb.apiToken!,
            }),
          ),
          new LocationResolver(
            db,
            new PartDbStorageLocationsResource(
              new PartDbRestClient({
                baseUrl: activeConfig.partDb.baseUrl!,
                apiToken: activeConfig.partDb.apiToken!,
              }),
            ),
          ),
        ),
        app.log,
      )
    : null;
  const inventoryService =
    options.inventoryService ??
    new InventoryService(db, partDbClient, partDbOutbox);

  const idempotency = createIdempotencyHooks(db);

  const requireMutationOrigin = async (request: Parameters<preHandlerAsyncHookHandler>[0]) => {
    if (
      request.method !== "GET" &&
      request.method !== "HEAD" &&
      request.headers.origin !== activeConfig.frontendOrigin
    ) {
      throw new ForbiddenError("Cross-origin mutation requests are not allowed.");
    }
  };

  const loadAuthenticatedSession = async (
    request: Parameters<preHandlerAsyncHookHandler>[0],
    reply: Parameters<preHandlerAsyncHookHandler>[1],
  ) => {
    const sessionId = request.cookies[activeConfig.sessionCookieName];
    const session = sessionId ? authService.getSession(sessionId) : null;
    if (!sessionId || !session) {
      reply.clearCookie(
        activeConfig.sessionCookieName,
        sessionCookieOptions(activeConfig.publicBaseUrl, null),
      );
      throw new UnauthenticatedError();
    }
    request.authContext = {
      sessionId,
      session,
    };
  };

  const requireAuth: preHandlerAsyncHookHandler = async (request, reply) => {
    await requireMutationOrigin(request);
    await loadAuthenticatedSession(request, reply);
  };

  const requireRole = (requiredRole: SmartDbRole): preHandlerAsyncHookHandler =>
    async function (request, reply) {
      await requireAuth.call(this, request, reply);
      if (!hasSmartDbRole(request.authContext!.session.roles, requiredRole)) {
        throw new ForbiddenError("You do not have permission to perform this action.", {
          requiredRole,
        });
      }
    };

  const requireAdmin = requireRole(smartDbRoles.admin);

  await registerAuthRoutes(app, activeConfig, authService, requireAuth);
  await registerInventoryRoutes(app, inventoryService, {
    requireAuth,
    requireAdmin,
    idempotency,
  });
  await registerPartDbAdminRoutes(
    app,
    {
      enabled: syncEnabled,
      outbox: partDbOutbox,
      worker: partDbWorker,
      inventoryService,
    },
    requireAdmin,
  );

  if (partDbWorker) {
    partDbWorker.start();
    app.addHook("onClose", async () => {
      partDbWorker.stop();
    });
  }

  app.setErrorHandler((error, request, reply) => {
    if (isApplicationError(error)) {
      reply.status(error.httpStatus).send({
        error: {
          code: error.code,
          message: error.message,
          details: error.details,
        },
      });
      return;
    }

    // Fastify's own errors (request parsing, validation, rate-limits etc.)
    // carry their own statusCode + code. Surface them faithfully instead of
    // wrapping as 500/invariant — a 400 "empty JSON body" is a client
    // problem and must stay a 400.
    const fastifyError = error as { statusCode?: number; code?: string; message?: string };
    if (
      typeof fastifyError.statusCode === "number" &&
      fastifyError.statusCode >= 400 &&
      fastifyError.statusCode < 500
    ) {
      request.log.warn(
        { err: error, url: request.url, method: request.method },
        "client request rejected by fastify",
      );
      reply.status(fastifyError.statusCode).send({
        error: {
          code: typeof fastifyError.code === "string" ? fastifyError.code : "bad_request",
          message: typeof fastifyError.message === "string" ? fastifyError.message : "Bad request.",
          details: {},
        },
      });
      return;
    }

    // Genuine unexpected failure: log the cause so diagnosing "invariant /
    // Unhandled middleware failure" in production no longer requires a
    // redeploy-with-extra-logging cycle.
    const wrapped = new InvariantError("Unhandled middleware failure.", {}, { cause: error });
    request.log.error(
      { err: error, url: request.url, method: request.method },
      "unhandled middleware failure",
    );
    reply.status(wrapped.httpStatus).send({
      error: {
        code: wrapped.code,
        message: wrapped.message,
        details: wrapped.details,
      },
    });
  });

  return app;
}
