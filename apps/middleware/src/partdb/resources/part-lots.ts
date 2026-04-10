import type { Result } from "@smart-db/contracts";
import type { PartDbError } from "../partdb-errors.js";
import {
  partDbLotResponseSchema,
  type PartDbLotResponse,
} from "../partdb-schemas.js";
import { PartDbRestClient } from "../partdb-rest.js";

export class PartDbPartLotsResource {
  constructor(private readonly rest: PartDbRestClient) {}

  create(payload: Record<string, unknown>): Promise<Result<PartDbLotResponse, PartDbError>> {
    return this.rest.postJson("/api/part_lots", payload, partDbLotResponseSchema, {
      resource: "part_lot",
    });
  }

  patch(lotIri: string, payload: Record<string, unknown>): Promise<Result<PartDbLotResponse, PartDbError>> {
    return this.rest.patchJson(lotIri, payload, partDbLotResponseSchema, {
      resource: "part_lot",
      identifier: lotIri,
    });
  }

  delete(lotIri: string): Promise<Result<void, PartDbError>> {
    return this.rest.deleteResource(lotIri, {
      resource: "part_lot",
      identifier: lotIri,
    });
  }
}
