import type { Result } from "@smart-db/contracts";
import type { PartDbError } from "../partdb-errors.js";
import {
  partDbStorageLocationResponseSchema,
  type PartDbStorageLocationResponse,
} from "../partdb-schemas.js";
import { PartDbRestClient } from "../partdb-rest.js";

export class PartDbStorageLocationsResource {
  constructor(private readonly rest: PartDbRestClient) {}

  list(query: URLSearchParams = new URLSearchParams()): Promise<Result<PartDbStorageLocationResponse[], PartDbError>> {
    const suffix = query.toString() ? `?${query.toString()}` : "";
    return this.rest.getCollection(
      `/api/storage_locations${suffix}`,
      partDbStorageLocationResponseSchema,
      { resource: "storage_location" },
    );
  }

  create(payload: Record<string, unknown>): Promise<Result<PartDbStorageLocationResponse, PartDbError>> {
    return this.rest.postJson(
      "/api/storage_locations",
      payload,
      partDbStorageLocationResponseSchema,
      { resource: "storage_location" },
    );
  }

  async findByName(name: string): Promise<Result<PartDbStorageLocationResponse | null, PartDbError>> {
    const listed = await this.list(new URLSearchParams({ name }));
    if (!listed.ok) {
      return listed;
    }

    const match = listed.value.find((location) => location.name === name) ?? null;
    return { ok: true, value: match };
  }

  async findByNameAndParent(
    name: string,
    parentIri: string | null,
  ): Promise<Result<PartDbStorageLocationResponse | null, PartDbError>> {
    const listed = await this.list(new URLSearchParams({ name }));
    if (!listed.ok) {
      return listed;
    }

    const match = listed.value.find((location) => {
      if (location.name !== name) {
        return false;
      }
      const parent =
        typeof location.parent === "string"
          ? location.parent
          : location.parent && typeof location.parent === "object" && "@id" in location.parent
            ? location.parent["@id"]
            : null;
      return (parent ?? null) === parentIri;
    }) ?? null;
    return { ok: true, value: match };
  }
}
