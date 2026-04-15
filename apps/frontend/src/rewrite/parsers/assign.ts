import {
  defaultMeasurementUnit,
  type AssignQrRequest,
} from "@smart-db/contracts";
import type { ParseIssue } from "@smart-db/contracts";
import { Ok } from "@smart-db/contracts";
import {
  failParse,
  isRecord,
  readBoolean,
  readCategoryPath,
  readInstanceStatus,
  readLiteral,
  readMeasurementUnit,
  readOptionalNumber,
  readOptionalString,
  readRequiredNumber,
  readRequiredString,
  type ParseResult,
} from "./shared";

export type AssignCommand = AssignQrRequest;

export function parseAssignForm(input: unknown): ParseResult<AssignCommand> {
  const record = isRecord(input) ? input : {};
  const issues: ParseIssue[] = [];

  const qrCode = readRequiredString(record, "qrCode", issues, "QR code is required.");
  const entityKind = readLiteral(
    record,
    "entityKind",
    ["instance", "bulk"] as const,
    issues,
    "Choose whether the QR tracks a discrete item or bulk stock.",
  );
  const location = readRequiredString(
    record,
    "location",
    issues,
    "Choose the location where this item will live.",
  );
  const notes = readOptionalString(record, "notes", issues);
  const partTypeMode = readLiteral(
    record,
    "partTypeMode",
    ["existing", "new"] as const,
    issues,
    "Choose whether to reuse an existing part type or create a new one.",
  );

  if (!qrCode || !entityKind || !location || !partTypeMode) {
    return failParse("scan.assign", issues);
  }

  const existingPartTypeIdInput = record.existingPartTypeId;
  const canonicalNameInput = record.canonicalName;
  const categoryInput = record.category;
  const existingPartTypeId = readOptionalString(
    record,
    "existingPartTypeId",
    issues,
    "Enter the existing part type identifier.",
  );
  const canonicalName = readOptionalString(
    record,
    "canonicalName",
    issues,
    "Enter the new part type name.",
  );
  const category = readOptionalString(
    record,
    "category",
    issues,
    "Enter the category path for the new part type.",
  );
  const initialStatus = readInstanceStatus(
    record,
    "initialStatus",
    issues,
    "Choose a valid initial instance status.",
  );

  const bulkInitialQuantity = entityKind === "bulk"
    ? readRequiredNumber(
        record,
        "initialQuantity",
        issues,
        "Starting quantity must be greater than zero.",
        { positive: true },
      )
    : null;
  const bulkMinimumQuantity = entityKind === "bulk"
    ? readOptionalNumber(
        record,
        "minimumQuantity",
        issues,
        "Low-stock threshold must be zero or greater.",
        { nonnegative: true },
      )
    : null;
  const bulkUnit = entityKind === "bulk"
    ? readMeasurementUnit(
        record,
        "unitSymbol",
        issues,
        "Choose a valid unit of measure.",
      )
    : null;
  let parsedCountable: boolean | null = null;

  if (partTypeMode === "existing" && !existingPartTypeId && isMissingTextInput(existingPartTypeIdInput)) {
    issues.push({
      path: "existingPartTypeId",
      message: "Choose an existing part type to attach.",
    });
  }

  if (partTypeMode === "new") {
    if (!canonicalName && isMissingTextInput(canonicalNameInput)) {
      issues.push({
        path: "canonicalName",
        message: "Give the new part type a canonical name.",
      });
    }

    if (isMissingTextInput(categoryInput)) {
      issues.push({
        path: "category",
        message: "Choose the category for the new part type.",
      });
    } else if (typeof categoryInput === "string") {
      readCategoryPath(record, "category", issues);
    }

    parsedCountable = readBoolean(
      record,
      "countable",
      issues,
      "Choose whether the part type tracks discrete items or measured stock.",
    );

    if (parsedCountable !== null) {
      if (entityKind === "instance" && !parsedCountable) {
        issues.push({
          path: "countable",
          message: "Discrete items must use countable part types.",
        });
      }

      if (entityKind === "bulk" && parsedCountable && bulkUnit && !bulkUnit.isInteger) {
        issues.push({
          path: "unitSymbol",
          message: "Piece-counted bulk stock must use a whole-number unit such as pcs.",
        });
      }
    }
  }

  if (issues.length > 0) {
    return failParse("scan.assign", issues);
  }

  const normalizedNotes = notes;
  const normalizedLocation = location;
  const normalizedQrCode = qrCode;

  if (partTypeMode === "existing") {
    if (entityKind === "instance") {
      return Ok({
        qrCode: normalizedQrCode,
        entityKind,
        location: normalizedLocation,
        notes: normalizedNotes,
        partType: {
          kind: "existing",
          existingPartTypeId: existingPartTypeId ?? "",
        },
        initialStatus: initialStatus ?? "available",
      });
    }

    return Ok({
      qrCode: normalizedQrCode,
      entityKind,
      location: normalizedLocation,
      notes: normalizedNotes,
      partType: {
        kind: "existing",
        existingPartTypeId: existingPartTypeId ?? "",
      },
      initialQuantity: bulkInitialQuantity ?? 0,
      minimumQuantity: bulkMinimumQuantity,
    });
  }

  if (entityKind === "instance") {
    return Ok({
      qrCode: normalizedQrCode,
      entityKind,
      location: normalizedLocation,
      notes: normalizedNotes,
      partType: {
        kind: "new",
        canonicalName: canonicalName ?? "",
        category: category ?? "",
        aliases: [],
        notes: null,
        imageUrl: null,
        countable: true,
        unit: defaultMeasurementUnit,
      },
      initialStatus: initialStatus ?? "available",
    });
  }

  return Ok({
    qrCode: normalizedQrCode,
    entityKind,
    location: normalizedLocation,
    notes: normalizedNotes,
    partType: {
      kind: "new",
        canonicalName: canonicalName ?? "",
        category: category ?? "",
        aliases: [],
        notes: null,
        imageUrl: null,
        countable: parsedCountable ?? false,
        unit: bulkUnit ?? defaultMeasurementUnit,
      },
    initialQuantity: bulkInitialQuantity ?? 0,
    minimumQuantity: bulkMinimumQuantity,
  });
}

function isMissingTextInput(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    (typeof value === "string" && value.trim().length === 0)
  );
}
