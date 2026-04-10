import { config } from "../config.js";
import { createDatabase } from "../db/database.js";
import { PartDbDeleteReconciler } from "../partdb/partdb-reconciler.js";
import { PartDbRestClient } from "../partdb/partdb-rest.js";
import { PartDbPartLotsResource } from "../partdb/resources/part-lots.js";
import { PartDbPartsResource } from "../partdb/resources/parts.js";

async function main(): Promise<void> {
  if (!config.partDb.baseUrl || !config.partDb.apiToken) {
    throw new Error(
      "Part-DB credentials are not configured. Set PARTDB_BASE_URL and PARTDB_API_TOKEN before reconciling deletes.",
    );
  }

  const db = createDatabase(config.dataPath);
  try {
    const rest = new PartDbRestClient({
      baseUrl: config.partDb.baseUrl,
      apiToken: config.partDb.apiToken,
    });
    const reconciler = new PartDbDeleteReconciler(
      db,
      new PartDbPartsResource(rest),
      new PartDbPartLotsResource(rest),
    );
    const result = await reconciler.reconcileMissingRemoteReferences();
    if (!result.ok) {
      throw new Error(`Failed to reconcile Part-DB deletions: ${result.error.kind}`);
    }

    console.log(
      [
        "Part-DB delete reconciliation finished.",
        `Part types cleared: ${result.value.clearedPartTypes}.`,
        `Instance lots cleared: ${result.value.clearedInstanceLots}.`,
        `Bulk lots cleared: ${result.value.clearedBulkLots}.`,
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
