import type { BulkAssignQrsRequest, SharedAssignRequest } from "@smart-db/contracts";
import type { ParseIssue } from "@smart-db/contracts";
import { Ok } from "@smart-db/contracts";
import { parseAssignForm } from "./assign";
import {
  failParse,
  isRecord,
  issue,
  type ParseResult,
} from "./shared";

export type BulkAssignCommand = BulkAssignQrsRequest;

export function parseBulkAssignForm(input: unknown): ParseResult<BulkAssignCommand> {
  const record = isRecord(input) ? input : {};
  const issues: ParseIssue[] = [];
  const qrs = readUniqueQrCodes(record.qrs, issues);

  const parsedAssignment = parseAssignForm({
    ...record,
    qrCode: "__bulk__",
  });
  if (!parsedAssignment.ok && parsedAssignment.error.kind === "parse") {
    issues.push(...parsedAssignment.error.issues);
  }

  if (issues.length > 0 || !qrs || !parsedAssignment.ok) {
    return failParse("bulk.assign", issues);
  }

  const { qrCode: _ignoredQrCode, ...assignment } = parsedAssignment.value;

  return Ok({
    qrs,
    assignment: assignment as SharedAssignRequest,
  });
}

function readUniqueQrCodes(value: unknown, issues: ParseIssue[]): string[] | null {
  if (!Array.isArray(value) || value.length === 0) {
    issues.push(issue("qrs", "Scan at least one Smart DB label before submitting a bulk action."));
    return null;
  }

  const qrs: string[] = [];
  const seen = new Set<string>();

  for (const [index, entry] of value.entries()) {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      issues.push(issue(`qrs.${index}`, "Each bulk queue row must carry a Smart DB label code."));
      continue;
    }

    const code = entry.trim();
    if (seen.has(code)) {
      issues.push(issue(`qrs.${index}`, "Each Smart DB label may appear only once in the bulk request."));
      continue;
    }

    seen.add(code);
    qrs.push(code);
  }

  return issues.length > 0 ? null : qrs;
}
