import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { OutboxOperation, OutboxRow, OutboxStatus } from "./outbox-types.js";
import { parseWithSchema } from "@smart-db/contracts";
import { outboxOperationSchema } from "./outbox-schemas.js";

type SqlRow = Record<string, unknown>;

interface ClaimOptions {
  nowIso?: string;
  batchSize?: number;
  leaseDurationMs?: number;
}

export class PartDbOutbox {
  constructor(private readonly db: DatabaseSync) {}

  enqueue(operation: OutboxOperation, correlationId: string): string {
    const idempotencyKey = computeIdempotencyKey(operation);
    const id = randomUUID();
    const nowIso = new Date().toISOString();

    this.db.prepare(`
      INSERT OR IGNORE INTO partdb_outbox
        (id, idempotency_key, correlation_id, operation, payload_json,
         depends_on_id, target_table, target_row_id, target_column,
         status, attempt_count, max_attempts, next_attempt_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, 10, ?, ?)
    `).run(
      id,
      idempotencyKey,
      correlationId,
      operation.kind,
      JSON.stringify(operation.payload),
      operation.dependsOnId,
      operation.target?.table ?? null,
      operation.target?.rowId ?? null,
      operation.target?.column ?? null,
      nowIso,
      nowIso,
    );

    const existing = this.db.prepare(
      `SELECT id FROM partdb_outbox WHERE idempotency_key = ?`,
    ).get(idempotencyKey) as { id: string };

    return existing.id;
  }

  getById(id: string): OutboxRow | null {
    const row = this.db.prepare(`SELECT * FROM partdb_outbox WHERE id = ?`).get(id) as SqlRow | undefined;
    return row ? mapOutboxRow(row) : null;
  }

  listByCorrelation(correlationId: string): OutboxRow[] {
    return this.db
      .prepare(`SELECT * FROM partdb_outbox WHERE correlation_id = ? ORDER BY created_at, id`)
      .all(correlationId)
      .map((row) => mapOutboxRow(row as SqlRow));
  }

  listFailures(limit: number = 50): OutboxRow[] {
    return this.db
      .prepare(`
        SELECT *
        FROM partdb_outbox
        WHERE status IN ('failed', 'dead')
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      `)
      .all(limit)
      .map((row) => mapOutboxRow(row as SqlRow));
  }

  getStatusSummary(): {
    pending: number;
    inFlight: number;
    failedLast24h: number;
    deadTotal: number;
  } {
    const row = this.db.prepare(`
      SELECT
        SUM(CASE WHEN status IN ('pending', 'failed') THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN status = 'leased' THEN 1 ELSE 0 END) AS in_flight,
        SUM(CASE WHEN status = 'failed' AND completed_at IS NULL THEN 1 ELSE 0 END) AS failed_last_24h,
        SUM(CASE WHEN status = 'dead' THEN 1 ELSE 0 END) AS dead_total
      FROM partdb_outbox
    `).get() as SqlRow;

    return {
      pending: Number(row.pending ?? 0),
      inFlight: Number(row.in_flight ?? 0),
      failedLast24h: Number(row.failed_last_24h ?? 0),
      deadTotal: Number(row.dead_total ?? 0),
    };
  }

  retry(id: string, nowIso: string = new Date().toISOString()): void {
    this.db.prepare(`
      UPDATE partdb_outbox
      SET status = 'pending',
          next_attempt_at = ?,
          lease_expires_at = NULL,
          leased_at = NULL
      WHERE id = ? AND status IN ('failed', 'dead')
    `).run(nowIso, id);
  }

  getDependencyResponseIri(id: string): string | null {
    const row = this.db.prepare(
      `SELECT response_iri FROM partdb_outbox WHERE id = ? AND status = 'delivered'`,
    ).get(id) as SqlRow | undefined;
    return row && typeof row.response_iri === "string" ? row.response_iri : null;
  }

  findLatestPendingTarget(
    table: NonNullable<OutboxRow["targetTable"]>,
    rowId: string,
    column: NonNullable<OutboxRow["targetColumn"]>,
  ): OutboxRow | null {
    const row = this.db.prepare(`
      SELECT *
      FROM partdb_outbox
      WHERE target_table = ?
        AND target_row_id = ?
        AND target_column = ?
        AND status IN ('pending', 'failed', 'leased')
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `).get(table, rowId, column) as SqlRow | undefined;
    return row ? mapOutboxRow(row) : null;
  }

  claimBatch(options: ClaimOptions = {}): OutboxRow[] {
    const nowIso = options.nowIso ?? new Date().toISOString();
    const leaseDurationMs = options.leaseDurationMs ?? 30_000;
    const batchSize = options.batchSize ?? 10;
    const leaseExpiresAt = new Date(Date.parse(nowIso) + leaseDurationMs).toISOString();

    this.db.exec("BEGIN");
    try {
      this.db.prepare(`
        UPDATE partdb_outbox
        SET status = 'pending',
            lease_expires_at = NULL,
            leased_at = NULL
        WHERE status = 'leased' AND lease_expires_at < ?
      `).run(nowIso);

      const rows = this.db.prepare(`
        SELECT * FROM partdb_outbox
        WHERE status IN ('pending', 'failed')
          AND next_attempt_at <= ?
          AND (depends_on_id IS NULL OR EXISTS (
            SELECT 1
            FROM partdb_outbox dep
            WHERE dep.id = partdb_outbox.depends_on_id
              AND dep.status = 'delivered'
          ))
        ORDER BY created_at, id
        LIMIT ?
      `).all(nowIso, batchSize) as SqlRow[];

      for (const row of rows) {
        this.db.prepare(`
          UPDATE partdb_outbox
          SET status = 'leased',
              leased_at = ?,
              lease_expires_at = ?,
              attempt_count = attempt_count + 1
          WHERE id = ?
        `).run(nowIso, leaseExpiresAt, String(row.id));
      }

      const claimedRows = rows.map((row) =>
        mapOutboxRow({
          ...row,
          status: "leased",
          leased_at: nowIso,
          lease_expires_at: leaseExpiresAt,
          attempt_count: Number(row.attempt_count) + 1,
        }),
      );
      this.db.exec("COMMIT");
      return claimedRows;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  markDelivered(id: string, response: { iri: string | null; body: unknown }, completedAt: string = new Date().toISOString()): void {
    this.db.exec("BEGIN");
    try {
      this.db.prepare(`
        UPDATE partdb_outbox
        SET status = 'delivered',
            response_json = ?,
            response_iri = ?,
            completed_at = ?,
            lease_expires_at = NULL
        WHERE id = ?
      `).run(JSON.stringify(response.body), response.iri, completedAt, id);

      const row = this.db.prepare(`
        SELECT target_table, target_row_id, target_column
        FROM partdb_outbox
        WHERE id = ?
      `).get(id) as SqlRow | undefined;

      if (
        row &&
        typeof row.target_table === "string" &&
        typeof row.target_row_id === "string" &&
        typeof row.target_column === "string" &&
        response.iri
      ) {
        const targetValue = String(extractIdFromIri(response.iri));
        this.db.prepare(
          `UPDATE ${row.target_table} SET ${row.target_column} = ? WHERE id = ?`,
        ).run(targetValue, row.target_row_id);
      }

      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  markFailed(id: string, error: unknown, status: Extract<OutboxStatus, "failed" | "dead">, nextAttemptAt: string | null = null): void {
    this.db.prepare(`
      UPDATE partdb_outbox
      SET status = ?,
          next_attempt_at = COALESCE(?, next_attempt_at),
          last_error_json = ?,
          lease_expires_at = NULL
      WHERE id = ?
    `).run(status, nextAttemptAt, JSON.stringify(error), id);
  }

  hydrateOperation(row: OutboxRow): OutboxOperation {
    return parseWithSchema(
      outboxOperationSchema,
      {
        kind: row.operation,
        payload: JSON.parse(row.payloadJson),
        target:
          row.targetTable && row.targetRowId && row.targetColumn
            ? {
                table: row.targetTable,
                rowId: row.targetRowId,
                column: row.targetColumn,
              }
            : null,
        dependsOnId: row.dependsOnId,
      },
      "partdb outbox operation",
    );
  }
}

function computeIdempotencyKey(operation: OutboxOperation): string {
  const canonical = {
    kind: operation.kind,
    payload: operation.payload,
    target: operation.target,
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function mapOutboxRow(row: SqlRow): OutboxRow {
  return {
    id: String(row.id),
    idempotencyKey: String(row.idempotency_key),
    correlationId: String(row.correlation_id),
    operation: String(row.operation) as OutboxRow["operation"],
    payloadJson: String(row.payload_json),
    dependsOnId: stringOrNull(row.depends_on_id),
    targetTable: stringOrNull(row.target_table) as OutboxRow["targetTable"],
    targetRowId: stringOrNull(row.target_row_id),
    targetColumn: stringOrNull(row.target_column) as OutboxRow["targetColumn"],
    status: String(row.status) as OutboxStatus,
    attemptCount: Number(row.attempt_count),
    maxAttempts: Number(row.max_attempts),
    leaseExpiresAt: stringOrNull(row.lease_expires_at),
    nextAttemptAt: String(row.next_attempt_at),
    lastErrorJson: stringOrNull(row.last_error_json),
    responseJson: stringOrNull(row.response_json),
    responseIri: stringOrNull(row.response_iri),
    createdAt: String(row.created_at),
    leasedAt: stringOrNull(row.leased_at),
    completedAt: stringOrNull(row.completed_at),
  };
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function extractIdFromIri(iri: string): number {
  const match = iri.match(/\/(\d+)$/);
  if (!match) {
    throw new Error(`Could not extract numeric id from Part-DB IRI '${iri}'.`);
  }

  return Number(match[1]);
}
