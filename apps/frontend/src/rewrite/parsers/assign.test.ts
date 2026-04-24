import { describe, expect, it } from "vitest";
import { parseAssignForm } from "./assign";

describe("parseAssignForm", () => {
  it("parses an existing instance assignment into a valid request", () => {
    const result = parseAssignForm({
      qrCode: " QR-1001 ",
      entityKind: "instance",
      location: " Shelf A ",
      notes: " ",
      partTypeMode: "existing",
      existingPartTypeId: " part-1 ",
      initialStatus: "available",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.value).toEqual({
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
  });

  it("rejects existing bulk assignments when the starting quantity is zero", () => {
    const result = parseAssignForm({
      qrCode: "QR-1501",
      entityKind: "bulk",
      location: "Shelf A",
      notes: "",
      partTypeMode: "existing",
      existingPartTypeId: "part-bulk-1",
      initialQuantity: "0",
      minimumQuantity: "",
      unitSymbol: "kg",
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }

    expect(result.error.message).toBe(
      "Could not parse assignment form: Starting quantity must be greater than zero.",
    );
    expect(result.error.issues).toEqual([
      {
        path: "initialQuantity",
        message: "Starting quantity must be greater than zero.",
      },
    ]);
  });

  it("parses a new measured part type as a bulk pool", () => {
    const result = parseAssignForm({
      qrCode: "QR-2001",
      entityKind: "bulk",
      location: "Shelf B",
      notes: "",
      partTypeMode: "new",
      canonicalName: "Copper wire",
      category: "Materials / Wire",
      countable: false,
      unitSymbol: "kg",
      initialQuantity: "12.5",
      minimumQuantity: "1",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.value).toEqual({
      qrCode: "QR-2001",
      entityKind: "bulk",
      location: "Shelf B",
      notes: null,
      partType: {
        kind: "new",
        canonicalName: "Copper wire",
        category: "Materials / Wire",
        aliases: [],
        notes: null,
        imageUrl: null,
        countable: false,
        unit: {
          symbol: "kg",
          name: "Kilograms",
          isInteger: false,
        },
      },
      initialQuantity: 12.5,
      minimumQuantity: 1,
    });
  });

  it("rejects countable part types as bulk pools", () => {
    const result = parseAssignForm({
      qrCode: "QR-2002",
      entityKind: "bulk",
      location: "Shelf B",
      notes: "",
      partTypeMode: "new",
      canonicalName: "Copper wire",
      category: "Materials / Wire",
      countable: true,
      unitSymbol: "kg",
      initialQuantity: "12.5",
      minimumQuantity: "1",
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }

    expect(result.error.message).toBe(
      "Could not parse assignment form: Bulk stock must use measured part types.",
    );
    expect(result.error.issues).toEqual([
      {
        path: "countable",
        message: "Bulk stock must use measured part types.",
      },
    ]);
  });

  it("rejects invalid categories and missing new part details with precise issues", () => {
    const result = parseAssignForm({
      qrCode: "QR-3001",
      entityKind: "instance",
      location: "Shelf C",
      notes: null,
      partTypeMode: "new",
      category: " / ",
      countable: false,
      unitSymbol: "pcs",
      initialStatus: "available",
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }

    expect(result.error.operation).toBe("scan.assign");
    expect(result.error.message).toBe(
      "Could not parse assignment form: Give the new part type a canonical name.",
    );
    expect(result.error.issues).toEqual(
      expect.arrayContaining([
        { path: "canonicalName", message: "Give the new part type a canonical name." },
        { path: "countable", message: "Discrete items must use countable part types." },
      ]),
    );
  });

  it("reports malformed conditional text fields once, with a field-specific message", () => {
    const result = parseAssignForm({
      qrCode: "QR-4001",
      entityKind: "instance",
      location: "Shelf D",
      partTypeMode: "existing",
      existingPartTypeId: 42,
      initialStatus: "available",
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }

    expect(result.error).toMatchObject({
      kind: "parse",
      operation: "scan.assign",
      details: { issueCount: 1, primaryPath: "existingPartTypeId" },
    });
    expect(result.error.message).toBe(
      "Could not parse assignment form: Enter the existing part type identifier.",
    );
    expect(result.error.issues).toEqual([
      {
        path: "existingPartTypeId",
        message: "Enter the existing part type identifier.",
      },
    ]);
  });
});
