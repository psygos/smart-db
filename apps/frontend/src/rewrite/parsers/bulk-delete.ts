import type { BulkReverseIngestRequest, BulkReverseIngestTarget } from "@smart-db/contracts";
import type { ParseIssue } from "@smart-db/contracts";
import { Ok } from "@smart-db/contracts";
import {
  failParse,
  isRecord,
  issue,
  readRequiredString,
  type ParseResult,
} from "./shared";

export type BulkDeleteCommand = BulkReverseIngestRequest;

export function parseBulkDeleteForm(input: unknown): ParseResult<BulkDeleteCommand> {
  const record = isRecord(input) ? input : {};
  const issues: ParseIssue[] = [];
  const targets = readDeleteTargets(record.targets, issues);
  const reason = readRequiredString(record, "reason", issues, "Explain why these ingests are being reversed.");

  if (issues.length > 0 || !targets || !reason) {
    return failParse("bulk.delete", issues);
  }

  return Ok({
    targets,
    reason,
  });
}

function readDeleteTargets(value: unknown, issues: ParseIssue[]): BulkReverseIngestTarget[] | null {
  if (!Array.isArray(value) || value.length === 0) {
    issues.push(issue("targets", "Scan at least one reversible Smart DB label before bulk deleting."));
    return null;
  }

  const targets: BulkReverseIngestTarget[] = [];
  const seenCodes = new Set<string>();
  const seenTargets = new Set<string>();

  for (const [index, entry] of value.entries()) {
    if (!isRecord(entry)) {
      issues.push(issue(`targets.${index}`, "Each bulk delete row must carry a reversible inventory target."));
      continue;
    }

    const targetTypeValue = entry.assignedKind;
    const targetIdValue = entry.assignedId;
    const qrCodeValue = entry.qrCode;
    if (
      (targetTypeValue !== "instance" && targetTypeValue !== "bulk") ||
      typeof targetIdValue !== "string" ||
      targetIdValue.trim().length === 0 ||
      typeof qrCodeValue !== "string" ||
      qrCodeValue.trim().length === 0
    ) {
      issues.push(issue(`targets.${index}`, "Each bulk delete row must carry a reversible inventory target."));
      continue;
    }

    const assignedKind = targetTypeValue;
    const assignedId = targetIdValue.trim();
    const qrCode = qrCodeValue.trim();
    const targetKey = `${assignedKind}:${assignedId}`;

    if (seenTargets.has(targetKey)) {
      issues.push(issue(`targets.${index}`, "Each inventory target may appear only once in a bulk delete."));
      continue;
    }
    if (seenCodes.has(qrCode)) {
      issues.push(issue(`targets.${index}`, "Each Smart DB label may appear only once in a bulk delete."));
      continue;
    }

    seenTargets.add(targetKey);
    seenCodes.add(qrCode);
    targets.push({ assignedKind, assignedId, qrCode });
  }

  return issues.length > 0 ? null : targets;
}
