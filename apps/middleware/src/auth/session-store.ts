import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { IntegrationError, smartDbRoles, type AuthSession } from "@smart-db/contracts";

interface SessionRecord {
  id: string;
  session: AuthSession;
  idToken: string | null;
}

interface CreateSessionInput {
  subject: string;
  username: string;
  name: string | null;
  email: string | null;
  roles: string[];
  expiresAt: string | null;
  idToken: string | null;
}

type SqlRow = Record<string, unknown>;

export class SessionStore {
  private lastCleanupAt = 0;

  constructor(
    private readonly db: DatabaseSync,
    private readonly cleanupIntervalMs: number = 5 * 60 * 1000,
  ) {}

  create(input: CreateSessionInput): SessionRecord {
    this.maybeDeleteExpired();
    const id = randomUUID();
    const now = new Date().toISOString();
    if (!input.expiresAt) {
      throw new IntegrationError("Auth", "session expiry could not be determined.");
    }

    const expiresAt = input.expiresAt;
    const session: AuthSession = {
      subject: input.subject,
      username: input.username,
      name: input.name,
      email: input.email,
      roles: materializeSessionRoles(input.roles),
      issuedAt: now,
      expiresAt,
    };

    this.db.prepare(`
      INSERT INTO auth_sessions (
        id, subject, username, display_name, email, roles_json, id_token, expires_at, created_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      session.subject,
      session.username,
      session.name,
      session.email,
      JSON.stringify(session.roles),
      input.idToken,
      expiresAt,
      now,
      now,
    );

    return { id, session, idToken: input.idToken };
  }

  get(id: string): SessionRecord | null {
    this.maybeDeleteExpired();
    const row = this.db.prepare(`SELECT * FROM auth_sessions WHERE id = ?`).get(id) as SqlRow | undefined;
    if (!row) {
      return null;
    }

    const record = mapSessionRecord(row);
    if (record.session.expiresAt && Date.parse(record.session.expiresAt) <= Date.now()) {
      this.delete(id);
      return null;
    }

    this.db.prepare(`UPDATE auth_sessions SET last_seen_at = ? WHERE id = ?`).run(
      new Date().toISOString(),
      id,
    );
    return record;
  }

  delete(id: string): void {
    this.db.prepare(`DELETE FROM auth_sessions WHERE id = ?`).run(id);
  }

  deleteExpired(nowIso: string = new Date().toISOString()): void {
    this.db.prepare(`DELETE FROM auth_sessions WHERE expires_at <= ?`).run(nowIso);
    this.lastCleanupAt = Date.now();
  }

  private maybeDeleteExpired(): void {
    if (Date.now() - this.lastCleanupAt < this.cleanupIntervalMs) {
      return;
    }

    this.deleteExpired();
  }
}

function mapSessionRecord(row: SqlRow): SessionRecord {
  return {
    id: String(row.id),
    session: {
      subject: stringOrNull(row.subject),
      username: String(row.username),
      name: stringOrNull(row.display_name),
      email: stringOrNull(row.email),
      roles: parseRoles(row.roles_json),
      issuedAt: String(row.created_at),
      expiresAt: stringOrNull(row.expires_at),
    },
    idToken: stringOrNull(row.id_token),
  };
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function parseRoles(value: unknown): string[] {
  if (typeof value !== "string") {
    return materializeSessionRoles([]);
  }

  try {
    const parsed = JSON.parse(value) as unknown[];
    return materializeSessionRoles(parsed.filter((item): item is string => typeof item === "string"));
  } catch {
    return materializeSessionRoles([]);
  }
}

function materializeSessionRoles(roles: readonly string[]): string[] {
  return Array.from(new Set([...roles, smartDbRoles.admin])).sort((left, right) => left.localeCompare(right));
}
