import type { Result } from "@smart-db/contracts";
import type { PartDbError } from "../partdb-errors.js";
import {
  partDbPartResponseSchema,
  type PartDbPartResponse,
} from "../partdb-schemas.js";
import { PartDbRestClient } from "../partdb-rest.js";

export class PartDbPartsResource {
  constructor(private readonly rest: PartDbRestClient) {}

  get(partIri: string): Promise<Result<PartDbPartResponse, PartDbError>> {
    return this.rest.getJson(partIri, partDbPartResponseSchema, {
      resource: "part",
      identifier: partIri,
    });
  }

  create(payload: Record<string, unknown>): Promise<Result<PartDbPartResponse, PartDbError>> {
    return this.rest.postJson("/api/parts", payload, partDbPartResponseSchema, {
      resource: "part",
    });
  }

  patch(partIri: string, payload: Record<string, unknown>): Promise<Result<PartDbPartResponse, PartDbError>> {
    return this.rest.patchJson(partIri, payload, partDbPartResponseSchema, {
      resource: "part",
      identifier: partIri,
    });
  }

  delete(partIri: string): Promise<Result<void, PartDbError>> {
    return this.rest.deleteResource(partIri, {
      resource: "part",
      identifier: partIri,
    });
  }
}
