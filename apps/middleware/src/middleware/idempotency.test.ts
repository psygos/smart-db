import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, beforeEach } from "vitest";
import { applyMigrations } from "../db/migrations.js";
import { registerIdempotencyHooks } from "./idempotency.js";
import Fastify from "fastify";

describe("idempotency middleware", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec("PRAGMA journal_mode = WAL;");
    applyMigrations(db);
  });

  it("returns cached response for duplicate idempotency key", async () => {
    const app = Fastify();
    registerIdempotencyHooks(app, db);

    app.post("/test", async () => ({ result: "created" }));
    await app.ready();

    const first = await app.inject({
      method: "POST",
      url: "/test",
      headers: { "x-idempotency-key": "key-1" },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ result: "created" });

    const second = await app.inject({
      method: "POST",
      url: "/test",
      headers: { "x-idempotency-key": "key-1" },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ result: "created" });
    expect(second.headers["x-idempotency-replay"]).toBe("true");
  });

  it("proceeds normally when no idempotency key is present", async () => {
    let callCount = 0;
    const app = Fastify();
    registerIdempotencyHooks(app, db);

    app.post("/test", async () => ({ count: ++callCount }));
    await app.ready();

    const first = await app.inject({ method: "POST", url: "/test" });
    expect(first.json()).toEqual({ count: 1 });

    const second = await app.inject({ method: "POST", url: "/test" });
    expect(second.json()).toEqual({ count: 2 });
  });

  it("does not cache error responses", async () => {
    let callCount = 0;
    const app = Fastify();
    registerIdempotencyHooks(app, db);

    app.post("/test", async (_req, reply) => {
      callCount++;
      if (callCount === 1) {
        reply.code(409);
        return { error: "conflict" };
      }
      return { result: "ok" };
    });
    await app.ready();

    const first = await app.inject({
      method: "POST",
      url: "/test",
      headers: { "x-idempotency-key": "key-err" },
    });
    expect(first.statusCode).toBe(409);

    const second = await app.inject({
      method: "POST",
      url: "/test",
      headers: { "x-idempotency-key": "key-err" },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ result: "ok" });
  });

  it("does not replay cached responses across authorization headers", async () => {
    let callCount = 0;
    const app = Fastify();
    registerIdempotencyHooks(app, db);

    app.post("/test", async (request) => ({
      count: ++callCount,
      authorization: request.headers.authorization ?? null,
    }));
    await app.ready();

    const first = await app.inject({
      method: "POST",
      url: "/test",
      headers: {
        authorization: "Bearer token-a",
        "x-idempotency-key": "key-auth",
      },
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: "POST",
      url: "/test",
      headers: {
        authorization: "Bearer token-b",
        "x-idempotency-key": "key-auth",
      },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ count: 2, authorization: "Bearer token-b" });
    expect(second.headers["x-idempotency-replay"]).toBeUndefined();
  });

  it("does not replay cached responses across endpoints", async () => {
    let oneCount = 0;
    let twoCount = 0;
    const app = Fastify();
    registerIdempotencyHooks(app, db);

    app.post("/one", async () => ({ count: ++oneCount, endpoint: "one" }));
    app.post("/two", async () => ({ count: ++twoCount, endpoint: "two" }));
    await app.ready();

    const first = await app.inject({
      method: "POST",
      url: "/one",
      headers: { "x-idempotency-key": "key-shared" },
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: "POST",
      url: "/two",
      headers: { "x-idempotency-key": "key-shared" },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ count: 1, endpoint: "two" });
    expect(second.headers["x-idempotency-replay"]).toBeUndefined();
  });

  it("does not replay cached responses when the payload changes", async () => {
    let callCount = 0;
    const app = Fastify();
    registerIdempotencyHooks(app, db);

    app.post("/test", async (request) => ({
      count: ++callCount,
      payload: request.body,
    }));
    await app.ready();

    const first = await app.inject({
      method: "POST",
      url: "/test",
      headers: { "x-idempotency-key": "key-body" },
      payload: { code: "QR-1", location: "Shelf A" },
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: "POST",
      url: "/test",
      headers: { "x-idempotency-key": "key-body" },
      payload: { code: "QR-1", location: "Shelf B" },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({
      count: 2,
      payload: { code: "QR-1", location: "Shelf B" },
    });
    expect(second.headers["x-idempotency-replay"]).toBeUndefined();
  });
});
