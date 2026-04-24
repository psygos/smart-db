import { describe, expect, it } from "vitest";
import { InvariantError } from "@smart-db/contracts";
import { ApiClientError } from "./api";
import {
  buildAssignRequest,
  buildEventRequest,
  describePartDbSyncFailure,
  errorMessage,
  formatCategoryPath,
  getAssignFormIssues,
  hasAssignFormIssues,
  narrowBulkEvent,
  narrowInstanceEvent,
  normalizeNullable,
} from "./rewrite/presentation-helpers";

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
        unitSymbol: "pcs",
        initialStatus: "available",
        initialQuantity: "0",
        minimumQuantity: "",
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
        unitSymbol: "pcs",
        initialStatus: "available",
        initialQuantity: "0",
        minimumQuantity: "",
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
        unit: {
          symbol: "pcs",
          name: "Pieces",
          isInteger: true,
        },
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
        unitSymbol: "g",
        initialStatus: "available",
        initialQuantity: "8.5",
        minimumQuantity: "2.5",
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
        unit: {
          symbol: "g",
          name: "Grams",
          isInteger: false,
        },
      },
      initialQuantity: 8.5,
      minimumQuantity: 2.5,
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
        unitSymbol: "pcs",
        initialStatus: "available",
        initialQuantity: "4",
        minimumQuantity: "",
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
      initialQuantity: 4,
      minimumQuantity: null,
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
        quantityDelta: "",
        quantity: "",
        quantityIsInteger: true,
        splitQuantity: "",
        assignee: "Ayesha",
        notes: "",
      }),
    ).toEqual({
      targetType: "instance",
      targetId: "instance-1",
      event: "checked_out",
      location: "Workbench",
      notes: null,
      assignee: "Ayesha",
    });

    expect(
      buildEventRequest({
        targetType: "bulk",
        targetId: "bulk-1",
        event: "restocked",
        location: "Wall",
        quantityDelta: "5",
        quantity: "",
        quantityIsInteger: true,
        splitQuantity: "",
        assignee: "",
        notes: "running low",
      }),
    ).toEqual({
      targetType: "bulk",
      targetId: "bulk-1",
      event: "restocked",
      location: "Wall",
      notes: "running low",
      quantityDelta: 5,
    });

    expect(
      buildEventRequest({
        targetType: "bulk",
        targetId: "bulk-1",
        event: "moved",
        location: "Shelf B",
        quantityDelta: "",
        quantity: "",
        quantityIsInteger: true,
        splitQuantity: "",
        assignee: "",
        notes: "",
      }),
    ).toEqual({
      targetType: "bulk",
      targetId: "bulk-1",
      event: "moved",
      location: "Shelf B",
      notes: null,
    });
  });

  it("guards impossible event combinations", () => {
    expect(narrowInstanceEvent("checked_out")).toBe("checked_out");
    expect(narrowBulkEvent("restocked")).toBe("restocked");
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
        unitSymbol: "pcs",
        initialStatus: "available",
        initialQuantity: "0",
        minimumQuantity: "",
      }),
    ).toThrowError("Choose an existing part type or switch to creating a new one.");
    expect(
      getAssignFormIssues({
        qrCode: "QR-1006",
        entityKind: "instance",
        location: " ",
        notes: "",
        partTypeMode: "new",
        existingPartTypeId: "",
        canonicalName: "",
        category: "",
        countable: true,
        unitSymbol: "pcs",
        initialStatus: "available",
        initialQuantity: "0",
        minimumQuantity: "",
      }),
    ).toEqual({
      location: "Location is required.",
      canonicalName: "Name the new part type.",
      category: "Category is required.",
    });
    expect(
      getAssignFormIssues({
        qrCode: "QR-1008",
        entityKind: "instance",
        location: "Shelf A",
        notes: "",
        partTypeMode: "new",
        existingPartTypeId: "",
        canonicalName: "Resistor Kit",
        category: "Electronics/Bad|Segment",
        countable: true,
        unitSymbol: "pcs",
        initialStatus: "available",
        initialQuantity: "0",
        minimumQuantity: "",
      }),
    ).toEqual({
      category: "Category segment 'Bad|Segment' contains unsupported characters.",
    });
    expect(
      hasAssignFormIssues(
        getAssignFormIssues({
          qrCode: "QR-1007",
          entityKind: "instance",
          location: "Shelf A",
          notes: "",
          partTypeMode: "existing",
          existingPartTypeId: "",
          canonicalName: "",
          category: "",
          countable: true,
          unitSymbol: "pcs",
          initialStatus: "available",
          initialQuantity: "0",
          minimumQuantity: "",
        }),
      ),
    ).toBe(true);
    expect(() =>
      buildEventRequest({
        targetType: "instance",
        targetId: "instance-1",
        event: "moved",
        location: "   ",
        quantityDelta: "",
        quantity: "",
        quantityIsInteger: true,
        splitQuantity: "",
        assignee: "",
        notes: "",
      }),
    ).toThrowError("Moved event requires a destination location.");
    expect(() =>
      buildEventRequest({
        targetType: "bulk",
        targetId: "bulk-1",
        event: "moved",
        location: "",
        quantityDelta: "",
        quantity: "",
        quantityIsInteger: true,
        splitQuantity: "",
        assignee: "",
        notes: "",
      }),
    ).toThrowError("Destination location is required.");
    expect(
      getAssignFormIssues({
        qrCode: "QR-1010",
        entityKind: "bulk",
        location: "Bin 1",
        notes: "",
        partTypeMode: "new",
        existingPartTypeId: "",
        canonicalName: "Metric Screw",
        category: "Hardware",
        countable: false,
        unitSymbol: "pcs",
        initialStatus: "available",
        initialQuantity: "1.5",
        minimumQuantity: "",
      }),
    ).toEqual({
      initialQuantity: "pcs quantities must be whole numbers.",
    });
  });

  it("humanizes structured API failures", () => {
    expect(
      errorMessage(
        new ApiClientError("parse_input", "Could not parse assignment form.", {
          issues: [{ path: "location", message: "Location is required." }],
        }),
      ),
    ).toBe("Location is required.");
    expect(
      errorMessage(
        new ApiClientError("unauthenticated", "Authentication is required."),
      ),
    ).toBe("Your session has expired. Sign in again.");
    expect(
      errorMessage(
        new ApiClientError("conflict", "in progress", { idempotencyKey: "abc" }),
      ),
    ).toBe("That action is already being processed.");
    expect(
      errorMessage(
        new ApiClientError("integration", "Part-DB integration failed: timeout", {
          integration: "Part-DB",
        }),
      ),
    ).toBe("Part-DB is unavailable right now.");
  });

  it("formats category paths and structured sync failures", () => {
    expect(formatCategoryPath(["Electronics", "Resistors", "SMD 0603"])).toBe(
      "Electronics / Resistors / SMD 0603",
    );

    expect(
      describePartDbSyncFailure({
        id: "sync-1",
        operation: "create_part",
        status: "failed",
        targetTable: "part_types",
        targetRowId: "part-1",
        attemptCount: 2,
        nextAttemptAt: "2026-01-01T00:01:00.000Z",
        lastFailureAt: "2026-01-01T00:00:30.000Z",
        lastError: {
          kind: "validation",
          violations: [{ propertyPath: "name", message: "This value is already used." }],
        },
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    ).toBe("Part-DB rejected the payload: name This value is already used.");
  });
});
