import { z } from "zod";
import { type Result, Err, Ok } from "@smart-db/contracts";
import { withRetry, type RetryOptions, defaultRetryOptions } from "./retry.js";
import {
  type PartDbError,
  type ValidationViolation,
} from "./partdb-errors.js";
import { partDbErrorResponseSchema } from "./partdb-schemas.js";

interface PartDbRestConfig {
  baseUrl: string;
  apiToken: string;
  retry?: RetryOptions;
  timeoutMs?: number;
}

interface RequestOptions {
  body?: unknown;
  resource?: string;
  identifier?: string;
}

export class PartDbRestClient {
  private readonly baseUrl: string;
  private readonly retry: RetryOptions;
  private readonly timeoutMs: number;

  constructor(private readonly config: PartDbRestConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.retry = config.retry ?? defaultRetryOptions;
    this.timeoutMs = config.timeoutMs ?? 10_000;
  }

  async getJson<TSchema extends z.ZodTypeAny>(
    path: string,
    schema: TSchema,
    options: Omit<RequestOptions, "body"> = {},
  ): Promise<Result<z.output<TSchema>, PartDbError>> {
    return this.requestJson("GET", path, schema, options);
  }

  async postJson<TSchema extends z.ZodTypeAny>(
    path: string,
    body: unknown,
    schema: TSchema,
    options: Omit<RequestOptions, "body"> = {},
  ): Promise<Result<z.output<TSchema>, PartDbError>> {
    return this.requestJson("POST", path, schema, { ...options, body });
  }

  async patchJson<TSchema extends z.ZodTypeAny>(
    path: string,
    body: unknown,
    schema: TSchema,
    options: Omit<RequestOptions, "body"> = {},
  ): Promise<Result<z.output<TSchema>, PartDbError>> {
    return this.requestJson("PATCH", path, schema, { ...options, body });
  }

  async deleteResource(
    path: string,
    options: Omit<RequestOptions, "body"> = {},
  ): Promise<Result<void, PartDbError>> {
    const response = await this.perform("DELETE", path, options);
    if (!response.ok) {
      return Err(response.error);
    }

    if (response.value.status < 200 || response.value.status >= 300) {
      return Err(await classifyHttpError(response.value, options));
    }

    return Ok(undefined);
  }

  private async requestJson<TSchema extends z.ZodTypeAny>(
    method: "GET" | "POST" | "PATCH",
    path: string,
    schema: TSchema,
    options: RequestOptions = {},
  ): Promise<Result<z.output<TSchema>, PartDbError>> {
    const response = await this.perform(method, path, options);
    if (!response.ok) {
      return Err(response.error);
    }

    if (response.value.status < 200 || response.value.status >= 300) {
      return Err(await classifyHttpError(response.value, options));
    }

    const body = await response.value.json().catch(() => null);
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return Err({
        kind: "schema_mismatch",
        issues: parsed.error.issues,
        body,
        retryable: false,
      });
    }

    return Ok(parsed.data);
  }

  private async perform(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    options: RequestOptions,
  ): Promise<Result<Response, PartDbError>> {
    try {
      const response = await withRetry(
        () => this.fetchWithTimeout(method, path, options.body),
        this.retry,
      );
      return Ok(response);
    } catch (error) {
      return Err(classifyThrownError(error, this.timeoutMs));
    }
  }

  private async fetchWithTimeout(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    body: unknown,
  ): Promise<Response> {
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const requestInit: RequestInit = {
      method,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${this.config.apiToken}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      signal: timeoutSignal,
    };
    if (body !== undefined) {
      requestInit.body = JSON.stringify(body);
    }

    return fetch(`${this.baseUrl}${path}`, requestInit);
  }
}

function classifyThrownError(error: unknown, timeoutMs: number): PartDbError {
  if (error instanceof DOMException && error.name === "TimeoutError") {
    return { kind: "timeout", timeoutMs, retryable: true };
  }

  if (error instanceof Error) {
    return {
      kind: "network",
      message: error.message,
      cause: error,
      retryable: true,
    };
  }

  return {
    kind: "network",
    message: "Unknown network failure",
    cause: new Error("Unknown network failure"),
    retryable: true,
  };
}

async function classifyHttpError(
  response: Response,
  options: Omit<RequestOptions, "body">,
): Promise<PartDbError> {
  const body = await response.clone().json().catch(async () => response.text().catch(() => null));
  const parsedError = partDbErrorResponseSchema.safeParse(body);
  const violations = parsedError.success
    ? (parsedError.data.violations ?? []).map(toValidationViolation)
    : [];

  switch (response.status) {
    case 400:
    case 422:
      return {
        kind: "validation",
        httpStatus: response.status,
        violations,
        retryable: false,
      };
    case 401:
      return { kind: "unauthorized", httpStatus: 401, body, retryable: false };
    case 403:
      return { kind: "forbidden", httpStatus: 403, body, retryable: false };
    case 404:
      return {
        kind: "not_found",
        httpStatus: 404,
        resource: options.resource ?? "resource",
        identifier: options.identifier ?? "unknown",
        retryable: false,
      };
    case 409:
      return { kind: "conflict", httpStatus: 409, body, retryable: false };
    case 429: {
      const retryAfterHeader = response.headers.get("retry-after");
      const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : 1000;
      return { kind: "rate_limited", retryAfterMs, retryable: true };
    }
    default:
      return {
        kind: "server_error",
        httpStatus: response.status,
        body,
        retryable: true,
      };
  }
}

function toValidationViolation(violation: {
  propertyPath: string;
  message: string;
  code?: string | undefined;
}): ValidationViolation {
  const normalized: ValidationViolation = {
    propertyPath: violation.propertyPath,
    message: violation.message,
  };
  if (violation.code !== undefined) {
    normalized.code = violation.code;
  }

  return normalized;
}
