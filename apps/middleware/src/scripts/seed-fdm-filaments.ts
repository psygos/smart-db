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
  aliases?: string[];
}

const KG = { symbol: "kg", name: "Kilograms", isInteger: false };

// All filaments are 1.75mm spools tracked by mass.
const CATALOG: SeedItem[] = [
  // ── PLA+ Standard ────────────────────────────────────────────────
  { name: "eSUN PLA+ 1.75mm — Black",       category: "Materials/3D Printing Filament/PLA", aliases: ["PLA+", "Black"] },
  { name: "eSUN PLA+ 1.75mm — White",       category: "Materials/3D Printing Filament/PLA", aliases: ["PLA+", "White"] },
  { name: "eSUN PLA+ 1.75mm — Yellow",      category: "Materials/3D Printing Filament/PLA", aliases: ["PLA+", "Yellow"] },
  { name: "eSUN PLA+ 1.75mm — Red",         category: "Materials/3D Printing Filament/PLA", aliases: ["PLA+", "Red"] },
  { name: "eSUN PLA+ 1.75mm — Orange",      category: "Materials/3D Printing Filament/PLA", aliases: ["PLA+", "Orange"] },
  { name: "eSUN PLA+ 1.75mm — Green",       category: "Materials/3D Printing Filament/PLA", aliases: ["PLA+", "Green"] },
  { name: "eSUN PLA+ 1.75mm — Purple",      category: "Materials/3D Printing Filament/PLA", aliases: ["PLA+", "Purple"] },
  { name: "eSUN PLA+ 1.75mm — Light Blue",  category: "Materials/3D Printing Filament/PLA", aliases: ["PLA+", "Light Blue"] },
  { name: "eSUN PLA+ 1.75mm — Brown",       category: "Materials/3D Printing Filament/PLA", aliases: ["PLA+", "Brown"] },
  { name: "eSUN PLA+ 1.75mm — Pink",        category: "Materials/3D Printing Filament/PLA", aliases: ["PLA+", "Pink"] },

  // ── PLA — Silk and Specialty ────────────────────────────────────
  { name: "eSUN PLA Silk Rainbow 1.75mm — Dragon Palace",  category: "Materials/3D Printing Filament/PLA", aliases: ["Silk", "Rainbow"] },
  { name: "eSUN PLA Silk Rainbow 1.75mm — Flaming Mountain", category: "Materials/3D Printing Filament/PLA", aliases: ["Silk", "Rainbow"] },
  { name: "eSUN PLA Luminous 1.75mm — Green",              category: "Materials/3D Printing Filament/PLA", aliases: ["Luminous", "Glow"] },
  { name: "eSUN PLA Luminous 1.75mm — Rainbow",            category: "Materials/3D Printing Filament/PLA", aliases: ["Luminous", "Glow"] },
  { name: "eSUN ePLA-Silk Magic 1.75mm — Red Blue",        category: "Materials/3D Printing Filament/PLA", aliases: ["Silk", "Magic"] },
  { name: "eSUN eSilk PLA 1.75mm — Bronze",                category: "Materials/3D Printing Filament/PLA", aliases: ["Silk", "Bronze"] },
  { name: "eSUN eSilk PLA 1.75mm — Violet",                category: "Materials/3D Printing Filament/PLA", aliases: ["Silk", "Violet"] },
  { name: "eSUN ePLA-Silk Mystic 1.75mm — Gold Green Black", category: "Materials/3D Printing Filament/PLA", aliases: ["Silk", "Mystic"] },
  { name: "eSUN ePLA-Silk Mystic 1.75mm — Gold Red Green", category: "Materials/3D Printing Filament/PLA", aliases: ["Silk", "Mystic"] },
  { name: "eSUN eMarble PLA 1.75mm — Natural Grey",        category: "Materials/3D Printing Filament/PLA", aliases: ["Marble", "Grey"] },

  // ── ABS+ ─────────────────────────────────────────────────────────
  { name: "eSUN ABS+ 1.75mm — Black",          category: "Materials/3D Printing Filament/ABS", aliases: ["ABS+", "Black"] },
  { name: "eSUN ABS+ 1.75mm — Grey",           category: "Materials/3D Printing Filament/ABS", aliases: ["ABS+", "Grey"] },
  { name: "eSUN ABS+ 1.75mm — Orange",         category: "Materials/3D Printing Filament/ABS", aliases: ["ABS+", "Orange"] },
  { name: "eSUN ABS+ 1.75mm — Fire Engine Red", category: "Materials/3D Printing Filament/ABS", aliases: ["ABS+", "Red"] },
  { name: "eSUN ABS+ 1.75mm — Silver",         category: "Materials/3D Printing Filament/ABS", aliases: ["ABS+", "Silver"] },
  { name: "eSUN ABS+ 1.75mm — Light Blue",     category: "Materials/3D Printing Filament/ABS", aliases: ["ABS+", "Light Blue"] },
  { name: "eSUN ABS+ 1.75mm — Purple",         category: "Materials/3D Printing Filament/ABS", aliases: ["ABS+", "Purple"] },
  { name: "eSUN ABS+ 1.75mm — Brown",          category: "Materials/3D Printing Filament/ABS", aliases: ["ABS+", "Brown"] },
  { name: "eSUN ABS+ 1.75mm — Natural",        category: "Materials/3D Printing Filament/ABS", aliases: ["ABS+", "Natural"] },
  { name: "eSUN ABS+ 1.75mm — Blue",           category: "Materials/3D Printing Filament/ABS", aliases: ["ABS+", "Blue"] },
  { name: "eSUN ABS+ 1.75mm — Yellow",         category: "Materials/3D Printing Filament/ABS", aliases: ["ABS+", "Yellow"] },
  { name: "eSUN ABS+ 1.75mm — Pink",           category: "Materials/3D Printing Filament/ABS", aliases: ["ABS+", "Pink"] },

  // ── PETG ─────────────────────────────────────────────────────────
  { name: "eSUN PETG 1.75mm — Yellow",            category: "Materials/3D Printing Filament/PETG", aliases: ["PETG", "Yellow"] },
  { name: "eSUN PETG 1.75mm — Solid Red",         category: "Materials/3D Printing Filament/PETG", aliases: ["PETG", "Red"] },
  { name: "eSUN PETG 1.75mm — Green",             category: "Materials/3D Printing Filament/PETG", aliases: ["PETG", "Green"] },
  { name: "eSUN PETG 1.75mm — Translucent Grey",  category: "Materials/3D Printing Filament/PETG", aliases: ["PETG", "Grey"] },
  { name: "eSUN PETG 1.75mm — Blue",              category: "Materials/3D Printing Filament/PETG", aliases: ["PETG", "Blue"] },

  // ── TPU and Flexible ─────────────────────────────────────────────
  { name: "eSUN eTPU 1.75mm — White (95A)",       category: "Materials/3D Printing Filament/TPU", aliases: ["TPU", "White", "95A"] },
  { name: "eSUN eTPU 1.75mm — Black (95A)",       category: "Materials/3D Printing Filament/TPU", aliases: ["TPU", "Black", "95A"] },
  { name: "eSUN eFlex TPU 1.75mm — Natural (87A)", category: "Materials/3D Printing Filament/TPU", aliases: ["TPU", "Flex", "Natural", "87A"] },
  { name: "eSUN eLastic 1.75mm — Black (83A)",    category: "Materials/3D Printing Filament/TPU", aliases: ["Elastic", "Black", "83A"] },
  { name: "SunLU TPU 1.75mm — Burgundy (95A)",    category: "Materials/3D Printing Filament/TPU", aliases: ["TPU", "Burgundy", "95A"] },

  // ── Carbon Fibre Nylon ───────────────────────────────────────────
  { name: "eSUN ePA12-CF 1.75mm — Black",         category: "Materials/3D Printing Filament/Nylon CF", aliases: ["Nylon", "PA12", "Carbon Fibre"] },
  { name: "eSUN PA-CF 1.75mm — Black",            category: "Materials/3D Printing Filament/Nylon CF", aliases: ["Nylon", "PA", "Carbon Fibre"] },
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
      notes: "FDM filament — track by mass",
      imageUrl: null,
      countable: false,  // bulk material
      unit: KG,
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

  console.log(`\nFilament seed complete. Created ${created}, skipped ${skipped}.`);

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
