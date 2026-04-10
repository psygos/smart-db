import type { Result } from "@smart-db/contracts";
import type { PartDbError } from "../partdb-errors.js";
import {
  partDbMeasurementUnitResponseSchema,
  type PartDbMeasurementUnitResponse,
} from "../partdb-schemas.js";
import { PartDbRestClient } from "../partdb-rest.js";

export class PartDbMeasurementUnitsResource {
  constructor(private readonly rest: PartDbRestClient) {}

  list(query: URLSearchParams = new URLSearchParams()): Promise<Result<PartDbMeasurementUnitResponse[], PartDbError>> {
    const suffix = query.toString() ? `?${query.toString()}` : "";
    return this.rest.getJson(
      `/api/measurement_units${suffix}`,
      partDbMeasurementUnitResponseSchema.array(),
      { resource: "measurement_unit" },
    );
  }

  create(payload: Record<string, unknown>): Promise<Result<PartDbMeasurementUnitResponse, PartDbError>> {
    return this.rest.postJson(
      "/api/measurement_units",
      payload,
      partDbMeasurementUnitResponseSchema,
      { resource: "measurement_unit" },
    );
  }
}
