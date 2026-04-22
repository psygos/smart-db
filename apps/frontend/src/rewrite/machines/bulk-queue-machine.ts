import { assign, setup } from "xstate";
import type { RewriteFailure } from "../errors";
import type { BulkQueueAction, BulkQueueRow } from "../ui-state";

export interface BulkQueueContext {
  readonly action: BulkQueueAction;
  readonly kind: "unlabeled" | "assigned" | null;
  readonly rows: readonly BulkQueueRow[];
  readonly failure: RewriteFailure | null;
}

export type BulkQueueEvent =
  | { readonly type: "QUEUE.ACTION_CHANGED"; readonly action: BulkQueueAction }
  | { readonly type: "QUEUE.ROW_ACCEPTED"; readonly row: BulkQueueRow }
  | { readonly type: "QUEUE.ROW_REJECTED"; readonly failure: RewriteFailure }
  | { readonly type: "QUEUE.ROW_DECREMENT_REQUESTED"; readonly code: string }
  | { readonly type: "QUEUE.ROW_REMOVE_REQUESTED"; readonly code: string }
  | { readonly type: "QUEUE.CLEAR_REQUESTED" }
  | { readonly type: "QUEUE.SUBMIT_REQUESTED" }
  | { readonly type: "QUEUE.SUBMIT_SUCCEEDED" }
  | { readonly type: "QUEUE.SUBMIT_FAILED"; readonly failure: RewriteFailure };

export const bulkQueueMachine = setup({
  types: {
    context: {} as BulkQueueContext,
    events: {} as BulkQueueEvent,
    input: {} as Partial<BulkQueueContext>,
  },
  actions: {
    changeAction: assign({
      action: ({ event, context }) =>
        event.type === "QUEUE.ACTION_CHANGED" ? event.action : context.action,
      kind: () => null,
      rows: () => [],
      failure: () => null,
    }),
    acceptRow: assign({
      kind: ({ event, context }) =>
        event.type === "QUEUE.ROW_ACCEPTED" ? event.row.kind : context.kind,
      rows: ({ event, context }) =>
        event.type === "QUEUE.ROW_ACCEPTED" ? mergeRow(context.rows, event.row) : context.rows,
      failure: () => null,
    }),
    rejectRow: assign({
      failure: ({ event, context }) =>
        event.type === "QUEUE.ROW_REJECTED" || event.type === "QUEUE.SUBMIT_FAILED"
          ? event.failure
          : context.failure,
    }),
    decrementRow: assign({
      rows: ({ event, context }) =>
        event.type === "QUEUE.ROW_DECREMENT_REQUESTED"
          ? context.rows.flatMap((row) =>
              row.code !== event.code
                ? [row]
                : row.count <= 1
                  ? []
                  : [{ ...row, count: row.count - 1 }]
            )
          : context.rows,
      kind: ({ event, context }) =>
        event.type === "QUEUE.ROW_DECREMENT_REQUESTED"
          ? deriveKind(
              context.rows.flatMap((row) =>
                row.code !== event.code
                  ? [row]
                  : row.count <= 1
                    ? []
                    : [{ ...row, count: row.count - 1 }]
              ),
            )
          : context.kind,
      failure: () => null,
    }),
    removeRow: assign({
      rows: ({ event, context }) =>
        event.type === "QUEUE.ROW_REMOVE_REQUESTED"
          ? context.rows.filter((row) => row.code !== event.code)
          : context.rows,
      kind: ({ event, context }) =>
        event.type === "QUEUE.ROW_REMOVE_REQUESTED"
          ? deriveKind(context.rows.filter((row) => row.code !== event.code))
          : context.kind,
      failure: () => null,
    }),
    clearQueue: assign({
      kind: () => null,
      rows: () => [],
      failure: () => null,
    }),
  },
}).createMachine({
  id: "bulkQueue",
  initial: "empty",
  context: ({ input }) => ({
    action: input?.action ?? "label",
    kind: input?.kind ?? null,
    rows: input?.rows ?? [],
    failure: input?.failure ?? null,
  }),
  states: {
    empty: {
      on: {
        "QUEUE.ACTION_CHANGED": {
          actions: "changeAction",
        },
        "QUEUE.ROW_ACCEPTED": {
          target: "ready",
          actions: "acceptRow",
        },
        "QUEUE.ROW_REJECTED": {
          target: "failed",
          actions: "rejectRow",
        },
        "QUEUE.CLEAR_REQUESTED": {
          actions: "clearQueue",
        },
      },
    },
    ready: {
      on: {
        "QUEUE.ACTION_CHANGED": {
          target: "empty",
          actions: "changeAction",
        },
        "QUEUE.ROW_ACCEPTED": {
          actions: "acceptRow",
        },
        "QUEUE.ROW_REJECTED": {
          target: "failed",
          actions: "rejectRow",
        },
        "QUEUE.ROW_DECREMENT_REQUESTED": [
          {
            target: "empty",
            guard: ({ context, event }) =>
              event.type === "QUEUE.ROW_DECREMENT_REQUESTED" && nextRowsAfterDecrement(context.rows, event.code).length === 0,
            actions: "decrementRow",
          },
          {
            actions: "decrementRow",
          },
        ],
        "QUEUE.ROW_REMOVE_REQUESTED": [
          {
            target: "empty",
            guard: ({ context, event }) =>
              event.type === "QUEUE.ROW_REMOVE_REQUESTED" && context.rows.filter((row) => row.code !== event.code).length === 0,
            actions: "removeRow",
          },
          {
            actions: "removeRow",
          },
        ],
        "QUEUE.CLEAR_REQUESTED": {
          target: "empty",
          actions: "clearQueue",
        },
        "QUEUE.SUBMIT_REQUESTED": {
          target: "submitting",
        },
      },
    },
    submitting: {
      on: {
        "QUEUE.SUBMIT_SUCCEEDED": {
          target: "empty",
          actions: "clearQueue",
        },
        "QUEUE.SUBMIT_FAILED": {
          target: "failed",
          actions: "rejectRow",
        },
      },
    },
    failed: {
      on: {
        "QUEUE.ACTION_CHANGED": {
          target: "empty",
          actions: "changeAction",
        },
        "QUEUE.ROW_ACCEPTED": {
          target: "ready",
          actions: "acceptRow",
        },
        "QUEUE.ROW_REJECTED": {
          actions: "rejectRow",
        },
        "QUEUE.ROW_DECREMENT_REQUESTED": [
          {
            target: "empty",
            guard: ({ context, event }) =>
              event.type === "QUEUE.ROW_DECREMENT_REQUESTED" && nextRowsAfterDecrement(context.rows, event.code).length === 0,
            actions: "decrementRow",
          },
          {
            target: "ready",
            actions: "decrementRow",
          },
        ],
        "QUEUE.ROW_REMOVE_REQUESTED": [
          {
            target: "empty",
            guard: ({ context, event }) =>
              event.type === "QUEUE.ROW_REMOVE_REQUESTED" && context.rows.filter((row) => row.code !== event.code).length === 0,
            actions: "removeRow",
          },
          {
            target: "ready",
            actions: "removeRow",
          },
        ],
        "QUEUE.CLEAR_REQUESTED": {
          target: "empty",
          actions: "clearQueue",
        },
        "QUEUE.SUBMIT_REQUESTED": {
          target: "submitting",
        },
      },
    },
  },
});

function mergeRow(rows: readonly BulkQueueRow[], incoming: BulkQueueRow): readonly BulkQueueRow[] {
  const existing = rows.find((row) => row.code === incoming.code);
  if (!existing) {
    return [...rows, incoming];
  }

  return rows.map((row) =>
    row.code !== incoming.code
      ? row
      : {
          ...row,
          count: row.count + incoming.count,
          lastSeenAt: incoming.lastSeenAt,
        }
  );
}

function nextRowsAfterDecrement(rows: readonly BulkQueueRow[], code: string): readonly BulkQueueRow[] {
  return rows.flatMap((row) =>
    row.code !== code
      ? [row]
      : row.count <= 1
        ? []
        : [{ ...row, count: row.count - 1 }]
  );
}

function deriveKind(rows: readonly BulkQueueRow[]): "unlabeled" | "assigned" | null {
  return rows[0]?.kind ?? null;
}
