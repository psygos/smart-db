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
    return this.rest.getCollection(
      `/api/measurement_units${suffix}`,
      partDbMeasurementUnitResponseSchema,
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

  async findByName(name: string): Promise<Result<PartDbMeasurementUnitResponse | null, PartDbError>> {
    const listed = await this.list(new URLSearchParams({ name }));
    if (!listed.ok) {
      return listed;
    }

    const match = listed.value.find((unit) => unit.name === name) ?? null;
    return { ok: true, value: match };
  }
}
