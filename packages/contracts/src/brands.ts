import { Err, Ok, type Result } from "./result.js";
import { sanitizeScannedCode } from "./scan-normalization.js";

declare const QrCodeBrand: unique symbol;
declare const PartTypeIdBrand: unique symbol;
declare const InstanceIdBrand: unique symbol;
declare const BulkStockIdBrand: unique symbol;
declare const BorrowDueDateBrand: unique symbol;

export type QrCode = string & { readonly [QrCodeBrand]: void };
export type PartTypeId = string & { readonly [PartTypeIdBrand]: void };
export type InstanceId = string & { readonly [InstanceIdBrand]: void };
export type BulkStockId = string & { readonly [BulkStockIdBrand]: void };
export type BorrowDueDate = string & { readonly [BorrowDueDateBrand]: void };

export type BrandParseFailure = {
  readonly kind:
    | "qr_code_empty"
    | "qr_code_not_string"
    | "identifier_empty"
    | "identifier_not_string"
    | "due_date_not_iso"
    | "due_date_not_future";
  readonly message: string;
};

export function parseQrCode(input: unknown): Result<QrCode, BrandParseFailure> {
  if (typeof input !== "string") {
    return Err({ kind: "qr_code_not_string", message: "QR code must be a string." });
  }
  const sanitized = sanitizeScannedCode(input);
  if (sanitized.length === 0) {
    return Err({ kind: "qr_code_empty", message: "QR code is required." });
  }
  return Ok(sanitized as QrCode);
}

function parseIdentifier<Brand>(
  input: unknown,
  kind: string,
): Result<Brand & string, BrandParseFailure> {
  if (typeof input !== "string") {
    return Err({
      kind: "identifier_not_string",
      message: `${kind} must be a string.`,
    });
  }
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return Err({ kind: "identifier_empty", message: `${kind} is required.` });
  }
  return Ok(trimmed as Brand & string);
}

export function parsePartTypeId(input: unknown): Result<PartTypeId, BrandParseFailure> {
  return parseIdentifier<PartTypeId>(input, "Part type id");
}

export function parseInstanceId(input: unknown): Result<InstanceId, BrandParseFailure> {
  return parseIdentifier<InstanceId>(input, "Instance id");
}

export function parseBulkStockId(input: unknown): Result<BulkStockId, BrandParseFailure> {
  return parseIdentifier<BulkStockId>(input, "Bulk stock id");
}

export function parseBorrowDueDate(input: unknown, now: Date = new Date()): Result<BorrowDueDate, BrandParseFailure> {
  if (typeof input !== "string") {
    return Err({ kind: "due_date_not_iso", message: "Due date must be an ISO string." });
  }
  const parsed = Date.parse(input);
  if (Number.isNaN(parsed)) {
    return Err({ kind: "due_date_not_iso", message: "Due date must be a valid ISO timestamp." });
  }
  if (parsed <= now.getTime()) {
    return Err({ kind: "due_date_not_future", message: "Due date must be in the future." });
  }
  return Ok(input as BorrowDueDate);
}

export function unsafeBrand<T>(value: string): T {
  return value as unknown as T;
}
