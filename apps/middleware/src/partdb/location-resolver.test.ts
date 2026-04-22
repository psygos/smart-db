import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Ok, Err } from "@smart-db/contracts";
import { applyMigrations } from "../db/migrations.js";
import { LocationResolver, extractIdFromIri } from "./location-resolver.js";

function makeDb(): DatabaseSync {
  const directory = mkdtempSync(join(tmpdir(), "smart-db-location-cache-"));
  const db = new DatabaseSync(join(directory, "smart.db"));
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA journal_mode = WAL;");
  applyMigrations(db);
  return db;
}

describe("LocationResolver", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = makeDb();
  });

  it("returns cached locations without remote calls", async () => {
    db.prepare(
      `INSERT INTO partdb_location_cache (path_key, partdb_iri, cached_at) VALUES (?, ?, ?)`,
    ).run("shelf a/bin 7", "/api/storage_locations/99", "2026-01-01T00:00:00.000Z");

    const locations = {
      findByNameAndParent: vi.fn(),
      create: vi.fn(),
    } as never;

    const resolver = new LocationResolver(db, locations);
    await expect(resolver.resolveOrCreate(["Shelf A", "Bin 7"])).resolves.toEqual(
      Ok({ iri: "/api/storage_locations/99", id: 99 }),
    );
    expect(locations.findByNameAndParent).not.toHaveBeenCalled();
  });

  it("walks the path, creating missing children in order and chaining parents", async () => {
    const locations = {
      findByNameAndParent: vi
        .fn()
        .mockResolvedValueOnce(Ok({ "@id": "/api/storage_locations/10", id: 10, name: "Shelf A" }))
        .mockResolvedValueOnce(Ok(null))
        .mockResolvedValueOnce(Ok(null)),
      create: vi
        .fn()
        .mockResolvedValueOnce(Ok({ "@id": "/api/storage_locations/11", id: 11, name: "Bin 7" }))
        .mockResolvedValueOnce(Ok({ "@id": "/api/storage_locations/12", id: 12, name: "Drawer" })),
    } as never;

    const resolver = new LocationResolver(db, locations);
    await expect(
      resolver.resolveOrCreate(["Shelf A", "Bin 7", "Drawer"]),
    ).resolves.toEqual(Ok({ iri: "/api/storage_locations/12", id: 12 }));

    expect(locations.findByNameAndParent).toHaveBeenNthCalledWith(1, "Shelf A", null);
    expect(locations.findByNameAndParent).toHaveBeenNthCalledWith(2, "Bin 7", "/api/storage_locations/10");
    expect(locations.findByNameAndParent).toHaveBeenNthCalledWith(3, "Drawer", "/api/storage_locations/11");

    expect(locations.create).toHaveBeenNthCalledWith(1, { name: "Bin 7", parent: "/api/storage_locations/10" });
    expect(locations.create).toHaveBeenNthCalledWith(2, { name: "Drawer", parent: "/api/storage_locations/11" });
  });

  it("omits the parent field on the root-level create", async () => {
    const locations = {
      findByNameAndParent: vi.fn().mockResolvedValueOnce(Ok(null)),
      create: vi.fn().mockResolvedValueOnce(Ok({ "@id": "/api/storage_locations/20", id: 20, name: "Freezer" })),
    } as never;

    const resolver = new LocationResolver(db, locations);
    await expect(resolver.resolveOrCreate(["Freezer"])).resolves.toEqual(
      Ok({ iri: "/api/storage_locations/20", id: 20 }),
    );
    expect(locations.create).toHaveBeenCalledWith({ name: "Freezer" });
  });

  it("returns the first resource error without calling create", async () => {
    const locations = {
      findByNameAndParent: vi.fn().mockResolvedValue(
        Err({ kind: "network", message: "reset", cause: new Error("reset"), retryable: true }),
      ),
      create: vi.fn(),
    } as never;

    const resolver = new LocationResolver(db, locations);
    const result = await resolver.resolveOrCreate(["Shelf A"]);
    expect(result).toMatchObject({ ok: false, error: { kind: "network" } });
    expect(locations.create).not.toHaveBeenCalled();
  });
});

describe("extractIdFromIri (location)", () => {
  it("extracts the numeric suffix from a storage location iri", () => {
    expect(extractIdFromIri("/api/storage_locations/77")).toBe(77);
  });
});
