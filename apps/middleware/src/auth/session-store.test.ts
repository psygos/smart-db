import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations } from "../db/migrations.js";
import { SessionStore } from "./session-store";

describe("SessionStore", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON;");
    applyMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  it("creates and returns persisted sessions", () => {
    const store = new SessionStore(db);
    const created = store.create({
      subject: "zitadel-user-1",
      username: "labeler",
      name: "Labeler User",
      email: "labeler@example.com",
      roles: ["smartdb.labeler", "smartdb.labeler", "smartdb.viewer"],
      expiresAt: "2030-04-02T00:00:00.000Z",
      idToken: "id-token",
    });

    expect(store.get(created.id)).toEqual({
      id: created.id,
      session: {
        subject: "zitadel-user-1",
        username: "labeler",
        name: "Labeler User",
        email: "labeler@example.com",
        roles: ["smartdb.admin", "smartdb.labeler", "smartdb.viewer"],
        issuedAt: expect.any(String),
        expiresAt: "2030-04-02T00:00:00.000Z",
      },
      idToken: "id-token",
    });
  });

  it("drops expired sessions on read", () => {
    const store = new SessionStore(db);
    const created = store.create({
      subject: "zitadel-user-2",
      username: "expired",
      name: null,
      email: null,
      roles: [],
      expiresAt: "2020-01-01T00:00:00.000Z",
      idToken: null,
    });

    expect(store.get(created.id)).toBeNull();
    expect(db.prepare(`SELECT COUNT(*) AS count FROM auth_sessions WHERE id = ?`).get(created.id)).toEqual({ count: 0 });
  });

  it("deletes expired sessions in bulk", () => {
    const store = new SessionStore(db);
    store.create({
      subject: "zitadel-user-3",
      username: "fresh",
      name: null,
      email: null,
      roles: [],
      expiresAt: "2030-01-01T00:00:00.000Z",
      idToken: null,
    });
    store.create({
      subject: "zitadel-user-4",
      username: "stale",
      name: null,
      email: null,
      roles: [],
      expiresAt: "2020-01-01T00:00:00.000Z",
      idToken: null,
    });

    store.deleteExpired("2026-01-01T00:00:00.000Z");
    expect(db.prepare(`SELECT COUNT(*) AS count FROM auth_sessions`).get()).toEqual({ count: 1 });
  });

  it("fails fast when session expiry is missing", () => {
    const store = new SessionStore(db);

    expect(() =>
      store.create({
        subject: "zitadel-user-5",
        username: "broken",
        name: null,
        email: null,
        roles: [],
        expiresAt: null,
        idToken: null,
      }),
    ).toThrowError("session expiry could not be determined");
  });

  it("sweeps other expired sessions during normal reads", () => {
    const store = new SessionStore(db, 0);
    store.create({
      subject: "zitadel-user-6",
      username: "expired-other",
      name: null,
      email: null,
      roles: [],
      expiresAt: "2020-01-01T00:00:00.000Z",
      idToken: null,
    });
    const active = store.create({
      subject: "zitadel-user-7",
      username: "active",
      name: null,
      email: null,
      roles: [],
      expiresAt: "2030-01-01T00:00:00.000Z",
      idToken: null,
    });

    expect(store.get(active.id)).toMatchObject({
      session: {
        username: "active",
        roles: ["smartdb.admin"],
      },
    });
    expect(db.prepare(`SELECT COUNT(*) AS count FROM auth_sessions`).get()).toEqual({ count: 1 });
  });
});
