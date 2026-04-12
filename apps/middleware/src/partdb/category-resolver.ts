import type { DatabaseSync } from "node:sqlite";
import { type Result, Ok } from "@smart-db/contracts";
import type { PartDbError } from "./partdb-errors.js";
import { PartDbCategoriesResource } from "./resources/categories.js";

type SqlRow = Record<string, unknown>;

export interface ResolvedCategory {
  iri: string;
  id: number;
}

export class CategoryResolver {
  constructor(
    private readonly db: DatabaseSync,
    private readonly categories: PartDbCategoriesResource,
  ) {}

  async resolveOrCreate(path: string[]): Promise<Result<ResolvedCategory, PartDbError>> {
    const fullKey = path.join("/");
    const fullyCached = this.readCache(fullKey);
    if (fullyCached) {
      return Ok({
        iri: fullyCached,
        id: extractIdFromIri(fullyCached),
      });
    }

    let parentIri: string | null = null;

    for (let depth = 1; depth <= path.length; depth += 1) {
      const subPath = path.slice(0, depth);
      const subKey = subPath.join("/");
      const cached = this.readCache(subKey);
      if (cached) {
        parentIri = cached;
        continue;
      }

      const name = subPath[subPath.length - 1]!;
      const existing = await this.categories.findByNameAndParent(name, parentIri);
      if (!existing.ok) {
        return existing;
      }

      if (existing.value) {
        this.writeCache(subKey, existing.value["@id"]);
        parentIri = existing.value["@id"];
        continue;
      }

      const created = await this.categories.create({
        name,
        parent: parentIri,
      });
      if (!created.ok) {
        return created;
      }

      this.writeCache(subKey, created.value["@id"]);
      parentIri = created.value["@id"];
    }

    return Ok({
      iri: parentIri!,
      id: extractIdFromIri(parentIri!),
    });
  }

  private readCache(pathKey: string): string | null {
    // Case-insensitive cache lookup so "Materials/PLA" and "materials/pla"
    // resolve to the same Part-DB category.
    const row = this.db.prepare(
      `SELECT partdb_iri FROM partdb_category_cache WHERE LOWER(path_key) = LOWER(?)`,
    ).get(pathKey) as SqlRow | undefined;
    return row && typeof row.partdb_iri === "string" ? row.partdb_iri : null;
  }

  private writeCache(pathKey: string, iri: string): void {
    // Store the cache key in lowercase so subsequent case-insensitive
    // lookups land in the same slot regardless of typed casing.
    this.db.prepare(
      `INSERT OR REPLACE INTO partdb_category_cache (path_key, partdb_iri, cached_at) VALUES (?, ?, ?)`,
    ).run(pathKey.toLowerCase(), iri, new Date().toISOString());
  }
}

export function extractIdFromIri(iri: string): number {
  const match = iri.match(/\/(\d+)$/);
  if (!match) {
    throw new Error(`Could not extract numeric id from Part-DB IRI '${iri}'.`);
  }

  return Number(match[1]);
}
