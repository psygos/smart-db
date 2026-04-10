import type { FastifyBaseLogger } from "fastify";
import { type Result, Err, Ok } from "@smart-db/contracts";
import { isRetryable, type PartDbError } from "../partdb/partdb-errors.js";
import {
  PartDbOperations,
  type PartDbOperationResponse,
} from "../partdb/partdb-operations.js";
import { PartDbOutbox } from "./partdb-outbox.js";
import type { OutboxOperation, OutboxRow } from "./outbox-types.js";

interface WorkerOptions {
  intervalMs?: number;
  leaseDurationMs?: number;
  batchSize?: number;
}

export class PartDbOutboxWorker {
  private readonly intervalMs: number;
  private readonly leaseDurationMs: number;
  private readonly batchSize: number;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly outbox: PartDbOutbox,
    private readonly operations: PartDbOperations,
    private readonly logger: Pick<FastifyBaseLogger, "info" | "error">,
    options: WorkerOptions = {},
  ) {
    this.intervalMs = options.intervalMs ?? 2_000;
    this.leaseDurationMs = options.leaseDurationMs ?? 30_000;
    this.batchSize = options.batchSize ?? 10;
  }

  start(): void {
    if (this.timer) {
      return;
    }

    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async tick(nowIso: string = new Date().toISOString()): Promise<{
    claimed: number;
    delivered: number;
    failed: number;
  }> {
    const rows = this.outbox.claimBatch({
      nowIso,
      batchSize: this.batchSize,
      leaseDurationMs: this.leaseDurationMs,
    });

    let delivered = 0;
    let failed = 0;

    for (const row of rows) {
      const result = await this.processOne(row, nowIso);
      if (result.ok) {
        delivered += 1;
      } else {
        failed += 1;
      }
    }

    if (rows.length > 0) {
      this.logger.info({ claimed: rows.length, delivered, failed }, "Part-DB outbox tick completed");
    }

    return {
      claimed: rows.length,
      delivered,
      failed,
    };
  }

  private async processOne(
    row: OutboxRow,
    nowIso: string,
  ): Promise<Result<void, PartDbError>> {
    const hydrated = this.hydrateOperation(row);
    if (!hydrated.ok) {
      this.outbox.markFailed(row.id, hydrated.error, "dead");
      return hydrated;
    }

    const executed = await this.operations.execute(hydrated.value);
    if (executed.ok) {
      this.outbox.markDelivered(row.id, executed.value, nowIso);
      return Ok(undefined);
    }

    if (isRetryable(executed.error)) {
      const nextAttemptAt = new Date(
        Date.parse(nowIso) + retryBackoffMs(row.attemptCount),
      ).toISOString();
      const status = row.attemptCount >= row.maxAttempts ? "dead" : "failed";
      this.outbox.markFailed(row.id, executed.error, status, status === "dead" ? null : nextAttemptAt);
    } else {
      this.outbox.markFailed(row.id, executed.error, "dead");
    }

    return Err(executed.error);
  }

  private hydrateOperation(row: OutboxRow): Result<OutboxOperation, PartDbError> {
    const operation = this.outbox.hydrateOperation(row);
    if (operation.kind === "create_lot" && operation.payload.partIri === null && row.dependsOnId) {
      const dependencyIri = this.outbox.getDependencyResponseIri(row.dependsOnId);
      if (!dependencyIri) {
        return Err({ kind: "dependency_missing", dependency: "partIri", retryable: false });
      }

      return Ok({
        ...operation,
        payload: {
          ...operation.payload,
          partIri: dependencyIri,
        },
      });
    }

    if ((operation.kind === "update_lot" || operation.kind === "delete_lot") && row.dependsOnId) {
      const dependencyIri = this.outbox.getDependencyResponseIri(row.dependsOnId);
      if (!dependencyIri) {
        return Err({ kind: "dependency_missing", dependency: "lotIri", retryable: false });
      }

      return Ok(
        operation.kind === "update_lot"
          ? {
              ...operation,
              payload: {
                ...operation.payload,
                lotIri: operation.payload.lotIri ?? dependencyIri,
              },
            }
          : {
              ...operation,
              payload: {
                lotIri: operation.payload.lotIri ?? dependencyIri,
              },
            },
      );
    }

    return Ok(operation);
  }
}

export function retryBackoffMs(attemptCount: number): number {
  return Math.min(1_000 * Math.pow(2, attemptCount), 5 * 60 * 1_000);
}
