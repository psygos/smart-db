import { describe, expect, it } from "vitest";
import { InvariantError } from "@smart-db/contracts";
import {
  buildAssignRequest,
  buildEventRequest,
  narrowBulkEvent,
  narrowInstanceEvent,
  normalizeNullable,
} from "./SmartApp.helpers";

describe("App helpers", () => {
  it("builds instance and bulk assignment commands from local form state", () => {
    expect(
      buildAssignRequest({
        qrCode: "QR-1001",
        entityKind: "instance",
        location: "Shelf A",
        notes: "",
        partTypeMode: "existing",
        existingPartTypeId: "part-1",
        canonicalName: "",
        category: "",
        countable: true,
        initialStatus: "available",
        initialLevel: "good",
      }),
    ).toEqual({
      qrCode: "QR-1001",
      entityKind: "instance",
      location: "Shelf A",
      notes: null,
      partType: {
        kind: "existing",
        existingPartTypeId: "part-1",
      },
      initialStatus: "available",
    });

    expect(
      buildAssignRequest({
        qrCode: "QR-1003",
        entityKind: "instance",
        location: "Shelf B",
        notes: "new board",
        partTypeMode: "new",
        existingPartTypeId: "",
        canonicalName: "STM32 Nucleo",
        category: "Microcontrollers",
        countable: true,
        initialStatus: "available",
        initialLevel: "good",
      }),
    ).toEqual({
      qrCode: "QR-1003",
      entityKind: "instance",
      location: "Shelf B",
      notes: "new board",
      partType: {
        kind: "new",
        canonicalName: "STM32 Nucleo",
        category: "Microcontrollers",
        aliases: [],
        notes: null,
        imageUrl: null,
        countable: true,
      },
      initialStatus: "available",
    });

    expect(
      buildAssignRequest({
        qrCode: "QR-1002",
        entityKind: "bulk",
        location: "Bin 7",
        notes: "screws",
        partTypeMode: "new",
        existingPartTypeId: "",
        canonicalName: "M3 Screw",
        category: "Fasteners",
        countable: false,
        initialStatus: "available",
        initialLevel: "good",
      }),
    ).toEqual({
      qrCode: "QR-1002",
      entityKind: "bulk",
      location: "Bin 7",
      notes: "screws",
      partType: {
        kind: "new",
        canonicalName: "M3 Screw",
        category: "Fasteners",
        aliases: [],
        notes: null,
        imageUrl: null,
        countable: false,
        },
        initialLevel: "good",
      });

    expect(
      buildAssignRequest({
        qrCode: "QR-1004",
        entityKind: "bulk",
        location: "Bin 8",
        notes: "",
        partTypeMode: "existing",
        existingPartTypeId: "part-2",
        canonicalName: "",
        category: "",
        countable: false,
        initialStatus: "available",
        initialLevel: "low",
      }),
    ).toEqual({
      qrCode: "QR-1004",
      entityKind: "bulk",
      location: "Bin 8",
      notes: null,
      partType: {
        kind: "existing",
        existingPartTypeId: "part-2",
      },
      initialLevel: "low",
    });
  });

  it("builds lifecycle commands and normalizes empty strings", () => {
    expect(normalizeNullable("  ")).toBeNull();
    expect(
      buildEventRequest({
        targetType: "instance",
        targetId: "instance-1",
        event: "checked_out",
        location: "Workbench",
        nextStatus: "checked_out",
        nextLevel: "good",
        assignee: "Ayesha",
        notes: "",
      }),
    ).toEqual({
      targetType: "instance",
      targetId: "instance-1",
      event: "checked_out",
      location: "Workbench",
      notes: null,
      nextStatus: "checked_out",
      assignee: "Ayesha",
    });

    expect(
      buildEventRequest({
        targetType: "bulk",
        targetId: "bulk-1",
        event: "level_changed",
        location: "Wall",
        nextStatus: "available",
        nextLevel: "low",
        assignee: "",
        notes: "running low",
      }),
    ).toEqual({
      targetType: "bulk",
      targetId: "bulk-1",
      event: "level_changed",
      location: "Wall",
      notes: "running low",
      nextLevel: "low",
    });

    expect(
      buildEventRequest({
        targetType: "bulk",
        targetId: "bulk-1",
        event: "moved",
        location: "Shelf B",
        nextStatus: "available",
        nextLevel: "good",
        assignee: "",
        notes: "",
      }),
    ).toEqual({
      targetType: "bulk",
      targetId: "bulk-1",
      event: "moved",
      location: "Shelf B",
      notes: null,
      nextLevel: "good",
    });
  });

  it("guards impossible event combinations", () => {
    expect(narrowInstanceEvent("checked_out")).toBe("checked_out");
    expect(narrowBulkEvent("level_changed")).toBe("level_changed");
    expect(() => narrowInstanceEvent("level_changed")).toThrowError(InvariantError);
    expect(() => narrowBulkEvent("lost")).toThrowError(InvariantError);
    expect(() =>
      buildAssignRequest({
        qrCode: "QR-1005",
        entityKind: "instance",
        location: "Shelf C",
        notes: "",
        partTypeMode: "existing",
        existingPartTypeId: "   ",
        canonicalName: "",
        category: "",
        countable: true,
        initialStatus: "available",
        initialLevel: "good",
      }),
    ).toThrowError("Existing part type selection requires a part type id.");
  });
});
