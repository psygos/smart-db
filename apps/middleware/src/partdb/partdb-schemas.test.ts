import { describe, expect, it } from "vitest";
import {
  partDbCategoryResponseSchema,
  partDbErrorResponseSchema,
  partDbLotResponseSchema,
  partDbMeasurementUnitResponseSchema,
  partDbPartResponseSchema,
  partDbStorageLocationResponseSchema,
} from "./partdb-schemas";

describe("partdb response schemas", () => {
  it("parses the resource response shapes we rely on", () => {
    expect(
      partDbCategoryResponseSchema.parse({
        "@id": "/api/categories/42",
        id: 42,
        name: "SMD",
        parent: "/api/categories/17",
      }),
    ).toMatchObject({ id: 42, name: "SMD" });

    expect(
      partDbPartResponseSchema.parse({
        "@id": "/api/parts/7",
        id: 7,
        name: "Arduino Uno",
        category: "/api/categories/42",
      }),
    ).toMatchObject({ id: 7, name: "Arduino Uno" });

    expect(
      partDbLotResponseSchema.parse({
        "@id": "/api/part_lots/11",
        id: 11,
        amount: 25,
        storage_location: "/api/storage_locations/5",
      }),
    ).toMatchObject({ id: 11, amount: 25 });

    expect(
      partDbStorageLocationResponseSchema.parse({
        "@id": "/api/storage_locations/5",
        id: 5,
        name: "Shelf A",
      }),
    ).toMatchObject({ id: 5, name: "Shelf A" });

    expect(
      partDbMeasurementUnitResponseSchema.parse({
        "@id": "/api/measurement_units/2",
        id: 2,
        name: "Pieces",
        unit: "pcs",
        is_integer: true,
      }),
    ).toMatchObject({ id: 2, name: "Pieces" });
  });

  it("parses structured error payloads from Part-DB", () => {
    expect(
      partDbErrorResponseSchema.parse({
        title: "Validation Failed",
        detail: "See violations",
        status: 422,
        violations: [
          {
            propertyPath: "name",
            message: "This value should not be blank.",
          },
        ],
      }),
    ).toEqual({
      title: "Validation Failed",
      detail: "See violations",
      status: 422,
      violations: [
        {
          propertyPath: "name",
          message: "This value should not be blank.",
        },
      ],
    });
  });
});
