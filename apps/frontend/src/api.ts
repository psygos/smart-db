import { z } from "zod";
import {
  applicationErrorResponseSchema,
  assignQrRequestSchema,
  authSessionSchema,
  bulkAssignQrsRequestSchema,
  bulkAssignQrsResponseSchema,
  bulkMoveEntitiesRequestSchema,
  bulkMoveEntitiesResponseSchema,
  bulkReverseIngestRequestSchema,
  bulkReverseIngestResponseSchema,
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
  partTypeArtBackfillResponseSchema,
  partTypeSchema,
  qrCodeSchema,
  reassignEntityPartTypeRequestSchema,
  reassignEntityPartTypeResponseSchema,
  reassignEntityQrRequestSchema,
  reassignEntityQrResponseSchema,
  recordEventRequestSchema,
  registerQrBatchRequestSchema,
  registerQrBatchResponseSchema,
  reverseIngestAssignmentRequestSchema,
  reverseIngestAssignmentResponseSchema,
  scanResponseSchema,
  stockEventSchema,
  type AssignQrRequest,
  type AuthSession,
  type BulkAssignQrsRequest,
  type BulkAssignQrsResponse,
  type BulkMoveEntitiesRequest,
  type BulkMoveEntitiesResponse,
  type BulkReverseIngestRequest,
  type BulkReverseIngestResponse,
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
  type PartTypeArtBackfillResponse,
  type PartType,
  type ReassignEntityPartTypeRequest,
  type ReassignEntityPartTypeResponse,
  type ReassignEntityQrRequest,
  type ReassignEntityQrResponse,
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

export type ApiTransportReason = "offline" | "timeout" | "aborted" | "unreachable";

export class ApiTransportError extends ApiClientError {
  constructor(
    readonly reason: ApiTransportReason,
    readonly endpoint: string,
  ) {
    super("transport", transportMessage(reason, endpoint), { reason, endpoint });
    this.name = "ApiTransportError";
  }
}

interface ApiRequestInit extends RequestInit {
  signal?: AbortSignal;
}

const requestTimeoutMs = 15_000;

async function fetchApi(path: string, init?: RequestInit): Promise<Response> {
  const callerSignal = init?.signal ?? null;
  const timeoutSignal = AbortSignal.timeout(requestTimeoutMs);
  const combinedSignal = callerSignal
    ? AbortSignal.any([callerSignal, timeoutSignal])
    : timeoutSignal;

  try {
    return await fetch(apiUrl(path), {
      ...init,
      signal: combinedSignal,
    });
  } catch (caught) {
    throw classifyTransportError(path, caught, callerSignal, timeoutSignal);
  }
}

function classifyTransportError(
  path: string,
  caught: unknown,
  callerSignal: AbortSignal | null,
  timeoutSignal: AbortSignal,
): ApiTransportError {
  if (callerSignal?.aborted) {
    return new ApiTransportError("aborted", path);
  }

  if (timeoutSignal.aborted || errorName(caught) === "TimeoutError") {
    return new ApiTransportError("timeout", path);
  }

  if (errorName(caught) === "AbortError") {
    return new ApiTransportError("aborted", path);
  }

  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return new ApiTransportError("offline", path);
  }

  return new ApiTransportError("unreachable", path);
}

function errorName(value: unknown): string | null {
  if (typeof value !== "object" || value === null || !("name" in value)) {
    return null;
  }

  return typeof value.name === "string" ? value.name : null;
}

function transportMessage(reason: ApiTransportReason, endpoint: string): string {
  const action = requestAction(endpoint);
  switch (reason) {
    case "offline":
      return `Cannot ${action} right now because this device is offline. Reconnect to the lab network and try again.`;
    case "timeout":
      return `Smart DB took too long to ${action}. Check the lab network and try again.`;
    case "aborted":
      return "The request was cancelled.";
    case "unreachable":
      return `Cannot ${action} because this device cannot reach the Smart DB host. Check the lab Wi-Fi and try again.`;
  }
}

function requestAction(endpoint: string): string {
  if (endpoint.startsWith("/api/scan")) return "scan";
  if (endpoint === "/api/assignments") return "assign this item";
  if (endpoint.startsWith("/api/corrections")) return "save this correction";
  if (endpoint.startsWith("/api/partdb/sync")) return "update Part-DB sync";
  if (endpoint.endsWith("/labels.pdf")) return "download the label PDF";
  if (endpoint === "/api/auth/session") return "restore your session";
  if (endpoint === "/api/auth/logout") return "sign out";
  if (endpoint === "/api/qr-batches") return "create this QR batch";
  if (endpoint.startsWith("/api/part-types/search")) return "search the parts catalog";
  if (
    endpoint === "/api/dashboard" ||
    endpoint === "/api/inventory/summary" ||
    endpoint === "/api/locations" ||
    endpoint === "/api/categories"
  ) {
    return "refresh Smart DB data";
  }
  return "complete this request";
}

async function request<TSchema extends z.ZodTypeAny>(
  schema: TSchema,
  path: string,
  init?: ApiRequestInit,
): Promise<z.output<TSchema>> {
  const { headers: initHeaders, signal: requestSignal, body: initBody, ...restInit } = init ?? {};
  // Only declare the JSON content-type when we actually have a JSON body to
  // send. Fastify's default JSON parser rejects body-less requests that carry
  // a Content-Type: application/json header with FST_ERR_CTP_EMPTY_JSON_BODY
  // (status 400) before the route handler runs, which made every body-less
  // POST (logout, sync-drain, etc.) fail with an opaque invariant 500.
  const hasBody = initBody !== undefined && initBody !== null;
  const headers: HeadersInit = {
    ...(hasBody ? { "Content-Type": "application/json" } : {}),
    ...(initHeaders ?? {}),
  };
  const response = await fetchApi(path, {
    ...restInit,
    ...(hasBody ? { body: initBody } : {}),
    credentials: "include",
    headers,
    ...(requestSignal ? { signal: requestSignal } : {}),
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

    throw new ApiClientError(
      "http_error",
      `Smart DB returned HTTP ${response.status}.`,
      { endpoint: path, httpStatus: response.status },
    );
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
  imageUrl: z.string().nullable().default(null),
  unit: z.object({
    symbol: z.string(),
    name: z.string(),
    isInteger: z.boolean(),
  }),
  countable: z.boolean(),
  bins: z.number(),
  instanceCount: z.number(),
  onHand: z.number(),
  entityCount: z.number(),
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
    canReverseIngest: z.boolean(),
  })),
  instances: z.array(z.object({
    id: z.string(),
    qrCode: z.string(),
    status: z.string(),
    location: z.string(),
    assignee: z.string().nullable(),
    canReverseIngest: z.boolean(),
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
  backfillPartTypeArt(): Promise<PartTypeArtBackfillResponse> {
    return request(partTypeArtBackfillResponseSchema, "/api/part-types/art/backfill", {
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
  createCategory(path: string): Promise<{ path: string }> {
    return request(
      z.object({ path: z.string() }),
      "/api/categories",
      { method: "POST", body: JSON.stringify({ path }), headers: { "Content-Type": "application/json" } },
    );
  },
  createLocation(path: string): Promise<{ path: string }> {
    return request(
      z.object({ path: z.string() }),
      "/api/locations",
      { method: "POST", body: JSON.stringify({ path }), headers: { "Content-Type": "application/json" } },
    );
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
  listCorrectionEvents(limit: number = 50): Promise<CorrectionEvent[]> {
    const params = new URLSearchParams({ limit: String(Math.max(1, Math.min(200, Math.floor(limit)))) });
    return request(correctionEventSchema.array(), `/api/corrections?${params.toString()}`);
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
  bulkAssignQrs(payload: BulkAssignQrsRequest): Promise<BulkAssignQrsResponse> {
    return request(bulkAssignQrsResponseSchema, "/api/bulk/assign", {
      method: "POST",
      body: JSON.stringify(parseWithSchema(bulkAssignQrsRequestSchema, payload, "bulk assignment form")),
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
  bulkMoveEntities(payload: BulkMoveEntitiesRequest): Promise<BulkMoveEntitiesResponse> {
    return request(bulkMoveEntitiesResponseSchema, "/api/bulk/move", {
      method: "POST",
      body: JSON.stringify(parseWithSchema(bulkMoveEntitiesRequestSchema, payload, "bulk move form")),
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
  reassignEntityQr(payload: ReassignEntityQrRequest): Promise<ReassignEntityQrResponse> {
    return request(reassignEntityQrResponseSchema, "/api/corrections/reassign-qr", {
      method: "POST",
      body: JSON.stringify(parseWithSchema(reassignEntityQrRequestSchema, payload, "entity QR correction request")),
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
  bulkReverseIngest(payload: BulkReverseIngestRequest): Promise<BulkReverseIngestResponse> {
    return request(bulkReverseIngestResponseSchema, "/api/bulk/reverse-ingest", {
      method: "POST",
      body: JSON.stringify(parseWithSchema(bulkReverseIngestRequestSchema, payload, "bulk reverse ingest request")),
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
  const path = `/api/qr-batches/${encodeURIComponent(batchId)}/labels.pdf`;
  const response = await fetchApi(path, {
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

    throw new ApiClientError(
      "http_error",
      `Smart DB returned HTTP ${response.status}.`,
      { endpoint: path, httpStatus: response.status },
    );
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
