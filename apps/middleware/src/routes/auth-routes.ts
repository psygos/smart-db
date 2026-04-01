import type { FastifyInstance, preHandlerAsyncHookHandler } from "fastify";
import { UnauthenticatedError, logoutResponseSchema, parseWithSchema } from "@smart-db/contracts";
import { AuthService } from "../auth/auth-service.js";
import {
  authRequestCookieName,
  sessionCookieOptions,
  transientCookieOptions,
} from "../auth/auth-cookies.js";
import type { AppConfig } from "../config.js";

export async function registerAuthRoutes(
  app: FastifyInstance,
  config: AppConfig,
  authService: AuthService,
  requireAuth: preHandlerAsyncHookHandler,
): Promise<void> {
  app.get("/api/auth/login", async (request, reply) => {
    const query = request.query as { returnTo?: string };
    const result = await authService.startLogin(query.returnTo);
    reply.setCookie(
      authRequestCookieName,
      result.authRequest,
      transientCookieOptions(config.publicBaseUrl),
    );
    return reply.redirect(result.authorizationUrl);
  });

  app.get("/api/auth/callback", async (request, reply) => {
    const query = request.query as { code?: string; state?: string };

    try {
      const result = await authService.completeLogin(
        query,
        request.cookies[authRequestCookieName],
      );
      reply.clearCookie(
        authRequestCookieName,
        transientCookieOptions(config.publicBaseUrl),
      );
      reply.setCookie(
        config.sessionCookieName,
        result.sessionId,
        sessionCookieOptions(config.publicBaseUrl, result.session.expiresAt),
      );
      return reply.redirect(result.redirectTo);
    } catch (error) {
      reply.clearCookie(
        authRequestCookieName,
        transientCookieOptions(config.publicBaseUrl),
      );
      const url = new URL(config.frontendOrigin);
      url.searchParams.set(
        "authError",
        error instanceof Error ? error.message : "Authentication failed.",
      );
      return reply.redirect(url.toString());
    }
  });

  app.get("/api/auth/session", { preHandler: requireAuth }, async (request) => {
    return request.authContext!.session;
  });

  app.post("/api/auth/logout", async (request, reply) => {
    if (request.headers.origin !== config.frontendOrigin) {
      throw new UnauthenticatedError("Cross-origin logout requests are not allowed.");
    }
    const result = await authService.logout(request.cookies[config.sessionCookieName]);
    reply.clearCookie(
      config.sessionCookieName,
      sessionCookieOptions(config.publicBaseUrl, null),
    );
    return parseWithSchema(
      logoutResponseSchema,
      { ok: true, redirectUrl: result.redirectUrl },
      "logout response",
    );
  });
}
