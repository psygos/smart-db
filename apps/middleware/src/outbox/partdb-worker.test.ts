import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Err, Ok } from "@smart-db/contracts";
import { applyMigrations } from "../db/migrations.js";
import { PartDbOutbox } from "./partdb-outbox.js";
import { PartDbOutboxWorker, retryBackoffMs } from "./partdb-worker.js";

function makeDb(): DatabaseSync {
  const directory = mkdtempSync(join(tmpdir(), "smart-db-worker-"));
  const db = new DatabaseSync(join(directory, "smart.db"));
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA journal_mode = WAL;");
  applyMigrations(db);
  return db;
}

describe("PartDbOutboxWorker", () => {
  let db: DatabaseSync;
  let outbox: PartDbOutbox;

  beforeEach(() => {
    db = makeDb();
    outbox = new PartDbOutbox(db);
  });

  it("delivers successful operations and persists response metadata", async () => {
    const operationId = outbox.enqueue(
      {
        kind: "create_storage_location",
        payload: { name: "Shelf A" },
        target: null,
        dependsOnId: null,
      },
      "corr-1",
    );

    const operations = {
      execute: vi.fn().mockResolvedValue(
        Ok({ iri: "/api/storage_locations/2", body: { id: 2 } }),
      ),
    } as never;
    const logger = { info: vi.fn(), error: vi.fn() };
    const worker = new PartDbOutboxWorker(outbox, operations, logger);

    const result = await worker.tick("2030-01-01T00:00:00.000Z");
    expect(result).toEqual({ claimed: 1, delivered: 1, failed: 0 });
    expect(outbox.getById(operationId)).toMatchObject({
      status: "delivered",
      responseIri: "/api/storage_locations/2",
    });
  });

  it("hydrates dependent IRIs before execution", async () => {
    const partOp = outbox.enqueue(
      {
        kind: "create_part",
        payload: {
          name: "Arduino Uno",
          categoryIri: "/api/categories/7",
          categoryPath: ["Electronics", "Microcontrollers"],
          unitIri: "/api/measurement_units/3",
          unit: { name: "Pieces", symbol: "pcs", isInteger: true },
          description: "",
          tags: [],
          needsReview: false,
          minAmount: null,
        },
        target: { table: "part_types", rowId: "part-1", column: "partdb_part_id" },
        dependsOnId: null,
      },
      "corr-2",
    );
    outbox.markDelivered(partOp, { iri: "/api/parts/9", body: { id: 9 } }, "2026-01-01T00:00:00.000Z");

    outbox.enqueue(
      {
        kind: "create_lot",
        payload: {
          partIri: null,
          storageLocationName: "Shelf A",
          amount: 1,
          description: "",
          userBarcode: "QR-1",
          instockUnknown: false,
        },
        target: { table: "physical_instances", rowId: "instance-1", column: "partdb_lot_id" },
        dependsOnId: partOp,
      },
      "corr-2",
    );

    const operations = {
      execute: vi.fn().mockResolvedValue(
        Ok({ iri: "/api/part_lots/5", body: { id: 5 } }),
      ),
    } as never;
    const worker = new PartDbOutboxWorker(outbox, operations, { info: vi.fn(), error: vi.fn() });

    await worker.tick("2030-01-01T00:00:00.000Z");
    expect(operations.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "create_lot",
        payload: expect.objectContaining({
          partIri: "/api/parts/9",
        }),
      }),
    );
  });

  it("schedules retryable errors with exponential backoff", async () => {
    const retryId = outbox.enqueue(
      {
        kind: "create_storage_location",
        payload: { name: "Shelf B" },
        target: null,
        dependsOnId: null,
      },
      "corr-3",
    );

    const operations = {
      execute: vi
        .fn()
        .mockResolvedValueOnce(
          Err({ kind: "network", message: "reset", cause: new Error("reset"), retryable: true }),
        )
    } as never;
    const worker = new PartDbOutboxWorker(outbox, operations, { info: vi.fn(), error: vi.fn() });

    await worker.tick("2030-01-01T00:00:00.000Z");

    expect(outbox.getById(retryId)).toMatchObject({
      status: "failed",
      nextAttemptAt: "2030-01-01T00:00:02.000Z",
    });
  });

  it("dead-letters non-retryable errors", async () => {
    const deadId = outbox.enqueue(
      {
        kind: "create_storage_location",
        payload: { name: "Shelf C" },
        target: null,
        dependsOnId: null,
      },
      "corr-4",
    );

    const operations = {
      execute: vi.fn().mockResolvedValue(
        Err({ kind: "validation", httpStatus: 422, violations: [], retryable: false }),
      ),
    } as never;
    const worker = new PartDbOutboxWorker(outbox, operations, { info: vi.fn(), error: vi.fn() });

    await worker.tick("2030-01-01T00:00:00.000Z");

    expect(outbox.getById(deadId)).toMatchObject({
      status: "dead",
    });
  });
});

describe("retryBackoffMs", () => {
  it("grows exponentially and caps at five minutes", () => {
    expect(retryBackoffMs(0)).toBe(1000);
    expect(retryBackoffMs(1)).toBe(2000);
    expect(retryBackoffMs(2)).toBe(4000);
    expect(retryBackoffMs(10)).toBe(300000);
  });
});
