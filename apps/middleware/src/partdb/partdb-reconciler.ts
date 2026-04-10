import type { DatabaseSync } from "node:sqlite";
import { Err, Ok, type Result } from "@smart-db/contracts";
import type { PartDbError } from "./partdb-errors.js";
import { PartDbPartLotsResource } from "./resources/part-lots.js";
import { PartDbPartsResource } from "./resources/parts.js";

export interface PartDbDeleteReconcileResult {
  clearedPartTypes: number;
  clearedInstanceLots: number;
  clearedBulkLots: number;
}

export class PartDbDeleteReconciler {
  constructor(
    private readonly db: DatabaseSync,
    private readonly parts: PartDbPartsResource,
    private readonly lots: PartDbPartLotsResource,
  ) {}

  async reconcileMissingRemoteReferences(): Promise<Result<PartDbDeleteReconcileResult, PartDbError>> {
    let clearedPartTypes = 0;
    let clearedInstanceLots = 0;
    let clearedBulkLots = 0;

    const partRows = this.db.prepare(`
      SELECT id, partdb_part_id
      FROM part_types
      WHERE partdb_part_id IS NOT NULL
      ORDER BY created_at, id
    `).all() as Array<{ id: string; partdb_part_id: string }>;

    for (const part of partRows) {
      const result = await this.parts.get(`/api/parts/${part.partdb_part_id}`);
      if (!result.ok && result.error.kind !== "not_found") {
        return result;
      }

      if (!result.ok && result.error.kind === "not_found") {
        const changes = this.clearPartReference(part.id);
        clearedPartTypes += changes.clearedPartTypes;
        clearedInstanceLots += changes.clearedInstanceLots;
        clearedBulkLots += changes.clearedBulkLots;
      }
    }

    const instanceRows = this.db.prepare(`
      SELECT id, partdb_lot_id
      FROM physical_instances
      WHERE partdb_lot_id IS NOT NULL
      ORDER BY created_at, id
    `).all() as Array<{ id: string; partdb_lot_id: string }>;
    for (const instance of instanceRows) {
      const result = await this.lots.get(`/api/part_lots/${instance.partdb_lot_id}`);
      if (!result.ok && result.error.kind !== "not_found") {
        return result;
      }

      if (!result.ok && result.error.kind === "not_found") {
        clearedInstanceLots += this.clearLotReference("physical_instances", instance.id);
      }
    }

    const bulkRows = this.db.prepare(`
      SELECT id, partdb_lot_id
      FROM bulk_stocks
      WHERE partdb_lot_id IS NOT NULL
      ORDER BY created_at, id
    `).all() as Array<{ id: string; partdb_lot_id: string }>;
    for (const bulk of bulkRows) {
      const result = await this.lots.get(`/api/part_lots/${bulk.partdb_lot_id}`);
      if (!result.ok && result.error.kind !== "not_found") {
        return result;
      }

      if (!result.ok && result.error.kind === "not_found") {
        clearedBulkLots += this.clearLotReference("bulk_stocks", bulk.id);
      }
    }

    return Ok({
      clearedPartTypes,
      clearedInstanceLots,
      clearedBulkLots,
    });
  }

  private clearPartReference(partTypeId: string): PartDbDeleteReconcileResult {
    this.db.exec("BEGIN");
    try {
      const clearedPartTypes = this.db.prepare(`
        UPDATE part_types
        SET partdb_part_id = NULL,
            partdb_sync_status = 'never'
        WHERE id = ?
      `).run(partTypeId).changes;
      const clearedInstanceLots = this.db.prepare(`
        UPDATE physical_instances
        SET partdb_lot_id = NULL,
            partdb_sync_status = 'never'
        WHERE part_type_id = ?
      `).run(partTypeId).changes;
      const clearedBulkLots = this.db.prepare(`
        UPDATE bulk_stocks
        SET partdb_lot_id = NULL,
            partdb_sync_status = 'never'
        WHERE part_type_id = ?
      `).run(partTypeId).changes;
      this.db.exec("COMMIT");
      return {
        clearedPartTypes: Number(clearedPartTypes),
        clearedInstanceLots: Number(clearedInstanceLots),
        clearedBulkLots: Number(clearedBulkLots),
      };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private clearLotReference(
    table: "physical_instances" | "bulk_stocks",
    id: string,
  ): number {
    return Number(this.db.prepare(`
      UPDATE ${table}
      SET partdb_lot_id = NULL,
          partdb_sync_status = 'never'
      WHERE id = ?
    `).run(id).changes);
  }
}
