import { type Result, Ok, Err } from "@smart-db/contracts";
import type { OutboxOperation } from "../outbox/outbox-types.js";
import type { PartDbError } from "./partdb-errors.js";
import { CategoryResolver } from "./category-resolver.js";
import { LocationResolver } from "./location-resolver.js";
import { PartDbMeasurementUnitsResource } from "./resources/measurement-units.js";
import { PartDbPartLotsResource } from "./resources/part-lots.js";
import { PartDbPartsResource } from "./resources/parts.js";
import { PartDbStorageLocationsResource } from "./resources/storage-locations.js";

export interface PartDbOperationResponse {
  iri: string | null;
  body: unknown;
}

export class PartDbOperations {
  constructor(
    private readonly categories: CategoryResolver,
    private readonly measurementUnits: PartDbMeasurementUnitsResource,
    private readonly parts: PartDbPartsResource,
    private readonly partLots: PartDbPartLotsResource,
    private readonly storageLocations: PartDbStorageLocationsResource,
    private readonly locations: LocationResolver | null = null,
  ) {}

  private async resolveStorageLocation(
    path: string[] | undefined,
    name: string,
  ): Promise<Result<string, PartDbError>> {
    if (path && path.length > 0 && this.locations) {
      const resolved = await this.locations.resolveOrCreate(path);
      return resolved.ok ? Ok(resolved.value.iri) : resolved;
    }

    const existing = await this.storageLocations.findByName(name);
    if (!existing.ok) {
      return existing;
    }
    if (existing.value) {
      return Ok(existing.value["@id"]);
    }
    const created = await this.storageLocations.create({ name });
    return created.ok ? Ok(created.value["@id"]) : created;
  }

  async execute(
    operation: OutboxOperation,
  ): Promise<Result<PartDbOperationResponse, PartDbError>> {
    switch (operation.kind) {
      case "create_category": {
        const resolved = await this.categories.resolveOrCreate(operation.payload.path);
        return resolved.ok
          ? Ok({ iri: resolved.value.iri, body: resolved.value })
          : resolved;
      }
      case "create_measurement_unit": {
        const existing = await this.measurementUnits.findByName(operation.payload.name);
        if (!existing.ok) return existing;
        if (existing.value) {
          return Ok({ iri: existing.value["@id"], body: existing.value });
        }

        const created = await this.measurementUnits.create({
          name: operation.payload.name,
          unit: operation.payload.symbol,
          is_integer: operation.payload.isInteger,
        });
        return created.ok ? Ok({ iri: created.value["@id"], body: created.value }) : created;
      }
      case "create_storage_location": {
        const existing = await this.storageLocations.findByName(operation.payload.name);
        if (!existing.ok) return existing;
        if (existing.value) {
          return Ok({ iri: existing.value["@id"], body: existing.value });
        }

        const created = await this.storageLocations.create({ name: operation.payload.name });
        return created.ok ? Ok({ iri: created.value["@id"], body: created.value }) : created;
      }
      case "create_part": {
        const resolvedCategory =
          operation.payload.categoryIri === null
            ? await this.categories.resolveOrCreate(operation.payload.categoryPath)
            : Ok({ iri: operation.payload.categoryIri, id: 0 });
        if (!resolvedCategory.ok) {
          return resolvedCategory;
        }

        let unitIri = operation.payload.unitIri;
        if (unitIri === null) {
          const existingUnit = await this.measurementUnits.findByName(operation.payload.unit.name);
          if (!existingUnit.ok) {
            return existingUnit;
          }

          if (existingUnit.value) {
            unitIri = existingUnit.value["@id"];
          } else {
            const createdUnit = await this.measurementUnits.create({
              name: operation.payload.unit.name,
              unit: operation.payload.unit.symbol,
              is_integer: operation.payload.unit.isInteger,
            });
            if (!createdUnit.ok) {
              return createdUnit;
            }
            unitIri = createdUnit.value["@id"];
          }
        }

        const created = await this.parts.create({
          name: operation.payload.name,
          category: resolvedCategory.value.iri,
          description: operation.payload.description,
          tags: operation.payload.tags.join(","),
          needs_review: operation.payload.needsReview,
          min_amount: operation.payload.minAmount,
          partUnit: unitIri,
        });
        return created.ok ? Ok({ iri: created.value["@id"], body: created.value }) : created;
      }
      case "update_part": {
        const partIri = operation.payload.partIri;
        if (!partIri) {
          return Err({ kind: "dependency_missing", dependency: "partIri", retryable: false });
        }

        let categoryIri = operation.payload.patch.categoryIri;
        if (!categoryIri && operation.payload.patch.categoryPath) {
          const resolvedCategory = await this.categories.resolveOrCreate(operation.payload.patch.categoryPath);
          if (!resolvedCategory.ok) {
            return resolvedCategory;
          }
          categoryIri = resolvedCategory.value.iri;
        }

        let unitIri = operation.payload.patch.unitIri;
        if (!unitIri && operation.payload.patch.unit) {
          const existingUnit = await this.measurementUnits.findByName(operation.payload.patch.unit.name);
          if (!existingUnit.ok) {
            return existingUnit;
          }

          if (existingUnit.value) {
            unitIri = existingUnit.value["@id"];
          } else {
            const createdUnit = await this.measurementUnits.create({
              name: operation.payload.patch.unit.name,
              unit: operation.payload.patch.unit.symbol,
              is_integer: operation.payload.patch.unit.isInteger,
            });
            if (!createdUnit.ok) {
              return createdUnit;
            }
            unitIri = createdUnit.value["@id"];
          }
        }

        const updated = await this.parts.patch(partIri, {
          name: operation.payload.patch.name,
          category: categoryIri,
          partUnit: unitIri,
          description: operation.payload.patch.description,
          tags: operation.payload.patch.tags?.join(","),
        });
        return updated.ok ? Ok({ iri: updated.value["@id"], body: updated.value }) : updated;
      }
      case "delete_part": {
        if (!operation.payload.partIri) {
          return Err({ kind: "dependency_missing", dependency: "partIri", retryable: false });
        }

        const deleted = await this.parts.delete(operation.payload.partIri);
        return deleted.ok ? Ok({ iri: operation.payload.partIri, body: null }) : deleted;
      }
      case "create_lot": {
        if (!operation.payload.partIri) {
          return Err({ kind: "dependency_missing", dependency: "partIri", retryable: false });
        }

        const resolvedLocation = await this.resolveStorageLocation(
          operation.payload.storageLocationPath,
          operation.payload.storageLocationName,
        );
        if (!resolvedLocation.ok) {
          return resolvedLocation;
        }
        const storageLocationIri: string = resolvedLocation.value;

        const created = await this.partLots.create({
          part: operation.payload.partIri,
          storage_location: storageLocationIri,
          amount: operation.payload.amount,
          description: operation.payload.description,
          user_barcode: operation.payload.userBarcode,
          instock_unknown: operation.payload.instockUnknown,
        });
        return created.ok ? Ok({ iri: created.value["@id"], body: created.value }) : created;
      }
      case "update_lot": {
        if (!operation.payload.lotIri) {
          return Err({ kind: "dependency_missing", dependency: "lotIri", retryable: false });
        }

        let storageLocationIri: string | undefined;
        if (operation.payload.patch.storageLocationName) {
          const resolvedLocation = await this.resolveStorageLocation(
            operation.payload.patch.storageLocationPath,
            operation.payload.patch.storageLocationName,
          );
          if (!resolvedLocation.ok) {
            return resolvedLocation;
          }
          storageLocationIri = resolvedLocation.value;
        }

        const updated = await this.partLots.patch(operation.payload.lotIri, {
          amount: operation.payload.patch.amount,
          storage_location: storageLocationIri,
          description: operation.payload.patch.description,
        });
        return updated.ok ? Ok({ iri: updated.value["@id"], body: updated.value }) : updated;
      }
      case "delete_lot": {
        if (!operation.payload.lotIri) {
          return Err({ kind: "dependency_missing", dependency: "lotIri", retryable: false });
        }
        const deleted = await this.partLots.delete(operation.payload.lotIri);
        return deleted.ok ? Ok({ iri: operation.payload.lotIri, body: null }) : deleted;
      }
    }
  }
}
