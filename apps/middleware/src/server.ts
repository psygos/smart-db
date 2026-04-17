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
