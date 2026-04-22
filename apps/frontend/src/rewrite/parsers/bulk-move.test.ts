import { describe, expect, it } from "vitest";
import { parseBulkMoveForm } from "./bulk-move";

describe("parseBulkMoveForm", () => {
  it("rejects empty bulk move submissions", () => {
    const parsed = parseBulkMoveForm({
      targets: [],
      location: "Shelf B",
    });

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error.message).toContain("Scan at least one assigned Smart DB label");
    }
  });

  it("parses a shared bulk move payload", () => {
    const parsed = parseBulkMoveForm({
      targets: [
        {
          targetType: "instance",
          targetId: "instance-1",
          qrCode: "QR-1001",
        },
      ],
      location: "Shelf B",
      notes: "Reorganized",
    });

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value).toEqual({
        targets: [
          {
            targetType: "instance",
            targetId: "instance-1",
            qrCode: "QR-1001",
          },
        ],
        location: "Shelf B",
        notes: "Reorganized",
      });
    }
  });
});
