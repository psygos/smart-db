export interface OutboxTarget {
  table: "part_types" | "physical_instances" | "bulk_stocks";
  rowId: string;
  column: "partdb_part_id" | "partdb_lot_id" | "partdb_category_id" | "partdb_unit_id";
}

export type OutboxOperation =
  | {
      kind: "create_category";
      payload: { path: string[]; parentIri: string | null };
      target: OutboxTarget | null;
      dependsOnId: string | null;
    }
  | {
      kind: "create_measurement_unit";
      payload: { name: string; symbol: string; isInteger: boolean };
      target: OutboxTarget;
      dependsOnId: null;
    }
  | {
      kind: "create_part";
      payload: {
        name: string;
        categoryIri: string | null;
        categoryPath: string[];
        unitIri: string | null;
        unit: {
          name: string;
          symbol: string;
          isInteger: boolean;
        };
        description: string;
        tags: string[];
        needsReview: boolean;
        minAmount: number | null;
      };
      target: OutboxTarget;
      dependsOnId: string | null;
    }
  | {
      kind: "update_part";
      payload: {
        partIri: string | null;
        patch: {
          name?: string | undefined;
          categoryIri?: string | null | undefined;
          categoryPath?: string[] | undefined;
          unitIri?: string | null | undefined;
          unit?: {
            name: string;
            symbol: string;
            isInteger: boolean;
          } | undefined;
          description?: string | undefined;
          tags?: string[] | undefined;
        };
      };
      target: OutboxTarget | null;
      dependsOnId: string | null;
    }
  | {
      kind: "create_storage_location";
      payload: { name: string };
      target: null;
      dependsOnId: null;
    }
  | {
      kind: "delete_part";
      payload: { partIri: string | null };
      target: null;
      dependsOnId: string | null;
    }
  | {
      kind: "create_lot";
      payload: {
        partIri: string | null;
        storageLocationName: string;
        storageLocationPath?: string[] | undefined;
        amount: number;
        description: string;
        userBarcode: string;
        instockUnknown: boolean;
      };
      target: OutboxTarget;
      dependsOnId: string | null;
    }
  | {
      kind: "update_lot";
      payload: {
        lotIri: string | null;
        patch: {
          amount?: number | undefined;
          storageLocationName?: string | undefined;
          storageLocationPath?: string[] | undefined;
          description?: string | undefined;
        };
      };
      target: OutboxTarget | null;
      dependsOnId: string | null;
    }
  | {
      kind: "delete_lot";
      payload: { lotIri: string | null };
      target: OutboxTarget | null;
      dependsOnId: string | null;
    };

export type OutboxOperationKind = OutboxOperation["kind"];
export type OutboxStatus = "pending" | "failed" | "leased" | "delivered" | "dead";

export interface OutboxRow {
  id: string;
  idempotencyKey: string;
  correlationId: string;
  operation: OutboxOperationKind;
  payloadJson: string;
  dependsOnId: string | null;
  targetTable: OutboxTarget["table"] | null;
  targetRowId: string | null;
  targetColumn: OutboxTarget["column"] | null;
  status: OutboxStatus;
  attemptCount: number;
  maxAttempts: number;
  leaseExpiresAt: string | null;
  nextAttemptAt: string;
  lastErrorJson: string | null;
  lastFailureAt: string | null;
  responseJson: string | null;
  responseIri: string | null;
  createdAt: string;
  leasedAt: string | null;
  completedAt: string | null;
}
