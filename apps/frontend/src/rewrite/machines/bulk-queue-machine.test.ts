import { createActor } from "xstate";
import { describe, expect, it } from "vitest";
import type { RewriteFailure } from "../errors";
import { bulkQueueMachine } from "./bulk-queue-machine";

const queueFailure: RewriteFailure = {
  kind: "domain",
  operation: "bulk.collect",
  code: "bulk_queue_mode_mismatch",
  message: "This scan does not belong in the current bulk queue.",
  retryability: "never",
  details: {
    machine: "bulkQueue",
    state: "ready",
  },
};

describe("bulkQueueMachine", () => {
  it("merges duplicate scans into a single row count", () => {
    const actor = createActor(bulkQueueMachine).start();

    actor.send({
      type: "QUEUE.ROW_ACCEPTED",
      row: {
        kind: "unlabeled",
        code: "QR-1",
        batchId: "batch-1",
        count: 1,
        firstSeenAt: "2026-01-01T00:00:00.000Z",
        lastSeenAt: "2026-01-01T00:00:00.000Z",
      },
    });
    actor.send({
      type: "QUEUE.ROW_ACCEPTED",
      row: {
        kind: "unlabeled",
        code: "QR-1",
        batchId: "batch-1",
        count: 1,
        firstSeenAt: "2026-01-01T00:00:01.000Z",
        lastSeenAt: "2026-01-01T00:00:01.000Z",
      },
    });

    expect(actor.getSnapshot().value).toBe("ready");
    expect(actor.getSnapshot().context.rows).toHaveLength(1);
    expect(actor.getSnapshot().context.rows[0]?.count).toBe(2);
  });

  it("decrements and removes rows explicitly", () => {
    const actor = createActor(bulkQueueMachine).start();

    actor.send({
      type: "QUEUE.ROW_ACCEPTED",
      row: {
        kind: "unlabeled",
        code: "QR-1",
        batchId: "batch-1",
        count: 2,
        firstSeenAt: "2026-01-01T00:00:00.000Z",
        lastSeenAt: "2026-01-01T00:00:00.000Z",
      },
    });

    actor.send({ type: "QUEUE.ROW_DECREMENT_REQUESTED", code: "QR-1" });
    expect(actor.getSnapshot().context.rows[0]?.count).toBe(1);

    actor.send({ type: "QUEUE.ROW_REMOVE_REQUESTED", code: "QR-1" });
    expect(actor.getSnapshot().value).toBe("empty");
    expect(actor.getSnapshot().context.rows).toHaveLength(0);
  });

  it("clears incompatible queue state when the action changes", () => {
    const actor = createActor(bulkQueueMachine).start();

    actor.send({
      type: "QUEUE.ROW_ACCEPTED",
      row: {
        kind: "assigned",
        code: "QR-1",
        count: 1,
        firstSeenAt: "2026-01-01T00:00:00.000Z",
        lastSeenAt: "2026-01-01T00:00:00.000Z",
        targetType: "instance",
        targetId: "instance-1",
        partTypeId: "part-1",
        partTypeName: "Arduino Uno",
        location: "Shelf A",
        deleteEligibility: {
          status: "eligible",
        },
      },
    });
    actor.send({ type: "QUEUE.ACTION_CHANGED", action: "delete" });

    expect(actor.getSnapshot().value).toBe("empty");
    expect(actor.getSnapshot().context.action).toBe("delete");
    expect(actor.getSnapshot().context.rows).toHaveLength(0);
  });

  it("keeps rows while exposing collection failures explicitly", () => {
    const actor = createActor(bulkQueueMachine).start();

    actor.send({
      type: "QUEUE.ROW_ACCEPTED",
      row: {
        kind: "unlabeled",
        code: "QR-1",
        batchId: "batch-1",
        count: 1,
        firstSeenAt: "2026-01-01T00:00:00.000Z",
        lastSeenAt: "2026-01-01T00:00:00.000Z",
      },
    });
    actor.send({
      type: "QUEUE.ROW_REJECTED",
      failure: queueFailure,
    });

    expect(actor.getSnapshot().value).toBe("failed");
    expect(actor.getSnapshot().context.rows).toHaveLength(1);
    expect(actor.getSnapshot().context.failure?.message).toBe(queueFailure.message);
  });

  it("returns to empty after a successful submit", () => {
    const actor = createActor(bulkQueueMachine).start();

    actor.send({
      type: "QUEUE.ROW_ACCEPTED",
      row: {
        kind: "assigned",
        code: "QR-1",
        count: 1,
        firstSeenAt: "2026-01-01T00:00:00.000Z",
        lastSeenAt: "2026-01-01T00:00:00.000Z",
        targetType: "bulk",
        targetId: "bulk-1",
        partTypeId: "part-1",
        partTypeName: "PLA",
        location: "Shelf A",
        deleteEligibility: {
          status: "eligible",
        },
      },
    });
    actor.send({ type: "QUEUE.SUBMIT_REQUESTED" });
    actor.send({ type: "QUEUE.SUBMIT_SUCCEEDED" });

    expect(actor.getSnapshot().value).toBe("empty");
    expect(actor.getSnapshot().context.rows).toHaveLength(0);
  });
});
