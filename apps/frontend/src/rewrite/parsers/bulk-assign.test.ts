import { describe, expect, it } from "vitest";
import { parseBulkAssignForm } from "./bulk-assign";

describe("parseBulkAssignForm", () => {
  it("rejects an empty batch label submission", () => {
    const parsed = parseBulkAssignForm({
      qrs: [],
      entityKind: "instance",
      location: "Shelf A",
      partTypeMode: "existing",
      existingPartTypeId: "part-1",
      initialStatus: "available",
    });

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error.message).toContain("Scan at least one Smart DB label");
    }
  });

  it("parses a shared batch assignment payload", () => {
    const parsed = parseBulkAssignForm({
      qrs: ["QR-1001", "QR-1002"],
      entityKind: "bulk",
      location: "Shelf A",
      partTypeMode: "existing",
      existingPartTypeId: "part-1",
      unitSymbol: "kg",
      initialQuantity: "1",
      minimumQuantity: "0.2",
    });

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value).toEqual({
        qrs: ["QR-1001", "QR-1002"],
        assignment: {
          entityKind: "bulk",
          location: "Shelf A",
          notes: null,
          partType: {
            kind: "existing",
            existingPartTypeId: "part-1",
          },
          initialQuantity: 1,
          minimumQuantity: 0.2,
        },
      });
    }
  });
});
