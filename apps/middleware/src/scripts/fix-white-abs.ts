import { config } from "../config.js";
import { createDatabase } from "../db/database.js";
import { PartDbOutbox } from "../outbox/partdb-outbox.js";
import { PartDbOutboxWorker } from "../outbox/partdb-worker.js";
import { CategoryResolver } from "../partdb/category-resolver.js";
import { PartDbOperations } from "../partdb/partdb-operations.js";
import { PartDbRestClient } from "../partdb/partdb-rest.js";
import { PartDbCategoriesResource } from "../partdb/resources/categories.js";
import { PartDbMeasurementUnitsResource } from "../partdb/resources/measurement-units.js";
import { PartDbPartLotsResource } from "../partdb/resources/part-lots.js";
import { PartDbPartsResource } from "../partdb/resources/parts.js";
import { PartDbStorageLocationsResource } from "../partdb/resources/storage-locations.js";
import { randomUUID } from "node:crypto";

const PART_TYPE_NAME = "eSUN ABS+ 1.75MM - White";
const QR_CODE = "322218";

async function main(): Promise<void> {
  const db = createDatabase(config.dataPath);
  const syncEnabled =
    config.partDb.syncEnabled &&
    Boolean(config.partDb.baseUrl) &&
    Boolean(config.partDb.apiToken);
  const outbox = syncEnabled ? new PartDbOutbox(db) : null;

  // Discover the records we need to clean up
  const partType = db
    .prepare(`SELECT id, partdb_part_id FROM part_types WHERE canonical_name = ?`)
    .get(PART_TYPE_NAME) as { id: string; partdb_part_id: string | null } | undefined;

  if (!partType) {
    console.log(`No part type named "${PART_TYPE_NAME}" — nothing to clean up.`);
    db.close?.();
    return;
  }

  const instances = db
    .prepare(`SELECT id, qr_code, partdb_lot_id FROM physical_instances WHERE part_type_id = ?`)
    .all(partType.id) as Array<{ id: string; qr_code: string; partdb_lot_id: string | null }>;

  const bulks = db
    .prepare(`SELECT id, qr_code, partdb_lot_id FROM bulk_stocks WHERE part_type_id = ?`)
    .all(partType.id) as Array<{ id: string; qr_code: string; partdb_lot_id: string | null }>;

  console.log(`Part type id: ${partType.id} (Part-DB part #${partType.partdb_part_id ?? "n/a"})`);
  console.log(`Instances bound: ${instances.length}`);
  console.log(`Bulk stocks bound: ${bulks.length}`);

  const correlationId = randomUUID();
  const now = new Date().toISOString();

  // Run the local deletes inside a single SQLite transaction.
  db.exec("BEGIN");
  try {
    for (const instance of instances) {
      // Delete events first to satisfy foreign key constraints (if any).
      db.prepare(`DELETE FROM stock_events WHERE target_type = 'instance' AND target_id = ?`).run(instance.id);
      db.prepare(`DELETE FROM physical_instances WHERE id = ?`).run(instance.id);
      // Free the QR code (delete the qrcodes row entirely; it'll be re-created on next register)
      db.prepare(`DELETE FROM qrcodes WHERE code = ?`).run(instance.qr_code);
      console.log(`  voided instance ${instance.id} (QR ${instance.qr_code})`);

      // Queue Part-DB lot delete
      if (outbox && instance.partdb_lot_id) {
        outbox.enqueue(
          {
            kind: "delete_lot",
            payload: { lotIri: `/api/part_lots/${instance.partdb_lot_id}` },
            target: null,
            dependsOnId: null,
          },
          correlationId,
        );
        console.log(`  queued delete_lot for /api/part_lots/${instance.partdb_lot_id}`);
      }
    }

    for (const bulk of bulks) {
      db.prepare(`DELETE FROM stock_events WHERE target_type = 'bulk' AND target_id = ?`).run(bulk.id);
      db.prepare(`DELETE FROM bulk_stocks WHERE id = ?`).run(bulk.id);
      db.prepare(`DELETE FROM qrcodes WHERE code = ?`).run(bulk.qr_code);
      console.log(`  voided bulk ${bulk.id} (QR ${bulk.qr_code})`);

      if (outbox && bulk.partdb_lot_id) {
        outbox.enqueue(
          {
            kind: "delete_lot",
            payload: { lotIri: `/api/part_lots/${bulk.partdb_lot_id}` },
            target: null,
            dependsOnId: null,
          },
          correlationId,
        );
      }
    }

    // Finally delete the part_type itself
    db.prepare(`DELETE FROM part_types WHERE id = ?`).run(partType.id);
    console.log(`  deleted part_type ${partType.id}`);

    // Queue Part-DB part delete
    if (outbox && partType.partdb_part_id) {
      outbox.enqueue(
        {
          kind: "delete_part",
          payload: { partIri: `/api/parts/${partType.partdb_part_id}` },
          target: null,
          dependsOnId: null,
        },
        correlationId,
      );
      console.log(`  queued delete_part for /api/parts/${partType.partdb_part_id}`);
    }

    db.exec("COMMIT");
    console.log(`Local cleanup committed at ${now}`);
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  // Drain the outbox so the Part-DB deletes happen now
  if (syncEnabled && outbox) {
    const rest = new PartDbRestClient({
      baseUrl: config.partDb.baseUrl!,
      apiToken: config.partDb.apiToken!,
    });
    const worker = new PartDbOutboxWorker(
      outbox,
      new PartDbOperations(
        new CategoryResolver(db, new PartDbCategoriesResource(rest)),
        new PartDbMeasurementUnitsResource(rest),
        new PartDbPartsResource(rest),
        new PartDbPartLotsResource(rest),
        new PartDbStorageLocationsResource(rest),
      ),
      console,
      { intervalMs: 0 },
    );

    let totalDelivered = 0;
    let totalFailed = 0;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const tick = await worker.tick();
      totalDelivered += tick.delivered;
      totalFailed += tick.failed;
      if (tick.claimed === 0) break;
    }
    console.log(`Part-DB sync: delivered ${totalDelivered}, failed ${totalFailed}`);
  }

  db.close?.();
}

void main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
