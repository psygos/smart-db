// Converts a part type from countable=true (instance tracking) to countable=false (bulk tracking),
// migrating any existing physical_instance entries into bulk_stocks rows with quantity=1 each.
// Stock events are preserved (their target_type is updated).
//
// Usage: tsx src/scripts/convert-to-bulk.ts "<canonical name>"

import { config } from "../config.js";
import { createDatabase } from "../db/database.js";
import { randomUUID } from "node:crypto";


function reportQuantities(db: ReturnType<typeof createDatabase>, partTypeIds: string[]): void {
  if (partTypeIds.length === 0) return;
  const placeholders = partTypeIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `
      SELECT pt.canonical_name AS name,
             pt.unit_symbol    AS unit,
             COUNT(bs.id)      AS bins,
             COALESCE(SUM(bs.quantity), 0) AS on_hand
      FROM part_types pt
      LEFT JOIN bulk_stocks bs ON bs.part_type_id = pt.id
      WHERE pt.id IN (${placeholders})
      GROUP BY pt.id
      ORDER BY pt.canonical_name
      `,
    )
    .all(...partTypeIds) as Array<{ name: string; unit: string; bins: number; on_hand: number }>;

  console.log("");
  console.log("─── Quantities on hand ─────────────────────────────────────────");
  console.log(`${"Part".padEnd(50)}  ${"Unit".padEnd(5)}  ${"Bins".padStart(5)}  ${"On hand".padStart(10)}`);
  console.log("─".repeat(80));
  let totalOnHand = 0;
  for (const row of rows) {
    const qty = Number(row.on_hand);
    totalOnHand += qty;
    const name = row.name.length > 50 ? row.name.slice(0, 47) + "..." : row.name;
    console.log(
      `${name.padEnd(50)}  ${row.unit.padEnd(5)}  ${String(row.bins).padStart(5)}  ${qty.toFixed(1).padStart(10)}`,
    );
  }
  console.log("─".repeat(80));
  console.log(`Total parts: ${rows.length}    Total quantity (mixed units): ${totalOnHand.toFixed(1)}`);
  console.log("");
}

async function main(): Promise<void> {
  const targetName = process.argv[2];
  if (!targetName) {
    console.error('Usage: tsx convert-to-bulk.ts "<part type canonical name>"');
    process.exit(1);
  }

  const db = createDatabase(config.dataPath);

  const partType = db
    .prepare(`SELECT id, canonical_name, countable, unit_symbol FROM part_types WHERE canonical_name = ?`)
    .get(targetName) as { id: string; canonical_name: string; countable: number; unit_symbol: string } | undefined;

  if (!partType) {
    console.error(`No part type named "${targetName}"`);
    db.close?.();
    process.exit(1);
  }

  if (partType.countable === 0) {
    console.log(`Part type "${targetName}" is already bulk.`);
    reportQuantities(db, [partType.id]);
    db.close?.();
    return;
  }

  const instances = db
    .prepare(
      `SELECT id, qr_code, location, partdb_lot_id, created_at, updated_at FROM physical_instances WHERE part_type_id = ?`,
    )
    .all(partType.id) as Array<{
      id: string;
      qr_code: string;
      location: string;
      partdb_lot_id: string | null;
      created_at: string;
      updated_at: string;
    }>;

  console.log(`Converting "${partType.canonical_name}" from instance to bulk.`);
  console.log(`Existing instances to migrate: ${instances.length}`);

  const now = new Date().toISOString();

  db.exec("BEGIN");
  try {
    // 1. Flip the part type to bulk
    db.prepare(`UPDATE part_types SET countable = 0, updated_at = ? WHERE id = ?`).run(now, partType.id);
    console.log(`  → part_types.countable = 0`);

    // 2. For each instance, create a corresponding bulk_stock with quantity = 1
    for (const inst of instances) {
      const newBulkId = randomUUID();
      db.prepare(
        `
        INSERT INTO bulk_stocks
          (id, qr_code, part_type_id, level, quantity, minimum_quantity, location, partdb_lot_id, partdb_sync_status, version, created_at, updated_at)
        VALUES (?, ?, ?, 'good', 1, NULL, ?, ?, ?, 1, ?, ?)
        `,
      ).run(
        newBulkId,
        inst.qr_code,
        partType.id,
        inst.location,
        inst.partdb_lot_id,
        inst.partdb_lot_id ? "synced" : "pending",
        inst.created_at,
        now,
      );
      console.log(`  → bulk_stocks ${newBulkId} (qr=${inst.qr_code}, qty=1, location=${inst.location})`);

      // 3. Re-point the QR code to the new bulk entity
      db.prepare(
        `UPDATE qrcodes SET assigned_kind = 'bulk', assigned_id = ?, updated_at = ? WHERE code = ?`,
      ).run(newBulkId, now, inst.qr_code);

      // 4. Migrate stock events: same target_id, change target_type to bulk
      const eventCount = db
        .prepare(
          `UPDATE stock_events SET target_type = 'bulk', target_id = ? WHERE target_type = 'instance' AND target_id = ?`,
        )
        .run(newBulkId, inst.id).changes;
      if (eventCount > 0) console.log(`  → migrated ${eventCount} stock events`);

      // 5. Drop the old physical_instance
      db.prepare(`DELETE FROM physical_instances WHERE id = ?`).run(inst.id);
    }

    db.exec("COMMIT");
    console.log("Committed.");
    reportQuantities(db, [partType.id]);
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  db.close?.();
}

void main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
