import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { Err, Ok } from "@smart-db/contracts";
import { applyMigrations } from "../db/migrations.js";
import { PartDbDeleteReconciler } from "./partdb-reconciler.js";

function makeDb(): DatabaseSync {
  const directory = mkdtempSync(join(tmpdir(), "smart-db-reconcile-"));
  const db = new DatabaseSync(join(directory, "smart.db"));
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA journal_mode = WAL;");
  applyMigrations(db);
  return db;
}

function seedInventory(db: DatabaseSync): void {
  db.prepare(`
    INSERT INTO part_types (
      id, canonical_name, category, aliases_json, image_url, notes, countable, needs_review,
      partdb_part_id, created_at, updated_at, category_path_json, unit_symbol, unit_name, unit_is_integer,
      partdb_category_id, partdb_unit_id, partdb_sync_status
    ) VALUES
      ('part-1', 'Arduino Uno', 'Electronics', '[]', NULL, NULL, 1, 0, '41', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '["Electronics"]', 'pcs', 'Pieces', 1, NULL, NULL, 'synced'),
      ('part-2', 'Bulk Screws', 'Hardware', '[]', NULL, NULL, 0, 0, '42', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '["Hardware"]', 'pcs', 'Pieces', 1, NULL, NULL, 'synced')
  `).run();
  db.prepare(`
    INSERT INTO qr_batches (id, prefix, start_number, end_number, actor, created_at)
    VALUES ('batch-1', 'QR', 1, 2, 'tester', '2026-01-01T00:00:00.000Z')
  `).run();
  db.prepare(`
    INSERT INTO qrcodes (code, batch_id, status, assigned_kind, assigned_id, created_at, updated_at)
    VALUES
      ('QR-1', 'batch-1', 'assigned', 'instance', 'instance-1', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
      ('QR-2', 'batch-1', 'assigned', 'bulk', 'bulk-1', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
  `).run();
  db.prepare(`
    INSERT INTO physical_instances (
      id, qr_code, part_type_id, status, location, assignee, created_at, updated_at, partdb_lot_id, partdb_sync_status
    ) VALUES ('instance-1', 'QR-1', 'part-1', 'available', 'Shelf A', NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '51', 'synced')
  `).run();
  db.prepare(`
    INSERT INTO bulk_stocks (
      id, qr_code, part_type_id, level, quantity, minimum_quantity, location, partdb_lot_id, partdb_sync_status, created_at, updated_at
    ) VALUES ('bulk-1', 'QR-2', 'part-2', 'good', 10, 2, 'Bin A', '52', 'synced', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
  `).run();
}

describe("PartDbDeleteReconciler", () => {
  it("clears stale part and lot references when Part-DB resources are missing", async () => {
    const db = makeDb();
    seedInventory(db);
    const parts = {
      get: vi
        .fn()
        .mockResolvedValueOnce(Err({ kind: "not_found", httpStatus: 404, resource: "part", identifier: "/api/parts/41", retryable: false }))
        .mockResolvedValueOnce(Ok({ "@id": "/api/parts/42", id: 42, name: "Bulk Screws", category: null })),
    } as never;
    const lots = {
      get: vi
        .fn()
        .mockResolvedValueOnce(Err({ kind: "not_found", httpStatus: 404, resource: "part_lot", identifier: "/api/part_lots/52", retryable: false })),
    } as never;

    const reconciler = new PartDbDeleteReconciler(db, parts, lots);
    const result = await reconciler.reconcileMissingRemoteReferences();

    expect(result).toEqual(
      Ok({
        clearedPartTypes: 1,
        clearedInstanceLots: 1,
        clearedBulkLots: 1,
      }),
    );

    const partRow = db.prepare(`SELECT partdb_part_id, partdb_sync_status FROM part_types WHERE id = 'part-1'`).get() as {
      partdb_part_id: string | null;
      partdb_sync_status: string;
    };
    expect(partRow).toEqual({
      partdb_part_id: null,
      partdb_sync_status: "never",
    });

    const instanceRow = db.prepare(`SELECT partdb_lot_id, partdb_sync_status FROM physical_instances WHERE id = 'instance-1'`).get() as {
      partdb_lot_id: string | null;
      partdb_sync_status: string;
    };
    expect(instanceRow).toEqual({
      partdb_lot_id: null,
      partdb_sync_status: "never",
    });

    const bulkRow = db.prepare(`SELECT partdb_lot_id, partdb_sync_status FROM bulk_stocks WHERE id = 'bulk-1'`).get() as {
      partdb_lot_id: string | null;
      partdb_sync_status: string;
    };
    expect(bulkRow).toEqual({
      partdb_lot_id: null,
      partdb_sync_status: "never",
    });
  });
});
