import { describe, expect, it } from "vitest";
import {
  getAvailableBulkActions,
  getAvailableInstanceActions,
  getNextBulkQuantity,
  getNextInstanceStatus,
} from "./transitions";

describe("transitions", () => {
  it("maps each instance status to the correct available actions", () => {
    expect(getAvailableInstanceActions("available")).toEqual(
      expect.arrayContaining(["moved", "checked_out", "consumed", "damaged", "lost", "disposed"]),
    );
    expect(getAvailableInstanceActions("checked_out")).toEqual(
      expect.arrayContaining(["moved", "returned", "consumed", "damaged", "lost", "disposed"]),
    );
    expect(getAvailableInstanceActions("damaged")).toEqual(
      expect.arrayContaining(["moved", "disposed", "returned", "lost"]),
    );
    expect(getAvailableInstanceActions("lost")).toEqual(
      expect.arrayContaining(["returned", "disposed"]),
    );
    expect(getAvailableInstanceActions("consumed")).toEqual([]);
  });

  it("maps bulk quantity to the correct available actions", () => {
    expect(getAvailableBulkActions(10)).toEqual(
      expect.arrayContaining(["moved", "restocked", "consumed", "stocktaken", "adjusted"]),
    );
    expect(getAvailableBulkActions(0)).toEqual(
      expect.arrayContaining(["moved", "restocked", "stocktaken", "adjusted"]),
    );
    expect(getAvailableBulkActions(0)).not.toContain("consumed");
  });

  it("returns the correct next instance status for legal transitions", () => {
    expect(getNextInstanceStatus("available", "checked_out")).toBe("checked_out");
    expect(getNextInstanceStatus("available", "moved")).toBe("available");
    expect(getNextInstanceStatus("available", "consumed")).toBe("consumed");
    expect(getNextInstanceStatus("available", "damaged")).toBe("damaged");
    expect(getNextInstanceStatus("available", "lost")).toBe("lost");
    expect(getNextInstanceStatus("available", "disposed")).toBe("consumed");
    expect(getNextInstanceStatus("checked_out", "returned")).toBe("available");
    expect(getNextInstanceStatus("checked_out", "consumed")).toBe("consumed");
    expect(getNextInstanceStatus("damaged", "returned")).toBe("available");
    expect(getNextInstanceStatus("damaged", "disposed")).toBe("consumed");
    expect(getNextInstanceStatus("lost", "returned")).toBe("available");
  });

  it("returns null for illegal instance transitions", () => {
    expect(getNextInstanceStatus("consumed", "moved")).toBeNull();
    expect(getNextInstanceStatus("consumed", "returned")).toBeNull();
    expect(getNextInstanceStatus("available", "returned")).toBeNull();
    expect(getNextInstanceStatus("lost", "moved")).toBeNull();
    expect(getNextInstanceStatus("lost", "consumed")).toBeNull();
    expect(getNextInstanceStatus("damaged", "checked_out")).toBeNull();
  });

  it("returns the correct next bulk quantity for legal transitions", () => {
    expect(getNextBulkQuantity(12, { event: "moved" })).toBe(12);
    expect(getNextBulkQuantity(12, { event: "restocked", quantityDelta: 8 })).toBe(20);
    expect(getNextBulkQuantity(12, { event: "consumed", quantityDelta: 5 })).toBe(7);
    expect(getNextBulkQuantity(12, { event: "stocktaken", quantity: 4 })).toBe(4);
    expect(getNextBulkQuantity(12, { event: "adjusted", quantityDelta: -2 })).toBe(10);
  });

  it("returns null for illegal bulk transitions", () => {
    expect(getNextBulkQuantity(0, { event: "consumed", quantityDelta: 1 })).toBeNull();
    expect(getNextBulkQuantity(4, { event: "adjusted", quantityDelta: -5 })).toBeNull();
  });
});
