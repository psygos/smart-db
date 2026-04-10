import { describe, expect, it, vi } from "vitest";
import { Err, Ok } from "@smart-db/contracts";
import { PartDbOperations } from "./partdb-operations.js";

function makeOperations() {
  const categories = {
    resolveOrCreate: vi.fn(),
  } as never;
  const measurementUnits = {
    findByName: vi.fn(),
    create: vi.fn(),
  } as never;
  const parts = {
    create: vi.fn(),
  } as never;
  const partLots = {
    create: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  } as never;
  const storageLocations = {
    findByName: vi.fn(),
    create: vi.fn(),
  } as never;

  return {
    categories,
    measurementUnits,
    parts,
    partLots,
    storageLocations,
    operations: new PartDbOperations(
      categories,
      measurementUnits,
      parts,
      partLots,
      storageLocations,
    ),
  };
}

describe("PartDbOperations", () => {
  it("executes category, storage location, and measurement unit creation idempotently", async () => {
    const { operations, categories, storageLocations, measurementUnits } = makeOperations();
    categories.resolveOrCreate.mockResolvedValue(Ok({ iri: "/api/categories/7", id: 7 }));
    storageLocations.findByName.mockResolvedValue(Ok(null));
    storageLocations.create.mockResolvedValue(Ok({ "@id": "/api/storage_locations/2", id: 2, name: "Shelf A" }));
    measurementUnits.findByName.mockResolvedValue(Ok({ "@id": "/api/measurement_units/3", id: 3, name: "Pieces" }));

    await expect(
      operations.execute({
        kind: "create_category",
        payload: { path: ["Electronics", "Resistors"], parentIri: null },
        target: null,
        dependsOnId: null,
      }),
    ).resolves.toEqual(Ok({ iri: "/api/categories/7", body: { iri: "/api/categories/7", id: 7 } }));

    await expect(
      operations.execute({
        kind: "create_storage_location",
        payload: { name: "Shelf A" },
        target: null,
        dependsOnId: null,
      }),
    ).resolves.toEqual(Ok({ iri: "/api/storage_locations/2", body: { "@id": "/api/storage_locations/2", id: 2, name: "Shelf A" } }));

    await expect(
      operations.execute({
        kind: "create_measurement_unit",
        payload: { name: "Pieces", symbol: "pcs", isInteger: true },
        target: { table: "part_types", rowId: "part-1", column: "partdb_unit_id" },
        dependsOnId: null,
      }),
    ).resolves.toEqual(Ok({ iri: "/api/measurement_units/3", body: { "@id": "/api/measurement_units/3", id: 3, name: "Pieces" } }));
  });

  it("returns dependency_missing instead of calling downstream resources", async () => {
    const { operations, partLots } = makeOperations();

    const lotResult = await operations.execute({
      kind: "create_lot",
      payload: {
        partIri: null,
        storageLocationName: "Shelf A",
        amount: 10,
        description: "",
        userBarcode: "QR-1",
        instockUnknown: false,
      },
      target: { table: "bulk_stocks", rowId: "bulk-1", column: "partdb_lot_id" },
      dependsOnId: null,
    });
    expect(lotResult).toMatchObject({
      ok: false,
      error: { kind: "dependency_missing", dependency: "partIri" },
    });
    expect(partLots.create).not.toHaveBeenCalled();
  });

  it("delegates part and lot mutations to the correct resources", async () => {
    const { operations, parts, partLots } = makeOperations();
    parts.create.mockResolvedValue(Ok({ "@id": "/api/parts/9", id: 9, name: "Arduino Uno", category: "/api/categories/7" }));
    partLots.patch.mockResolvedValue(Ok({ "@id": "/api/part_lots/4", id: 4, amount: 12 }));
    partLots.delete.mockResolvedValue(Ok(undefined));

    await expect(
      operations.execute({
        kind: "create_part",
        payload: {
          name: "Arduino Uno",
          categoryIri: "/api/categories/7",
          categoryPath: ["Electronics", "Microcontrollers"],
          unitIri: "/api/measurement_units/3",
          unit: { name: "Pieces", symbol: "pcs", isInteger: true },
          description: "Dev board",
          tags: ["microcontroller"],
          needsReview: true,
          minAmount: 2,
        },
        target: { table: "part_types", rowId: "part-1", column: "partdb_part_id" },
        dependsOnId: null,
      }),
    ).resolves.toEqual(Ok({ iri: "/api/parts/9", body: { "@id": "/api/parts/9", id: 9, name: "Arduino Uno", category: "/api/categories/7" } }));

    await expect(
      operations.execute({
        kind: "update_lot",
        payload: {
          lotIri: "/api/part_lots/4",
          patch: {
            amount: 12,
          },
        },
        target: null,
        dependsOnId: null,
      }),
    ).resolves.toEqual(Ok({ iri: "/api/part_lots/4", body: { "@id": "/api/part_lots/4", id: 4, amount: 12 } }));

    await expect(
      operations.execute({
        kind: "delete_lot",
        payload: { lotIri: "/api/part_lots/4" },
        target: null,
        dependsOnId: null,
      }),
    ).resolves.toEqual(Ok({ iri: "/api/part_lots/4", body: null }));
  });

  it("bubbles resource errors unchanged", async () => {
    const { operations, categories } = makeOperations();
    categories.resolveOrCreate.mockResolvedValue(
      Err({ kind: "network", message: "reset", cause: new Error("reset"), retryable: true }),
    );

    const result = await operations.execute({
      kind: "create_category",
      payload: { path: ["Electronics"], parentIri: null },
      target: null,
      dependsOnId: null,
    });

    expect(result).toMatchObject({
      ok: false,
      error: { kind: "network" },
    });
  });
});
