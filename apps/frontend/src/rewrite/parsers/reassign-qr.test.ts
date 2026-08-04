import { describe, expect, it } from "vitest";
import { parseReassignQrForm } from "./reassign-qr";

describe("parseReassignQrForm", () => {
  it("parses a complete audited QR replacement", () => {
    expect(
      parseReassignQrForm({
        targetType: "instance",
        targetId: "instance-1",
        fromQrCode: "QR-1001",
        toQrCode: "QR-1002",
        reason: "Wrong label attached",
      }),
    ).toEqual({
      ok: true,
      value: {
        targetType: "instance",
        targetId: "instance-1",
        fromQrCode: "QR-1001",
        toQrCode: "QR-1002",
        reason: "Wrong label attached",
      },
    });
  });

  it("rejects an empty, unchanged, or unexplained replacement", () => {
    const result = parseReassignQrForm({
      targetType: "instance",
      targetId: "instance-1",
      fromQrCode: "QR-1001",
      toQrCode: " qr-1001 ",
      reason: "",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.issues.map((issue) => issue.path)).toEqual(
        expect.arrayContaining(["toQrCode", "reason"]),
      );
    }
  });
});
