import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { applyMigrations, migrations, type Migration } from "./migrations";

function makeDb(): DatabaseSync {
  const directory = mkdtempSync(join(tmpdir(), "smart-db-migration-"));
  const db = new DatabaseSync(join(directory, "smart.db"));
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA journal_mode = WAL;");
  return db;
}

describe("applyMigrations", () => {
  it("creates the schema_version table and applies all migrations on a fresh database", () => {
    const db = makeDb();

    const result = applyMigrations(db);

    expect(result.applied).toBe(migrations.length);
    expect(result.current).toBe(migrations[migrations.length - 1]!.version);

    const versions = db
      .prepare(`SELECT version, description FROM schema_version ORDER BY version`)
      .all() as { version: number; description: string }[];

    expect(versions).toHaveLength(migrations.length);
    expect(versions[0]).toMatchObject({ version: 1, description: "baseline schema" });
    expect(versions[1]).toMatchObject({ version: 2, description: "version columns and idempotency keys" });
    expect(versions[2]).toMatchObject({ version: 3, description: "auth sessions" });
    expect(versions[3]).toMatchObject({ version: 4, description: "partdb sync model foundations" });
    expect(versions[4]).toMatchObject({ version: 5, description: "partdb outbox" });
    expect(versions[5]).toMatchObject({ version: 6, description: "partdb outbox failure timestamps" });
    expect(versions[6]).toMatchObject({ version: 7, description: "physical instance sync status" });
    expect(versions[7]).toMatchObject({ version: 8, description: "correction events" });
    expect(versions[8]).toMatchObject({ version: 9, description: "borrow records for countable instances" });
    expect(versions[9]).toMatchObject({ version: 10, description: "partdb storage location cache" });
    expect(versions[10]).toMatchObject({ version: 11, description: "unified entities table backfilled from instances and bulk_stocks" });
    expect(versions[11]).toMatchObject({ version: 12, description: "branch-merge catch-up for borrow_records" });
    expect(versions[12]).toMatchObject({ version: 13, description: "branch-merge catch-up for partdb storage location cache" });
    expect(versions[13]).toMatchObject({ version: 14, description: "standalone known_categories table" });
    expect(versions[14]).toMatchObject({ version: 15, description: "standalone known_locations table" });
  });

  it("skips already-applied migrations on subsequent runs", () => {
    const db = makeDb();

    const first = applyMigrations(db);
    expect(first.applied).toBeGreaterThan(0);

    const second = applyMigrations(db);
    expect(second.applied).toBe(0);
    expect(second.current).toBe(first.current);
  });

  it("creates all expected tables in the baseline migration", () => {
    const db = makeDb();
    applyMigrations(db);

    const tables = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
      )
      .all() as { name: string }[];

    const tableNames = tables.map((t) => t.name);
    expect(tableNames).toContain("part_types");
    expect(tableNames).toContain("qr_batches");
    expect(tableNames).toContain("qrcodes");
    expect(tableNames).toContain("physical_instances");
    expect(tableNames).toContain("bulk_stocks");
    expect(tableNames).toContain("stock_events");
    expect(tableNames).toContain("auth_sessions");
    expect(tableNames).toContain("partdb_category_cache");
    expect(tableNames).toContain("partdb_outbox");
    expect(tableNames).toContain("correction_events");
    expect(tableNames).toContain("borrow_records");
    expect(tableNames).toContain("partdb_location_cache");
    expect(tableNames).toContain("entities");
    expect(tableNames).toContain("known_categories");
    expect(tableNames).toContain("known_locations");
    expect(tableNames).toContain("schema_version");
  });

  it("creates the idempotency_keys table and version columns in v2", () => {
    const db = makeDb();
    applyMigrations(db);

    const tables = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'idempotency_keys'`,
      )
      .all() as { name: string }[];
    expect(tables).toHaveLength(1);

    const instanceCols = db.prepare(`PRAGMA table_info(physical_instances)`).all() as {
      name: string;
    }[];
    expect(instanceCols.map((c) => c.name)).toContain("version");

    const bulkCols = db.prepare(`PRAGMA table_info(bulk_stocks)`).all() as {
      name: string;
    }[];
    expect(bulkCols.map((c) => c.name)).toContain("version");
  });

  it("creates the auth_sessions table in v3", () => {
    const db = makeDb();
    applyMigrations(db);

    const tables = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'auth_sessions'`,
      )
      .all() as { name: string }[];
    expect(tables).toHaveLength(1);

    const sessionCols = db.prepare(`PRAGMA table_info(auth_sessions)`).all() as {
      name: string;
    }[];
    expect(sessionCols.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        "id",
        "subject",
        "username",
        "display_name",
        "email",
        "roles_json",
        "id_token",
        "expires_at",
        "created_at",
        "last_seen_at",
      ]),
    );
  });

  it("adds partdb sync columns and cache table in v4", () => {
    const db = makeDb();
    applyMigrations(db);

    const partTypeCols = db.prepare(`PRAGMA table_info(part_types)`).all() as { name: string }[];
    expect(partTypeCols.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        "category_path_json",
        "unit_symbol",
        "unit_name",
        "unit_is_integer",
        "partdb_category_id",
        "partdb_unit_id",
        "partdb_sync_status",
      ]),
    );

    const bulkCols = db.prepare(`PRAGMA table_info(bulk_stocks)`).all() as { name: string }[];
    expect(bulkCols.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        "quantity",
        "minimum_quantity",
        "partdb_lot_id",
        "partdb_sync_status",
      ]),
    );

    const instanceCols = db.prepare(`PRAGMA table_info(physical_instances)`).all() as { name: string }[];
    expect(instanceCols.map((column) => column.name)).toContain("partdb_lot_id");
    expect(instanceCols.map((column) => column.name)).toContain("partdb_sync_status");
  });

  it("creates the partdb_outbox table and indexes in v5", () => {
    const db = makeDb();
    applyMigrations(db);

    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'partdb_outbox'`)
      .all() as { name: string }[];
    expect(tables).toHaveLength(1);

    const outboxCols = db.prepare(`PRAGMA table_info(partdb_outbox)`).all() as { name: string }[];
    expect(outboxCols.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        "id",
        "idempotency_key",
        "correlation_id",
        "operation",
        "payload_json",
        "depends_on_id",
        "target_table",
        "target_row_id",
        "target_column",
        "status",
        "attempt_count",
        "max_attempts",
        "lease_expires_at",
        "next_attempt_at",
        "last_error_json",
        "last_failure_at",
        "response_json",
        "response_iri",
        "created_at",
        "leased_at",
        "completed_at",
      ]),
    );
  });

  it("rolls back a failed migration without advancing the version", () => {
    const db = makeDb();
    applyMigrations(db);

    db.prepare(`INSERT INTO schema_version (version, description, applied_at) VALUES (?, ?, ?)`)
      .run(999, "placeholder", new Date().toISOString());
    db.prepare(`DELETE FROM schema_version WHERE version = ?`).run(999);

    const result = applyMigrations(db);
    expect(result.applied).toBe(0);
  });

  it("rolls back and throws when a migration contains invalid SQL", () => {
    const db = makeDb();
    applyMigrations(db);

    const badMigrations: Migration[] = [
      ...migrations,
      {
        version: 99,
        description: "intentionally broken",
        sql: "CREATE TABLE broken_table (id TEXT PRIMARY KEY); INSERT INTO nonexistent_table VALUES ('boom');",
      },
    ];

    expect(() => applyMigrations(db, badMigrations)).toThrowError();

    const row = db
      .prepare(`SELECT COUNT(*) AS count FROM schema_version WHERE version = 99`)
      .get() as { count: number };
    expect(Number(row.count)).toBe(0);

    const brokenTable = db
      .prepare(`SELECT COUNT(*) AS count FROM sqlite_master WHERE name = 'broken_table'`)
      .get() as { count: number };
    expect(Number(brokenTable.count)).toBe(0);
  });

  it("upgrades a database created from the old dev-branch migration lineage", () => {
    const db = makeDb();
    const devBranchMigrations: Migration[] = [
      ...migrations.slice(0, 8),
      {
        version: 9,
        description: "standalone known_categories table",
        sql: `
CREATE TABLE IF NOT EXISTS known_categories (
  path TEXT PRIMARY KEY
);
        `,
      },
      {
        version: 10,
        description: "standalone known_locations table",
        sql: `
CREATE TABLE IF NOT EXISTS known_locations (
  path TEXT PRIMARY KEY
);
        `,
      },
    ];

    expect(applyMigrations(db, devBranchMigrations).current).toBe(10);

    const result = applyMigrations(db);
    expect(result.current).toBe(migrations[migrations.length - 1]!.version);

    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
      .all() as Array<{ name: string }>;
    const tableNames = new Set(tables.map((row) => row.name));

    expect(tableNames.has("borrow_records")).toBe(true);
    expect(tableNames.has("partdb_location_cache")).toBe(true);
    expect(tableNames.has("entities")).toBe(true);
    expect(tableNames.has("known_categories")).toBe(true);
    expect(tableNames.has("known_locations")).toBe(true);
  });

  it("upgrades a database created from the old main-branch migration lineage", () => {
    const db = makeDb();
    const mainBranchMigrations = migrations.slice(0, 11);

    expect(applyMigrations(db, mainBranchMigrations).current).toBe(11);

    const result = applyMigrations(db);
    expect(result.current).toBe(migrations[migrations.length - 1]!.version);

    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('known_categories', 'known_locations')`)
      .all() as Array<{ name: string }>;
    expect(new Set(tables.map((row) => row.name))).toEqual(new Set(["known_categories", "known_locations"]));
  });
});
