import type { ZodIssue } from "zod";

export interface ValidationViolation {
  propertyPath: string;
  message: string;
  code?: string;
}

export type PartDbError =
  | { kind: "network"; message: string; cause: Error; retryable: true }
  | { kind: "timeout"; timeoutMs: number; retryable: true }
  | { kind: "unauthorized"; httpStatus: 401; body: unknown; retryable: false }
  | { kind: "forbidden"; httpStatus: 403; body: unknown; retryable: false }
  | {
      kind: "not_found";
      httpStatus: 404;
      resource: string;
      identifier: string;
      retryable: false;
    }
  | {
      kind: "validation";
      httpStatus: 400 | 422;
      violations: ValidationViolation[];
      retryable: false;
    }
  | { kind: "conflict"; httpStatus: 409; body: unknown; retryable: false }
  | { kind: "server_error"; httpStatus: number; body: unknown; retryable: true }
  | { kind: "rate_limited"; retryAfterMs: number; retryable: true }
  | { kind: "schema_mismatch"; issues: ZodIssue[]; body: unknown; retryable: false }
  | { kind: "dependency_missing"; dependency: string; retryable: false };

export function isRetryable(error: PartDbError): boolean {
  return error.retryable;
}

export function describePartDbError(error: PartDbError): string {
  switch (error.kind) {
    case "network":
      return `Network error: ${error.message}`;
    case "timeout":
      return `Request timed out after ${error.timeoutMs}ms`;
    case "unauthorized":
      return "Part-DB rejected our token";
    case "forbidden":
      return "Part-DB token lacks write permission";
    case "not_found":
      return `${error.resource} '${error.identifier}' not found in Part-DB`;
    case "validation":
      return `Invalid request: ${error.violations
        .map((violation) => `${violation.propertyPath}: ${violation.message}`)
        .join("; ")}`;
    case "conflict":
      return "Part-DB resource conflict";
    case "server_error":
      return `Part-DB returned ${error.httpStatus}`;
    case "rate_limited":
      return `Rate limited; retry after ${error.retryAfterMs}ms`;
    case "schema_mismatch":
      return "Part-DB response did not match expected schema";
    case "dependency_missing":
      return `Prerequisite missing: ${error.dependency}`;
  }
}
