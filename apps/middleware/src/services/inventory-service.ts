import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  bulkLevels,
  bulkStockSchema,
  categoryLeafFromPath,
  ConflictError,
  correctionEventSchema,
  defaultMeasurementUnit,
  type CorrectionEvent,
  type CorrectionKind,
  type CorrectionTargetKind,
  type EditPartTypeDefinitionCommand,
  type EditPartTypeDefinitionResponse,
  type ReassignEntityPartTypeCommand,
  type ReassignEntityPartTypeResponse,
  type ReverseIngestAssignmentCommand,
  type ReverseIngestAssignmentResponse,
  InvariantError,
  instanceStatuses,
  inventoryEntitySummarySchema,
  partTypeSchema,
  qrBatchSchema,
  type AssignQrCommand,
  type BulkLevel,
  type DashboardSummary,
  type InventoryEntitySummary,
  type InventoryTargetKind,
  type MergePartTypesRequest,
  type PartDbConnectionStatus,
  type PartType,
  type PartTypeDraft,
  type PhysicalInstance,
  type QRCode,
  type RecordEventCommand,
  type RegisterQrBatchCommand,
  type RegisterQrBatchResponse,
  type ScanResponse,
  type StockEvent,
  NotFoundError,
  partTypeSchema as persistedPartTypeSchema,
  physicalInstanceSchema,
  parseCategoryPathInput,
  qrCodeSchema,
  stockEventSchema,
  getAvailableInstanceActions,
  getAvailableBulkActions,
  getNextInstanceStatus,
  getNextBulkQuantity,
  sanitizeScannedCode,
  scanLookupCompactKey,
} from "@smart-db/contracts";
import { PartDbClient } from "../partdb/partdb-client.js";
import type { PartDbOutbox } from "../outbox/partdb-outbox.js";
import type { OutboxTarget } from "../outbox/outbox-types.js";

type SqlRow = Record<string, unknown>;
type LotOutboxTarget = {
  table: "physical_instances" | "bulk_stocks";
  rowId: string;
  column: "partdb_lot_id";
};
type PartOutboxTarget = {
  table: "part_types";
  rowId: string;
  column: "partdb_part_id";
};

interface LoadedCorrectionEntity {
  targetType: "instance" | "bulk";
  id: string;
  table: "physical_instances" | "bulk_stocks";
  qrCode: string;
  partType: PartType;
  location: string;
  state: string;
  assignee: string | null;
  quantity: number | null;
  minimumQuantity: number | null;
  partDbLotId: string | null;
  partDbSyncStatus: PartType["partDbSyncStatus"];
}

interface PartDbBackfillResult {
  queuedPartTypes: number;
  queuedLots: number;
  skipped: number;
}

interface ResetInventoryStateResult {
  clearedPartTypes: number;
  clearedInventoryItems: number;
  clearedQrCodes: number;
  queuedRemotePartDeletes: number;
  queuedRemoteLotDeletes: number;
}

export class InventoryService {
  constructor(
    private readonly db: DatabaseSync,
    private readonly partDbClient: PartDbClient,
    private readonly partDbOutbox: PartDbOutbox | null = null,
  ) {}

  getDashboardSummary(): DashboardSummary {
    const countRow = this.db
      .prepare(
        `
        SELECT
          (SELECT COUNT(*) FROM part_types) AS part_type_count,
          (SELECT COUNT(*) FROM physical_instances) AS instance_count,
          (SELECT COUNT(*) FROM bulk_stocks) AS bulk_stock_count,
          (SELECT COUNT(*) FROM part_types WHERE needs_review = 1) AS provisional_count,
          (SELECT COUNT(*) FROM qrcodes WHERE status = 'printed') AS unassigned_qr_count
        `,
      )
      .get() as SqlRow;

    const recentEvents = this.db
      .prepare(`
        SELECT se.*,
          COALESCE(
            (SELECT pt.canonical_name FROM bulk_stocks bs JOIN part_types pt ON pt.id = bs.part_type_id WHERE bs.id = se.target_id),
            (SELECT pt.canonical_name FROM physical_instances pi JOIN part_types pt ON pt.id = pi.part_type_id WHERE pi.id = se.target_id)
          ) AS part_name
        FROM stock_events se ORDER BY se.rowid DESC LIMIT 8
      `)
      .all()
      .map((row) => ({ ...mapStockEvent(row as SqlRow), partName: (row as SqlRow).part_name as string | null }));

    return {
      partTypeCount: numberFromRow(countRow.part_type_count),
      instanceCount: numberFromRow(countRow.instance_count),
      bulkStockCount: numberFromRow(countRow.bulk_stock_count),
      provisionalCount: numberFromRow(countRow.provisional_count),
      unassignedQrCount: numberFromRow(countRow.unassigned_qr_count),
      recentEvents,
    };
  }

  searchPartTypes(query: string): PartType[] {
    const normalized = query.trim().toLowerCase();
    if (!normalized) {
      return this.db
        .prepare(`SELECT * FROM part_types ORDER BY updated_at DESC LIMIT 12`)
        .all()
        .map((row) => mapPartType(row as SqlRow));
    }

    const categoryPathPattern = `%${normalized
      .split("/")
      .map((segment) => segment.trim())
      .filter(Boolean)
      .join("%")}%`;

    const rows = this.db
      .prepare(
        `
        SELECT *
        FROM part_types
        WHERE lower(canonical_name) LIKE ?
          OR lower(category) LIKE ?
          OR lower(category_path_json) LIKE ?
          OR lower(aliases_json) LIKE ?
        ORDER BY needs_review DESC, updated_at DESC
        LIMIT 20
        `,
      )
      .all(`%${normalized}%`, `%${normalized}%`, categoryPathPattern, `%${normalized}%`);

    return rows.map((row) => mapPartType(row as SqlRow));
  }

  getKnownCategories(): string[] {
    const partTypeRows = this.db
      .prepare(`SELECT DISTINCT category_path_json FROM part_types WHERE category_path_json IS NOT NULL AND category_path_json != '[]'`)
      .all() as Array<{ category_path_json: string }>;
    const standaloneRows = this.db
      .prepare(`SELECT path FROM known_categories`)
      .all() as Array<{ path: string }>;
    const paths = new Set<string>();
    for (const row of partTypeRows) {
      try {
        const parsed = JSON.parse(row.category_path_json);
        if (Array.isArray(parsed) && parsed.length > 0) {
          paths.add(parsed.join(" / "));
        }
      } catch {}
    }
    for (const row of standaloneRows) {
      paths.add(row.path);
    }
    return Array.from(paths).sort((a, b) => a.localeCompare(b));
  }

  createKnownCategory(path: string): void {
    this.db
      .prepare(`INSERT OR IGNORE INTO known_categories (path) VALUES (?)`)
      .run(path);
  }

  getPartTypeItems(partTypeId: string): {
    bulkStocks: Array<{ id: string; qrCode: string; quantity: number; location: string; minimumQuantity: number | null }>;
    instances: Array<{ id: string; qrCode: string; status: string; location: string; assignee: string | null }>;
  } {
    const pt = this.db
      .prepare(`SELECT id FROM part_types WHERE id = ?`)
      .get(partTypeId) as { id: string } | undefined;
    if (!pt) {
      throw new NotFoundError("Part type", partTypeId);
    }

    const bulkStocks = this.db
      .prepare(`SELECT id, qr_code, quantity, location, minimum_quantity FROM bulk_stocks WHERE part_type_id = ? ORDER BY location, qr_code`)
      .all(partTypeId) as Array<{ id: string; qr_code: string; quantity: number; location: string; minimum_quantity: number | null }>;

    const instances = this.db
      .prepare(`SELECT id, qr_code, status, location, assignee FROM physical_instances WHERE part_type_id = ? ORDER BY location, qr_code`)
      .all(partTypeId) as Array<{ id: string; qr_code: string; status: string; location: string; assignee: string | null }>;

    return {
      bulkStocks: bulkStocks.map((r) => ({
        id: r.id,
        qrCode: r.qr_code,
        quantity: Number(r.quantity),
        location: r.location,
        minimumQuantity: r.minimum_quantity !== null ? Number(r.minimum_quantity) : null,
      })),
      instances: instances.map((r) => ({
        id: r.id,
        qrCode: r.qr_code,
        status: r.status,
        location: r.location,
        assignee: r.assignee !== null ? String(r.assignee) : null,
      })),
    };
  }

  getInventorySummary(): Array<{
    id: string;
    canonicalName: string;
    categoryPath: string[];
    unit: { symbol: string; name: string; isInteger: boolean };
    countable: boolean;
    bins: number;
    instanceCount: number;
    onHand: number;
    partDbSyncStatus: string;
  }> {
    const rows = this.db
      .prepare(
        `
        SELECT
          pt.id,
          pt.canonical_name,
          pt.category,
          pt.category_path_json,
          pt.unit_symbol,
          pt.unit_name,
          pt.unit_is_integer,
          pt.countable,
          pt.partdb_sync_status,
          (SELECT COUNT(*) FROM bulk_stocks WHERE part_type_id = pt.id) AS bins,
          COALESCE((SELECT SUM(quantity) FROM bulk_stocks WHERE part_type_id = pt.id), 0) AS on_hand,
          (SELECT COUNT(*) FROM physical_instances WHERE part_type_id = pt.id) AS instance_count
        FROM part_types pt
        ORDER BY pt.canonical_name
        `,
      )
      .all() as Array<{
        id: string;
        canonical_name: string;
        category: string;
        category_path_json: string;
        unit_symbol: string;
        unit_name: string;
        unit_is_integer: number;
        countable: number;
        partdb_sync_status: string;
        bins: number;
        on_hand: number;
        instance_count: number;
      }>;

    return rows.map((row) => {
      let categoryPath: string[] = [];
      try {
        categoryPath = JSON.parse(row.category_path_json);
        if (!Array.isArray(categoryPath)) categoryPath = [row.category];
      } catch {
        categoryPath = [row.category];
      }
      return {
        id: row.id,
        canonicalName: row.canonical_name,
        categoryPath,
        unit: {
          symbol: row.unit_symbol,
          name: row.unit_name,
          isInteger: Boolean(row.unit_is_integer),
        },
        countable: Boolean(row.countable),
        bins: Number(row.bins),
        instanceCount: Number(row.instance_count),
        onHand: Number(row.on_hand),
        partDbSyncStatus: row.partdb_sync_status,
      };
    });
  }

  getKnownLocations(): string[] {
    const instanceRows = this.db
      .prepare(`SELECT location, updated_at FROM physical_instances WHERE location IS NOT NULL AND TRIM(location) <> ''`)
      .all() as Array<{ location: string; updated_at: string }>;
    const bulkRows = this.db
      .prepare(`SELECT location, updated_at FROM bulk_stocks WHERE location IS NOT NULL AND TRIM(location) <> ''`)
      .all() as Array<{ location: string; updated_at: string }>;
    const standaloneRows = this.db
      .prepare(`SELECT path FROM known_locations`)
      .all() as Array<{ path: string }>;
    const latest = new Map<string, string>();
    for (const row of [...instanceRows, ...bulkRows]) {
      const existing = latest.get(row.location);
      if (!existing || row.updated_at > existing) {
        latest.set(row.location, row.updated_at);
      }
    }
    for (const row of standaloneRows) {
      if (!latest.has(row.path)) {
        latest.set(row.path, "");
      }
    }
    return Array.from(latest.entries())
      .sort((a, b) => (a[1] < b[1] ? 1 : a[1] > b[1] ? -1 : a[0].localeCompare(b[0])))
      .slice(0, 200)
      .map(([loc]) => loc);
  }

  createKnownLocation(path: string): void {
    this.db
      .prepare(`INSERT OR IGNORE INTO known_locations (path) VALUES (?)`)
      .run(path);
  }

  getProvisionalPartTypes(): PartType[] {
    return this.db
      .prepare(
        `SELECT * FROM part_types WHERE needs_review = 1 ORDER BY updated_at DESC LIMIT 50`,
      )
      .all()
      .map((row) => mapPartType(row as SqlRow));
  }

  getLatestQrBatch() {
    const row = this.db
      .prepare(`SELECT * FROM qr_batches ORDER BY created_at DESC, rowid DESC LIMIT 1`)
      .get() as SqlRow | undefined;

    return row ? mapQrBatch(row) : null;
  }

  getQrBatchById(batchId: string) {
    const row = this.db
      .prepare(`SELECT * FROM qr_batches WHERE id = ?`)
      .get(batchId) as SqlRow | undefined;

    if (!row) {
      throw new NotFoundError("QR batch", batchId);
    }

    return mapQrBatch(row);
  }

  registerQrBatch(input: RegisterQrBatchCommand): RegisterQrBatchResponse {
    const actor = input.actor;
    const prefix = input.prefix;
    const startNumber = input.startNumber;
    const count = input.count;
    const batchId = input.batchId?.trim() || `batch-${randomUUID()}`;
    const createdAt = nowIso();
    const batch = {
      id: batchId,
      prefix,
      startNumber,
      endNumber: startNumber + count - 1,
      actor,
      createdAt,
    };

    let created = 0;
    let skipped = 0;
    let persistedBatch = batch;

    this.withTransaction(() => {
      const existingRow = this.db
        .prepare(`SELECT * FROM qr_batches WHERE id = ?`)
        .get(batch.id) as SqlRow | undefined;

      if (existingRow) {
        const existingBatch = mapQrBatch(existingRow);
        if (
          existingBatch.prefix !== batch.prefix ||
          existingBatch.startNumber !== batch.startNumber ||
          existingBatch.endNumber !== batch.endNumber ||
          existingBatch.actor !== batch.actor
        ) {
          throw new ConflictError("QR batch id already exists with different metadata.", {
            batchId: batch.id,
          });
        }
        persistedBatch = existingBatch;
      } else {
        this.db
          .prepare(
            `
            INSERT INTO qr_batches (id, prefix, start_number, end_number, actor, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
            `,
          )
          .run(
            batch.id,
            batch.prefix,
            batch.startNumber,
            batch.endNumber,
            batch.actor,
            batch.createdAt,
          );
      }

      const statement = this.db.prepare(
        `
        INSERT OR IGNORE INTO qrcodes (code, batch_id, status, assigned_kind, assigned_id, created_at, updated_at)
        VALUES (?, ?, 'printed', NULL, NULL, ?, ?)
        `,
      );

      for (let number = persistedBatch.startNumber; number <= persistedBatch.endNumber; number += 1) {
        const code = `${persistedBatch.prefix}-${number}`;
        const result = statement.run(code, persistedBatch.id, createdAt, createdAt);
        if (result.changes > 0) {
          created += 1;
        } else {
          skipped += 1;
        }
      }
    });

    return { batch: persistedBatch, created, skipped };
  }

  async scanCode(code: string, actor: string | null = null, options: { autoIncrement?: boolean; incrementAmount?: number } = {}): Promise<ScanResponse> {
    const normalized = sanitizeScannedCode(code);
    const qrRow = this.findQrRowByScannedCode(normalized);
    const partDb = await this.partDbClient.getLookupSummary();

    if (!qrRow) {
      return {
        mode: "unknown",
        code: normalized,
        partDb,
      };
    }

    const qrCode = mapQrCode(qrRow);
    if (qrCode.status === "assigned") {
      const entity = this.getEntityByQr(qrCode);
      if (!entity) {
        throw new InvariantError("Assigned QR is missing its inventory entity.", {
          qrCode: normalized,
        });
      }

      const recentEvents = this.db
        .prepare(
          `
          SELECT * FROM stock_events
          WHERE target_type = ? AND target_id = ?
          ORDER BY rowid DESC
          LIMIT 8
          `,
        )
        .all(entity.targetType, entity.id)
        .map((row) => mapStockEvent(row as SqlRow));

      if (entity.targetType === "instance") {
        return {
          mode: "interact",
          qrCode,
          entity: {
            ...entity,
            targetType: "instance",
          },
          recentEvents,
          availableActions: getAvailableInstanceActions(entity.state as PhysicalInstance["status"]),
          partDb,
        };
      }

      // Auto-increment when an external (manufacturer) barcode is scanned for a bulk item
      let autoIncremented = false;
      let workingEntity = entity;
      let workingRecentEvents = recentEvents;
      const autoIncrementEnabled = options.autoIncrement !== false;
      if (autoIncrementEnabled && qrCode.batchId === "external" && entity.targetType === "bulk") {
        const amount = options.incrementAmount && Number.isFinite(options.incrementAmount) && options.incrementAmount > 0
          ? options.incrementAmount
          : 1;
        const incrementResult = this.autoIncrementExternalBulk(entity.id, actor, amount);
        if (incrementResult) {
          autoIncremented = true;
          workingEntity = { ...entity, quantity: incrementResult.newQuantity };
          workingRecentEvents = this.db
            .prepare(
              `
              SELECT * FROM stock_events
              WHERE target_type = ? AND target_id = ?
              ORDER BY rowid DESC
              LIMIT 8
              `,
            )
            .all(entity.targetType, entity.id)
            .map((row) => mapStockEvent(row as SqlRow));
        }
      }

      return {
        mode: "interact",
        qrCode,
        entity: {
          ...workingEntity,
          targetType: "bulk",
        },
        recentEvents: workingRecentEvents,
        availableActions: getAvailableBulkActions(workingEntity.quantity ?? 0),
        partDb,
        ...(autoIncremented ? { autoIncremented: true } : {}),
      };
    }

    if (qrCode.status !== "printed") {
      return {
        mode: "unknown",
        code: normalized,
        partDb: {
          ...partDb,
          message: `QR ${normalized} is ${qrCode.status} and cannot be assigned.`,
        },
      };
    }

    return {
      mode: "label",
      qrCode,
      suggestions: this.searchPartTypes(""),
      partDb,
    };
  }

  splitBulkStock(
    bulkId: string,
    quantity: number,
    destinationLocation: string,
    actor: string,
    notes: string | null,
  ): { source: { id: string; quantity: number }; destination: { id: string; quantity: number } } {
    const rawDest = destinationLocation.trim().replace(/\s+/g, " ");
    const timestamp = nowIso();
    const correlationId = randomUUID();

    return this.withTransaction(() => {
      const source = this.db
        .prepare(`SELECT bs.*, pt.unit_symbol, pt.unit_is_integer, pt.id AS pt_id FROM bulk_stocks bs JOIN part_types pt ON pt.id = bs.part_type_id WHERE bs.id = ?`)
        .get(bulkId) as SqlRow | undefined;
      if (!source) {
        throw new NotFoundError("Bulk stock", bulkId);
      }

      const sourceQty = Number(source.quantity);
      const unitSymbol = String(source.unit_symbol);
      const partTypeId = String(source.pt_id);
      const currentLocation = String(source.location);
      const minQty = source.minimum_quantity !== null ? Number(source.minimum_quantity) : null;

      if (quantity <= 0 || quantity > sourceQty) {
        throw new ConflictError(`Cannot move ${quantity}; only ${sourceQty} on hand.`, { requested: quantity, available: sourceQty });
      }
      if (source.unit_is_integer && !Number.isInteger(quantity)) {
        throw new ConflictError("This unit requires whole-number quantities.", { quantity });
      }
      if (rawDest.toLowerCase() === currentLocation.toLowerCase()) {
        throw new ConflictError("Destination is the same as the current location.", { location: rawDest });
      }

      const canonicalDest = this.canonicalizeLocation(rawDest);

      // Full move: just update the location
      if (quantity === sourceQty) {
        this.db.prepare(`UPDATE bulk_stocks SET location = ?, updated_at = ? WHERE id = ?`).run(canonicalDest, timestamp, bulkId);
        this.insertEvent({ targetType: "bulk", targetId: bulkId, event: "moved", fromState: formatBulkState(sourceQty, unitSymbol, minQty), toState: formatBulkState(sourceQty, unitSymbol, minQty), location: canonicalDest, actor, notes, createdAt: timestamp });
        this.enqueueLotUpdate({ table: "bulk_stocks", rowId: bulkId, column: "partdb_lot_id" }, correlationId, { storageLocationName: canonicalDest });
        return { source: { id: bulkId, quantity: sourceQty }, destination: { id: bulkId, quantity: sourceQty } };
      }

      // Partial move: decrement source, create or augment destination
      const newSourceQty = sourceQty - quantity;
      this.db.prepare(`UPDATE bulk_stocks SET quantity = ?, updated_at = ? WHERE id = ?`).run(newSourceQty, timestamp, bulkId);
      this.insertEvent({ targetType: "bulk", targetId: bulkId, event: "adjusted", fromState: formatBulkState(sourceQty, unitSymbol, minQty), toState: formatBulkState(newSourceQty, unitSymbol, minQty), location: currentLocation, actor, notes: notes ?? `Split ${quantity} to ${canonicalDest}`, createdAt: timestamp });
      this.enqueueLotUpdate({ table: "bulk_stocks", rowId: bulkId, column: "partdb_lot_id" }, correlationId, { amount: newSourceQty });

      const existingDest = this.db
        .prepare(`SELECT id, quantity FROM bulk_stocks WHERE part_type_id = ? AND LOWER(TRIM(location)) = LOWER(?) LIMIT 1`)
        .get(partTypeId, canonicalDest) as { id: string; quantity: number } | undefined;

      if (existingDest) {
        const prevDestQty = Number(existingDest.quantity);
        const newDestQty = prevDestQty + quantity;
        this.db.prepare(`UPDATE bulk_stocks SET quantity = ?, updated_at = ? WHERE id = ?`).run(newDestQty, timestamp, existingDest.id);
        this.insertEvent({ targetType: "bulk", targetId: existingDest.id, event: "restocked", fromState: formatBulkState(prevDestQty, unitSymbol, null), toState: formatBulkState(newDestQty, unitSymbol, null), location: canonicalDest, actor, notes: `Received ${quantity} from ${currentLocation}`, createdAt: timestamp });
        this.enqueueLotUpdate({ table: "bulk_stocks", rowId: existingDest.id, column: "partdb_lot_id" }, correlationId, { amount: newDestQty });
        return { source: { id: bulkId, quantity: newSourceQty }, destination: { id: existingDest.id, quantity: newDestQty } };
      }

      // Create new bin with auto-generated QR in external batch
      this.ensureExternalBatch();
      const newQrCode = `SPLIT-${randomUUID().slice(0, 8)}`;
      const newBulkId = randomUUID();
      this.db.prepare(`INSERT INTO qrcodes (code, batch_id, status, assigned_kind, assigned_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(newQrCode, "external", "assigned", "bulk", newBulkId, timestamp, timestamp);
      this.db.prepare(`INSERT INTO bulk_stocks (id, qr_code, part_type_id, level, quantity, minimum_quantity, location, partdb_lot_id, partdb_sync_status, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, NULL, ?, NULL, ?, 1, ?, ?)`).run(newBulkId, newQrCode, partTypeId, "good", quantity, canonicalDest, "pending", timestamp, timestamp);
      this.insertEvent({ targetType: "bulk", targetId: newBulkId, event: "labeled", fromState: null, toState: formatBulkState(quantity, unitSymbol, null), location: canonicalDest, actor, notes: `Split from ${currentLocation}`, createdAt: timestamp });

      const partType = this.findPartType(partTypeId);
      if (partType) {
        const partSyncDep = this.ensurePartTypeSync(partType, correlationId);
        this.enqueueCreateLot({ table: "bulk_stocks", rowId: newBulkId, column: "partdb_lot_id" }, correlationId, partType, canonicalDest, newQrCode, `Split from ${currentLocation}`, quantity, partSyncDep);
      }
      return { source: { id: bulkId, quantity: newSourceQty }, destination: { id: newBulkId, quantity } };
    });
  }

  private canonicalizeLocation(raw: string): string {
    const existing = this.db
      .prepare(`SELECT location FROM physical_instances WHERE LOWER(TRIM(location)) = LOWER(?) ORDER BY updated_at DESC LIMIT 1`)
      .get(raw) as { location: string } | undefined;
    if (existing) return existing.location;
    const existingBulk = this.db
      .prepare(`SELECT location FROM bulk_stocks WHERE LOWER(TRIM(location)) = LOWER(?) ORDER BY updated_at DESC LIMIT 1`)
      .get(raw) as { location: string } | undefined;
    return existingBulk?.location ?? raw;
  }

  private autoIncrementExternalBulk(bulkId: string, actor: string | null, amount: number = 1): { newQuantity: number } | null {
    const row = this.db
      .prepare(`SELECT quantity FROM bulk_stocks WHERE id = ?`)
      .get(bulkId) as { quantity: number } | undefined;
    if (!row) return null;
    const previous = row.quantity ?? 0;
    const newQuantity = previous + amount;
    const timestamp = nowIso();
    const correlationId = randomUUID();

    this.withTransaction(() => {
      this.db
        .prepare(`UPDATE bulk_stocks SET quantity = ?, updated_at = ? WHERE id = ?`)
        .run(newQuantity, timestamp, bulkId);
      this.db
        .prepare(
          `INSERT INTO stock_events (id, target_type, target_id, event, from_state, to_state, location, actor, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
        )
        .run(
          randomUUID(),
          "bulk",
          bulkId,
          "restocked",
          String(previous),
          String(newQuantity),
          actor ?? "system",
          `Auto-increment +${amount} from external barcode scan`,
          timestamp,
        );

      // Propagate the new quantity to Part-DB via the outbox
      this.enqueueLotUpdate(
        { table: "bulk_stocks", rowId: bulkId, column: "partdb_lot_id" },
        correlationId,
        { amount: newQuantity },
      );
    });

    return { newQuantity };
  }

  private ensureExternalBatch(): void {
    const existing = this.db
      .prepare(`SELECT id FROM qr_batches WHERE id = 'external'`)
      .get();
    if (existing) return;
    this.db
      .prepare(
        `
        INSERT INTO qr_batches (id, prefix, start_number, end_number, actor, created_at)
        VALUES ('external', 'EXT', 0, 0, 'system', ?)
        `,
      )
      .run(nowIso());
  }

  assignQr(input: AssignQrCommand): InventoryEntitySummary {
    const qrCodeValue = sanitizeScannedCode(input.qrCode);
    const actor = input.actor;
    const rawLocation = input.location.trim().replace(/\s+/g, " ");
    const location = this.canonicalizeLocation(rawLocation);
    let qrRow = this.findQrRowByScannedCode(qrCodeValue);

    if (!qrRow) {
      // External (manufacturer) barcode — auto-register against the external batch
      this.ensureExternalBatch();
      const externalNow = nowIso();
      this.db
        .prepare(
          `INSERT INTO qrcodes (code, batch_id, status, assigned_kind, assigned_id, created_at, updated_at) VALUES (?, ?, ?, NULL, NULL, ?, ?)`,
        )
        .run(qrCodeValue, "external", "printed", externalNow, externalNow);
      qrRow = this.db
        .prepare(`SELECT * FROM qrcodes WHERE code = ?`)
        .get(qrCodeValue) as SqlRow | undefined;
      if (!qrRow) {
        throw new InvariantError("External barcode insertion failed.", { code: qrCodeValue });
      }
    }

    const qrCode = mapQrCode(qrRow);
    if (qrCode.status !== "printed") {
      throw new ConflictError(`QR ${qrCodeValue} is already ${qrCode.status}.`, {
        qrCode: qrCodeValue,
        status: qrCode.status,
      });
    }

    const partType = this.resolvePartType(input.partType);
    enforcePartTypeCompatibility(input.entityKind, partType);
    const timestamp = nowIso();
    const correlationId = randomUUID();
    let summary: InventoryEntitySummary | null = null;

    this.withTransaction(() => {
      const partSyncDependencyId = this.ensurePartTypeSync(partType, correlationId);

      if (input.entityKind === "instance") {
        const initialStatus = validInstanceStatus(input.initialStatus)
          ? input.initialStatus
          : "available";
        const id = randomUUID();
        this.db
          .prepare(
            `
            INSERT INTO physical_instances
              (id, qr_code, part_type_id, status, location, assignee, partdb_sync_status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, NULL, 'never', ?, ?)
            `,
          )
          .run(id, qrCodeValue, partType.id, initialStatus, location, timestamp, timestamp);

        this.updateQrAssignment(qrCodeValue, "instance", id, timestamp);
        this.enqueueCreateLot(
          {
            table: "physical_instances",
            rowId: id,
            column: "partdb_lot_id",
          },
          correlationId,
          partType,
          location,
          qrCodeValue,
          input.notes ?? "",
          1,
          partSyncDependencyId,
        );
        this.insertEvent({
          targetType: "instance",
          targetId: id,
          event: "labeled",
          fromState: null,
          toState: initialStatus,
          location,
          actor,
          notes: input.notes ?? null,
          createdAt: timestamp,
        });
      } else {
        const initialQuantity = requireFinitePositiveQuantity(input.initialQuantity, "initialQuantity");
        const minimumQuantity =
          input.minimumQuantity === null
            ? null
            : requireFiniteNonNegativeQuantity(input.minimumQuantity, "minimumQuantity");
        requireUnitCompatibleQuantity(initialQuantity, partType.unit, "initialQuantity");
        if (minimumQuantity !== null) {
          requireUnitCompatibleQuantity(minimumQuantity, partType.unit, "minimumQuantity");
        }
        const initialLevel = persistedBulkLevelFromQuantity(initialQuantity, minimumQuantity);
        const id = randomUUID();
        this.db
          .prepare(
            `
            INSERT INTO bulk_stocks
              (id, qr_code, part_type_id, level, quantity, minimum_quantity, location, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `,
          )
          .run(id, qrCodeValue, partType.id, initialLevel, initialQuantity, minimumQuantity, location, timestamp, timestamp);

        this.updateQrAssignment(qrCodeValue, "bulk", id, timestamp);
        this.enqueueCreateLot(
          {
            table: "bulk_stocks",
            rowId: id,
            column: "partdb_lot_id",
          },
          correlationId,
          partType,
          location,
          qrCodeValue,
          input.notes ?? "",
          initialQuantity,
          partSyncDependencyId,
        );
        this.insertEvent({
          targetType: "bulk",
          targetId: id,
          event: "labeled",
          fromState: null,
          toState: formatBulkState(initialQuantity, partType.unit.symbol, minimumQuantity),
          location,
          actor,
          notes: input.notes ?? null,
          createdAt: timestamp,
        });
      }

      const assignedQr = this.db
        .prepare(`SELECT * FROM qrcodes WHERE code = ?`)
        .get(qrCodeValue) as SqlRow;
      summary = this.getEntityByQr(mapQrCode(assignedQr));
    });

    if (!summary) {
      throw new InvariantError("Assignment succeeded, but the summary could not be built.", {
        qrCode: qrCodeValue,
      });
    }

    return summary;
  }

  recordEvent(input: RecordEventCommand): StockEvent {
    const actor = input.actor;
    const targetId = input.targetId;
    const timestamp = nowIso();
    const correlationId = randomUUID();

    if (input.targetType === "instance") {
      const row = this.db
        .prepare(`SELECT * FROM physical_instances WHERE id = ?`)
        .get(targetId) as SqlRow | undefined;
      if (!row) {
        throw new NotFoundError("Physical instance", targetId);
      }

      const current = mapPhysicalInstance(row);
      const location =
        input.event === "moved"
          ? requireChangedLocation(input.location, current.location, input.event)
          : input.location?.trim() || current.location;

      const nextStatus = getNextInstanceStatus(current.status, input.event);
      if (nextStatus === null) {
        throw new ConflictError(
          `Cannot perform '${input.event}' on an instance with status '${current.status}'.`,
          { currentStatus: current.status, event: input.event },
        );
      }

      let assignee = current.assignee;
      if (input.event === "checked_out") {
        assignee = input.assignee?.trim() || actor;
      } else if (input.event === "returned" || input.event === "consumed" || input.event === "disposed" || input.event === "damaged" || input.event === "lost") {
        assignee = null;
      }

      this.withTransaction(() => {
        this.db
          .prepare(
            `
            UPDATE physical_instances
            SET status = ?, location = ?, assignee = ?, updated_at = ?
            WHERE id = ?
            `,
          )
          .run(nextStatus, location, assignee, timestamp, current.id);

        this.insertEvent({
          targetType: "instance",
          targetId: current.id,
          event: input.event,
          fromState: current.status,
          toState: nextStatus,
          location,
          actor,
          notes: input.notes ?? null,
          createdAt: timestamp,
        });

        if (input.event === "moved") {
          this.enqueueLotUpdate(
            {
              table: "physical_instances",
              rowId: current.id,
              column: "partdb_lot_id",
            },
            correlationId,
            {
              storageLocationName: location,
            },
          );
        }
      });

      return this.latestEvent("instance", current.id);
    }

    const row = this.db
      .prepare(`SELECT * FROM bulk_stocks WHERE id = ?`)
      .get(targetId) as SqlRow | undefined;
    if (!row) {
      throw new NotFoundError("Bulk stock", targetId);
    }

    const current = mapBulkStock(row);
    if ("quantityDelta" in input && !Number.isFinite(input.quantityDelta)) {
      throw new InvariantError(`Parsed '${input.event}' command is missing a finite quantity delta.`, {
        event: input.event,
      });
    }
    if ("quantity" in input && !Number.isFinite(input.quantity)) {
      throw new InvariantError(`Parsed '${input.event}' command is missing a finite quantity.`, {
        event: input.event,
      });
    }

    const location =
      input.event === "moved"
        ? requireChangedLocation(input.location, current.location, input.event)
        : input.location?.trim() || current.location;

    const nextQuantity = getNextBulkQuantity(
      current.quantity,
      input.event,
      "quantity" in input
        ? { quantity: input.quantity }
        : "quantityDelta" in input
          ? { quantityDelta: input.quantityDelta }
          : {},
    );
    if (nextQuantity === null) {
      throw new ConflictError(
        `Cannot perform '${input.event}' on bulk stock with quantity '${current.quantity}'.`,
        { currentQuantity: current.quantity, event: input.event },
      );
    }
    const nextLevel = persistedBulkLevelFromQuantity(nextQuantity, current.minimumQuantity);
    const partType = this.findPartType(current.partTypeId);
    if (!partType) {
      throw new InvariantError("Bulk stock is missing its part type.", { partTypeId: current.partTypeId });
    }
    requireUnitCompatibleQuantity(nextQuantity, partType.unit, "quantity");

    this.withTransaction(() => {
      this.db
        .prepare(
          `
          UPDATE bulk_stocks
          SET level = ?, quantity = ?, location = ?, updated_at = ?
          WHERE id = ?
          `,
        )
        .run(nextLevel, nextQuantity, location, timestamp, current.id);

      this.insertEvent({
        targetType: "bulk",
        targetId: current.id,
        event: input.event,
        fromState: formatBulkState(current.quantity, partType.unit.symbol, current.minimumQuantity),
        toState: formatBulkState(nextQuantity, partType.unit.symbol, current.minimumQuantity),
        location,
        actor,
        notes: input.notes ?? null,
        createdAt: timestamp,
      });

      if (input.event === "moved") {
        this.enqueueLotUpdate(
          {
            table: "bulk_stocks",
            rowId: current.id,
            column: "partdb_lot_id",
          },
          correlationId,
          {
            storageLocationName: location,
          },
        );
      } else {
        this.enqueueLotUpdate(
          {
            table: "bulk_stocks",
            rowId: current.id,
            column: "partdb_lot_id",
          },
          correlationId,
          {
            amount: nextQuantity,
          },
        );
      }
    });

    return this.latestEvent("bulk", current.id);
  }

  mergePartTypes(input: MergePartTypesRequest): PartType {
    const source = this.findPartType(input.sourcePartTypeId);
    const destination = this.findPartType(input.destinationPartTypeId);

    if (!source) {
      throw new NotFoundError("Part type", input.sourcePartTypeId);
    }
    if (!destination) {
      throw new NotFoundError("Part type", input.destinationPartTypeId);
    }

    if (source.id === destination.id) {
      throw new ConflictError("Cannot merge a part type into itself.", {
        sourcePartTypeId: source.id,
        destinationPartTypeId: destination.id,
      });
    }

    const aliasSet = new Set(destination.aliases);
    aliasSet.add(input.aliasLabel?.trim() || source.canonicalName);
    for (const alias of source.aliases) {
      aliasSet.add(alias);
    }

    const mergedAliases = Array.from(aliasSet)
      .map((alias) => alias.trim())
      .filter(Boolean)
      .sort();
    const timestamp = nowIso();

    this.withTransaction(() => {
      this.db
        .prepare(
          `UPDATE physical_instances SET part_type_id = ? WHERE part_type_id = ?`,
        )
        .run(destination.id, source.id);
      this.db
        .prepare(`UPDATE bulk_stocks SET part_type_id = ? WHERE part_type_id = ?`)
        .run(destination.id, source.id);
      this.db
        .prepare(
          `
          UPDATE part_types
          SET aliases_json = ?, needs_review = 0, updated_at = ?
          WHERE id = ?
          `,
        )
        .run(JSON.stringify(mergedAliases), timestamp, destination.id);
      this.db.prepare(`DELETE FROM part_types WHERE id = ?`).run(source.id);
    });

    const partType = this.findPartType(destination.id);
    if (!partType) {
      throw new InvariantError(
        "Merge succeeded, but the destination part type is missing.",
        { destinationPartTypeId: destination.id },
      );
    }

    return partType;
  }

  voidQrCode(code: string, actor: string): QRCode {
    const normalized = sanitizeScannedCode(code);
    const qrRow = this.findQrRowByScannedCode(normalized);

    if (!qrRow) {
      throw new NotFoundError("QR code", normalized);
    }

    const qrCode = mapQrCode(qrRow);
    if (qrCode.status === "voided") {
      return qrCode;
    }

    const timestamp = nowIso();
    const correlationId = randomUUID();

    this.withTransaction(() => {
      if (qrCode.status === "assigned" && qrCode.assignedKind && qrCode.assignedId) {
        if (qrCode.assignedKind === "instance") {
          const row = this.db
            .prepare(`SELECT * FROM physical_instances WHERE id = ?`)
            .get(qrCode.assignedId) as SqlRow | undefined;
          if (row) {
            const instance = mapPhysicalInstance(row);
            this.db
              .prepare(`UPDATE physical_instances SET status = 'consumed', updated_at = ? WHERE id = ?`)
              .run(timestamp, instance.id);
            this.insertEvent({
              targetType: "instance",
              targetId: instance.id,
              event: "disposed",
              fromState: instance.status,
              toState: "consumed",
              location: instance.location,
              actor,
              notes: "Voided via QR void",
              createdAt: timestamp,
            });
            this.enqueueDeleteLot(
              {
                table: "physical_instances",
                rowId: instance.id,
                column: "partdb_lot_id",
              },
              correlationId,
            );
          }
        } else {
          const row = this.db
            .prepare(`SELECT * FROM bulk_stocks WHERE id = ?`)
            .get(qrCode.assignedId) as SqlRow | undefined;
          if (row) {
            const bulk = mapBulkStock(row);
            this.db
              .prepare(`UPDATE bulk_stocks SET level = 'empty', updated_at = ? WHERE id = ?`)
              .run(timestamp, bulk.id);
            this.insertEvent({
              targetType: "bulk",
              targetId: bulk.id,
              event: "consumed",
              fromState: bulk.level,
              toState: "empty",
              location: bulk.location,
              actor,
              notes: "Voided via QR void",
              createdAt: timestamp,
            });
            this.enqueueDeleteLot(
              {
                table: "bulk_stocks",
                rowId: bulk.id,
                column: "partdb_lot_id",
              },
              correlationId,
            );
          }
        }
      }

      this.db
        .prepare(`UPDATE qrcodes SET status = 'voided', updated_at = ? WHERE code = ?`)
        .run(timestamp, normalized);
    });

    const updated = this.db
      .prepare(`SELECT * FROM qrcodes WHERE code = ?`)
      .get(normalized) as SqlRow;
    return mapQrCode(updated);
  }

  approvePartType(id: string): PartType {
    const partType = this.findPartType(id);
    if (!partType) {
      throw new NotFoundError("Part type", id);
    }

    const timestamp = nowIso();
    this.db
      .prepare(`UPDATE part_types SET needs_review = 0, updated_at = ? WHERE id = ?`)
      .run(timestamp, id);

    const updated = this.findPartType(id);
    if (!updated) {
      throw new InvariantError("Approved part type could not be read back.", { partTypeId: id });
    }
    return updated;
  }

  getCorrectionHistory(targetType: CorrectionTargetKind, targetId: string): CorrectionEvent[] {
    return this.db
      .prepare(`
        SELECT *
        FROM correction_events
        WHERE target_type = ? AND target_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT 50
      `)
      .all(targetType, targetId)
      .map((row) => mapCorrectionEvent(row as SqlRow));
  }

  reassignEntityPartType(input: ReassignEntityPartTypeCommand): ReassignEntityPartTypeResponse {
    const target = this.loadCorrectionEntity(input.targetType, input.targetId);
    if (!target) {
      throw new NotFoundError(input.targetType === "instance" ? "Physical instance" : "Bulk stock", input.targetId);
    }

    if (target.partType.id !== input.fromPartTypeId) {
      throw new ConflictError("The scanned entity no longer points at the expected part type.", {
        targetId: input.targetId,
        currentPartTypeId: target.partType.id,
        expectedPartTypeId: input.fromPartTypeId,
      });
    }

    const replacement = this.findPartType(input.toPartTypeId);
    if (!replacement) {
      throw new NotFoundError("Part type", input.toPartTypeId);
    }

    enforcePartTypeCompatibility(input.targetType, replacement);
    this.assertNoPendingLotSync(target.table, target.id, "Wait for Part-DB lot sync to finish before correcting this item.");

    const timestamp = nowIso();
    const correlationId = randomUUID();
    let correctionEvent: CorrectionEvent | null = null;

    this.withTransaction(() => {
      this.db
        .prepare(`UPDATE ${target.table} SET part_type_id = ?, updated_at = ? WHERE id = ?`)
        .run(replacement.id, timestamp, target.id);

      correctionEvent = this.insertCorrectionEvent({
        targetType: input.targetType,
        targetId: input.targetId,
        correctionKind: "entity_part_type_reassigned",
        actor: input.actor,
        reason: input.reason,
        before: buildEntityCorrectionSnapshot(target),
        after: {
          ...buildEntityCorrectionSnapshot(target),
          partTypeId: replacement.id,
          partTypeName: replacement.canonicalName,
          categoryPath: replacement.categoryPath,
          countable: replacement.countable,
          unitSymbol: replacement.unit.symbol,
        },
        createdAt: timestamp,
      });

      if (target.partDbLotId) {
        this.db
          .prepare(`UPDATE ${target.table} SET partdb_lot_id = NULL, partdb_sync_status = 'pending' WHERE id = ?`)
          .run(target.id);

        this.partDbOutbox?.enqueue(
          {
            kind: "delete_lot",
            payload: {
              lotIri: `/api/part_lots/${target.partDbLotId}`,
            },
            target: null,
            dependsOnId: null,
          },
          correlationId,
        );

        const partDependencyId = this.ensurePartTypeSync(replacement, correlationId);
        this.enqueueCreateLot(
          {
            table: target.table,
            rowId: target.id,
            column: "partdb_lot_id",
          },
          correlationId,
          replacement,
          target.location,
          target.qrCode,
          "",
          target.targetType === "instance" ? 1 : (target.quantity ?? 0),
          partDependencyId,
        );
      }
    });

    if (!correctionEvent) {
      throw new InvariantError("Correction succeeded without recording a correction event.", {
        targetId: input.targetId,
      });
    }

    const entity = this.getEntityByTarget(input.targetType, input.targetId);
    if (!entity) {
      throw new InvariantError("Reassigned entity could not be read back.", {
        targetId: input.targetId,
      });
    }

    return {
      entity,
      correctionEvent,
    };
  }

  editPartTypeDefinition(input: EditPartTypeDefinitionCommand): EditPartTypeDefinitionResponse {
    const partType = this.findPartType(input.partTypeId);
    if (!partType) {
      throw new NotFoundError("Part type", input.partTypeId);
    }

    if (partType.updatedAt !== input.expectedUpdatedAt) {
      throw new ConflictError("The shared part type changed before your correction was submitted.", {
        partTypeId: input.partTypeId,
        expectedUpdatedAt: input.expectedUpdatedAt,
        actualUpdatedAt: partType.updatedAt,
      });
    }

    const categoryPath = parseCategoryPathInput(input.category);
    if (!categoryPath.ok) {
      throw new InvariantError("Parsed part type category path is invalid.", {
        category: input.category,
        reason: categoryPath.error,
      });
    }

    const canonicalName = input.canonicalName.trim().replace(/\s+/g, " ");
    const category = categoryLeafFromPath(categoryPath.value);
    const conflictingPartType = this.findConflictingSharedPartTypeDefinition(
      input.partTypeId,
      canonicalName,
      categoryPath.value,
    );
    if (conflictingPartType) {
      throw new ConflictError(
        "A shared part type with this name and category already exists. Reassign this scanned item/bin to that type instead of renaming the shared type.",
        {
          partTypeId: input.partTypeId,
          conflictingPartTypeId: conflictingPartType.id,
          canonicalName,
          categoryPath: categoryPath.value,
        },
      );
    }
    const timestamp = nowIso();
    const correlationId = randomUUID();
    const before = {
      canonicalName: partType.canonicalName,
      categoryPath: partType.categoryPath,
      updatedAt: partType.updatedAt,
    };
    let correctionEvent: CorrectionEvent | null = null;

    this.assertNoPendingPartSync(input.partTypeId, "Wait for Part-DB part sync to finish before editing this shared part type.");

    this.withTransaction(() => {
      this.db
        .prepare(`
          UPDATE part_types
          SET canonical_name = ?, category = ?, category_path_json = ?, updated_at = ?
          WHERE id = ?
        `)
        .run(canonicalName, category, JSON.stringify(categoryPath.value), timestamp, input.partTypeId);

      correctionEvent = this.insertCorrectionEvent({
        targetType: "part_type",
        targetId: input.partTypeId,
        correctionKind: "part_type_definition_edited",
        actor: input.actor,
        reason: input.reason,
        before,
        after: {
          canonicalName,
          categoryPath: categoryPath.value,
          updatedAt: timestamp,
        },
        createdAt: timestamp,
      });

      const updatedPartType = this.findPartType(input.partTypeId);
      if (!updatedPartType) {
        throw new InvariantError("Updated shared part type could not be read during correction.", {
          partTypeId: input.partTypeId,
        });
      }

      if (updatedPartType.partDbPartId) {
        this.partDbOutbox?.enqueue(
          {
            kind: "update_part",
            payload: {
              partIri: `/api/parts/${updatedPartType.partDbPartId}`,
              patch: {
                name: updatedPartType.canonicalName,
                categoryPath: updatedPartType.categoryPath,
                unit: updatedPartType.unit,
                description: updatedPartType.notes ?? "",
                tags: updatedPartType.aliases,
              },
            },
            target: {
              table: "part_types",
              rowId: updatedPartType.id,
              column: "partdb_part_id",
            },
            dependsOnId: null,
          },
          correlationId,
        );
      } else {
        this.ensurePartTypeSync(updatedPartType, correlationId);
      }
    });

    if (!correctionEvent) {
      throw new InvariantError("Shared part type correction succeeded without a correction event.", {
        partTypeId: input.partTypeId,
      });
    }

    const updated = this.findPartType(input.partTypeId);
    if (!updated) {
      throw new InvariantError("Updated part type could not be read back after correction.", {
        partTypeId: input.partTypeId,
      });
    }

    return {
      partType: updated,
      correctionEvent,
    };
  }

  reverseIngestAssignment(input: ReverseIngestAssignmentCommand): ReverseIngestAssignmentResponse {
    const normalizedCode = sanitizeScannedCode(input.qrCode);
    const qrRow = this.findQrRowByScannedCode(normalizedCode);
    if (!qrRow) {
      throw new NotFoundError("QR code", normalizedCode);
    }

    const qrCode = mapQrCode(qrRow);
    if (
      qrCode.status !== "assigned" ||
      qrCode.assignedKind !== input.assignedKind ||
      qrCode.assignedId !== input.assignedId
    ) {
      throw new ConflictError("The scanned QR no longer points at the expected ingested entity.", {
        qrCode: normalizedCode,
        expectedAssignedKind: input.assignedKind,
        expectedAssignedId: input.assignedId,
        actualAssignedKind: qrCode.assignedKind,
        actualAssignedId: qrCode.assignedId,
      });
    }

    const target = this.loadCorrectionEntity(input.assignedKind, input.assignedId);
    if (!target) {
      throw new NotFoundError(input.assignedKind === "instance" ? "Physical instance" : "Bulk stock", input.assignedId);
    }

    this.assertOnlyLabeledHistory(target.targetType, target.id);
    this.assertNoPendingLotSync(target.table, target.id, "Wait for Part-DB lot sync to finish before reversing this ingest.");

    const timestamp = nowIso();
    const correlationId = randomUUID();
    let correctionEvent: CorrectionEvent | null = null;

    this.withTransaction(() => {
      correctionEvent = this.insertCorrectionEvent({
        targetType: target.targetType,
        targetId: target.id,
        correctionKind: "ingest_reversed",
        actor: input.actor,
        reason: input.reason,
        before: buildEntityCorrectionSnapshot(target),
        after: {
          qrCode: target.qrCode,
          qrStatus: "printed",
          assignedKind: null,
          assignedId: null,
        },
        createdAt: timestamp,
      });

      if (target.partDbLotId) {
        this.partDbOutbox?.enqueue(
          {
            kind: "delete_lot",
            payload: {
              lotIri: `/api/part_lots/${target.partDbLotId}`,
            },
            target: null,
            dependsOnId: null,
          },
          correlationId,
        );
      }

      this.db.prepare(`DELETE FROM ${target.table} WHERE id = ?`).run(target.id);
      this.db
        .prepare(`
          UPDATE qrcodes
          SET status = 'printed', assigned_kind = NULL, assigned_id = NULL, updated_at = ?
          WHERE code = ?
        `)
        .run(timestamp, target.qrCode);
    });

    if (!correctionEvent) {
      throw new InvariantError("Ingest reversal succeeded without recording a correction event.", {
        qrCode: normalizedCode,
      });
    }

    const updated = this.db
      .prepare(`SELECT * FROM qrcodes WHERE code = ?`)
      .get(target.qrCode) as SqlRow | undefined;
    if (!updated) {
      throw new InvariantError("Reversed QR could not be read back.", {
        qrCode: target.qrCode,
      });
    }

    return {
      qrCode: mapQrCode(updated),
      correctionEvent,
    };
  }

  async getPartDbStatus(): Promise<PartDbConnectionStatus> {
    return this.partDbClient.getConnectionStatus();
  }

  resetInventoryState(): ResetInventoryStateResult {
    const outbox = this.partDbOutbox;
    const correlationId = randomUUID();
    let queuedRemotePartDeletes = 0;
    let queuedRemoteLotDeletes = 0;
    let clearedPartTypes = 0;
    let clearedInventoryItems = 0;
    let clearedQrCodes = 0;

    this.withTransaction(() => {
      const parts = this.db
        .prepare(`SELECT id, partdb_part_id FROM part_types ORDER BY created_at, id`)
        .all() as Array<{ id: string; partdb_part_id: string | null }>;
      const instances = this.db
        .prepare(`SELECT id, part_type_id, partdb_lot_id FROM physical_instances ORDER BY created_at, id`)
        .all() as Array<{ id: string; part_type_id: string; partdb_lot_id: string | null }>;
      const bulkStocks = this.db
        .prepare(`SELECT id, part_type_id, partdb_lot_id FROM bulk_stocks ORDER BY created_at, id`)
        .all() as Array<{ id: string; part_type_id: string; partdb_lot_id: string | null }>;
      const qrCountRow = this.db
        .prepare(`SELECT COUNT(*) AS count FROM qrcodes`)
        .get() as { count: number };

      clearedPartTypes = parts.length;
      clearedInventoryItems = instances.length + bulkStocks.length;
      clearedQrCodes = Number(qrCountRow.count);

      if (outbox) {
        this.db.prepare(`DELETE FROM partdb_outbox`).run();
        const lastDeleteByPartType = new Map<string, string | null>();

        for (const item of [...instances, ...bulkStocks]) {
          if (!item.partdb_lot_id) {
            continue;
          }

          const opId = outbox.enqueue(
            {
              kind: "delete_lot",
              payload: {
                lotIri: `/api/part_lots/${item.partdb_lot_id}`,
              },
              target: null,
              dependsOnId: lastDeleteByPartType.get(item.part_type_id) ?? null,
            },
            correlationId,
          );
          lastDeleteByPartType.set(item.part_type_id, opId);
          queuedRemoteLotDeletes += 1;
        }

        for (const part of parts) {
          if (!part.partdb_part_id) {
            continue;
          }

          outbox.enqueue(
            {
              kind: "delete_part",
              payload: {
                partIri: `/api/parts/${part.partdb_part_id}`,
              },
              target: null,
              dependsOnId: lastDeleteByPartType.get(part.id) ?? null,
            },
            correlationId,
          );
          queuedRemotePartDeletes += 1;
        }
      }

      this.db.prepare(`DELETE FROM stock_events`).run();
      this.db.prepare(`DELETE FROM physical_instances`).run();
      this.db.prepare(`DELETE FROM bulk_stocks`).run();
      this.db.prepare(`DELETE FROM qrcodes`).run();
      this.db.prepare(`DELETE FROM qr_batches`).run();
      this.db.prepare(`DELETE FROM part_types`).run();
      this.db.prepare(`DELETE FROM partdb_category_cache`).run();
      this.db.prepare(`DELETE FROM idempotency_keys`).run();
    });

    return {
      clearedPartTypes,
      clearedInventoryItems,
      clearedQrCodes,
      queuedRemotePartDeletes,
      queuedRemoteLotDeletes,
    };
  }

  backfillPartDbSync(): PartDbBackfillResult {
    const outbox = this.partDbOutbox;
    if (!outbox) {
      return {
        queuedPartTypes: 0,
        queuedLots: 0,
        skipped: 0,
      };
    }

    const correlationId = randomUUID();
    let queuedPartTypes = 0;
    let queuedLots = 0;
    let skipped = 0;

    this.withTransaction(() => {
      const partTypes = this.db
        .prepare(`SELECT * FROM part_types ORDER BY created_at, id`)
        .all()
        .map((row) => mapPartType(row as SqlRow));
      const partTypesById = new Map(partTypes.map((partType) => [partType.id, partType]));
      const partDependencies = new Map<string, string | null>();

      for (const partType of partTypes) {
        if (partType.partDbPartId) {
          skipped += 1;
          continue;
        }

        const existing = outbox.findLatestPendingTarget(
          "part_types",
          partType.id,
          "partdb_part_id",
        );
        if (existing) {
          partDependencies.set(partType.id, existing.id);
          skipped += 1;
          continue;
        }

        const dependencyId = this.ensurePartTypeSync(partType, correlationId);
        partDependencies.set(partType.id, dependencyId);
        if (dependencyId) {
          queuedPartTypes += 1;
        } else {
          skipped += 1;
        }
      }

      const instances = this.db
        .prepare(`SELECT id, qr_code, part_type_id, location FROM physical_instances ORDER BY created_at, id`)
        .all() as Array<{ id: string; qr_code: string; part_type_id: string; location: string }>;

      for (const instance of instances) {
        if (this.readSyncedLotId("physical_instances", instance.id)) {
          skipped += 1;
          continue;
        }

        const pending = outbox.findLatestPendingTarget(
          "physical_instances",
          instance.id,
          "partdb_lot_id",
        );
        if (pending) {
          skipped += 1;
          continue;
        }

        const partType = partTypesById.get(instance.part_type_id);
        if (!partType) {
          throw new InvariantError("Physical instance is missing its part type during Part-DB backfill.", {
            partTypeId: instance.part_type_id,
            targetId: instance.id,
          });
        }

        this.enqueueCreateLot(
          {
            table: "physical_instances",
            rowId: instance.id,
            column: "partdb_lot_id",
          },
          correlationId,
          partType,
          instance.location,
          instance.qr_code,
          "",
          1,
          partDependencies.get(partType.id) ?? null,
        );
        queuedLots += 1;
      }

      const bulkStocks = this.db
        .prepare(`SELECT id, qr_code, part_type_id, location, quantity FROM bulk_stocks ORDER BY created_at, id`)
        .all() as Array<{ id: string; qr_code: string; part_type_id: string; location: string; quantity: number }>;

      for (const bulkStock of bulkStocks) {
        if (this.readSyncedLotId("bulk_stocks", bulkStock.id)) {
          skipped += 1;
          continue;
        }

        const pending = outbox.findLatestPendingTarget(
          "bulk_stocks",
          bulkStock.id,
          "partdb_lot_id",
        );
        if (pending) {
          skipped += 1;
          continue;
        }

        const partType = partTypesById.get(bulkStock.part_type_id);
        if (!partType) {
          throw new InvariantError("Bulk stock is missing its part type during Part-DB backfill.", {
            partTypeId: bulkStock.part_type_id,
            targetId: bulkStock.id,
          });
        }

        this.enqueueCreateLot(
          {
            table: "bulk_stocks",
            rowId: bulkStock.id,
            column: "partdb_lot_id",
          },
          correlationId,
          partType,
          bulkStock.location,
          bulkStock.qr_code,
          "",
          Number(bulkStock.quantity),
          partDependencies.get(partType.id) ?? null,
        );
        queuedLots += 1;
      }
    });

    return {
      queuedPartTypes,
      queuedLots,
      skipped,
    };
  }

  private resolvePartType(draft: PartTypeDraft): PartType {
    if (draft.kind === "existing") {
      const partType = this.findPartType(draft.existingPartTypeId);
      if (!partType) {
        throw new NotFoundError("Part type", draft.existingPartTypeId);
      }

      return partType;
    }

    const canonicalName = draft.canonicalName.trim().replace(/\s+/g, " ");

    // Case-insensitive duplicate guard: if a part type with the same normalized
    // name already exists, return it instead of creating a near-duplicate.
    const existingByName = this.db
      .prepare(
        `SELECT * FROM part_types WHERE LOWER(TRIM(canonical_name)) = LOWER(?)`,
      )
      .get(canonicalName) as SqlRow | undefined;
    if (existingByName) {
      return mapPartType(existingByName);
    }

    const categoryPath = parseCategoryPathInput(draft.category);
    if (!categoryPath.ok) {
      throw new InvariantError("Parsed part type category path is invalid.", {
        category: draft.category,
        reason: categoryPath.error,
      });
    }

    const category = categoryLeafFromPath(categoryPath.value);
    const countable = draft.countable;
    const timestamp = nowIso();
    const unit = draft.unit ?? defaultMeasurementUnit;
    const partType: PartType = {
      id: randomUUID(),
      canonicalName,
      category,
      categoryPath: categoryPath.value,
      aliases: uniqueAliases(draft.aliases),
      imageUrl: draft.imageUrl,
      notes: draft.notes,
      countable,
      unit,
      needsReview: true,
      partDbPartId: null,
      partDbCategoryId: null,
      partDbUnitId: null,
      partDbSyncStatus: "never",
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    this.db
      .prepare(
        `
        INSERT INTO part_types
          (id, canonical_name, category, category_path_json, aliases_json, image_url, notes, countable, unit_symbol, unit_name, unit_is_integer, needs_review, partdb_part_id, partdb_category_id, partdb_unit_id, partdb_sync_status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        partType.id,
        partType.canonicalName,
        partType.category,
        JSON.stringify(partType.categoryPath),
        JSON.stringify(partType.aliases),
        partType.imageUrl,
        partType.notes,
        partType.countable ? 1 : 0,
        partType.unit.symbol,
        partType.unit.name,
        partType.unit.isInteger ? 1 : 0,
        1,
        partType.partDbPartId,
        partType.partDbCategoryId,
        partType.partDbUnitId,
        partType.partDbSyncStatus,
        partType.createdAt,
        partType.updatedAt,
      );

    return partType;
  }

  private ensurePartTypeSync(partType: PartType, correlationId: string): string | null {
    if (!this.partDbOutbox || partType.partDbPartId) {
      return null;
    }

    const existing = this.partDbOutbox.findLatestPendingTarget(
      "part_types",
      partType.id,
      "partdb_part_id",
    );
    if (existing) {
      return existing.id;
    }

    return this.partDbOutbox.enqueue(
      {
        kind: "create_part",
        payload: {
          name: partType.canonicalName,
          categoryIri: partType.partDbCategoryId ? `/api/categories/${partType.partDbCategoryId}` : null,
          categoryPath: partType.categoryPath,
          unitIri: partType.partDbUnitId ? `/api/measurement_units/${partType.partDbUnitId}` : null,
          unit: partType.unit,
          description: partType.notes ?? "",
          tags: partType.aliases,
          needsReview: partType.needsReview,
          minAmount: null,
        },
        target: {
          table: "part_types",
          rowId: partType.id,
          column: "partdb_part_id",
        },
        dependsOnId: null,
      },
      correlationId,
    );
  }

  private enqueueCreateLot(
    target: OutboxTarget,
    correlationId: string,
    partType: PartType,
    location: string,
    qrCode: string,
    description: string,
    amount: number,
    partDependencyId: string | null,
  ): void {
    if (!this.partDbOutbox) {
      return;
    }

    const existing = this.partDbOutbox.findLatestPendingTarget(
      target.table,
      target.rowId,
      target.column,
    );
    if (existing) {
      return;
    }

    this.partDbOutbox.enqueue(
      {
        kind: "create_lot",
        payload: {
          partIri: partType.partDbPartId ? `/api/parts/${partType.partDbPartId}` : null,
          storageLocationName: location,
          amount,
          description,
          userBarcode: qrCode,
          instockUnknown: false,
        },
        target,
        dependsOnId: partDependencyId,
      },
      correlationId,
    );
  }

  private enqueueLotUpdate(
    target: LotOutboxTarget,
    correlationId: string,
    patch: {
      amount?: number | undefined;
      storageLocationName?: string | undefined;
    },
  ): void {
    if (!this.partDbOutbox) {
      return;
    }

    const dependency = this.partDbOutbox.findLatestPendingTarget(
      target.table,
      target.rowId,
      target.column,
    );
    const lotId = this.readSyncedLotId(target.table, target.rowId);
    if (!lotId && !dependency) {
      return;
    }

    this.partDbOutbox.enqueue(
      {
        kind: "update_lot",
        payload: {
          lotIri: lotId ? `/api/part_lots/${lotId}` : null,
          patch,
        },
        target,
        dependsOnId: dependency?.id ?? null,
      },
      correlationId,
    );
  }

  private enqueueDeleteLot(
    target: LotOutboxTarget,
    correlationId: string,
  ): void {
    if (!this.partDbOutbox) {
      return;
    }

    const dependency = this.partDbOutbox.findLatestPendingTarget(
      target.table,
      target.rowId,
      target.column,
    );
    const lotId = this.readSyncedLotId(target.table, target.rowId);
    if (!lotId && !dependency) {
      return;
    }

    this.partDbOutbox.enqueue(
      {
        kind: "delete_lot",
        payload: {
          lotIri: lotId ? `/api/part_lots/${lotId}` : null,
        },
        target,
        dependsOnId: dependency?.id ?? null,
      },
      correlationId,
    );
  }

  private readSyncedLotId(table: "physical_instances" | "bulk_stocks", rowId: string): string | null {
    if (table === "physical_instances") {
      const row = this.db.prepare(
        `SELECT partdb_lot_id FROM physical_instances WHERE id = ?`,
      ).get(rowId) as SqlRow | undefined;
      return stringOrNull(row?.partdb_lot_id);
    }

    const row = this.db.prepare(
      `SELECT partdb_lot_id FROM bulk_stocks WHERE id = ?`,
    ).get(rowId) as SqlRow | undefined;
    return stringOrNull(row?.partdb_lot_id);
  }

  private findPartType(id: string): PartType | null {
    const row = this.db
      .prepare(`SELECT * FROM part_types WHERE id = ?`)
      .get(id) as SqlRow | undefined;
    return row ? mapPartType(row) : null;
  }

  private getEntityByQr(qrCode: QRCode): InventoryEntitySummary | null {
    const qrTargetId = qrCode.assignedId;
    const qrTargetKind = qrCode.assignedKind;
    if (!qrTargetId || !qrTargetKind) {
      return null;
    }

    if (qrTargetKind === "instance") {
      const row = this.db
        .prepare(
          `
          SELECT
            pi.*,
            pt.id AS pt_id,
            pt.canonical_name AS pt_canonical_name,
            pt.category AS pt_category,
            pt.category_path_json AS pt_category_path_json,
            pt.aliases_json AS pt_aliases_json,
            pt.image_url AS pt_image_url,
            pt.notes AS pt_notes,
            pt.countable AS pt_countable,
            pt.unit_symbol AS pt_unit_symbol,
            pt.unit_name AS pt_unit_name,
            pt.unit_is_integer AS pt_unit_is_integer,
            pt.needs_review AS pt_needs_review,
            pt.partdb_part_id AS pt_partdb_part_id,
            pt.partdb_category_id AS pt_partdb_category_id,
            pt.partdb_unit_id AS pt_partdb_unit_id,
            pt.partdb_sync_status AS pt_partdb_sync_status,
            pt.created_at AS pt_created_at,
            pt.updated_at AS pt_updated_at
          FROM physical_instances pi
          JOIN part_types pt ON pt.id = pi.part_type_id
          WHERE pi.id = ?
          `,
        )
        .get(qrTargetId) as SqlRow | undefined;

      if (!row) {
        return null;
      }

      return parsePersisted(
        inventoryEntitySummarySchema,
        {
          id: String(row.id),
          targetType: "instance",
          qrCode: String(row.qr_code),
          location: String(row.location),
          state: String(row.status),
          assignee: stringOrNull(row.assignee),
          partDbSyncStatus: (stringOrNull(row.partdb_sync_status) ?? "never") as InventoryEntitySummary["partDbSyncStatus"],
          partType: mapPartTypeFromJoin(row, "pt_"),
        },
        "inventory instance summary",
      );
    }

    const row = this.db
      .prepare(
        `
        SELECT
          bs.*,
          pt.id AS pt_id,
          pt.canonical_name AS pt_canonical_name,
          pt.category AS pt_category,
          pt.category_path_json AS pt_category_path_json,
          pt.aliases_json AS pt_aliases_json,
          pt.image_url AS pt_image_url,
          pt.notes AS pt_notes,
          pt.countable AS pt_countable,
          pt.unit_symbol AS pt_unit_symbol,
          pt.unit_name AS pt_unit_name,
          pt.unit_is_integer AS pt_unit_is_integer,
          pt.needs_review AS pt_needs_review,
          pt.partdb_part_id AS pt_partdb_part_id,
          pt.partdb_category_id AS pt_partdb_category_id,
          pt.partdb_unit_id AS pt_partdb_unit_id,
          pt.partdb_sync_status AS pt_partdb_sync_status,
          pt.created_at AS pt_created_at,
          pt.updated_at AS pt_updated_at
        FROM bulk_stocks bs
        JOIN part_types pt ON pt.id = bs.part_type_id
        WHERE bs.id = ?
        `,
      )
      .get(qrTargetId) as SqlRow | undefined;

    if (!row) {
      return null;
    }

    return parsePersisted(
      inventoryEntitySummarySchema,
      {
        id: String(row.id),
        targetType: "bulk",
        qrCode: String(row.qr_code),
        location: String(row.location),
        state: formatBulkState(
          Number(row.quantity ?? 0),
          stringOrNull(row.pt_unit_symbol) ?? "pcs",
          row.minimum_quantity === null || row.minimum_quantity === undefined ? null : Number(row.minimum_quantity),
        ),
        assignee: null,
        partDbSyncStatus: (stringOrNull(row.partdb_sync_status) ?? "never") as InventoryEntitySummary["partDbSyncStatus"],
        quantity: Number(row.quantity ?? 0),
        minimumQuantity: row.minimum_quantity === null || row.minimum_quantity === undefined ? null : Number(row.minimum_quantity),
        partType: mapPartTypeFromJoin(row, "pt_"),
      },
      "bulk stock summary",
    );
  }

  private getEntityByTarget(targetType: InventoryTargetKind, targetId: string): InventoryEntitySummary | null {
    return targetType === "instance"
      ? this.getInstanceSummaryById(targetId)
      : this.getBulkSummaryById(targetId);
  }

  private getInstanceSummaryById(targetId: string): InventoryEntitySummary | null {
    const row = this.db
      .prepare(
        `
        SELECT
          pi.*,
          pt.id AS pt_id,
          pt.canonical_name AS pt_canonical_name,
          pt.category AS pt_category,
          pt.category_path_json AS pt_category_path_json,
          pt.aliases_json AS pt_aliases_json,
          pt.image_url AS pt_image_url,
          pt.notes AS pt_notes,
          pt.countable AS pt_countable,
          pt.unit_symbol AS pt_unit_symbol,
          pt.unit_name AS pt_unit_name,
          pt.unit_is_integer AS pt_unit_is_integer,
          pt.needs_review AS pt_needs_review,
          pt.partdb_part_id AS pt_partdb_part_id,
          pt.partdb_category_id AS pt_partdb_category_id,
          pt.partdb_unit_id AS pt_partdb_unit_id,
          pt.partdb_sync_status AS pt_partdb_sync_status,
          pt.created_at AS pt_created_at,
          pt.updated_at AS pt_updated_at
        FROM physical_instances pi
        JOIN part_types pt ON pt.id = pi.part_type_id
        WHERE pi.id = ?
        `,
      )
      .get(targetId) as SqlRow | undefined;

    if (!row) {
      return null;
    }

    return parsePersisted(
      inventoryEntitySummarySchema,
      {
        id: String(row.id),
        targetType: "instance",
        qrCode: String(row.qr_code),
        location: String(row.location),
        state: String(row.status),
        assignee: stringOrNull(row.assignee),
        partDbSyncStatus: (stringOrNull(row.partdb_sync_status) ?? "never") as InventoryEntitySummary["partDbSyncStatus"],
        partType: mapPartTypeFromJoin(row, "pt_"),
      },
      "inventory instance summary",
    );
  }

  private getBulkSummaryById(targetId: string): InventoryEntitySummary | null {
    const row = this.db
      .prepare(
        `
        SELECT
          bs.*,
          pt.id AS pt_id,
          pt.canonical_name AS pt_canonical_name,
          pt.category AS pt_category,
          pt.category_path_json AS pt_category_path_json,
          pt.aliases_json AS pt_aliases_json,
          pt.image_url AS pt_image_url,
          pt.notes AS pt_notes,
          pt.countable AS pt_countable,
          pt.unit_symbol AS pt_unit_symbol,
          pt.unit_name AS pt_unit_name,
          pt.unit_is_integer AS pt_unit_is_integer,
          pt.needs_review AS pt_needs_review,
          pt.partdb_part_id AS pt_partdb_part_id,
          pt.partdb_category_id AS pt_partdb_category_id,
          pt.partdb_unit_id AS pt_partdb_unit_id,
          pt.partdb_sync_status AS pt_partdb_sync_status,
          pt.created_at AS pt_created_at,
          pt.updated_at AS pt_updated_at
        FROM bulk_stocks bs
        JOIN part_types pt ON pt.id = bs.part_type_id
        WHERE bs.id = ?
        `,
      )
      .get(targetId) as SqlRow | undefined;

    if (!row) {
      return null;
    }

    return parsePersisted(
      inventoryEntitySummarySchema,
      {
        id: String(row.id),
        targetType: "bulk",
        qrCode: String(row.qr_code),
        location: String(row.location),
        state: formatBulkState(
          Number(row.quantity ?? 0),
          stringOrNull(row.pt_unit_symbol) ?? "pcs",
          row.minimum_quantity === null || row.minimum_quantity === undefined ? null : Number(row.minimum_quantity),
        ),
        assignee: null,
        partDbSyncStatus: (stringOrNull(row.partdb_sync_status) ?? "never") as InventoryEntitySummary["partDbSyncStatus"],
        quantity: Number(row.quantity ?? 0),
        minimumQuantity: row.minimum_quantity === null || row.minimum_quantity === undefined ? null : Number(row.minimum_quantity),
        partType: mapPartTypeFromJoin(row, "pt_"),
      },
      "bulk stock summary",
    );
  }

  private loadCorrectionEntity(targetType: InventoryTargetKind, targetId: string): LoadedCorrectionEntity | null {
    if (targetType === "instance") {
      const row = this.db
        .prepare(
          `
          SELECT
            pi.*,
            pt.id AS pt_id,
            pt.canonical_name AS pt_canonical_name,
            pt.category AS pt_category,
            pt.category_path_json AS pt_category_path_json,
            pt.aliases_json AS pt_aliases_json,
            pt.image_url AS pt_image_url,
            pt.notes AS pt_notes,
            pt.countable AS pt_countable,
            pt.unit_symbol AS pt_unit_symbol,
            pt.unit_name AS pt_unit_name,
            pt.unit_is_integer AS pt_unit_is_integer,
            pt.needs_review AS pt_needs_review,
            pt.partdb_part_id AS pt_partdb_part_id,
            pt.partdb_category_id AS pt_partdb_category_id,
            pt.partdb_unit_id AS pt_partdb_unit_id,
            pt.partdb_sync_status AS pt_partdb_sync_status,
            pt.created_at AS pt_created_at,
            pt.updated_at AS pt_updated_at
          FROM physical_instances pi
          JOIN part_types pt ON pt.id = pi.part_type_id
          WHERE pi.id = ?
          `,
        )
        .get(targetId) as SqlRow | undefined;
      if (!row) {
        return null;
      }

      const partType = mapPartTypeFromJoin(row, "pt_");
      return {
        targetType: "instance",
        id: String(row.id),
        table: "physical_instances",
        qrCode: String(row.qr_code),
        partType,
        location: String(row.location),
        state: String(row.status),
        assignee: stringOrNull(row.assignee),
        quantity: null,
        minimumQuantity: null,
        partDbLotId: stringOrNull(row.partdb_lot_id),
        partDbSyncStatus: (stringOrNull(row.partdb_sync_status) ?? "never") as PartType["partDbSyncStatus"],
      };
    }

    const row = this.db
      .prepare(
        `
        SELECT
          bs.*,
          pt.id AS pt_id,
          pt.canonical_name AS pt_canonical_name,
          pt.category AS pt_category,
          pt.category_path_json AS pt_category_path_json,
          pt.aliases_json AS pt_aliases_json,
          pt.image_url AS pt_image_url,
          pt.notes AS pt_notes,
          pt.countable AS pt_countable,
          pt.unit_symbol AS pt_unit_symbol,
          pt.unit_name AS pt_unit_name,
          pt.unit_is_integer AS pt_unit_is_integer,
          pt.needs_review AS pt_needs_review,
          pt.partdb_part_id AS pt_partdb_part_id,
          pt.partdb_category_id AS pt_partdb_category_id,
          pt.partdb_unit_id AS pt_partdb_unit_id,
          pt.partdb_sync_status AS pt_partdb_sync_status,
          pt.created_at AS pt_created_at,
          pt.updated_at AS pt_updated_at
        FROM bulk_stocks bs
        JOIN part_types pt ON pt.id = bs.part_type_id
        WHERE bs.id = ?
        `,
      )
      .get(targetId) as SqlRow | undefined;
    if (!row) {
      return null;
    }

    const partType = mapPartTypeFromJoin(row, "pt_");
    return {
      targetType: "bulk",
      id: String(row.id),
      table: "bulk_stocks",
      qrCode: String(row.qr_code),
      partType,
      location: String(row.location),
      state: formatBulkState(
        Number(row.quantity ?? 0),
        partType.unit.symbol,
        row.minimum_quantity === null || row.minimum_quantity === undefined ? null : Number(row.minimum_quantity),
      ),
      assignee: null,
      quantity: Number(row.quantity ?? 0),
      minimumQuantity: row.minimum_quantity === null || row.minimum_quantity === undefined ? null : Number(row.minimum_quantity),
      partDbLotId: stringOrNull(row.partdb_lot_id),
      partDbSyncStatus: (stringOrNull(row.partdb_sync_status) ?? "never") as PartType["partDbSyncStatus"],
    };
  }

  private findQrRowByScannedCode(code: string): SqlRow | undefined {
    const exact = this.db
      .prepare(`SELECT * FROM qrcodes WHERE TRIM(code) = ?`)
      .get(code) as SqlRow | undefined;
    if (exact) {
      return exact;
    }

    const compactKey = scanLookupCompactKey(code);
    if (!compactKey) {
      return undefined;
    }

    const matches = this.db
      .prepare(`
        SELECT *
        FROM qrcodes
        WHERE batch_id = 'external'
          AND LOWER(REPLACE(REPLACE(REPLACE(TRIM(code), '-', ''), '_', ''), ' ', '')) = ?
      `)
      .all(compactKey) as SqlRow[];

    if (matches.length > 1) {
      throw new ConflictError("Scanned code matches multiple stored codes after normalization.", {
        scannedCode: code,
        candidates: matches.map((row) => String(row.code)),
      });
    }

    return matches[0];
  }

  private updateQrAssignment(
    code: string,
    assignedKind: InventoryTargetKind,
    assignedId: string,
    updatedAt: string,
  ): void {
    this.db
      .prepare(
        `
        UPDATE qrcodes
        SET status = 'assigned', assigned_kind = ?, assigned_id = ?, updated_at = ?
        WHERE code = ?
        `,
      )
      .run(assignedKind, assignedId, updatedAt, code);
  }

  private insertCorrectionEvent(input: {
    targetType: CorrectionTargetKind;
    targetId: string;
    correctionKind: CorrectionKind;
    actor: string;
    reason: string;
    before: Record<string, unknown>;
    after: Record<string, unknown>;
    createdAt: string;
  }): CorrectionEvent {
    const id = randomUUID();
    this.db
      .prepare(`
        INSERT INTO correction_events
          (id, target_type, target_id, correction_kind, actor, reason, before_json, after_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        id,
        input.targetType,
        input.targetId,
        input.correctionKind,
        input.actor,
        input.reason,
        JSON.stringify(input.before),
        JSON.stringify(input.after),
        input.createdAt,
      );

    return parsePersisted(
      correctionEventSchema,
      {
        id,
        targetType: input.targetType,
        targetId: input.targetId,
        correctionKind: input.correctionKind,
        actor: input.actor,
        reason: input.reason,
        before: input.before,
        after: input.after,
        createdAt: input.createdAt,
      },
      "correction event record",
    );
  }

  private assertNoPendingLotSync(
    table: "physical_instances" | "bulk_stocks",
    rowId: string,
    message: string,
  ): void {
    if (!this.partDbOutbox) {
      return;
    }

    const pending = this.partDbOutbox.findLatestPendingTarget(table, rowId, "partdb_lot_id");
    if (pending) {
      throw new ConflictError(message, {
        targetTable: table,
        targetId: rowId,
        outboxOperationId: pending.id,
      });
    }
  }

  private assertNoPendingPartSync(partTypeId: string, message: string): void {
    if (!this.partDbOutbox) {
      return;
    }

    const pending = this.partDbOutbox.findLatestPendingTarget("part_types", partTypeId, "partdb_part_id");
    if (pending) {
      throw new ConflictError(message, {
        partTypeId,
        outboxOperationId: pending.id,
      });
    }
  }

  private findConflictingSharedPartTypeDefinition(
    currentPartTypeId: string,
    canonicalName: string,
    categoryPath: string[],
  ): PartType | null {
    const candidates = this.db
      .prepare(`
        SELECT *
        FROM part_types
        WHERE id != ?
          AND LOWER(TRIM(canonical_name)) = LOWER(?)
      `)
      .all(currentPartTypeId, canonicalName)
      .map((row) => mapPartType(row as SqlRow));

    return candidates.find((candidate) => sameCategoryPath(candidate.categoryPath, categoryPath)) ?? null;
  }

  private assertOnlyLabeledHistory(targetType: InventoryTargetKind, targetId: string): void {
    const rows = this.db
      .prepare(`
        SELECT event
        FROM stock_events
        WHERE target_type = ? AND target_id = ?
        ORDER BY created_at, id
      `)
      .all(targetType, targetId) as Array<{ event: string }>;

    if (rows.length !== 1 || rows[0]?.event !== "labeled") {
      throw new ConflictError("Only fresh ingest assignments can be reversed.", {
        targetType,
        targetId,
        eventCount: rows.length,
      });
    }
  }

  private insertEvent(input: {
    targetType: InventoryTargetKind;
    targetId: string;
    event: string;
    fromState: string | null;
    toState: string | null;
    location: string | null;
    actor: string;
    notes: string | null;
    createdAt: string;
  }): void {
    this.db
      .prepare(
        `
        INSERT INTO stock_events
          (id, target_type, target_id, event, from_state, to_state, location, actor, notes, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        randomUUID(),
        input.targetType,
        input.targetId,
        input.event,
        input.fromState,
        input.toState,
        input.location,
        input.actor,
        input.notes,
        input.createdAt,
      );
  }

  private latestEvent(targetType: InventoryTargetKind, targetId: string): StockEvent {
    const row = this.db
      .prepare(
        `
        SELECT * FROM stock_events
        WHERE target_type = ? AND target_id = ?
        ORDER BY rowid DESC
        LIMIT 1
        `,
      )
      .get(targetType, targetId) as SqlRow | undefined;

    if (!row) {
      throw new InvariantError("Event could not be read back from the database.", {
        targetType,
        targetId,
      });
    }

    return mapStockEvent(row);
  }

  private withTransaction<T>(work: () => T): T {
    this.db.exec("BEGIN");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

function mapPartType(row: SqlRow): PartType {
  return parsePersisted(
    persistedPartTypeSchema,
    {
      id: String(row.id),
      canonicalName: String(row.canonical_name),
      category: String(row.category),
      categoryPath: parseCategoryPath(row.category_path_json, row.category),
      aliases: parseAliases(row.aliases_json),
      imageUrl: stringOrNull(row.image_url),
      notes: stringOrNull(row.notes),
      countable: Boolean(row.countable),
      unit: {
        symbol: stringOrNull(row.unit_symbol) ?? "pcs",
        name: stringOrNull(row.unit_name) ?? "Pieces",
        isInteger: Boolean(row.unit_is_integer ?? 1),
      },
      needsReview: Boolean(row.needs_review),
      partDbPartId: stringOrNull(row.partdb_part_id),
      partDbCategoryId: stringOrNull(row.partdb_category_id),
      partDbUnitId: stringOrNull(row.partdb_unit_id),
      partDbSyncStatus: (stringOrNull(row.partdb_sync_status) ?? "never") as PartType["partDbSyncStatus"],
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    },
    "part type record",
  );
}

function mapPartTypeFromJoin(row: SqlRow, prefix: string): PartType {
  return parsePersisted(
    partTypeSchema,
    {
      id: String(row[`${prefix}id`]),
      canonicalName: String(row[`${prefix}canonical_name`]),
      category: String(row[`${prefix}category`]),
      categoryPath: parseCategoryPath(row[`${prefix}category_path_json`], row[`${prefix}category`]),
      aliases: parseAliases(row[`${prefix}aliases_json`]),
      imageUrl: stringOrNull(row[`${prefix}image_url`]),
      notes: stringOrNull(row[`${prefix}notes`]),
      countable: Boolean(row[`${prefix}countable`]),
      unit: {
        symbol: stringOrNull(row[`${prefix}unit_symbol`]) ?? "pcs",
        name: stringOrNull(row[`${prefix}unit_name`]) ?? "Pieces",
        isInteger: Boolean(row[`${prefix}unit_is_integer`] ?? 1),
      },
      needsReview: Boolean(row[`${prefix}needs_review`]),
      partDbPartId: stringOrNull(row[`${prefix}partdb_part_id`]),
      partDbCategoryId: stringOrNull(row[`${prefix}partdb_category_id`]),
      partDbUnitId: stringOrNull(row[`${prefix}partdb_unit_id`]),
      partDbSyncStatus: (stringOrNull(row[`${prefix}partdb_sync_status`]) ?? "never") as PartType["partDbSyncStatus"],
      createdAt: String(row[`${prefix}created_at`]),
      updatedAt: String(row[`${prefix}updated_at`]),
    },
    "joined part type record",
  );
}

function mapQrCode(row: SqlRow): QRCode {
  return parsePersisted(
    qrCodeSchema,
    {
      code: String(row.code),
      batchId: String(row.batch_id),
      status: String(row.status) as QRCode["status"],
    assignedKind: stringOrNull(row.assigned_kind) as InventoryTargetKind | null,
      assignedId: stringOrNull(row.assigned_id),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    },
    "QR code record",
  );
}

function mapQrBatch(row: SqlRow) {
  return parsePersisted(
    qrBatchSchema,
    {
      id: String(row.id),
      prefix: String(row.prefix),
      startNumber: numberFromRow(row.start_number),
      endNumber: numberFromRow(row.end_number),
      actor: String(row.actor),
      createdAt: String(row.created_at),
    },
    "QR batch record",
  );
}

function mapPhysicalInstance(row: SqlRow): PhysicalInstance {
  return parsePersisted(
    physicalInstanceSchema,
    {
      id: String(row.id),
      qrCode: String(row.qr_code),
      partTypeId: String(row.part_type_id),
      status: String(row.status) as PhysicalInstance["status"],
    location: String(row.location),
      assignee: stringOrNull(row.assignee),
      partDbSyncStatus: (stringOrNull(row.partdb_sync_status) ?? "never") as PhysicalInstance["partDbSyncStatus"],
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    },
    "physical instance record",
  );
}

function mapBulkStock(row: SqlRow) {
  return parsePersisted(
    bulkStockSchema,
    {
      id: String(row.id),
      qrCode: String(row.qr_code),
      partTypeId: String(row.part_type_id),
      level: String(row.level) as BulkLevel,
      quantity: Number(row.quantity ?? 0),
      minimumQuantity: row.minimum_quantity === null || row.minimum_quantity === undefined ? null : Number(row.minimum_quantity),
      location: String(row.location),
      partDbLotId: stringOrNull(row.partdb_lot_id),
      partDbSyncStatus: (stringOrNull(row.partdb_sync_status) ?? "never") as PartType["partDbSyncStatus"],
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    },
    "bulk stock record",
  );
}

function mapStockEvent(row: SqlRow): StockEvent {
  return parsePersisted(
    stockEventSchema,
    {
      id: String(row.id),
      targetType: String(row.target_type) as InventoryTargetKind,
      targetId: String(row.target_id),
    event: String(row.event) as StockEvent["event"],
    fromState: stringOrNull(row.from_state),
    toState: stringOrNull(row.to_state),
    location: stringOrNull(row.location),
      actor: String(row.actor),
      notes: stringOrNull(row.notes),
      createdAt: String(row.created_at),
    },
    "stock event record",
  );
}

function mapCorrectionEvent(row: SqlRow): CorrectionEvent {
  return parsePersisted(
    correctionEventSchema,
    {
      id: String(row.id),
      targetType: String(row.target_type),
      targetId: String(row.target_id),
      correctionKind: String(row.correction_kind),
      actor: String(row.actor),
      reason: String(row.reason),
      before: parseJsonRecord(row.before_json, "correction before payload"),
      after: parseJsonRecord(row.after_json, "correction after payload"),
      createdAt: String(row.created_at),
    },
    "correction event record",
  );
}

function nowIso(): string {
  return new Date().toISOString();
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberFromRow(value: unknown): number {
  return Number(value);
}

function uniqueAliases(aliases: string[]): string[] {
  return Array.from(
    new Set(
      aliases
        .map((alias) => alias.trim())
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b)),
    ),
  );
}

function validBulkLevel(value: unknown): value is BulkLevel {
  return typeof value === "string" && bulkLevels.includes(value as BulkLevel);
}

function validInstanceStatus(value: unknown): value is PhysicalInstance["status"] {
  return typeof value === "string" && instanceStatuses.includes(value as PhysicalInstance["status"]);
}

function parseAliases(value: unknown): string[] {
  if (typeof value !== "string") {
    return [];
  }

  try {
    const parsed = JSON.parse(value) as unknown[];
    return parsed.filter((item): item is string => typeof item === "string");
  } catch {
    return [];
  }
}

function parseCategoryPath(value: unknown, fallbackCategory: unknown): string[] {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown[];
      const segments = parsed.filter((segment): segment is string => typeof segment === "string" && segment.trim().length > 0);
      if (segments.length > 0) {
        return segments;
      }
    } catch {
      // fall through to fallback below
    }
  }

  return typeof fallbackCategory === "string" && fallbackCategory.trim().length > 0
    ? [fallbackCategory]
    : ["Uncategorized"];
}

function parseJsonRecord(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "string") {
    throw new InvariantError(`Persisted ${context} is not valid JSON text.`, {
      context,
    });
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("parsed value is not an object");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new InvariantError(`Persisted ${context} could not be parsed.`, {
      context,
    }, { cause: error });
  }
}

function buildEntityCorrectionSnapshot(target: LoadedCorrectionEntity): Record<string, unknown> {
  return {
    targetType: target.targetType,
    targetId: target.id,
    qrCode: target.qrCode,
    partTypeId: target.partType.id,
    partTypeName: target.partType.canonicalName,
    categoryPath: target.partType.categoryPath,
    location: target.location,
    state: target.state,
    assignee: target.assignee,
    quantity: target.quantity,
    minimumQuantity: target.minimumQuantity,
  };
}

function parsePersisted<T>(schema: { parse: (input: unknown) => T }, input: unknown, context: string): T {
  try {
    return schema.parse(input);
  } catch (error) {
    throw new InvariantError(`Persisted ${context} failed to parse.`, { context }, { cause: error });
  }
}

function enforcePartTypeCompatibility(
  entityKind: InventoryTargetKind,
  partType: PartType,
): void {
  if (entityKind === "instance" && !partType.countable) {
    throw new ConflictError("Bulk part types cannot be assigned as physical instances.", {
      partTypeId: partType.id,
    });
  }

  if (entityKind === "bulk" && partType.countable && !partType.unit.isInteger) {
    throw new ConflictError("Piece-counted bulk stock requires a whole-number unit.", {
      partTypeId: partType.id,
      unitSymbol: partType.unit.symbol,
    });
  }
}

function requireChangedLocation(
  location: string | null | undefined,
  currentLocation: string,
  event: "moved",
): string {
  const normalized = location?.trim();
  if (!normalized) {
    throw new InvariantError(`Parsed '${event}' command is missing a destination location.`, {
      event,
    });
  }

  if (normalized === currentLocation) {
    throw new ConflictError(`Cannot perform '${event}' without changing location.`, {
      event,
      currentLocation,
    });
  }

  return normalized;
}

function persistedBulkLevelFromQuantity(
  quantity: number,
  minimumQuantity: number | null,
): BulkLevel {
  if (quantity <= 0) {
    return "empty";
  }

  if (minimumQuantity !== null && quantity <= minimumQuantity) {
    return "low";
  }

  return "good";
}

function formatBulkState(
  quantity: number,
  unitSymbol: string,
  minimumQuantity: number | null,
): string {
  const amount = `${formatQuantity(quantity)} ${unitSymbol} on hand`;
  if (minimumQuantity !== null && quantity <= minimumQuantity) {
    return `${amount} · low stock`;
  }

  return amount;
}

function formatQuantity(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.?0+$/, "");
}

function requireFiniteNonNegativeQuantity(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new InvariantError(`Parsed bulk command is missing a valid ${field}.`, {
      field,
    });
  }

  return value;
}

function requireFinitePositiveQuantity(value: number, field: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new InvariantError(`Parsed bulk command is missing a positive ${field}.`, {
      field,
    });
  }

  return value;
}

function requireUnitCompatibleQuantity(
  value: number,
  unit: PartType["unit"],
  field: string,
): void {
  if (unit.isInteger && !Number.isInteger(value)) {
    throw new InvariantError(`Parsed bulk command has a fractional ${field} for integer unit '${unit.symbol}'.`, {
      field,
      unit: unit.symbol,
    });
  }
}

function sameCategoryPath(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((segment, index) => segment.trim().toLowerCase() === (right[index] ?? "").trim().toLowerCase());
}

export const inventoryServiceTestInternals = {
  parseAliases,
};
