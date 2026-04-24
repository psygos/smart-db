import type {
  BulkActionKind,
  InstanceActionKind,
  InstanceStatus,
} from "./schemas.js";

export const INSTANCE_TRANSITIONS: Record<
  InstanceStatus,
  Partial<Record<InstanceActionKind, InstanceStatus>>
> = {
  available: {
    moved: "available",
    checked_out: "checked_out",
    consumed: "consumed",
    damaged: "damaged",
    lost: "lost",
    disposed: "consumed",
  },
  checked_out: {
    moved: "checked_out",
    checked_out: "checked_out",
    returned: "available",
    consumed: "consumed",
    damaged: "damaged",
    lost: "lost",
    disposed: "consumed",
  },
  damaged: {
    moved: "damaged",
    disposed: "consumed",
    returned: "available",
    lost: "lost",
  },
  lost: {
    returned: "available",
    disposed: "consumed",
  },
  consumed: {},
};

export function getAvailableInstanceActions(status: InstanceStatus): InstanceActionKind[] {
  return Object.keys(INSTANCE_TRANSITIONS[status]) as InstanceActionKind[];
}

export function getAvailableBulkActions(quantity: number): BulkActionKind[] {
  return quantity > 0
    ? ["moved", "restocked", "consumed", "stocktaken", "adjusted"]
    : ["moved", "restocked", "stocktaken", "adjusted"];
}

export function getNextInstanceStatus(
  current: InstanceStatus,
  event: InstanceActionKind,
): InstanceStatus | null {
  const transitions = INSTANCE_TRANSITIONS[current];
  const next = transitions[event];
  return next ?? null;
}

export type BulkQuantityTransition =
  | { event: "moved" }
  | { event: "restocked"; quantityDelta: number }
  | { event: "consumed"; quantityDelta: number }
  | { event: "stocktaken"; quantity: number }
  | { event: "adjusted"; quantityDelta: number };

export function getNextBulkQuantity(
  current: number,
  transition: BulkQuantityTransition,
): number | null {
  switch (transition.event) {
    case "moved":
      return current;
    case "restocked":
      return current + transition.quantityDelta;
    case "consumed":
      if (transition.quantityDelta > current) {
        return null;
      }
      return current - transition.quantityDelta;
    case "stocktaken":
      return transition.quantity;
    case "adjusted": {
      const next = current + transition.quantityDelta;
      return next >= 0 ? next : null;
    }
  }
}
