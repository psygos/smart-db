import type {
  AssignQrRequest,
  BulkLevel,
  InstanceStatus,
  InventoryTargetKind,
  RecordEventRequest,
  StockEventKind,
} from "@smart-db/contracts";
import { InvariantError } from "@smart-db/contracts";
import { ApiClientError } from "./api";

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
  initialStatus: InstanceStatus;
  initialLevel: BulkLevel;
};

export type EventFormState = {
  targetType: InventoryTargetKind;
  targetId: string;
  event: StockEventKind;
  location: string;
  nextStatus: InstanceStatus;
  nextLevel: BulkLevel;
  assignee: string;
  notes: string;
};

export function buildAssignRequest(form: AssignFormState): AssignQrRequest {
  const notes = normalizeNullable(form.notes);

  if (form.partTypeMode === "existing") {
    const existingPartTypeId = form.existingPartTypeId.trim();
    if (!existingPartTypeId) {
      throw new InvariantError("Existing part type selection requires a part type id.");
    }

    return form.entityKind === "instance"
      ? {
          qrCode: form.qrCode,
          entityKind: "instance",
          location: form.location,
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
          location: form.location,
          notes,
          partType: {
            kind: "existing",
            existingPartTypeId,
          },
          initialLevel: form.initialLevel,
        };
  }

  return form.entityKind === "instance"
    ? {
        qrCode: form.qrCode,
        entityKind: "instance",
        location: form.location,
        notes,
        partType: {
          kind: "new",
          canonicalName: form.canonicalName,
          category: form.category,
          aliases: [],
          notes: null,
          imageUrl: null,
          countable: form.countable,
        },
        initialStatus: form.initialStatus,
      }
    : {
        qrCode: form.qrCode,
        entityKind: "bulk",
        location: form.location,
        notes,
        partType: {
          kind: "new",
          canonicalName: form.canonicalName,
          category: form.category,
          aliases: [],
          notes: null,
          imageUrl: null,
          countable: form.countable,
        },
        initialLevel: form.initialLevel,
      };
}

export function buildEventRequest(form: EventFormState): RecordEventRequest {
  if (form.targetType === "instance") {
    return {
      targetType: "instance",
      targetId: form.targetId,
      event: narrowInstanceEvent(form.event),
      location: form.location,
      notes: normalizeNullable(form.notes),
      nextStatus: form.nextStatus,
      assignee: normalizeNullable(form.assignee),
    };
  }

  return {
    targetType: "bulk",
    targetId: form.targetId,
    event: narrowBulkEvent(form.event),
    location: form.location,
    notes: normalizeNullable(form.notes),
    nextLevel: form.nextLevel,
  };
}

export function normalizeNullable(value: string): string | null {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export function narrowInstanceEvent(
  event: StockEventKind,
): Extract<
  StockEventKind,
  "moved" | "checked_out" | "returned" | "consumed" | "damaged" | "lost" | "disposed"
> {
  if (event === "level_changed" || event === "labeled") {
    throw new InvariantError(`Invalid instance event: ${event}`);
  }

  return event;
}

export function narrowBulkEvent(
  event: StockEventKind,
): Extract<StockEventKind, "moved" | "level_changed" | "consumed"> {
  if (event !== "moved" && event !== "level_changed" && event !== "consumed") {
    throw new InvariantError(`Invalid bulk event: ${event}`);
  }

  return event;
}

export function errorMessage(value: unknown): string {
  if (value instanceof ApiClientError) {
    return `${value.code}: ${value.message}`;
  }

  if (value instanceof Error) {
    return value.message;
  }

  return "Something went wrong.";
}
