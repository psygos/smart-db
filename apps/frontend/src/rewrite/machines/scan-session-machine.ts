import { assign, setup } from "xstate";
import type { RewriteFailure } from "../errors";

export interface LastAssignmentSnapshot {
  readonly partTypeId: string;
  readonly partTypeName: string;
  readonly location: string;
}

export type ScanLookupResult =
  | { readonly mode: "unknown"; readonly code: string }
  | { readonly mode: "label"; readonly qrCode: string }
  | { readonly mode: "instance"; readonly qrCode: string; readonly targetId: string }
  | { readonly mode: "bulk"; readonly qrCode: string; readonly targetId: string };

export interface ScanSessionContext {
  readonly activeCode: string | null;
  readonly source: "manual" | "camera" | null;
  readonly lookup: ScanLookupResult | null;
  readonly failure: RewriteFailure | null;
  readonly lastAssignment: LastAssignmentSnapshot | null;
}

export type ScanSessionEvent =
  | {
      readonly type: "LOOKUP.REQUESTED";
      readonly code: string;
      readonly source: "manual" | "camera";
    }
  | { readonly type: "LOOKUP.UNKNOWN"; readonly code: string }
  | { readonly type: "LOOKUP.LABEL"; readonly qrCode: string }
  | { readonly type: "LOOKUP.INSTANCE"; readonly qrCode: string; readonly targetId: string }
  | { readonly type: "LOOKUP.BULK"; readonly qrCode: string; readonly targetId: string }
  | { readonly type: "LOOKUP.FAILED"; readonly failure: RewriteFailure }
  | { readonly type: "UNKNOWN.PROMOTED_TO_INTAKE" }
  | { readonly type: "ASSIGN.PARSE_REQUESTED" }
  | { readonly type: "ASSIGN.SUBMIT_REQUESTED" }
  | {
      readonly type: "ASSIGN.SUCCEEDED";
      readonly targetType: "instance" | "bulk";
      readonly qrCode: string;
      readonly targetId: string;
      readonly lastAssignment: LastAssignmentSnapshot;
    }
  | { readonly type: "ASSIGN.FAILED"; readonly failure: RewriteFailure }
  | { readonly type: "EVENT.PARSE_REQUESTED"; readonly targetType: "instance" | "bulk" }
  | { readonly type: "EVENT.SUBMIT_REQUESTED"; readonly targetType: "instance" | "bulk" }
  | {
      readonly type: "EVENT.SUCCEEDED";
      readonly targetType: "instance" | "bulk";
      readonly qrCode: string;
      readonly targetId: string;
    }
  | { readonly type: "EVENT.FAILED"; readonly failure: RewriteFailure }
  | { readonly type: "SPLIT.PARSE_REQUESTED" }
  | { readonly type: "SPLIT.SUBMIT_REQUESTED" }
  | { readonly type: "SPLIT.SUCCEEDED"; readonly qrCode: string; readonly targetId: string }
  | { readonly type: "SPLIT.FAILED"; readonly failure: RewriteFailure }
  | {
      readonly type: "EDIT.OPEN";
      readonly editKind: "reassign" | "editShared" | "reverseIngest";
    }
  | { readonly type: "EDIT.CLOSE" }
  | { readonly type: "EDIT.SUBMIT_REQUESTED" }
  | {
      readonly type: "EDIT.SUCCEEDED";
      readonly editKind: "reassign" | "editShared" | "reverseIngest";
    }
  | { readonly type: "EDIT.FAILED"; readonly failure: RewriteFailure }
  | { readonly type: "SCAN.CLEAR_REQUESTED" };

export const scanSessionMachine = setup({
  types: {
    context: {} as ScanSessionContext,
    events: {} as ScanSessionEvent,
    input: {} as Partial<ScanSessionContext>,
  },
  actions: {
    captureLookupRequest: assign({
      activeCode: ({ event }) => (event.type === "LOOKUP.REQUESTED" ? event.code : null),
      source: ({ event }) => (event.type === "LOOKUP.REQUESTED" ? event.source : null),
      lookup: () => null,
      failure: () => null,
      lastAssignment: ({ context }) => context.lastAssignment,
    }),
    setUnknown: assign({
      lookup: ({ event }) =>
        event.type === "LOOKUP.UNKNOWN"
          ? { mode: "unknown", code: event.code }
          : null,
      activeCode: ({ event, context }) =>
        event.type === "LOOKUP.UNKNOWN" ? event.code : context.activeCode,
    }),
    setLabelLookup: assign({
      lookup: ({ event }) =>
        event.type === "LOOKUP.LABEL"
          ? { mode: "label", qrCode: event.qrCode }
          : null,
      activeCode: ({ event, context }) =>
        event.type === "LOOKUP.LABEL" ? event.qrCode : context.activeCode,
    }),
    setInstanceLookup: assign({
      lookup: ({ event }) =>
        event.type === "LOOKUP.INSTANCE"
          ? { mode: "instance", qrCode: event.qrCode, targetId: event.targetId }
          : null,
      activeCode: ({ event, context }) =>
        event.type === "LOOKUP.INSTANCE" ? event.qrCode : context.activeCode,
    }),
    setBulkLookup: assign({
      lookup: ({ event }) =>
        event.type === "LOOKUP.BULK"
          ? { mode: "bulk", qrCode: event.qrCode, targetId: event.targetId }
          : null,
      activeCode: ({ event, context }) =>
        event.type === "LOOKUP.BULK" ? event.qrCode : context.activeCode,
    }),
    promoteUnknownToLabel: assign({
      lookup: ({ context }) =>
        context.lookup?.mode === "unknown"
          ? { mode: "label", qrCode: context.lookup.code }
          : context.lookup,
    }),
    captureAssignSuccess: assign({
      lastAssignment: ({ event }) =>
        event.type === "ASSIGN.SUCCEEDED" ? event.lastAssignment : null,
      lookup: ({ event }) =>
        event.type === "ASSIGN.SUCCEEDED"
          ? event.targetType === "instance"
            ? { mode: "instance", qrCode: event.qrCode, targetId: event.targetId }
            : { mode: "bulk", qrCode: event.qrCode, targetId: event.targetId }
          : null,
      activeCode: ({ event, context }) =>
        event.type === "ASSIGN.SUCCEEDED" ? event.qrCode : context.activeCode,
      failure: () => null,
    }),
    captureEventSuccess: assign({
      lookup: ({ event, context }) =>
        event.type === "EVENT.SUCCEEDED"
          ? event.targetType === "instance"
            ? { mode: "instance", qrCode: event.qrCode, targetId: event.targetId }
            : { mode: "bulk", qrCode: event.qrCode, targetId: event.targetId }
          : context.lookup,
      activeCode: ({ event, context }) =>
        event.type === "EVENT.SUCCEEDED" ? event.qrCode : context.activeCode,
      failure: () => null,
    }),
    captureSplitSuccess: assign({
      lookup: ({ event }) =>
        event.type === "SPLIT.SUCCEEDED"
          ? { mode: "bulk", qrCode: event.qrCode, targetId: event.targetId }
          : null,
      activeCode: ({ event, context }) =>
        event.type === "SPLIT.SUCCEEDED" ? event.qrCode : context.activeCode,
      failure: () => null,
    }),
    captureFailure: assign({
      failure: ({ event }) =>
        event.type === "LOOKUP.FAILED" ||
        event.type === "ASSIGN.FAILED" ||
        event.type === "EVENT.FAILED" ||
        event.type === "SPLIT.FAILED"
          ? event.failure
          : null,
    }),
    clearActiveScan: assign({
      activeCode: () => null,
      source: () => null,
      lookup: () => null,
      failure: () => null,
    }),
  },
}).createMachine({
  id: "scanSession",
  initial: "idle",
  context: ({ input }) => ({
    activeCode: input?.activeCode ?? null,
    source: input?.source ?? null,
    lookup: input?.lookup ?? null,
    failure: input?.failure ?? null,
    lastAssignment: input?.lastAssignment ?? null,
  }),
  states: {
    idle: {
      on: {
        "LOOKUP.REQUESTED": {
          target: "lookingUp",
          actions: "captureLookupRequest",
        },
      },
    },
    lookingUp: {
      on: {
        "LOOKUP.UNKNOWN": {
          target: "unknown",
          actions: "setUnknown",
        },
        "LOOKUP.LABEL": {
          target: "labeling.editing",
          actions: "setLabelLookup",
        },
        "LOOKUP.INSTANCE": {
          target: "interacting.instanceReady",
          actions: "setInstanceLookup",
        },
        "LOOKUP.BULK": {
          target: "interacting.bulkReady",
          actions: "setBulkLookup",
        },
        "LOOKUP.FAILED": {
          target: "failure.lookup",
          actions: "captureFailure",
        },
      },
    },
    unknown: {
      on: {
        "UNKNOWN.PROMOTED_TO_INTAKE": {
          target: "labeling.editing",
          actions: "promoteUnknownToLabel",
        },
        "LOOKUP.REQUESTED": {
          target: "lookingUp",
          actions: "captureLookupRequest",
        },
        "SCAN.CLEAR_REQUESTED": {
          target: "idle",
          actions: "clearActiveScan",
        },
      },
    },
    labeling: {
      initial: "editing",
      states: {
        editing: {
          on: {
            "ASSIGN.PARSE_REQUESTED": "parsing",
            "LOOKUP.REQUESTED": {
              target: "#scanSession.lookingUp",
              actions: "captureLookupRequest",
            },
            "SCAN.CLEAR_REQUESTED": {
              target: "#scanSession.idle",
              actions: "clearActiveScan",
            },
          },
        },
        parsing: {
          on: {
            "ASSIGN.SUBMIT_REQUESTED": "submitting",
            "ASSIGN.FAILED": {
              target: "#scanSession.failure.assign",
              actions: "captureFailure",
            },
          },
        },
        submitting: {
          on: {
            "ASSIGN.SUCCEEDED": [
              {
                guard: ({ event }) =>
                  event.type === "ASSIGN.SUCCEEDED" && event.targetType === "instance",
                target: "#scanSession.interacting.instanceReady",
                actions: "captureAssignSuccess",
              },
              {
                target: "#scanSession.interacting.bulkReady",
                actions: "captureAssignSuccess",
              },
            ],
            "ASSIGN.FAILED": {
              target: "#scanSession.failure.assign",
              actions: "captureFailure",
            },
          },
        },
      },
    },
    interacting: {
      initial: "instanceReady",
      states: {
        instanceReady: {
          on: {
            "EVENT.PARSE_REQUESTED": {
              guard: ({ event }) =>
                event.type === "EVENT.PARSE_REQUESTED" && event.targetType === "instance",
              target: "instanceSubmitting",
            },
            "EDIT.OPEN": "instanceEditing",
            "LOOKUP.REQUESTED": {
              target: "#scanSession.lookingUp",
              actions: "captureLookupRequest",
            },
            "SCAN.CLEAR_REQUESTED": {
              target: "#scanSession.idle",
              actions: "clearActiveScan",
            },
          },
        },
        instanceEditing: {
          on: {
            "EDIT.SUBMIT_REQUESTED": "instanceEditSubmitting",
            "EDIT.CLOSE": "instanceReady",
            "LOOKUP.REQUESTED": {
              target: "#scanSession.lookingUp",
              actions: "captureLookupRequest",
            },
            "SCAN.CLEAR_REQUESTED": {
              target: "#scanSession.idle",
              actions: "clearActiveScan",
            },
          },
        },
        instanceEditSubmitting: {
          on: {
            "EDIT.SUCCEEDED": "instanceReady",
            "EDIT.FAILED": {
              target: "#scanSession.failure.edit",
              actions: "captureFailure",
            },
          },
        },
        instanceSubmitting: {
          on: {
            "EVENT.SUCCEEDED": {
              guard: ({ event }) =>
                event.type === "EVENT.SUCCEEDED" && event.targetType === "instance",
              target: "instanceReady",
              actions: "captureEventSuccess",
            },
            "EVENT.FAILED": {
              target: "#scanSession.failure.event",
              actions: "captureFailure",
            },
          },
        },
        bulkReady: {
          on: {
            "EVENT.PARSE_REQUESTED": {
              guard: ({ event }) =>
                event.type === "EVENT.PARSE_REQUESTED" && event.targetType === "bulk",
              target: "bulkEventParsing",
            },
            "SPLIT.PARSE_REQUESTED": "bulkSplitParsing",
            "EDIT.OPEN": "bulkEditing",
            "LOOKUP.REQUESTED": {
              target: "#scanSession.lookingUp",
              actions: "captureLookupRequest",
            },
            "SCAN.CLEAR_REQUESTED": {
              target: "#scanSession.idle",
              actions: "clearActiveScan",
            },
          },
        },
        bulkEditing: {
          on: {
            "EDIT.SUBMIT_REQUESTED": "bulkEditSubmitting",
            "EDIT.CLOSE": "bulkReady",
            "LOOKUP.REQUESTED": {
              target: "#scanSession.lookingUp",
              actions: "captureLookupRequest",
            },
            "SCAN.CLEAR_REQUESTED": {
              target: "#scanSession.idle",
              actions: "clearActiveScan",
            },
          },
        },
        bulkEditSubmitting: {
          on: {
            "EDIT.SUCCEEDED": "bulkReady",
            "EDIT.FAILED": {
              target: "#scanSession.failure.edit",
              actions: "captureFailure",
            },
          },
        },
        bulkEventParsing: {
          on: {
            "EVENT.SUBMIT_REQUESTED": {
              guard: ({ event }) =>
                event.type === "EVENT.SUBMIT_REQUESTED" && event.targetType === "bulk",
              target: "bulkEventSubmitting",
            },
            "EVENT.FAILED": {
              target: "#scanSession.failure.event",
              actions: "captureFailure",
            },
          },
        },
        bulkEventSubmitting: {
          on: {
            "EVENT.SUCCEEDED": {
              guard: ({ event }) =>
                event.type === "EVENT.SUCCEEDED" && event.targetType === "bulk",
              target: "bulkReady",
              actions: "captureEventSuccess",
            },
            "EVENT.FAILED": {
              target: "#scanSession.failure.event",
              actions: "captureFailure",
            },
          },
        },
        bulkSplitParsing: {
          on: {
            "SPLIT.SUBMIT_REQUESTED": "bulkSplitSubmitting",
            "SPLIT.FAILED": {
              target: "#scanSession.failure.split",
              actions: "captureFailure",
            },
          },
        },
        bulkSplitSubmitting: {
          on: {
            "SPLIT.SUCCEEDED": {
              target: "bulkReady",
              actions: "captureSplitSuccess",
            },
            "SPLIT.FAILED": {
              target: "#scanSession.failure.split",
              actions: "captureFailure",
            },
          },
        },
      },
    },
    failure: {
      initial: "lookup",
      on: {
        "SCAN.CLEAR_REQUESTED": {
          target: "idle",
          actions: "clearActiveScan",
        },
        "LOOKUP.REQUESTED": {
          target: "lookingUp",
          actions: "captureLookupRequest",
        },
      },
      states: {
        lookup: {},
        assign: {},
        event: {},
        split: {},
        edit: {},
      },
    },
  },
});
