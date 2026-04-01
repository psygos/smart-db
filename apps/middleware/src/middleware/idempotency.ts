import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

const CLEANUP_THRESHOLD_MS = 24 * 60 * 60 * 1000;

export function registerIdempotencyHooks(app: FastifyInstance, db: DatabaseSync): void {
  const lookup = db.prepare(
    "SELECT response_json FROM idempotency_keys WHERE key = ?",
  );
  const insert = db.prepare(
    "INSERT OR IGNORE INTO idempotency_keys (key, endpoint, response_json, created_at) VALUES (?, ?, ?, ?)",
  );
  const cleanup = db.prepare(
    "DELETE FROM idempotency_keys WHERE created_at < ?",
  );

  app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.method !== "POST") return;

    const key = request.headers["x-idempotency-key"];
    if (typeof key !== "string" || !key) return;

    const row = lookup.get(storageKey(request, key)) as { response_json: string } | undefined;
    if (row) {
      const cached = JSON.parse(row.response_json) as { statusCode: number; body: unknown };
      reply.code(cached.statusCode);
      reply.header("x-idempotency-replay", "true");
      await reply.send(cached.body);
    }
  });

  app.addHook("onSend", async (request: FastifyRequest, reply: FastifyReply, payload: string) => {
    if (request.method !== "POST") return payload;

    const key = request.headers["x-idempotency-key"];
    if (typeof key !== "string" || !key) return payload;

    if (reply.getHeader("x-idempotency-replay")) return payload;

    const statusCode = reply.statusCode;
    if (statusCode >= 200 && statusCode < 300) {
      const cached = JSON.stringify({ statusCode, body: JSON.parse(payload) });
      insert.run(storageKey(request, key), request.url, cached, new Date().toISOString());
    }

    // Lazy cleanup
    const threshold = new Date(Date.now() - CLEANUP_THRESHOLD_MS).toISOString();
    cleanup.run(threshold);

    return payload;
  });
}

function storageKey(request: FastifyRequest, key: string): string {
  const authorization =
    typeof request.headers.authorization === "string"
      ? request.headers.authorization.trim()
      : "";
  return createHash("sha256")
    .update(`${request.method}\n${request.url}\n${authorization}\n${key}`)
    .digest("hex");
}
