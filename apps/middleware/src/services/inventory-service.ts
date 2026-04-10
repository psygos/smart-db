import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  bulkLevels,
  bulkStockSchema,
  ConflictError,
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
  qrCodeSchema,
  stockEventSchema,
  getAvailableInstanceActions,
  getAvailableBulkActions,
  getNextInstanceStatus,
  getNextBulkLevel,
} from "@smart-db/contracts";
import { PartDbClient } from "../partdb/partdb-client.js";

type SqlRow = Record<string, unknown>;

export class InventoryService {
  constructor(
    private readonly db: DatabaseSync,
    private readonly partDbClient: PartDbClient,
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
      .prepare(`SELECT * FROM stock_events ORDER BY rowid DESC LIMIT 8`)
      .all()
      .map((row) => mapStockEvent(row as SqlRow));

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

    const rows = this.db
      .prepare(
        `
        SELECT *
        FROM part_types
        WHERE lower(canonical_name) LIKE ?
          OR lower(category) LIKE ?
          OR lower(aliases_json) LIKE ?
        ORDER BY needs_review DESC, updated_at DESC
        LIMIT 20
        `,
      )
      .all(`%${normalized}%`, `%${normalized}%`, `%${normalized}%`);

    return rows.map((row) => mapPartType(row as SqlRow));
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

  async scanCode(code: string): Promise<ScanResponse> {
    const normalized = code.trim();
    const qrRow = this.db
      .prepare(`SELECT * FROM qrcodes WHERE code = ?`)
      .get(normalized) as SqlRow | undefined;
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

      return {
        mode: "interact",
        qrCode,
        entity: {
          ...entity,
          targetType: "bulk",
        },
        recentEvents,
        availableActions: getAvailableBulkActions(entity.state as BulkLevel),
        partDb,
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

  assignQr(input: AssignQrCommand): InventoryEntitySummary {
    const qrCodeValue = input.qrCode;
    const actor = input.actor;
    const location = input.location;
    const qrRow = this.db
      .prepare(`SELECT * FROM qrcodes WHERE code = ?`)
      .get(qrCodeValue) as SqlRow | undefined;

    if (!qrRow) {
      throw new NotFoundError("QR code", qrCodeValue);
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
    let summary: InventoryEntitySummary | null = null;

    this.withTransaction(() => {
      if (input.entityKind === "instance") {
        const initialStatus = validInstanceStatus(input.initialStatus)
          ? input.initialStatus
          : "available";
        const id = randomUUID();
        this.db
          .prepare(
            `
            INSERT INTO physical_instances
              (id, qr_code, part_type_id, status, location, assignee, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, NULL, ?, ?)
            `,
          )
          .run(id, qrCodeValue, partType.id, initialStatus, location, timestamp, timestamp);

        this.updateQrAssignment(qrCodeValue, "instance", id, timestamp);
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
        const initialLevel = validBulkLevel(input.initialLevel) ? input.initialLevel : "good";
        const id = randomUUID();
        this.db
          .prepare(
            `
            INSERT INTO bulk_stocks
              (id, qr_code, part_type_id, level, location, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            `,
          )
          .run(id, qrCodeValue, partType.id, initialLevel, location, timestamp, timestamp);

        this.updateQrAssignment(qrCodeValue, "bulk", id, timestamp);
        this.insertEvent({
          targetType: "bulk",
          targetId: id,
          event: "labeled",
          fromState: null,
          toState: initialLevel,
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
    const location =
      input.event === "moved"
        ? requireChangedLocation(input.location, current.location, input.event)
        : input.location?.trim() || current.location;

    const requestedLevel =
      input.event === "moved"
        ? undefined
        : requireBulkNextLevel(input.nextLevel, input.event);
    const nextLevel = getNextBulkLevel(current.level, input.event, requestedLevel);
    if (nextLevel === null) {
      throw new ConflictError(
        `Cannot perform '${input.event}' on bulk stock with level '${current.level}'.`,
        { currentLevel: current.level, event: input.event },
      );
    }

    this.withTransaction(() => {
      this.db
        .prepare(
          `
          UPDATE bulk_stocks
          SET level = ?, location = ?, updated_at = ?
          WHERE id = ?
          `,
        )
        .run(nextLevel, location, timestamp, current.id);

      this.insertEvent({
        targetType: "bulk",
        targetId: current.id,
        event: input.event,
        fromState: current.level,
        toState: nextLevel,
        location,
        actor,
        notes: input.notes ?? null,
        createdAt: timestamp,
      });
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
    const normalized = code.trim();
    const qrRow = this.db
      .prepare(`SELECT * FROM qrcodes WHERE code = ?`)
      .get(normalized) as SqlRow | undefined;

    if (!qrRow) {
      throw new NotFoundError("QR code", normalized);
    }

    const qrCode = mapQrCode(qrRow);
    if (qrCode.status === "voided") {
      return qrCode;
    }

    const timestamp = nowIso();

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

  async getPartDbStatus(): Promise<PartDbConnectionStatus> {
    return this.partDbClient.getConnectionStatus();
  }

  private resolvePartType(draft: PartTypeDraft): PartType {
    if (draft.kind === "existing") {
      const partType = this.findPartType(draft.existingPartTypeId);
      if (!partType) {
        throw new NotFoundError("Part type", draft.existingPartTypeId);
      }

      return partType;
    }

    const canonicalName = draft.canonicalName;
    const category = draft.category;
    const countable = draft.countable;
    const timestamp = nowIso();
    const partType: PartType = {
      id: randomUUID(),
      canonicalName,
      category,
      categoryPath: [category],
      aliases: uniqueAliases(draft.aliases),
      imageUrl: draft.imageUrl,
      notes: draft.notes,
      countable,
      unit: {
        symbol: "pcs",
        name: "Pieces",
        isInteger: true,
      },
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
            pt.aliases_json AS pt_aliases_json,
            pt.image_url AS pt_image_url,
            pt.notes AS pt_notes,
            pt.countable AS pt_countable,
            pt.needs_review AS pt_needs_review,
            pt.partdb_part_id AS pt_partdb_part_id,
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
          pt.aliases_json AS pt_aliases_json,
          pt.image_url AS pt_image_url,
          pt.notes AS pt_notes,
          pt.countable AS pt_countable,
          pt.needs_review AS pt_needs_review,
          pt.partdb_part_id AS pt_partdb_part_id,
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
        state: String(row.level),
        assignee: null,
        partType: mapPartTypeFromJoin(row, "pt_"),
      },
      "bulk stock summary",
    );
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

  if (entityKind === "bulk" && partType.countable) {
    throw new ConflictError("Countable part types cannot be assigned as bulk stock.", {
      partTypeId: partType.id,
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

function requireBulkNextLevel(
  nextLevel: unknown,
  event: "level_changed" | "consumed",
): BulkLevel {
  if (!validBulkLevel(nextLevel)) {
    throw new InvariantError(`Parsed '${event}' command is missing a valid next level.`, {
      event,
    });
  }

  return nextLevel;
}

export const inventoryServiceTestInternals = {
  parseAliases,
};
