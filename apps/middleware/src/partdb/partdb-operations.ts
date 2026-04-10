import { type Result, Ok, Err } from "@smart-db/contracts";
import type { OutboxOperation } from "../outbox/outbox-types.js";
import type { PartDbError } from "./partdb-errors.js";
import { CategoryResolver } from "./category-resolver.js";
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
  ) {}

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
          default_measurement_unit: unitIri,
        });
        return created.ok ? Ok({ iri: created.value["@id"], body: created.value }) : created;
      }
      case "create_lot": {
        if (!operation.payload.partIri) {
          return Err({ kind: "dependency_missing", dependency: "partIri", retryable: false });
        }

        const existingLocation = await this.storageLocations.findByName(operation.payload.storageLocationName);
        if (!existingLocation.ok) {
          return existingLocation;
        }

        let storageLocationIri: string;
        if (existingLocation.value) {
          storageLocationIri = existingLocation.value["@id"];
        } else {
          const createdLocation = await this.storageLocations.create({
            name: operation.payload.storageLocationName,
          });
          if (!createdLocation.ok) {
            return createdLocation;
          }
          storageLocationIri = createdLocation.value["@id"];
        }

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
          const existingLocation = await this.storageLocations.findByName(operation.payload.patch.storageLocationName);
          if (!existingLocation.ok) {
            return existingLocation;
          }

          if (existingLocation.value) {
            storageLocationIri = existingLocation.value["@id"];
          } else {
            const createdLocation = await this.storageLocations.create({
              name: operation.payload.patch.storageLocationName,
            });
            if (!createdLocation.ok) {
              return createdLocation;
            }
            storageLocationIri = createdLocation.value["@id"];
          }
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
