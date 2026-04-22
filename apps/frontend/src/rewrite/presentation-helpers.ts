import type {
  AssignQrRequest,
  InstanceStatus,
  InventoryTargetKind,
  PartDbSyncFailure,
  RecordEventRequest,
  StockEventKind,
} from "@smart-db/contracts";
import {
  defaultMeasurementUnit,
  getMeasurementUnitBySymbol,
  InvariantError,
  describeCategoryPathParseError,
  parseCategoryPathInput,
} from "@smart-db/contracts";
import type { PartType } from "@smart-db/contracts";
import { ApiClientError } from "../api";

export type SearchState = {
  query: string;
  results: PartType[];
  status: "idle" | "loading" | "error";
  error: string | null;
};

export type AssignFormState = {
  qrCode: string;
  entityKind: InventoryTargetKind;
  location: string;
  notes: string;
  partTypeMode: "existing" | "new";
  existingPartTypeId: string;
  canonicalName: string;
  category: string;
  countable: boolean;
  unitSymbol: string;
  initialStatus: InstanceStatus;
  initialQuantity: string;
  minimumQuantity: string;
};

export type AssignFormIssues = Partial<
  Record<
    "location" | "existingPartTypeId" | "canonicalName" | "category" | "initialQuantity" | "minimumQuantity",
    string
  >
>;

export type EventFormState = {
  targetType: InventoryTargetKind;
  targetId: string;
  event: StockEventKind;
  location: string;
  quantityDelta: string;
  quantity: string;
  quantityIsInteger: boolean;
  splitQuantity: string;
  assignee: string;
  notes: string;
};

export type EventFormIssues = Partial<
  Record<"location" | "quantityDelta" | "quantity" | "splitQuantity" | "notes", string>
>;

export function getAssignFormIssues(form: AssignFormState): AssignFormIssues {
  const issues: AssignFormIssues = {};
  const unit = getMeasurementUnitBySymbol(form.unitSymbol);

  if (!form.location.trim()) {
    issues.location = "Location is required.";
  }

  if (form.entityKind === "bulk") {
    const initialQuantity = parsePositiveNumber(form.initialQuantity);
    if (initialQuantity === null) {
      issues.initialQuantity = "Starting quantity must be greater than zero.";
    } else if (unit?.isInteger && !Number.isInteger(initialQuantity)) {
      issues.initialQuantity = `${unit.symbol} quantities must be whole numbers.`;
    }

    if (!unit) {
      issues.initialQuantity ??= "Choose a valid unit.";
    }

    if (form.minimumQuantity.trim().length > 0) {
      const minimumQuantity = parseNonNegativeNumber(form.minimumQuantity);
      if (minimumQuantity === null) {
        issues.minimumQuantity = "Low-stock threshold must be zero or greater.";
      } else if (unit?.isInteger && !Number.isInteger(minimumQuantity)) {
        issues.minimumQuantity = `${unit.symbol} quantities must be whole numbers.`;
      }
    }
  }

  if (form.partTypeMode === "existing") {
    if (!form.existingPartTypeId.trim()) {
      issues.existingPartTypeId = "Choose an existing part type or switch to creating a new one.";
    }

    return issues;
  }

  if (!form.canonicalName.trim()) {
    issues.canonicalName = "Name the new part type.";
  }

  const categoryPath = parseCategoryPathInput(form.category);
  if (!categoryPath.ok) {
    issues.category = describeCategoryPathParseError(categoryPath.error);
  }

  return issues;
}

export function hasAssignFormIssues(issues: AssignFormIssues): boolean {
  return Object.keys(issues).length > 0;
}

export function buildAssignRequest(form: AssignFormState): AssignQrRequest {
  const issues = getAssignFormIssues(form);
  const firstIssue = Object.values(issues)[0];
  if (firstIssue) {
    throw new InvariantError(firstIssue);
  }

  const notes = normalizeNullable(form.notes);
  const location = form.location.trim();
  const initialQuantity = parseNonNegativeNumber(form.initialQuantity);
  const minimumQuantity = parseNullableNonNegativeNumber(form.minimumQuantity);
  const selectedUnit = getMeasurementUnitBySymbol(form.unitSymbol) ?? defaultMeasurementUnit;

  if (form.partTypeMode === "existing") {
    const existingPartTypeId = form.existingPartTypeId.trim();

    return form.entityKind === "instance"
      ? {
          qrCode: form.qrCode,
          entityKind: "instance",
          location,
          notes,
          partType: {
            kind: "existing",
            existingPartTypeId,
          },
          initialStatus: form.initialStatus,
        }
      : {
          qrCode: form.qrCode,
          entityKind: "bulk",
          location,
          notes,
          partType: {
            kind: "existing",
            existingPartTypeId,
          },
          initialQuantity: initialQuantity ?? 0,
          minimumQuantity,
        };
  }

  return form.entityKind === "instance"
    ? {
        qrCode: form.qrCode,
        entityKind: "instance",
        location,
        notes,
        partType: {
          kind: "new",
          canonicalName: form.canonicalName.trim(),
          category: form.category.trim(),
          aliases: [],
          notes: null,
          imageUrl: null,
          countable: form.countable,
          unit: defaultMeasurementUnit,
        },
        initialStatus: form.initialStatus,
      }
    : {
        qrCode: form.qrCode,
        entityKind: "bulk",
        location,
        notes,
        partType: {
          kind: "new",
          canonicalName: form.canonicalName.trim(),
          category: form.category.trim(),
          aliases: [],
          notes: null,
          imageUrl: null,
          countable: form.countable,
          unit: selectedUnit,
        },
        initialQuantity: initialQuantity ?? 0,
        minimumQuantity,
      };
}

export function getEventFormIssues(form: EventFormState): EventFormIssues {
  const issues: EventFormIssues = {};

  if (form.targetType === "instance") {
    if (form.event === "moved" && !form.location.trim()) {
      issues.location = "Destination location is required.";
    }

    return issues;
  }

  const event = narrowBulkEvent(form.event);
  if (event === "moved") {
    if (!form.location.trim()) {
      issues.location = "Destination location is required.";
    }
    if (form.splitQuantity.trim()) {
      const splitQty = parsePositiveNumber(form.splitQuantity);
      if (splitQty === null) {
        issues.splitQuantity = "Enter a positive number.";
      } else if (form.quantityIsInteger && !Number.isInteger(splitQty)) {
        issues.splitQuantity = "This unit only allows whole numbers.";
      }
    }
    return issues;
  }

  if (event === "restocked" || event === "consumed") {
    const quantityDelta = parsePositiveNumber(form.quantityDelta);
    if (quantityDelta === null) {
      issues.quantityDelta = "Enter a quantity greater than zero.";
    } else if (form.quantityIsInteger && !Number.isInteger(quantityDelta)) {
      issues.quantityDelta = "This unit only allows whole-number quantities.";
    }
    return issues;
  }

  if (event === "stocktaken") {
    const quantity = parseNonNegativeNumber(form.quantity);
    if (quantity === null) {
      issues.quantity = "Enter the measured quantity on hand.";
    } else if (form.quantityIsInteger && !Number.isInteger(quantity)) {
      issues.quantity = "This unit only allows whole-number quantities.";
    }
    return issues;
  }

  const quantityDelta = parseSignedNumber(form.quantityDelta);
  if (quantityDelta === null) {
    issues.quantityDelta = "Enter a positive or negative adjustment.";
  } else if (form.quantityIsInteger && !Number.isInteger(quantityDelta)) {
    issues.quantityDelta = "This unit only allows whole-number quantities.";
  }

  if (!form.notes.trim()) {
    issues.notes = "Explain why this correction is needed.";
  }

  return issues;
}

export function hasEventFormIssues(issues: EventFormIssues): boolean {
  return Object.keys(issues).length > 0;
}

export function buildEventRequest(form: EventFormState): RecordEventRequest {
  if (form.targetType === "instance") {
    const event = narrowInstanceEvent(form.event);
    const location = normalizeNullable(form.location);
    const notes = normalizeNullable(form.notes);
    if (event === "checked_out") {
      return {
        targetType: "instance",
        targetId: form.targetId,
        event,
        location,
        notes,
        assignee: normalizeNullable(form.assignee),
      };
    }

    if (event === "moved") {
      if (!location) {
        throw new InvariantError("Moved event requires a destination location.");
      }

      return {
        targetType: "instance",
        targetId: form.targetId,
        event,
        location,
        notes,
      };
    }

    return {
      targetType: "instance",
      targetId: form.targetId,
      event,
      location,
      notes,
    };
  }

  const event = narrowBulkEvent(form.event);
  const location = normalizeNullable(form.location);
  const notes = normalizeNullable(form.notes);
  const issues = getEventFormIssues(form);
  const firstIssue = Object.values(issues)[0];
  if (firstIssue) {
    throw new InvariantError(firstIssue);
  }

  if (event === "restocked" || event === "consumed") {
    return {
      targetType: "bulk",
      targetId: form.targetId,
      event,
      location,
      notes,
      quantityDelta: parsePositiveNumber(form.quantityDelta) ?? 0,
    };
  }

  if (event === "stocktaken") {
    return {
      targetType: "bulk",
      targetId: form.targetId,
      event,
      location,
      notes,
      quantity: parseNonNegativeNumber(form.quantity) ?? 0,
    };
  }

  if (event === "adjusted") {
    return {
      targetType: "bulk",
      targetId: form.targetId,
      event,
      location,
      notes: form.notes.trim(),
      quantityDelta: parseSignedNumber(form.quantityDelta) ?? 0,
    };
  }

  if (!location) {
    throw new InvariantError("Moved event requires a destination location.");
  }

  return {
    targetType: "bulk",
    targetId: form.targetId,
    event,
    location,
    notes,
  };
}

export function normalizeNullable(value: string): string | null {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export function formatCategoryPath(path: string[]): string {
  return path.join(" / ");
}

export function formatQuantity(value: number | null | undefined): string {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return "0";
  }

  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.?0+$/, "");
}

export function formatBulkState(quantity: number | null, unitSymbol: string, minimumQuantity: number | null = null): string {
  if (quantity === null) {
    return "Quantity unavailable";
  }

  const amount = `${formatQuantity(quantity)} ${unitSymbol} on hand`;
  if (minimumQuantity !== null && quantity <= minimumQuantity) {
    return `${amount} · low stock`;
  }

  return amount;
}

export function quantityInputStep(isInteger: boolean): "1" | "any" {
  return isInteger ? "1" : "any";
}

export function narrowInstanceEvent(
  event: StockEventKind,
): Extract<
  StockEventKind,
  "moved" | "checked_out" | "returned" | "consumed" | "damaged" | "lost" | "disposed"
> {
  if (!["moved", "checked_out", "returned", "consumed", "damaged", "lost", "disposed"].includes(event)) {
    throw new InvariantError(`Invalid instance event: ${event}`);
  }

  return event as Extract<
    StockEventKind,
    "moved" | "checked_out" | "returned" | "consumed" | "damaged" | "lost" | "disposed"
  >;
}

export function narrowBulkEvent(
  event: StockEventKind,
): Extract<StockEventKind, "moved" | "restocked" | "consumed" | "stocktaken" | "adjusted"> {
  if (!["moved", "restocked", "consumed", "stocktaken", "adjusted"].includes(event)) {
    throw new InvariantError(`Invalid bulk event: ${event}`);
  }

  return event as Extract<StockEventKind, "moved" | "restocked" | "consumed" | "stocktaken" | "adjusted">;
}

export function errorMessage(value: unknown): string {
  if (value instanceof ApiClientError) {
    return humanizeApiError(value);
  }

  if (value instanceof Error) {
    return value.message;
  }

  return "Something went wrong.";
}

export function actionLabel(event: StockEventKind): string {
  switch (event) {
    case "checked_out":
      return "Check out";
    case "level_changed":
      return "Update level";
    case "restocked":
      return "Restock";
    case "stocktaken":
      return "Stocktake";
    case "adjusted":
      return "Adjust quantity";
    case "disposed":
      return "Dispose";
    case "returned":
      return "Return";
    case "consumed":
      return "Mark consumed";
    case "damaged":
      return "Mark damaged";
    case "lost":
      return "Mark lost";
    case "moved":
      return "Move";
    case "labeled":
      return "Labeled";
    default:
      return event;
  }
}

export type EventTone = "ok" | "info" | "warn" | "bad";

export function eventIconInfo(event: StockEventKind): { glyph: string; tone: EventTone } {
  switch (event) {
    case "labeled":
      return { glyph: "+", tone: "ok" };
    case "restocked":
      return { glyph: "+", tone: "ok" };
    case "returned":
      return { glyph: "↓", tone: "ok" };
    case "moved":
      return { glyph: "→", tone: "info" };
    case "stocktaken":
      return { glyph: "=", tone: "info" };
    case "level_changed":
      return { glyph: "~", tone: "info" };
    case "checked_out":
      return { glyph: "↑", tone: "warn" };
    case "adjusted":
      return { glyph: "±", tone: "warn" };
    case "damaged":
      return { glyph: "!", tone: "bad" };
    case "lost":
      return { glyph: "?", tone: "bad" };
    case "consumed":
      return { glyph: "×", tone: "bad" };
    case "disposed":
      return { glyph: "×", tone: "bad" };
    default:
      return { glyph: "•", tone: "info" };
  }
}

export function formatTimestamp(isoTimestamp: string): string {
  const parsed = new Date(isoTimestamp);
  if (Number.isNaN(parsed.getTime())) {
    return isoTimestamp;
  }

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(parsed);
}

export function describePartDbSyncFailure(failure: PartDbSyncFailure): string {
  const error = failure.lastError;
  if (!error) {
    return "Background sync failed.";
  }

  const kind = stringField(error.kind);
  switch (kind) {
    case "network":
      return `Network error: ${stringField(error.message) ?? "connection reset"}.`;
    case "timeout": {
      const timeoutMs = numberField(error.timeoutMs);
      return timeoutMs === null
        ? "Part-DB did not respond before the request timed out."
        : `Part-DB did not respond before ${timeoutMs}ms.`;
    }
    case "unauthorized":
      return "Part-DB rejected the configured token.";
    case "forbidden":
      return "The Part-DB token does not have write permission.";
    case "not_found":
      return `${stringField(error.resource) ?? "Resource"} '${stringField(error.identifier) ?? "unknown"}' was not found in Part-DB.`;
    case "validation": {
      const violations = Array.isArray(error.violations) ? error.violations : [];
      const firstViolation = violations[0];
      if (firstViolation && typeof firstViolation === "object" && firstViolation !== null) {
        const propertyPath = stringField((firstViolation as Record<string, unknown>).propertyPath);
        const message = stringField((firstViolation as Record<string, unknown>).message);
        if (propertyPath && message) {
          return `Part-DB rejected the payload: ${propertyPath} ${message}`.trim();
        }

        if (message) {
          return `Part-DB rejected the payload: ${message}`;
        }
      }

      return "Part-DB rejected the payload.";
    }
    case "conflict":
      return "Part-DB reported a resource conflict.";
    case "server_error":
      return `Part-DB returned ${numberField(error.httpStatus) ?? "a server error"}.`;
    case "rate_limited":
      return "Part-DB rate-limited background sync work.";
    case "schema_mismatch":
      return "Part-DB returned a response SmartDB could not parse.";
    case "dependency_missing":
      return `A required sync dependency is missing: ${stringField(error.dependency) ?? "unknown dependency"}.`;
    default:
      return stringField(error.message) ?? "Background sync failed.";
  }
}

function humanizeApiError(error: ApiClientError): string {
  switch (error.code) {
    case "parse_input":
      return parseInputMessage(error);
    case "unauthenticated":
      return "Your session has expired. Sign in again.";
    case "forbidden":
      return "You do not have permission to do that.";
    case "not_found":
      return notFoundMessage(error.details);
    case "conflict":
      return conflictMessage(error.message, error.details);
    case "integration":
      return integrationMessage(error.details, error.message);
    case "transport":
      return "The request could not be completed. Check your connection and try again.";
    default:
      return error.message;
  }
}

function parseInputMessage(error: ApiClientError): string {
  const issues = Array.isArray(error.details.issues)
    ? error.details.issues as Array<{ path?: unknown; message?: unknown }>
    : [];
  const firstIssue = issues[0];
  if (typeof firstIssue?.message === "string" && firstIssue.message) {
    return firstIssue.message;
  }

  if (typeof error.message === "string" && error.message) {
    return error.message;
  }

  return "The form is incomplete or invalid.";
}

function notFoundMessage(details: Record<string, unknown>): string {
  const entity = typeof details.entity === "string" ? details.entity : "Record";
  return `${entity} could not be found anymore.`;
}

function conflictMessage(message: string, details: Record<string, unknown>): string {
  if (typeof details.idempotencyKey === "string") {
    return "That action is already being processed.";
  }

  if (message.includes("already")) {
    return message;
  }

  return "That change conflicts with the current data. Refresh and try again.";
}

function integrationMessage(details: Record<string, unknown>, fallback: string): string {
  if (details.integration === "Part-DB") {
    return "Part-DB is unavailable right now.";
  }

  if (details.integration === "Zitadel") {
    return "Sign-in is temporarily unavailable.";
  }

  return fallback;
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function numberField(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseNonNegativeNumber(value: string | undefined): number | null {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function parseNullableNonNegativeNumber(value: string | undefined): number | null {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }

  return parseNonNegativeNumber(value);
}

function parsePositiveNumber(value: string | undefined): number | null {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseSignedNumber(value: string | undefined): number | null {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
