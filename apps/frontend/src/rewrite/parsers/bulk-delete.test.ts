import { describe, expect, it } from "vitest";
import { parseBulkDeleteForm } from "./bulk-delete";

describe("parseBulkDeleteForm", () => {
  it("requires a non-empty reason", () => {
    const parsed = parseBulkDeleteForm({
      targets: [
        {
          assignedKind: "bulk",
          assignedId: "bulk-1",
          qrCode: "QR-1001",
        },
      ],
      reason: "",
    });

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error.message).toContain("Explain why these ingests are being reversed.");
    }
  });

  it("parses a batch reverse-ingest payload", () => {
    const parsed = parseBulkDeleteForm({
      targets: [
        {
          assignedKind: "bulk",
          assignedId: "bulk-1",
          qrCode: "QR-1001",
        },
      ],
      reason: "Wrong intake session",
    });

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value).toEqual({
        targets: [
          {
            assignedKind: "bulk",
            assignedId: "bulk-1",
            qrCode: "QR-1001",
          },
        ],
        reason: "Wrong intake session",
      });
    }
  });
});
