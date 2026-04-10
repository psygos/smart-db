import type { Result } from "@smart-db/contracts";
import type { PartDbError } from "../partdb-errors.js";
import {
  partDbCategoryResponseSchema,
  type PartDbCategoryResponse,
} from "../partdb-schemas.js";
import { PartDbRestClient } from "../partdb-rest.js";

export class PartDbCategoriesResource {
  constructor(private readonly rest: PartDbRestClient) {}

  list(query: URLSearchParams = new URLSearchParams()): Promise<Result<PartDbCategoryResponse[], PartDbError>> {
    const suffix = query.toString() ? `?${query.toString()}` : "";
    return this.rest.getJson(`/api/categories${suffix}`, partDbCategoryResponseSchema.array(), {
      resource: "category",
    });
  }

  create(input: { name: string; parent: string | null }): Promise<Result<PartDbCategoryResponse, PartDbError>> {
    return this.rest.postJson(
      "/api/categories",
      {
        name: input.name,
        parent: input.parent,
      },
      partDbCategoryResponseSchema,
      { resource: "category" },
    );
  }
}
