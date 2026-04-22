import type { BulkEntityTarget, BulkMoveEntitiesRequest } from "@smart-db/contracts";
import type { ParseIssue } from "@smart-db/contracts";
import { Ok } from "@smart-db/contracts";
import {
  failParse,
  isRecord,
  issue,
  readOptionalString,
  readRequiredString,
  type ParseResult,
} from "./shared";

export type BulkMoveCommand = BulkMoveEntitiesRequest;

export function parseBulkMoveForm(input: unknown): ParseResult<BulkMoveCommand> {
  const record = isRecord(input) ? input : {};
  const issues: ParseIssue[] = [];
  const targets = readBulkTargets(record.targets, issues, "targetType", "targetId");
  const location = readRequiredString(record, "location", issues, "Choose the destination location for this bulk move.");
  const notes = readOptionalString(record, "notes", issues);

  if (issues.length > 0 || !targets || !location) {
    return failParse("bulk.move", issues);
  }

  return Ok({
    targets,
    location,
    notes,
  });
}

function readBulkTargets(
  value: unknown,
  issues: ParseIssue[],
  targetTypeField: "targetType" | "assignedKind",
  targetIdField: "targetId" | "assignedId",
): BulkEntityTarget[] | null {
  if (!Array.isArray(value) || value.length === 0) {
    issues.push(issue("targets", "Scan at least one assigned Smart DB label before submitting a bulk move."));
    return null;
  }

  const targets: BulkEntityTarget[] = [];
  const seenCodes = new Set<string>();
  const seenTargets = new Set<string>();

  for (const [index, entry] of value.entries()) {
    if (!isRecord(entry)) {
      issues.push(issue(`targets.${index}`, "Each bulk move row must carry a resolved inventory target."));
      continue;
    }

    const targetTypeValue = entry[targetTypeField];
    const targetIdValue = entry[targetIdField];
    const qrCodeValue = entry.qrCode;
    if (
      (targetTypeValue !== "instance" && targetTypeValue !== "bulk") ||
      typeof targetIdValue !== "string" ||
      targetIdValue.trim().length === 0 ||
      typeof qrCodeValue !== "string" ||
      qrCodeValue.trim().length === 0
    ) {
      issues.push(issue(`targets.${index}`, "Each bulk move row must carry a resolved inventory target."));
      continue;
    }

    const targetType = targetTypeValue;
    const targetId = targetIdValue.trim();
    const qrCode = qrCodeValue.trim();
    const targetKey = `${targetType}:${targetId}`;

    if (seenTargets.has(targetKey)) {
      issues.push(issue(`targets.${index}`, "Each inventory target may appear only once in a bulk move."));
      continue;
    }
    if (seenCodes.has(qrCode)) {
      issues.push(issue(`targets.${index}`, "Each Smart DB label may appear only once in a bulk move."));
      continue;
    }

    seenTargets.add(targetKey);
    seenCodes.add(qrCode);
    targets.push({ targetType, targetId, qrCode });
  }

  return issues.length > 0 ? null : targets;
}
