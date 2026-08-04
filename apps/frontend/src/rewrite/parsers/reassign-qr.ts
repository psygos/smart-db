import type { ParseIssue, ReassignEntityQrRequest } from "@smart-db/contracts";
import { Ok } from "@smart-db/contracts";
import {
  failParse,
  isRecord,
  readLiteral,
  readRequiredString,
  type ParseResult,
} from "./shared";

export type ReassignQrCommand = ReassignEntityQrRequest;

export function parseReassignQrForm(input: unknown): ParseResult<ReassignQrCommand> {
  const record = isRecord(input) ? input : {};
  const issues: ParseIssue[] = [];

  const targetType = readLiteral(
    record,
    "targetType",
    ["instance", "bulk"] as const,
    issues,
    "Choose the ingested entity to correct.",
  );
  const targetId = readRequiredString(record, "targetId", issues, "Choose the ingested entity to correct.");
  const fromQrCode = readRequiredString(record, "fromQrCode", issues, "Current QR code is required.");
  const toQrCode = readRequiredString(record, "toQrCode", issues, "Scan or enter the replacement QR code.");
  const reason = readRequiredString(record, "reason", issues, "Explain why this QR code is being replaced.");

  if (
    fromQrCode &&
    toQrCode &&
    fromQrCode.trim().toLocaleLowerCase() === toQrCode.trim().toLocaleLowerCase()
  ) {
    issues.push({
      path: "toQrCode",
      message: "Current and replacement QR codes must be different.",
    });
  }

  if (issues.length > 0 || !targetType || !targetId || !fromQrCode || !toQrCode || !reason) {
    return failParse("correction.reassignQr", issues);
  }

  return Ok({
    targetType,
    targetId,
    fromQrCode,
    toQrCode,
    reason,
  });
}
