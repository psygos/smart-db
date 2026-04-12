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
import { type NewPartTypeDraft } from "@smart-db/contracts";

interface SeedItem {
  name: string;
  category: string;
  unit: { symbol: string; name: string; isInteger: boolean };
  aliases?: string[];
}

const L = { symbol: "L", name: "Liters", isInteger: false };
const KG = { symbol: "kg", name: "Kilograms", isInteger: false };

// SLA / MSLA photopolymer resins — tracked by volume (or mass for the eLastic 0.5kg flexible)
const CATALOG: SeedItem[] = [
  // ── Formlabs Resins (5L bottles) ─────────────────────────────────
  { name: "Formlabs Clear Resin V5",                         category: "Materials/SLA Resin/Standard", unit: L, aliases: ["Formlabs", "Clear", "V5"] },
  { name: "Formlabs Grey Resin V5",                          category: "Materials/SLA Resin/Standard", unit: L, aliases: ["Formlabs", "Grey", "V5"] },
  { name: "Formlabs Elastic 50A Resin",                      category: "Materials/SLA Resin/Flexible", unit: L, aliases: ["Formlabs", "Elastic", "50A"] },

  // ── Elegoo Standard Resins ───────────────────────────────────────
  { name: "Elegoo Standard Resin — Grey",                    category: "Materials/SLA Resin/Standard", unit: L, aliases: ["Elegoo", "Grey"] },
  { name: "Elegoo Standard Resin — Black",                   category: "Materials/SLA Resin/Standard", unit: L, aliases: ["Elegoo", "Black"] },
  { name: "Elegoo Standard Resin — Red",                     category: "Materials/SLA Resin/Standard", unit: L, aliases: ["Elegoo", "Red"] },
  { name: "Elegoo Standard Resin — Blue",                    category: "Materials/SLA Resin/Standard", unit: L, aliases: ["Elegoo", "Blue"] },
  { name: "Elegoo Standard Resin — Green",                   category: "Materials/SLA Resin/Standard", unit: L, aliases: ["Elegoo", "Green"] },

  // ── eSUN PLA Resin ───────────────────────────────────────────────
  { name: "eSUN eResin-PLA — Grey",                          category: "Materials/SLA Resin/Standard", unit: L, aliases: ["eSUN", "PLA", "Grey"] },
  { name: "eSUN eResin-PLA — White",                         category: "Materials/SLA Resin/Standard", unit: L, aliases: ["eSUN", "PLA", "White"] },
  { name: "eSUN eResin-PLA — Black",                         category: "Materials/SLA Resin/Standard", unit: L, aliases: ["eSUN", "PLA", "Black"] },
  { name: "eSUN eResin-PLA — Clear",                         category: "Materials/SLA Resin/Standard", unit: L, aliases: ["eSUN", "PLA", "Clear"] },

  // ── eSUN Specialty Resins ────────────────────────────────────────
  { name: "eSUN eLastic Flexible Resin (0.5 kg)",            category: "Materials/SLA Resin/Flexible", unit: KG, aliases: ["eSUN", "Elastic", "Flex"] },
  { name: "eSUN Hard Tough Resin — Black",                   category: "Materials/SLA Resin/Engineering", unit: L, aliases: ["eSUN", "Tough", "Black"] },
  { name: "eSUN High Temp Resin",                            category: "Materials/SLA Resin/Engineering", unit: L, aliases: ["eSUN", "High Temp"] },
];

async function main(): Promise<void> {
  const db = createDatabase(config.dataPath);
  const syncEnabled =
    config.partDb.syncEnabled &&
    Boolean(config.partDb.baseUrl) &&
    Boolean(config.partDb.apiToken);
  const outbox = syncEnabled ? new PartDbOutbox(db) : null;
  const service = new InventoryService(db, new PartDbClient(config.partDb), outbox);

  let created = 0;
  let skipped = 0;

  for (const item of CATALOG) {
    const draft: NewPartTypeDraft = {
      kind: "new",
      canonicalName: item.name,
      category: item.category,
      aliases: item.aliases ?? [],
      notes: "SLA / MSLA photopolymer resin",
      imageUrl: null,
      countable: false,
      unit: item.unit,
    };

    try {
      const correlationId = (globalThis.crypto ?? require("node:crypto") as { randomUUID: () => string }).randomUUID();
      const partType = (service as unknown as {
        resolvePartType: (d: NewPartTypeDraft) => { id: string; canonicalName: string };
      }).resolvePartType(draft);
      (service as unknown as {
        ensurePartTypeSync: (pt: unknown, c: string) => string | null;
      }).ensurePartTypeSync(partType, correlationId);
      console.log(`✓ ${item.name}  →  ${item.category}`);
      created += 1;
    } catch (error) {
      console.error(`✗ ${item.name}`, (error as Error).message);
      skipped += 1;
    }
  }

  console.log(`\nResin seed complete. Created ${created}, skipped ${skipped}.`);

  if (!syncEnabled || !outbox) {
    db.close?.();
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

  let totalDelivered = 0;
  let totalFailed = 0;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const tick = await worker.tick();
    totalDelivered += tick.delivered;
    totalFailed += tick.failed;
    if (tick.claimed === 0) break;
  }
  console.log(`Part-DB sync drained: delivered ${totalDelivered}, failed ${totalFailed}.`);

  db.close?.();
}

void main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
