import { z } from "zod";
import {
  applicationErrorResponseSchema,
  assignQrRequestSchema,
  authSessionSchema,
  correctionEventSchema,
  correctionHistoryQuerySchema,
  dashboardSummarySchema,
  editPartTypeDefinitionRequestSchema,
  editPartTypeDefinitionResponseSchema,
  inventoryEntitySummarySchema,
  latestQrBatchResponseSchema,
  logoutResponseSchema,
  mergePartTypesRequestSchema,
  parseWithSchema,
  partDbConnectionStatusSchema,
  partDbSyncDrainResponseSchema,
  partDbSyncBackfillResponseSchema,
  partDbSyncFailureSchema,
  partDbSyncStatusResponseSchema,
  partTypeSchema,
  qrCodeSchema,
  reassignEntityPartTypeRequestSchema,
  reassignEntityPartTypeResponseSchema,
  recordEventRequestSchema,
  registerQrBatchRequestSchema,
  registerQrBatchResponseSchema,
  reverseIngestAssignmentRequestSchema,
  reverseIngestAssignmentResponseSchema,
  scanResponseSchema,
  stockEventSchema,
  type AssignQrRequest,
  type AuthSession,
  type CorrectionEvent,
  type CorrectionHistoryQuery,
  type DashboardSummary,
  type EditPartTypeDefinitionRequest,
  type EditPartTypeDefinitionResponse,
  type LatestQrBatchResponse,
  type LogoutResponse,
  type MergePartTypesRequest,
  type PartDbConnectionStatus,
  type PartDbSyncDrainResponse,
  type PartDbSyncBackfillResponse,
  type PartDbSyncFailure,
  type PartDbSyncStatusResponse,
  type PartType,
  type ReassignEntityPartTypeRequest,
  type ReassignEntityPartTypeResponse,
  type RecordEventRequest,
  type RegisterQrBatchRequest,
  type RegisterQrBatchResponse,
  type ReverseIngestAssignmentRequest,
  type ReverseIngestAssignmentResponse,
  type ScanResponse,
  type StockEvent,
} from "@smart-db/contracts";

const configuredApiBaseUrl = (import.meta.env.VITE_API_BASE_URL ?? "").trim();

export class ApiClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

interface ApiRequestInit extends RequestInit {
  signal?: AbortSignal;
}

async function request<TSchema extends z.ZodTypeAny>(
  schema: TSchema,
  path: string,
  init?: ApiRequestInit,
): Promise<z.output<TSchema>> {
  const timeoutSignal = AbortSignal.timeout(15_000);
  const combinedSignal = init?.signal
    ? AbortSignal.any([init.signal, timeoutSignal])
    : timeoutSignal;
  const { headers: initHeaders, signal: _ignoredSignal, ...restInit } = init ?? {};
  const response = await fetch(apiUrl(path), {
    ...restInit,
    credentials: "include",
    headers: {
      ...(restInit.body != null ? { "Content-Type": "application/json" } : {}),
      ...(initHeaders ?? {}),
    },
    signal: combinedSignal,
  });

  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const parsedError =
      body === null
        ? null
        : applicationErrorResponseSchema.safeParse(body);
    if (parsedError?.success) {
      throw new ApiClientError(
        parsedError.data.error.code,
        parsedError.data.error.message,
        parsedError.data.error.details,
      );
    }

    throw new ApiClientError("transport", `Request failed with ${response.status}`);
  }

  return parseWithSchema(schema, await response.json(), `response for ${path}`);
}

export function loginUrl(returnTo: string): string {
  const url = new URL(apiUrl("/api/auth/login"), currentOrigin());
  url.searchParams.set("returnTo", returnTo);
  return url.toString();
}

export function setSessionToken(_token: string): void {}

export function clearSessionToken(): void {}

export function hydrateSessionToken(): string | null {
  return null;
}

function idempotencyHeaders(): Record<string, string> {
  return { "X-Idempotency-Key": crypto.randomUUID() };
}

export const inventorySummaryRowSchema = z.object({
  id: z.string(),
  canonicalName: z.string(),
  categoryPath: z.array(z.string()),
  unit: z.object({
    symbol: z.string(),
    name: z.string(),
    isInteger: z.boolean(),
  }),
  countable: z.boolean(),
  bins: z.number(),
  instanceCount: z.number(),
  onHand: z.number(),
  partDbSyncStatus: z.string(),
});
export type InventorySummaryRow = z.output<typeof inventorySummaryRowSchema>;

export const partTypeItemsResponseSchema = z.object({
  bulkStocks: z.array(z.object({
    id: z.string(),
    qrCode: z.string(),
    quantity: z.number(),
    location: z.string(),
    minimumQuantity: z.number().nullable(),
  })),
  instances: z.array(z.object({
    id: z.string(),
    qrCode: z.string(),
    status: z.string(),
    location: z.string(),
    assignee: z.string().nullable(),
  })),
});
export type PartTypeItemsResponse = z.output<typeof partTypeItemsResponseSchema>;

export const api = {
  getSession(signal?: AbortSignal): Promise<AuthSession> {
    return request(authSessionSchema, "/api/auth/session", signal ? { signal } : undefined);
  },
  async logout(): Promise<LogoutResponse> {
    return request(logoutResponseSchema, "/api/auth/logout", {
      method: "POST",
    });
  },
  getDashboard(): Promise<DashboardSummary> {
    return request(dashboardSummarySchema, "/api/dashboard");
  },
  getPartDbStatus(): Promise<PartDbConnectionStatus> {
    return request(partDbConnectionStatusSchema, "/api/partdb/status");
  },
  getPartDbSyncStatus(): Promise<PartDbSyncStatusResponse> {
    return request(partDbSyncStatusResponseSchema, "/api/partdb/sync/status");
  },
  getPartDbSyncFailures(): Promise<PartDbSyncFailure[]> {
    return request(partDbSyncFailureSchema.array(), "/api/partdb/sync/failures");
  },
  drainPartDbSync(): Promise<PartDbSyncDrainResponse> {
    return request(partDbSyncDrainResponseSchema, "/api/partdb/sync/drain", {
      method: "POST",
      body: JSON.stringify({}),
      headers: idempotencyHeaders(),
    });
  },
  backfillPartDbSync(): Promise<PartDbSyncBackfillResponse> {
    return request(partDbSyncBackfillResponseSchema, "/api/partdb/sync/backfill", {
      method: "POST",
      body: JSON.stringify({}),
      headers: idempotencyHeaders(),
    });
  },
  async retryPartDbSync(id: string): Promise<void> {
    await request(z.object({ ok: z.literal(true) }).strict(), `/api/partdb/sync/retry/${encodeURIComponent(id)}`, {
      method: "POST",
      body: JSON.stringify({}),
      headers: idempotencyHeaders(),
    });
  },
  getLatestQrBatch(): Promise<LatestQrBatchResponse> {
    return request(latestQrBatchResponseSchema, "/api/qr-batches/latest");
  },
  getProvisionalPartTypes(): Promise<PartType[]> {
    return request(partTypeSchema.array(), "/api/part-types/provisional");
  },
  getKnownLocations(): Promise<string[]> {
    return request(z.array(z.string()), "/api/locations");
  },
  getKnownCategories(): Promise<string[]> {
    return request(z.array(z.string()), "/api/categories");
  },
  splitBulkStock(bulkId: string, payload: { quantity: number; destinationLocation: string; notes: string | null }): Promise<{ source: { id: string; quantity: number }; destination: { id: string; quantity: number } }> {
    return request(
      z.object({
        source: z.object({ id: z.string(), quantity: z.number() }),
        destination: z.object({ id: z.string(), quantity: z.number() }),
      }),
      `/api/bulk-stocks/${encodeURIComponent(bulkId)}/split`,
      {
        method: "POST",
        body: JSON.stringify(payload),
        headers: idempotencyHeaders(),
      },
    );
  },
  getPartTypeItems(partTypeId: string): Promise<PartTypeItemsResponse> {
    return request(partTypeItemsResponseSchema, `/api/part-types/${encodeURIComponent(partTypeId)}/items`);
  },
  getCorrectionHistory(query: CorrectionHistoryQuery): Promise<CorrectionEvent[]> {
    const parsed = parseWithSchema(correctionHistoryQuerySchema, query, "correction history query");
    const params = new URLSearchParams({
      targetType: parsed.targetType,
      targetId: parsed.targetId,
    });
    return request(correctionEventSchema.array(), `/api/corrections/history?${params.toString()}`);
  },
  getInventorySummary(): Promise<InventorySummaryRow[]> {
    return request(inventorySummaryRowSchema.array(), "/api/inventory/summary");
  },
  searchPartTypes(query: string, signal?: AbortSignal): Promise<PartType[]> {
    return request(
      partTypeSchema.array(),
      `/api/part-types/search?q=${encodeURIComponent(query)}`,
      signal ? { signal } : undefined,
    );
  },
  registerQrBatch(payload: RegisterQrBatchRequest): Promise<RegisterQrBatchResponse> {
    return request(registerQrBatchResponseSchema, "/api/qr-batches", {
      method: "POST",
      body: JSON.stringify(parseWithSchema(registerQrBatchRequestSchema, payload, "QR batch form")),
      headers: idempotencyHeaders(),
    });
  },
  scan(
    code: string,
    options: { signal?: AbortSignal; autoIncrement?: boolean } = {},
  ): Promise<ScanResponse> {
    const autoIncrement = options.autoIncrement !== false;
    const path = autoIncrement ? "/api/scan" : "/api/scan?count=false";
    const init: ApiRequestInit = {
      method: "POST",
      body: JSON.stringify({ code }),
    };
    if (options.signal) {
      init.signal = options.signal;
    }
    return request(scanResponseSchema, path, init);
  },
  assignQr(payload: AssignQrRequest) {
    return request(inventoryEntitySummarySchema, "/api/assignments", {
      method: "POST",
      body: JSON.stringify(parseWithSchema(assignQrRequestSchema, payload, "assignment form")),
      headers: idempotencyHeaders(),
    });
  },
  recordEvent(payload: RecordEventRequest): Promise<StockEvent> {
    return request(stockEventSchema, "/api/events", {
      method: "POST",
      body: JSON.stringify(parseWithSchema(recordEventRequestSchema, payload, "event form")),
      headers: idempotencyHeaders(),
    });
  },
  mergePartTypes(payload: MergePartTypesRequest): Promise<PartType> {
    return request(partTypeSchema, "/api/part-types/merge", {
      method: "POST",
      body: JSON.stringify(parseWithSchema(mergePartTypesRequestSchema, payload, "merge request")),
      headers: idempotencyHeaders(),
    });
  },
  reassignEntityPartType(payload: ReassignEntityPartTypeRequest): Promise<ReassignEntityPartTypeResponse> {
    return request(reassignEntityPartTypeResponseSchema, "/api/corrections/reassign-part-type", {
      method: "POST",
      body: JSON.stringify(parseWithSchema(reassignEntityPartTypeRequestSchema, payload, "entity correction request")),
      headers: idempotencyHeaders(),
    });
  },
  editPartTypeDefinition(payload: EditPartTypeDefinitionRequest): Promise<EditPartTypeDefinitionResponse> {
    return request(editPartTypeDefinitionResponseSchema, "/api/corrections/edit-part-type", {
      method: "POST",
      body: JSON.stringify(parseWithSchema(editPartTypeDefinitionRequestSchema, payload, "part type definition correction request")),
      headers: idempotencyHeaders(),
    });
  },
  reverseIngestAssignment(payload: ReverseIngestAssignmentRequest): Promise<ReverseIngestAssignmentResponse> {
    return request(reverseIngestAssignmentResponseSchema, "/api/corrections/reverse-ingest", {
      method: "POST",
      body: JSON.stringify(parseWithSchema(reverseIngestAssignmentRequestSchema, payload, "reverse ingest request")),
      headers: idempotencyHeaders(),
    });
  },
  voidQr(code: string) {
    return request(qrCodeSchema, `/api/qr-codes/${encodeURIComponent(code)}/void`, {
      method: "POST",
      body: JSON.stringify({}),
      headers: idempotencyHeaders(),
    });
  },
  approvePartType(id: string): Promise<PartType> {
    return request(partTypeSchema, `/api/part-types/${encodeURIComponent(id)}/approve`, {
      method: "POST",
      body: JSON.stringify({}),
      headers: idempotencyHeaders(),
    });
  },
};

export function qrBatchLabelsPdfUrl(batchId: string): string {
  return apiUrl(`/api/qr-batches/${encodeURIComponent(batchId)}/labels.pdf`);
}

export async function downloadQrBatchLabelsPdf(batchId: string): Promise<void> {
  const response = await fetch(apiUrl(`/api/qr-batches/${encodeURIComponent(batchId)}/labels.pdf`), {
    credentials: "include",
  });

  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const parsedError =
      body === null
        ? null
        : applicationErrorResponseSchema.safeParse(body);
    if (parsedError?.success) {
      throw new ApiClientError(
        parsedError.data.error.code,
        parsedError.data.error.message,
        parsedError.data.error.details,
      );
    }

    throw new ApiClientError("transport", `Request failed with ${response.status}`);
  }

  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = filenameFromContentDisposition(
    response.headers.get("Content-Disposition"),
    `${batchId}-labels.pdf`,
  );
  anchor.click();
  URL.revokeObjectURL(objectUrl);
}

function filenameFromContentDisposition(
  header: string | null,
  fallback: string,
): string {
  if (!header) {
    return fallback;
  }

  const match = header.match(/filename="([^"]+)"/i);
  return match?.[1] ?? fallback;
}

function apiUrl(path: string): string {
  return configuredApiBaseUrl ? `${configuredApiBaseUrl}${path}` : path;
}

function currentOrigin(): string {
  return typeof window === "undefined" ? "http://localhost" : window.location.origin;
}
