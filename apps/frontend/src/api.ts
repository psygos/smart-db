import type { z } from "zod";
import {
  applicationErrorResponseSchema,
  assignQrRequestSchema,
  authSessionSchema,
  dashboardSummarySchema,
  inventoryEntitySummarySchema,
  latestQrBatchResponseSchema,
  logoutResponseSchema,
  mergePartTypesRequestSchema,
  parseWithSchema,
  partDbConnectionStatusSchema,
  partTypeSchema,
  qrCodeSchema,
  recordEventRequestSchema,
  registerQrBatchRequestSchema,
  registerQrBatchResponseSchema,
  scanResponseSchema,
  stockEventSchema,
  type AssignQrRequest,
  type AuthSession,
  type DashboardSummary,
  type LatestQrBatchResponse,
  type LogoutResponse,
  type MergePartTypesRequest,
  type PartDbConnectionStatus,
  type PartType,
  type RecordEventRequest,
  type RegisterQrBatchRequest,
  type RegisterQrBatchResponse,
  type ScanResponse,
  type StockEvent,
} from "@smart-db/contracts";

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:4000";

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
  const response = await fetch(`${apiBaseUrl}${path}`, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    ...init,
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
  const url = new URL("/api/auth/login", apiBaseUrl);
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
  getLatestQrBatch(): Promise<LatestQrBatchResponse> {
    return request(latestQrBatchResponseSchema, "/api/qr-batches/latest");
  },
  getProvisionalPartTypes(): Promise<PartType[]> {
    return request(partTypeSchema.array(), "/api/part-types/provisional");
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
  scan(code: string, signal?: AbortSignal): Promise<ScanResponse> {
    return request(
      scanResponseSchema,
      "/api/scan",
      signal
        ? {
            method: "POST",
            body: JSON.stringify({ code }),
            signal,
          }
        : {
            method: "POST",
            body: JSON.stringify({ code }),
          },
    );
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
  return `${apiBaseUrl}/api/qr-batches/${encodeURIComponent(batchId)}/labels.pdf`;
}
