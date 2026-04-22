import type {
  PartDbConnectionStatus,
  PartDbSyncStatusResponse,
  ScanResponse,
} from "@smart-db/contracts";
import { parseCategoryPathInput } from "@smart-db/contracts";
import type {
  AssignFormState,
  EventFormState,
} from "./presentation-helpers";
import { defaultAssignForm, defaultEventForm } from "./ui-state";
import type { InventorySummaryRow } from "../api";

export function getPartDbHealthPill(
  status: PartDbConnectionStatus | null,
): { tone: "ok" | "warn" | "info"; label: string } | null {
  if (status === null) {
    return { tone: "info", label: "Checking Part-DB" };
  }

  if (status.connected) {
    return { tone: "ok", label: "Part-DB linked" };
  }

  return null;
}

export function getPartDbSyncPill(
  status: PartDbSyncStatusResponse | null,
): { tone: "ok" | "warn" | "info"; label: string } | null {
  if (status === null) {
    return { tone: "info", label: "Checking sync" };
  }

  if (!status.enabled) {
    return null;
  }

  if (status.deadTotal > 0) {
    return { tone: "warn", label: "Sync dead letters" };
  }

  if (status.failedLast24h > 0) {
    return { tone: "warn", label: "Sync needs retry" };
  }

  if (status.pending > 0 || status.inFlight > 0) {
    return { tone: "info", label: `Syncing ${status.pending + status.inFlight}` };
  }

  return { tone: "ok", label: "Sync idle" };
}

export function consumeAuthError(): string | null {
  if (typeof window === "undefined") {
    return null;
  }

  const url = new URL(window.location.href);
  const authError = url.searchParams.get("authError");
  if (!authError) {
    return null;
  }

  url.searchParams.delete("authError");
  window.history.replaceState({}, "", url.toString());
  return authError;
}

export function buildDefaultEventFormForEntity(
  entity: Extract<ScanResponse, { mode: "interact" }>["entity"],
): EventFormState {
  return {
    ...defaultEventForm,
    targetType: entity.targetType,
    targetId: entity.id,
    location: entity.location,
    quantity:
      entity.targetType === "bulk" && entity.quantity !== null
        ? String(entity.quantity)
        : "",
    quantityIsInteger: entity.partType.unit.isInteger,
  };
}

export function hasInProgressScanWork(
  scanResult: ScanResponse | null,
  assignForm: AssignFormState,
  labelSearchQuery: string,
  eventForm: EventFormState,
): boolean {
  if (scanResult?.mode === "label") {
    const baselineAssignForm: AssignFormState = {
      ...defaultAssignForm,
      qrCode: scanResult.qrCode.code,
    };
    return (
      labelSearchQuery.trim().length > 0 ||
      assignForm.entityKind !== baselineAssignForm.entityKind ||
      assignForm.location !== baselineAssignForm.location ||
      assignForm.notes !== baselineAssignForm.notes ||
      assignForm.partTypeMode !== baselineAssignForm.partTypeMode ||
      assignForm.existingPartTypeId !== baselineAssignForm.existingPartTypeId ||
      assignForm.canonicalName !== baselineAssignForm.canonicalName ||
      assignForm.category !== baselineAssignForm.category ||
      assignForm.countable !== baselineAssignForm.countable ||
      assignForm.unitSymbol !== baselineAssignForm.unitSymbol ||
      assignForm.initialStatus !== baselineAssignForm.initialStatus ||
      assignForm.initialQuantity !== baselineAssignForm.initialQuantity ||
      assignForm.minimumQuantity !== baselineAssignForm.minimumQuantity
    );
  }

  if (scanResult?.mode === "interact") {
    const baselineEventForm = buildDefaultEventFormForEntity(scanResult.entity);
    return (
      eventForm.targetType !== baselineEventForm.targetType ||
      eventForm.targetId !== baselineEventForm.targetId ||
      eventForm.event !== baselineEventForm.event ||
      eventForm.location !== baselineEventForm.location ||
      eventForm.quantityDelta !== baselineEventForm.quantityDelta ||
      eventForm.quantity !== baselineEventForm.quantity ||
      eventForm.quantityIsInteger !== baselineEventForm.quantityIsInteger ||
      eventForm.splitQuantity !== baselineEventForm.splitQuantity ||
      eventForm.assignee !== baselineEventForm.assignee ||
      eventForm.notes !== baselineEventForm.notes
    );
  }

  return false;
}

export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" &&
    typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
    : false;
}

export function findSharedTypeConflictCandidates(
  inventorySummary: readonly InventorySummaryRow[],
  currentPartTypeId: string,
  canonicalName: string,
  category: string,
): InventorySummaryRow[] {
  const normalizedName = canonicalName.trim().replace(/\s+/g, " ").toLowerCase();
  if (!normalizedName) {
    return [];
  }

  const parsedCategory = parseCategoryPathInput(category);
  if (!parsedCategory.ok) {
    return [];
  }

  return inventorySummary.filter((row) =>
    row.id !== currentPartTypeId &&
    row.canonicalName.trim().replace(/\s+/g, " ").toLowerCase() === normalizedName &&
    sameCategoryPath(row.categoryPath, parsedCategory.value)
  );
}

function sameCategoryPath(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((segment, index) => segment.trim().toLowerCase() === (right[index] ?? "").trim().toLowerCase());
}
