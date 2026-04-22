import type { ParseIssue } from "@smart-db/contracts";

export type OperationName =
  | "session.restore"
  | "session.logout"
  | "scan.lookup"
  | "scan.assign"
  | "scan.recordEvent"
  | "scan.splitBulk"
  | "bulk.collect"
  | "bulk.assign"
  | "bulk.move"
  | "bulk.delete"
  | "correction.scan"
  | "correction.loadHistory"
  | "correction.reassignEntityPartType"
  | "correction.editPartTypeDefinition"
  | "correction.reverseIngest"
  | "inventory.loadSummary"
  | "inventory.loadPartTypeItems"
  | "activity.loadDashboard"
  | "admin.registerBatch"
  | "admin.downloadBatchLabels"
  | "admin.searchMergeDestination"
  | "admin.mergePartType"
  | "admin.approvePartType"
  | "partdb.sync.drain"
  | "partdb.sync.backfill"
  | "partdb.sync.retry";

export type Retryability = "never" | "safe" | "after-user-action";

export type ParseFailureSource = "form" | "query" | "response" | "storage" | "camera";

export interface ParseFailureDetails {
  readonly source: ParseFailureSource;
  readonly context: string;
  readonly issueCount: number;
  readonly primaryPath: string | null;
  readonly primaryMessage: string | null;
}

export type DomainFailureCode =
  | "missing_active_scan"
  | "missing_assignable_lookup"
  | "invalid_route_access"
  | "machine_contract_broken"
  | "unsupported_action"
  | "bulk_queue_empty"
  | "bulk_queue_mixed_kind"
  | "bulk_queue_mode_mismatch"
  | "bulk_queue_ineligible"
  | "bulk_queue_external_unsupported";

export type RewriteFailure =
  | {
      readonly kind: "parse";
      readonly operation: OperationName;
      readonly source: ParseFailureSource;
      readonly issues: readonly ParseIssue[];
      readonly message: string;
      readonly retryability: "never";
      readonly details: ParseFailureDetails;
    }
  | {
      readonly kind: "transport";
      readonly operation: OperationName;
      readonly reason: "network" | "timeout" | "aborted";
      readonly message: string;
      readonly retryability: "safe" | "after-user-action";
      readonly details: {
        readonly endpoint: string | null;
      };
    }
  | {
      readonly kind: "auth";
      readonly operation: OperationName;
      readonly code: "unauthenticated" | "forbidden" | "expired";
      readonly message: string;
      readonly retryability: "after-user-action";
      readonly details: {
        readonly sessionKnown: boolean;
      };
    }
  | {
      readonly kind: "conflict";
      readonly operation: OperationName;
      readonly code:
        | "idempotency_in_progress"
        | "already_assigned"
        | "illegal_transition"
        | "stale_state";
      readonly message: string;
      readonly retryability: "after-user-action";
      readonly details: {
        readonly targetId: string | null;
      };
    }
  | {
      readonly kind: "domain";
      readonly operation: OperationName;
      readonly code: DomainFailureCode;
      readonly message: string;
      readonly retryability: "never";
      readonly details: {
        readonly machine: string;
        readonly state: string;
      };
    }
  | {
      readonly kind: "integration";
      readonly operation: OperationName;
      readonly service: "partdb" | "camera" | "download" | "browser";
      readonly message: string;
      readonly retryability: Retryability;
      readonly details: {
        readonly capability: string | null;
      };
    }
  | {
      readonly kind: "unexpected";
      readonly operation: OperationName;
      readonly message: string;
      readonly retryability: "never";
      readonly cause?: unknown;
      readonly details: {
        readonly machine: string | null;
      };
    };

export function isRetryableFailure(failure: RewriteFailure): boolean {
  return failure.retryability !== "never";
}

const parseOperationContexts: Record<OperationName, string> = {
  "session.restore": "session restoration",
  "session.logout": "sign-out",
  "scan.lookup": "scan lookup",
  "scan.assign": "assignment form",
  "scan.recordEvent": "event form",
  "scan.splitBulk": "split form",
  "bulk.collect": "bulk queue scan",
  "bulk.assign": "bulk label form",
  "bulk.move": "bulk move form",
  "bulk.delete": "bulk delete form",
  "correction.scan": "correction scan",
  "correction.loadHistory": "correction history",
  "correction.reassignEntityPartType": "entity correction",
  "correction.editPartTypeDefinition": "shared part type edit",
  "correction.reverseIngest": "ingest reversal",
  "inventory.loadSummary": "inventory summary",
  "inventory.loadPartTypeItems": "part type items",
  "activity.loadDashboard": "dashboard loading",
  "admin.registerBatch": "batch form",
  "admin.downloadBatchLabels": "batch label download",
  "admin.searchMergeDestination": "merge destination search",
  "admin.mergePartType": "merge form",
  "admin.approvePartType": "part type approval",
  "partdb.sync.drain": "Part-DB sync drain",
  "partdb.sync.backfill": "Part-DB sync backfill",
  "partdb.sync.retry": "Part-DB sync retry",
};

export function describeOperation(operation: OperationName): string {
  return parseOperationContexts[operation];
}

export function createParseFailure(
  operation: OperationName,
  source: ParseFailureSource,
  issues: readonly ParseIssue[],
): Extract<RewriteFailure, { readonly kind: "parse" }> {
  const firstIssue = issues[0] ?? null;
  const context = describeOperation(operation);
  return {
    kind: "parse",
    operation,
    source,
    issues,
    message: formatParseFailureMessage(context, issues),
    retryability: "never",
    details: {
      source,
      context,
      issueCount: issues.length,
      primaryPath: firstIssue?.path ?? null,
      primaryMessage: firstIssue?.message ?? null,
    },
  };
}

function formatParseFailureMessage(
  context: string,
  issues: readonly ParseIssue[],
): string {
  if (issues.length === 0) {
    return `Could not parse ${context}.`;
  }

  const firstIssue = issues[0]!;
  return `Could not parse ${context}: ${firstIssue.message}`;
}

export function failureSummary(failure: RewriteFailure): string {
  return failure.message;
}
