import { config } from "../config.js";
import { createDatabase } from "../db/database.js";
import { PartDbOutbox } from "../outbox/partdb-outbox.js";
import { PartDbOutboxWorker } from "../outbox/partdb-worker.js";
import { PartDbClient } from "../partdb/partdb-client.js";
import { CategoryResolver } from "../partdb/category-resolver.js";
import { PartDbOperations } from "../partdb/partdb-operations.js";
import { PartDbRestClient } from "../partdb/partdb-rest.js";
import { PartDbCategoriesResource } from "../partdb/resources/categories.js";
import { PartDbMeasurementUnitsResource } from "../partdb/resources/measurement-units.js";
import { PartDbPartLotsResource } from "../partdb/resources/part-lots.js";
import { PartDbPartsResource } from "../partdb/resources/parts.js";
import { PartDbStorageLocationsResource } from "../partdb/resources/storage-locations.js";
import { InventoryService } from "../services/inventory-service.js";

async function main(): Promise<void> {
  const db = createDatabase(config.dataPath);
  const syncEnabled =
    config.partDb.syncEnabled &&
    Boolean(config.partDb.baseUrl) &&
    Boolean(config.partDb.apiToken);
  const outbox = syncEnabled ? new PartDbOutbox(db) : null;
  const service = new InventoryService(db, new PartDbClient(config.partDb), outbox);

  try {
    const result = service.resetInventoryState();
    console.log(
      [
        "SmartDB reset queued.",
        `Local part types cleared: ${result.clearedPartTypes}.`,
        `Local inventory items cleared: ${result.clearedInventoryItems}.`,
        `QR codes cleared: ${result.clearedQrCodes}.`,
        `Remote part deletes queued: ${result.queuedRemotePartDeletes}.`,
        `Remote lot deletes queued: ${result.queuedRemoteLotDeletes}.`,
      ].join(" "),
    );

    if (!syncEnabled || !outbox) {
      return;
    }

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

    let totalClaimed = 0;
    let totalDelivered = 0;
    let totalFailed = 0;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const tick = await worker.tick();
      totalClaimed += tick.claimed;
      totalDelivered += tick.delivered;
      totalFailed += tick.failed;
      if (tick.claimed === 0) {
        break;
      }
    }

    console.log(
      [
        "Part-DB reset sync attempted.",
        `Claimed: ${totalClaimed}.`,
        `Delivered: ${totalDelivered}.`,
        `Failed: ${totalFailed}.`,
      ].join(" "),
    );
  } finally {
    db.close?.();
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
