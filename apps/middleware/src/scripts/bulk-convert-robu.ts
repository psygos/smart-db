// One-shot conversion: flip every Robu catalog item that should be tracked
// by COUNT (not by individual instance) from countable=true → bulk with pcs.
//
// Items kept as instances (identity matters): SBCs, STM32 dev boards,
// linear actuator, cameras.

import { config } from "../config.js";
import { createDatabase } from "../db/database.js";
import { randomUUID } from "node:crypto";

// Items that should remain physical_instance — every other Robu catalog item
// will be converted.
const KEEP_AS_INSTANCE = new Set<string>([
  "Arduino UNO Q (ABX00162, 2GB)",
  "Raspberry Pi 5 Model 4GB",
  "Raspberry Pi 5 Model 8GB",
  "Raspberry Pi Pico 2 W",
  "Raspberry Pi Pico 2",
  "Adafruit Feather nRF52840 Sense",
  "STM32 Nucleo-F030R8 Development Board",
  "STM32 Nucleo F303ZE Development Board",
  "STM32 Nucleo-F042K6 Development Board",
  "12V 150mm Stroke Linear Actuator (6000N, 5mm/s)",
  "Waveshare RPi IR-CUT Camera (B)",
  "Waveshare RPi Camera (I, Fisheye)",
  "Arducam 12MP USB Camera Module (M12 lens, 4K)",
]);

// Categories to consider for conversion (only Robu electronics; never touch
// the filaments or resins which are already bulk).
const CONVERT_CATEGORY_PREFIXES = [
  "Motors/",
  "Motor Control/",
  "Sensors/",
  "Power/",
  "Actuators/Solenoids",
  "Actuators/Pumps",
  "Mechanical/Servo Accessories",
];

interface PartTypeRow {
  id: string;
  canonical_name: string;
  countable: number;
  unit_symbol: string;
  category: string;
  category_path_json: string;
}


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
  const db = createDatabase(config.dataPath);

  const allCountable = db
    .prepare(
      `SELECT id, canonical_name, countable, unit_symbol, category, category_path_json
       FROM part_types
       WHERE countable = 1`,
    )
    .all() as unknown as PartTypeRow[];

  const targets = allCountable.filter((pt) => {
    if (KEEP_AS_INSTANCE.has(pt.canonical_name)) return false;
    let path: string[] = [];
    try {
      path = JSON.parse(pt.category_path_json);
    } catch {
      path = [pt.category];
    }
    const flat = path.join("/");
    return CONVERT_CATEGORY_PREFIXES.some((prefix) => flat.startsWith(prefix));
  });

  console.log(`Found ${allCountable.length} countable part types.`);
  console.log(`${targets.length} will be converted to bulk.`);
  console.log(`${KEEP_AS_INSTANCE.size} preserved as instances by name.`);
  console.log("");

  const now = new Date().toISOString();
  let convertedTypes = 0;
  const convertedIds: string[] = [];
  let migratedInstances = 0;
  let migratedEvents = 0;

  db.exec("BEGIN");
  try {
    for (const pt of targets) {
      // Skip if it has any bulk_stocks already (defensive)
      const existingBulks = db
        .prepare(`SELECT COUNT(*) AS n FROM bulk_stocks WHERE part_type_id = ?`)
        .get(pt.id) as { n: number };
      if (existingBulks.n > 0) {
        console.log(`SKIP ${pt.canonical_name} — already has ${existingBulks.n} bulk_stock(s)`);
        continue;
      }

      db.prepare(`UPDATE part_types SET countable = 0, updated_at = ? WHERE id = ?`).run(now, pt.id);
      convertedTypes += 1;
      convertedIds.push(pt.id);

      const instances = db
        .prepare(
          `SELECT id, qr_code, location, partdb_lot_id, created_at FROM physical_instances WHERE part_type_id = ?`,
        )
        .all(pt.id) as Array<{
          id: string;
          qr_code: string;
          location: string;
          partdb_lot_id: string | null;
          created_at: string;
        }>;

      for (const inst of instances) {
        const newBulkId = randomUUID();
        db.prepare(
          `
          INSERT INTO bulk_stocks
            (id, qr_code, part_type_id, level, quantity, minimum_quantity, location,
             partdb_lot_id, partdb_sync_status, version, created_at, updated_at)
          VALUES (?, ?, ?, 'good', 1, NULL, ?, ?, ?, 1, ?, ?)
          `,
        ).run(
          newBulkId,
          inst.qr_code,
          pt.id,
          inst.location,
          inst.partdb_lot_id,
          inst.partdb_lot_id ? "synced" : "pending",
          inst.created_at,
          now,
        );

        db.prepare(
          `UPDATE qrcodes SET assigned_kind = 'bulk', assigned_id = ?, updated_at = ? WHERE code = ?`,
        ).run(newBulkId, now, inst.qr_code);

        const eventChanges = db
          .prepare(
            `UPDATE stock_events SET target_type = 'bulk', target_id = ? WHERE target_type = 'instance' AND target_id = ?`,
          )
          .run(newBulkId, inst.id).changes;
        migratedEvents += Number(eventChanges);

        db.prepare(`DELETE FROM physical_instances WHERE id = ?`).run(inst.id);
        migratedInstances += 1;
      }

      console.log(`✓ ${pt.canonical_name}  (${instances.length} instance${instances.length === 1 ? "" : "s"} migrated)`);
    }

    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  console.log("");
  console.log(`Done. Converted ${convertedTypes} part types,`);
  console.log(`migrated ${migratedInstances} physical_instances → bulk_stocks,`);
  console.log(`re-pointed ${migratedEvents} stock events.`);

  reportQuantities(db, convertedIds);

  db.close?.();
}

void main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
