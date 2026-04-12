import { describe, expect, it, vi } from "vitest";
import { PartDbCategoriesResource } from "./categories.js";
import { PartDbMeasurementUnitsResource } from "./measurement-units.js";
import { PartDbPartLotsResource } from "./part-lots.js";
import { PartDbPartsResource } from "./parts.js";
import { PartDbStorageLocationsResource } from "./storage-locations.js";

function restStub() {
  return {
    getJson: vi.fn(),
    getCollection: vi.fn(),
    postJson: vi.fn(),
    patchJson: vi.fn(),
    deleteResource: vi.fn(),
  } as never;
}

describe("partdb resource wrappers", () => {
  it("routes category list/create through the expected endpoints", async () => {
    const rest = restStub();
    const resource = new PartDbCategoriesResource(rest);

    await resource.list(new URLSearchParams({ name: "SMD" }));
    await resource.create({ name: "SMD", parent: "/api/categories/17" });

    expect(rest.getCollection).toHaveBeenCalledWith(
      "/api/categories?name=SMD",
      expect.anything(),
      { resource: "category" },
    );
    expect(rest.postJson).toHaveBeenCalledWith(
      "/api/categories",
      { name: "SMD", parent: "/api/categories/17" },
      expect.anything(),
      { resource: "category" },
    );
  });

  it("routes part, lot, storage location, and unit operations through the expected endpoints", async () => {
    const rest = restStub();

    await new PartDbPartsResource(rest).patch("/api/parts/7", { name: "Arduino Uno" });
    await new PartDbPartLotsResource(rest).delete("/api/part_lots/9");
    await new PartDbStorageLocationsResource(rest).create({ name: "Shelf A" });
    await new PartDbMeasurementUnitsResource(rest).list();

    expect(rest.patchJson).toHaveBeenCalledWith(
      "/api/parts/7",
      { name: "Arduino Uno" },
      expect.anything(),
      { resource: "part", identifier: "/api/parts/7" },
    );
    expect(rest.deleteResource).toHaveBeenCalledWith(
      "/api/part_lots/9",
      { resource: "part_lot", identifier: "/api/part_lots/9" },
    );
    expect(rest.postJson).toHaveBeenCalledWith(
      "/api/storage_locations",
      { name: "Shelf A" },
      expect.anything(),
      { resource: "storage_location" },
    );
    expect(rest.getCollection).toHaveBeenCalledWith(
      "/api/measurement_units",
      expect.anything(),
      { resource: "measurement_unit" },
    );
  });
});
