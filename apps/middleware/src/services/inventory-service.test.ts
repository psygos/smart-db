import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import {
  ConflictError,
  InvariantError,
  NotFoundError,
  type PartDbConnectionStatus,
  type PartDbLookupSummary,
} from "@smart-db/contracts";
import { createDatabase } from "../db/database";
import { PartDbOutbox } from "../outbox/partdb-outbox.js";
import { InventoryService, inventoryServiceTestInternals } from "./inventory-service";

function makeService(options: { withOutbox?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "smart-db-service-"));
  const db = createDatabase(join(directory, "smart.db"));
  const outbox = options.withOutbox ? new PartDbOutbox(db) : null;
  const partDbLookupSummary: PartDbLookupSummary = {
    configured: false,
    connected: false,
    message: "Part-DB credentials are not configured.",
  };
  const partDbConnectionStatus: PartDbConnectionStatus = {
    configured: false,
    connected: false,
    baseUrl: null,
    tokenLabel: null,
    userLabel: null,
    message: "Part-DB credentials are not configured.",
    discoveredResources: {
      tokenInfoPath: "/api/tokens/current",
      openApiPath: "/api/docs.json",
      partsPath: null,
      partLotsPath: null,
      storageLocationsPath: null,
    },
  };
  const partDbClient = {
    getLookupSummary: vi.fn(async () => partDbLookupSummary),
    getConnectionStatus: vi.fn(async () => partDbConnectionStatus),
  };

  return {
    db,
    outbox,
    service: new InventoryService(
      db,
      partDbClient as never,
      outbox,
    ),
  };
}

function dbRows(db: ReturnType<typeof createDatabase>) {
  return db
    .prepare(`SELECT operation, target_table AS targetTable, target_column AS targetColumn, status, depends_on_id AS dependsOnId, id FROM partdb_outbox ORDER BY created_at, id`)
    .all() as Array<{
    operation: string;
    targetTable: string | null;
    targetColumn: string | null;
    status: string;
    dependsOnId: string | null;
    id: string;
  }>;
}

describe("InventoryService", () => {
  it("parses slash-delimited category paths into canonical leaf and hierarchy", () => {
    const { db, service, outbox } = makeService({ withOutbox: true });
    if (!outbox) {
      throw new Error("outbox was not created");
    }

    service.registerQrBatch({
      actor: "lab-admin",
      prefix: "CAT",
      startNumber: 1,
      count: 1,
    });

    service.assignQr({
      qrCode: "CAT-1",
      actor: "labeler",
      entityKind: "instance",
      location: "Shelf A",
      notes: null,
      partType: {
        kind: "new",
        canonicalName: "10k Resistor",
        category: "Electronics/Resistors/SMD 0603",
        aliases: [],
        notes: null,
        imageUrl: null,
        countable: true,
      },
      initialStatus: "available",
    });

    const [createdPart] = service.searchPartTypes("10k Resistor");
    expect(createdPart).toMatchObject({
      canonicalName: "10k Resistor",
      category: "SMD 0603",
      categoryPath: ["Electronics", "Resistors", "SMD 0603"],
    });

    const partRow = dbRows(db).find((row) => row.operation === "create_part");
    expect(partRow).toBeDefined();
    expect(
      partRow ? outbox.hydrateOperation(outbox.getById(partRow.id)!) : null,
    ).toMatchObject({
      kind: "create_part",
      payload: {
        categoryPath: ["Electronics", "Resistors", "SMD 0603"],
      },
    });
  });

  it("enqueues part and lot sync work when assigning a new part type", () => {
    const { db, service, outbox } = makeService({ withOutbox: true });
    if (!outbox) {
      throw new Error("outbox was not created");
    }

    service.registerQrBatch({
      actor: "lab-admin",
      prefix: "SYNC",
      startNumber: 1,
      count: 1,
    });

    const summary = service.assignQr({
      qrCode: "SYNC-1",
      actor: "labeler",
      entityKind: "instance",
      location: "Shelf A",
      notes: "starter board",
      partType: {
        kind: "new",
        canonicalName: "Arduino Uno R3",
        category: "Microcontrollers",
        aliases: ["uno r3"],
        notes: null,
        imageUrl: null,
        countable: true,
      },
      initialStatus: "available",
    });

    expect(summary.targetType).toBe("instance");

    const allRows = dbRows(db);
    expect(allRows.map((row) => row.operation).sort()).toEqual(["create_lot", "create_part"]);
    expect(service.searchPartTypes("Arduino Uno R3")[0]?.partDbSyncStatus).toBe("pending");
    const partRow = allRows.find((row) => row.operation === "create_part");
    const lotRow = allRows.find((row) => row.operation === "create_lot");
    expect(partRow).toMatchObject({
      targetTable: "part_types",
      targetColumn: "partdb_part_id",
      status: "pending",
    });
    expect(lotRow).toMatchObject({
      targetTable: "physical_instances",
      targetColumn: "partdb_lot_id",
      status: "pending",
      dependsOnId: partRow?.id,
    });
  });

  it("enqueues lot updates and deletes for synced inventory rows", () => {
    const { db, service, outbox } = makeService({ withOutbox: true });
    if (!outbox) {
      throw new Error("outbox was not created");
    }

    service.registerQrBatch({ actor: "admin", prefix: "L", startNumber: 1, count: 1 });
    const summary = service.assignQr({
      qrCode: "L-1",
      actor: "labeler",
      entityKind: "instance",
      location: "Shelf A",
      notes: null,
      partType: {
        kind: "new",
        canonicalName: "Sync Item",
        category: "Misc",
        aliases: [],
        notes: null,
        imageUrl: null,
        countable: true,
      },
      initialStatus: "available",
    });

    db.prepare(`UPDATE physical_instances SET partdb_lot_id = ? WHERE id = ?`).run("41", summary.id);

    service.recordEvent({
      targetType: "instance",
      targetId: summary.id,
      actor: "admin",
      event: "moved",
      location: "Shelf B",
      notes: null,
      assignee: null,
    });
    service.voidQrCode("L-1", "admin");

    const operations = dbRows(db).map((row) => row.operation);
    expect(operations).toContain("update_lot");
    expect(operations).toContain("delete_lot");
  });

  it("backfills existing unsynced inventory into the Part-DB outbox", () => {
    const initial = makeService();

    initial.service.registerQrBatch({ actor: "admin", prefix: "BF", startNumber: 1, count: 2 });
    initial.service.assignQr({
      qrCode: "BF-1",
      actor: "labeler",
      entityKind: "instance",
      location: "Shelf A",
      notes: null,
      partType: {
        kind: "new",
        canonicalName: "Backfill Instance",
        category: "Electronics",
        aliases: [],
        notes: null,
        imageUrl: null,
        countable: true,
      },
      initialStatus: "available",
    });
    initial.service.assignQr({
      qrCode: "BF-2",
      actor: "labeler",
      entityKind: "bulk",
      location: "Bin A",
      notes: null,
      partType: {
        kind: "new",
        canonicalName: "Backfill Bulk",
        category: "Hardware",
        aliases: [],
        notes: null,
        imageUrl: null,
        countable: false,
      },
      initialQuantity: 12,
      minimumQuantity: 3,
    });

    const outbox = new PartDbOutbox(initial.db);
    const lookupSummary: PartDbLookupSummary = {
      configured: false,
      connected: false,
      message: "Part-DB credentials are not configured.",
    };
    const connectionStatus: PartDbConnectionStatus = {
      configured: false,
      connected: false,
      baseUrl: null,
      tokenLabel: null,
      userLabel: null,
      message: "Part-DB credentials are not configured.",
      discoveredResources: {
        tokenInfoPath: "/api/tokens/current",
        openApiPath: "/api/docs.json",
        partsPath: null,
        partLotsPath: null,
        storageLocationsPath: null,
      },
    };
    const backfillService = new InventoryService(
      initial.db,
      {
        getLookupSummary: vi.fn(async () => lookupSummary),
        getConnectionStatus: vi.fn(async () => connectionStatus),
      } as never,
      outbox,
    );

    expect(backfillService.backfillPartDbSync()).toEqual({
      queuedPartTypes: 2,
      queuedLots: 2,
      skipped: 0,
    });
    expect(dbRows(initial.db).map((row) => row.operation).sort()).toEqual([
      "create_lot",
      "create_lot",
      "create_part",
      "create_part",
    ]);

    expect(backfillService.backfillPartDbSync()).toEqual({
      queuedPartTypes: 0,
      queuedLots: 0,
      skipped: 4,
    });
  });

  it("resets local inventory and queues corresponding Part-DB deletions", () => {
    const { db, service } = makeService({ withOutbox: true });

    service.registerQrBatch({ actor: "admin", prefix: "RST", startNumber: 1, count: 2 });
    const instance = service.assignQr({
      qrCode: "RST-1",
      actor: "labeler",
      entityKind: "instance",
      location: "Shelf A",
      notes: null,
      partType: {
        kind: "new",
        canonicalName: "Reset Instance",
        category: "Electronics",
        aliases: [],
        notes: null,
        imageUrl: null,
        countable: true,
      },
      initialStatus: "available",
    });
    const bulk = service.assignQr({
      qrCode: "RST-2",
      actor: "labeler",
      entityKind: "bulk",
      location: "Bin A",
      notes: null,
      partType: {
        kind: "new",
        canonicalName: "Reset Bulk",
        category: "Hardware",
        aliases: [],
        notes: null,
        imageUrl: null,
        countable: false,
      },
      initialQuantity: 12,
      minimumQuantity: 3,
    });

    db.prepare(`UPDATE part_types SET partdb_part_id = '41' WHERE id = ?`).run(instance.partType.id);
    db.prepare(`UPDATE part_types SET partdb_part_id = '42' WHERE id = ?`).run(bulk.partType.id);
    db.prepare(`UPDATE physical_instances SET partdb_lot_id = '51' WHERE id = ?`).run(instance.id);
    db.prepare(`UPDATE bulk_stocks SET partdb_lot_id = '52' WHERE id = ?`).run(bulk.id);

    const result = service.resetInventoryState();
    expect(result).toEqual({
      clearedPartTypes: 2,
      clearedInventoryItems: 2,
      clearedQrCodes: 2,
      queuedRemotePartDeletes: 2,
      queuedRemoteLotDeletes: 2,
    });

    const counts = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM part_types) AS part_types,
        (SELECT COUNT(*) FROM physical_instances) AS physical_instances,
        (SELECT COUNT(*) FROM bulk_stocks) AS bulk_stocks,
        (SELECT COUNT(*) FROM qrcodes) AS qrcodes,
        (SELECT COUNT(*) FROM qr_batches) AS qr_batches,
        (SELECT COUNT(*) FROM stock_events) AS stock_events
    `).get() as {
      part_types: number;
      physical_instances: number;
      bulk_stocks: number;
      qrcodes: number;
      qr_batches: number;
      stock_events: number;
    };
    expect(counts).toEqual({
      part_types: 0,
      physical_instances: 0,
      bulk_stocks: 0,
      qrcodes: 0,
      qr_batches: 0,
      stock_events: 0,
    });

    const resetRows = dbRows(db);
    expect(resetRows.map((row) => row.operation).sort()).toEqual([
      "delete_lot",
      "delete_lot",
      "delete_part",
      "delete_part",
    ]);
    expect(
      resetRows.filter((row) => row.operation === "delete_part").every((row) => row.dependsOnId !== null),
    ).toBe(true);
  });

  it("supports the full intake and lifecycle flow for instances and bulk stock", async () => {
    const { service } = makeService();

    expect(
      service.registerQrBatch({
        actor: "lab-admin",
        prefix: "QR",
        startNumber: 1001,
        count: 6,
      }),
    ).toEqual({
      batch: expect.objectContaining({
        prefix: "QR",
        startNumber: 1001,
        endNumber: 1006,
      }),
      created: 6,
      skipped: 0,
    });
    expect(
      service.registerQrBatch({
        actor: "lab-admin",
        prefix: "QR",
        startNumber: 1001,
        count: 1,
      }).skipped,
    ).toBe(1);
    expect(
      service.registerQrBatch({
        actor: "lab-admin",
        batchId: "manual-batch",
        prefix: "QR",
        startNumber: 2000,
        count: 1,
      }).batch.id,
    ).toBe("manual-batch");
    expect(
      service.registerQrBatch({
        actor: "lab-admin",
        batchId: "manual-batch",
        prefix: "QR",
        startNumber: 2000,
        count: 1,
      }),
    ).toMatchObject({
      batch: {
        id: "manual-batch",
        prefix: "QR",
        startNumber: 2000,
        endNumber: 2000,
        actor: "lab-admin",
      },
      created: 0,
      skipped: 1,
    });
    expect(() =>
      service.registerQrBatch({
        actor: "lab-admin",
        batchId: "manual-batch",
        prefix: "ALT",
        startNumber: 2000,
        count: 1,
      }),
    ).toThrowError(ConflictError);

    await expect(service.scanCode("EAN-1234")).resolves.toEqual({
      mode: "unknown",
      code: "EAN-1234",
      partDb: {
        configured: false,
        connected: false,
        message: "Part-DB credentials are not configured.",
      },
    });

    await expect(service.scanCode("QR-1001")).resolves.toMatchObject({
      mode: "label",
      qrCode: {
        code: "QR-1001",
        status: "printed",
      },
    });

    const instanceSummary = service.assignQr({
      qrCode: "QR-1001",
      actor: "labeler",
      entityKind: "instance",
      location: "Shelf A",
      notes: "starter board",
      partType: {
        kind: "new",
        canonicalName: "Arduino Uno R3",
        category: "Microcontrollers",
        aliases: ["uno r3"],
        notes: null,
        imageUrl: null,
        countable: true,
      },
      initialStatus: "available",
    });

    expect(instanceSummary).toMatchObject({
      targetType: "instance",
      state: "available",
      partType: {
        canonicalName: "Arduino Uno R3",
      },
    });

    expect(service.getDashboardSummary()).toMatchObject({
      partTypeCount: 1,
      instanceCount: 1,
      bulkStockCount: 0,
      provisionalCount: 1,
      unassignedQrCount: 6,
    });
    expect(service.searchPartTypes("arduino")).toHaveLength(1);
    expect(service.getProvisionalPartTypes()).toHaveLength(1);

    await expect(service.scanCode("QR-1001")).resolves.toMatchObject({
      mode: "interact",
      entity: {
        targetType: "instance",
      },
      availableActions: [
        "moved",
        "checked_out",
        "consumed",
        "damaged",
        "lost",
        "disposed",
      ],
    });

    expect(
      service.recordEvent({
        targetType: "instance",
        targetId: instanceSummary.id,
        actor: "lab-admin",
        event: "moved",
        location: "Shelf B",
        notes: null,
        assignee: null,
      }).event,
    ).toBe("moved");

    expect(
      service.recordEvent({
        targetType: "instance",
        targetId: instanceSummary.id,
        actor: "lab-admin",
        event: "checked_out",
        location: "Workbench",
        notes: "for robotics build",
        assignee: "Ayesha",
      }).toState,
    ).toBe("checked_out");
    expect(
      service.recordEvent({
        targetType: "instance",
        targetId: instanceSummary.id,
        actor: "lab-admin",
        event: "checked_out",
        location: "" as never,
        notes: null,
        assignee: "" as never,
      }).location,
    ).toBe("Workbench");

    expect(
      service.recordEvent({
        targetType: "instance",
        targetId: instanceSummary.id,
        actor: "lab-admin",
        event: "returned",
        location: "Shelf B",
        notes: null,
        assignee: null,
      }).toState,
    ).toBe("available");

    expect(
      service.recordEvent({
        targetType: "instance",
        targetId: instanceSummary.id,
        actor: "lab-admin",
        event: "damaged",
        location: "Repair shelf",
        notes: null,
        assignee: null,
      }).toState,
    ).toBe("damaged");

    expect(
      service.recordEvent({
        targetType: "instance",
        targetId: instanceSummary.id,
        actor: "lab-admin",
        event: "lost",
        location: "Unknown",
        notes: null,
        assignee: null,
      }).toState,
    ).toBe("lost");

    expect(
      service.recordEvent({
        targetType: "instance",
        targetId: instanceSummary.id,
        actor: "lab-admin",
        event: "disposed",
        location: "Waste",
        notes: null,
        assignee: null,
      }).toState,
    ).toBe("consumed");

    const secondInstance = service.assignQr({
      qrCode: "QR-1002",
      actor: "labeler",
      entityKind: "instance",
      location: "Shelf A",
      notes: null,
      partType: {
        kind: "existing",
        existingPartTypeId: instanceSummary.partType.id,
      },
      initialStatus: "available",
    });

    expect(
      service.recordEvent({
        targetType: "instance",
        targetId: secondInstance.id,
        actor: "lab-admin",
        event: "consumed",
        location: "Project bin",
        notes: null,
        assignee: null,
      }).toState,
    ).toBe("consumed");

    const bulkSummary = service.assignQr({
      qrCode: "QR-1003",
      actor: "labeler",
      entityKind: "bulk",
      location: "Bin 7",
      notes: "bulk screws",
      partType: {
        kind: "new",
        canonicalName: "M3 Screw",
        category: "Fasteners",
        aliases: [],
        notes: null,
        imageUrl: null,
        countable: false,
      },
      initialQuantity: 75,
      minimumQuantity: null,
    });
    const fallbackBulk = service.assignQr({
      qrCode: "QR-2000",
      actor: "labeler",
      entityKind: "bulk",
      location: "Drawer",
      notes: null,
      partType: {
        kind: "new",
        canonicalName: "Fallback Bulk",
        category: "Misc",
        aliases: [],
        notes: null,
        imageUrl: null,
        countable: false,
      },
      initialQuantity: 1,
      minimumQuantity: null,
    });

    expect(bulkSummary.targetType).toBe("bulk");
    expect(fallbackBulk.state).toBe("1 pcs on hand");
    await expect(service.scanCode("QR-1003")).resolves.toMatchObject({
      mode: "interact",
      availableActions: ["moved", "restocked", "consumed", "stocktaken", "adjusted"],
    });
    expect(
      service.recordEvent({
        targetType: "bulk",
        targetId: bulkSummary.id,
        actor: "lab-admin",
        event: "moved",
        location: "Fastener wall",
        notes: "drawer audit",
      }).event,
    ).toBe("moved");
    expect(
      service.recordEvent({
        targetType: "bulk",
        targetId: bulkSummary.id,
        actor: "lab-admin",
        event: "stocktaken",
        location: "Fastener wall",
        notes: null,
        quantity: 25,
      }).toState,
    ).toBe("25 pcs on hand");
    expect(
      service.recordEvent({
        targetType: "bulk",
        targetId: bulkSummary.id,
        actor: "lab-admin",
        event: "consumed",
        location: "Fastener wall",
        notes: null,
        quantityDelta: 25,
      }).toState,
    ).toBe("0 pcs on hand");
    service.recordEvent({
      targetType: "bulk",
      targetId: bulkSummary.id,
      actor: "lab-admin",
      event: "restocked",
      location: "Fastener wall",
      notes: null,
      quantityDelta: 3,
    });
    expect(() =>
      service.recordEvent({
        targetType: "bulk",
        targetId: bulkSummary.id,
        actor: "lab-admin",
        event: "consumed",
        location: "Fastener wall",
        notes: null,
        quantityDelta: 5,
      }),
    ).toThrowError(ConflictError);
    expect(() =>
      service.recordEvent({
        targetType: "bulk",
        targetId: bulkSummary.id,
        actor: "lab-admin",
        event: "adjusted",
        location: "" as never,
        notes: "" as never,
        quantityDelta: Number.NaN as never,
      }),
    ).toThrowError(InvariantError);

    const mergeA = service.assignQr({
      qrCode: "QR-1004",
      actor: "labeler",
      entityKind: "instance",
      location: "Cable shelf",
      notes: null,
      partType: {
        kind: "new",
        canonicalName: "USB-C Cable",
        category: "Cables",
        aliases: ["usb c"],
        notes: null,
        imageUrl: null,
        countable: true,
      },
      initialStatus: "available",
    });
    const mergeB = service.assignQr({
      qrCode: "QR-1005",
      actor: "labeler",
      entityKind: "instance",
      location: "Cable shelf",
      notes: null,
      partType: {
        kind: "new",
        canonicalName: "USB Type C Cable",
        category: "Cables",
        aliases: ["type c cable"],
        notes: null,
        imageUrl: null,
        countable: true,
      },
      initialStatus: "available",
    });

    expect(
      service.mergePartTypes({
        sourcePartTypeId: mergeB.partType.id,
        destinationPartTypeId: mergeA.partType.id,
        aliasLabel: "usb type c cable",
      }),
    ).toMatchObject({
      id: mergeA.partType.id,
      aliases: expect.arrayContaining(["usb c", "usb type c cable"]),
      needsReview: false,
    });

    await expect(service.getPartDbStatus()).resolves.toMatchObject({
      configured: false,
      connected: false,
    });
  });

  it("raises designed errors for missing resources and conflicts", async () => {
    const { db, service } = makeService();

    // Unknown QR codes now auto-register as external barcodes, so no NotFoundError.

    service.registerQrBatch({
      actor: "lab-admin",
      prefix: "QR",
      startNumber: 2001,
      count: 2,
    });
    service.assignQr({
      qrCode: "QR-2001",
      actor: "labeler",
      entityKind: "instance",
      location: "Shelf",
      notes: null,
      partType: {
        kind: "new",
        canonicalName: "Sensor",
        category: "Electronics",
        aliases: [],
        notes: null,
        imageUrl: null,
        countable: true,
      },
      initialStatus: "available",
    });

    expect(() =>
      service.assignQr({
        qrCode: "QR-2001",
        actor: "labeler",
        entityKind: "instance",
        location: "Shelf",
        notes: null,
        partType: {
          kind: "existing",
          existingPartTypeId: service.searchPartTypes("Sensor")[0]!.id,
        },
        initialStatus: "available",
      }),
    ).toThrowError(ConflictError);

    service.registerQrBatch({
      actor: "lab-admin",
      prefix: "QR",
      startNumber: 2999,
      count: 1,
    });
    expect(
      service.assignQr({
        qrCode: "QR-2999",
        actor: "labeler",
        entityKind: "instance",
        location: "Shelf",
        notes: null,
        partType: {
          kind: "new",
          canonicalName: "Fallback Status Part",
          category: "Misc",
          aliases: [],
          notes: null,
          imageUrl: null,
          countable: true,
        },
        initialStatus: "not-a-status" as never,
      }).state,
    ).toBe("available");

    expect(
      service.assignQr({
        qrCode: "QR-2002",
        actor: "labeler",
        entityKind: "bulk",
        location: "Bin",
        notes: null,
        partType: {
          kind: "existing",
          existingPartTypeId: service.searchPartTypes("Sensor")[0]!.id,
        },
        initialQuantity: 10,
        minimumQuantity: null,
      }).targetType,
    ).toBe("bulk");

    service.registerQrBatch({
      actor: "lab-admin",
      prefix: "QR",
      startNumber: 3001,
      count: 1,
    });
    const bulkPart = service.assignQr({
      qrCode: "QR-3001",
      actor: "labeler",
      entityKind: "bulk",
      location: "Bin",
      notes: null,
      partType: {
        kind: "new",
        canonicalName: "Cotton Thread",
        category: "Textiles",
        aliases: [],
        notes: null,
        imageUrl: null,
        countable: false,
      },
      initialQuantity: 10,
      minimumQuantity: null,
    });

    service.registerQrBatch({
      actor: "lab-admin",
      prefix: "QR",
      startNumber: 3002,
      count: 1,
    });
    expect(() =>
      service.assignQr({
        qrCode: "QR-3002",
        actor: "labeler",
        entityKind: "instance",
        location: "Shelf",
        notes: null,
        partType: {
          kind: "existing",
          existingPartTypeId: bulkPart.partType.id,
        },
        initialStatus: "available",
      }),
    ).toThrowError(ConflictError);

    await expect(service.scanCode("QR-2002")).resolves.toMatchObject({
      mode: "interact",
      entity: {
        targetType: "bulk",
      },
    });
    db.prepare(`UPDATE qrcodes SET status = 'voided' WHERE code = ?`).run("QR-2002");
    await expect(service.scanCode("QR-2002")).resolves.toMatchObject({
      mode: "unknown",
    });

    expect(() =>
      service.recordEvent({
        targetType: "instance",
        targetId: "missing",
        actor: "lab-admin",
        event: "moved",
        location: "Shelf",
        notes: null,
        assignee: null,
      }),
    ).toThrowError(NotFoundError);

    expect(() =>
      service.recordEvent({
        targetType: "bulk",
        targetId: "missing",
        actor: "lab-admin",
        event: "moved",
        location: "Bin",
        notes: null,
      }),
    ).toThrowError(NotFoundError);

    expect(() =>
      service.mergePartTypes({
        sourcePartTypeId: "missing",
        destinationPartTypeId: "also-missing",
      }),
    ).toThrowError(NotFoundError);

    service.registerQrBatch({
      actor: "lab-admin",
      prefix: "QR",
      startNumber: 3003,
      count: 1,
    });
    const mergeSource = service.assignQr({
      qrCode: "QR-3003",
      actor: "labeler",
      entityKind: "instance",
      location: "Shelf",
      notes: null,
      partType: {
        kind: "new",
        canonicalName: "Loose Cable",
        category: "Cables",
        aliases: [],
        notes: null,
        imageUrl: null,
        countable: true,
      },
      initialStatus: "available",
    });

    expect(() =>
      service.mergePartTypes({
        sourcePartTypeId: mergeSource.partType.id,
        destinationPartTypeId: "missing-destination",
      }),
    ).toThrowError(NotFoundError);

    expect(() =>
      service.mergePartTypes({
        sourcePartTypeId: mergeSource.partType.id,
        destinationPartTypeId: mergeSource.partType.id,
      }),
    ).toThrowError(ConflictError);

    service.registerQrBatch({
      actor: "lab-admin",
      prefix: "QR",
      startNumber: 3100,
      count: 1,
    });
    const availableItem = service.assignQr({
      qrCode: "QR-3100",
      actor: "labeler",
      entityKind: "instance",
      location: "Shelf",
      notes: null,
      partType: {
        kind: "new",
        canonicalName: "Transition Test",
        category: "Misc",
        aliases: [],
        notes: null,
        imageUrl: null,
        countable: true,
      },
      initialStatus: "available",
    });

    expect(() =>
      service.recordEvent({
        targetType: "instance",
        targetId: availableItem.id,
        actor: "lab-admin",
        event: "returned",
        location: "Shelf",
        notes: null,
        assignee: null,
      }),
    ).toThrowError(ConflictError);

    expect(() =>
      service.recordEvent({
        targetType: "instance",
        targetId: availableItem.id,
        actor: "lab-admin",
        event: "moved",
        location: "Shelf",
        notes: null,
      }),
    ).toThrowError(ConflictError);

    service.registerQrBatch({ actor: "lab-admin", prefix: "QR", startNumber: 3200, count: 1 });
    const bulkItem = service.assignQr({
      qrCode: "QR-3200",
      actor: "labeler",
      entityKind: "bulk",
      location: "Drawer",
      notes: null,
      partType: {
        kind: "new",
        canonicalName: "Move Bulk Test",
        category: "Misc",
        aliases: [],
        notes: null,
        imageUrl: null,
        countable: false,
      },
      initialQuantity: 10,
      minimumQuantity: null,
    });

    expect(() =>
      service.recordEvent({
        targetType: "bulk",
        targetId: bulkItem.id,
        actor: "lab-admin",
        event: "moved",
        location: "Drawer",
        notes: null,
      }),
    ).toThrowError(ConflictError);
  });

  it("allows a countable part type to own both tracked units and pooled stock", () => {
    const { service } = makeService();

    service.registerQrBatch({
      actor: "lab-admin",
      prefix: "QR",
      startNumber: 6100,
      count: 2,
    });

    const tracked = service.assignQr({
      qrCode: "QR-6100",
      actor: "labeler",
      entityKind: "instance",
      location: "Shelf A",
      notes: null,
      partType: {
        kind: "new",
        canonicalName: "Arduino Uno R4",
        category: "Microcontrollers",
        aliases: [],
        notes: null,
        imageUrl: null,
        countable: true,
      },
      initialStatus: "available",
    });

    const pooled = service.assignQr({
      qrCode: "QR-6101",
      actor: "labeler",
      entityKind: "bulk",
      location: "Shelf A",
      notes: null,
      partType: {
        kind: "existing",
        existingPartTypeId: tracked.partType.id,
      },
      initialQuantity: 12,
      minimumQuantity: 2,
    });

    const summary = service.getInventorySummary();
    expect(summary).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: tracked.partType.id,
          countable: true,
          bins: 1,
          instanceCount: 1,
          onHand: 13,
          entityCount: 2,
        }),
      ]),
    );

    expect(pooled.targetType).toBe("bulk");
    expect(pooled.partType.id).toBe(tracked.partType.id);
  });

  it("keeps Smart DB labels exact while allowing fuzzy external barcode lookup", async () => {
    const { service } = makeService();

    service.registerQrBatch({
      actor: "lab-admin",
      prefix: "QR",
      startNumber: 6300,
      count: 1,
    });

    service.assignQr({
      qrCode: "QR-6300",
      actor: "labeler",
      entityKind: "instance",
      location: "Shelf A",
      notes: null,
      partType: {
        kind: "new",
        canonicalName: "Handheld Scanner Test",
        category: "Misc",
        aliases: [],
        notes: null,
        imageUrl: null,
        countable: true,
      },
      initialStatus: "available",
    });

    await expect(service.scanCode(" qr_6300 ")).resolves.toMatchObject({
      mode: "unknown",
      code: "qr_6300",
    });

    service.assignQr({
      qrCode: "ESUN-BLACK-PLA",
      actor: "labeler",
      entityKind: "bulk",
      location: "Filament Shelf",
      notes: null,
      partType: {
        kind: "new",
        canonicalName: "eSUN PLA Black",
        category: "Filament",
        aliases: [],
        notes: null,
        imageUrl: null,
        countable: false,
        unit: {
          symbol: "kg",
          name: "Kilograms",
          isInteger: false,
        },
      },
      initialQuantity: 1,
      minimumQuantity: 0.2,
    });

    await expect(service.scanCode(" esun_black_pla ")).resolves.toMatchObject({
      mode: "interact",
      qrCode: {
        code: "ESUN-BLACK-PLA",
        batchId: "external",
      },
      entity: {
        targetType: "bulk",
      },
    });
  });

  it("rejects zero-quantity bulk assignment commands as impossible ingest", () => {
    const { service } = makeService();

    service.registerQrBatch({
      actor: "lab-admin",
      prefix: "QR",
      startNumber: 6400,
      count: 1,
    });

    expect(() =>
      service.assignQr({
        qrCode: "QR-6400",
        actor: "labeler",
        entityKind: "bulk",
        location: "Shelf A",
        notes: null,
        partType: {
          kind: "new",
          canonicalName: "Impossible Empty Ingest",
          category: "Materials",
          aliases: [],
          notes: null,
          imageUrl: null,
          countable: false,
        },
        initialQuantity: 0,
        minimumQuantity: null,
      }),
    ).toThrowError(InvariantError);
  });

  it("reassigns one ingested entity to a different existing part type and records a correction event", () => {
    const { service } = makeService();

    service.registerQrBatch({
      actor: "lab-admin",
      prefix: "QR",
      startNumber: 6500,
      count: 2,
    });

    const wrong = service.assignQr({
      qrCode: "QR-6500",
      actor: "labeler",
      entityKind: "instance",
      location: "Shelf A",
      notes: null,
      partType: {
        kind: "new",
        canonicalName: "Arduino Mega Typo",
        category: "Microcontrollers",
        aliases: [],
        notes: null,
        imageUrl: null,
        countable: true,
      },
      initialStatus: "available",
    });

    const correct = service.assignQr({
      qrCode: "QR-6501",
      actor: "labeler",
      entityKind: "instance",
      location: "Shelf A",
      notes: null,
      partType: {
        kind: "new",
        canonicalName: "Arduino Mega 2560",
        category: "Microcontrollers",
        aliases: [],
        notes: null,
        imageUrl: null,
        countable: true,
      },
      initialStatus: "available",
    });

    const corrected = service.reassignEntityPartType({
      targetType: "instance",
      targetId: wrong.id,
      fromPartTypeId: wrong.partType.id,
      toPartTypeId: correct.partType.id,
      actor: "admin",
      reason: "Wrong part selected during intake",
    });

    expect(corrected.entity.partType.id).toBe(correct.partType.id);
    expect(corrected.correctionEvent.correctionKind).toBe("entity_part_type_reassigned");
    expect(service.getCorrectionHistory("instance", wrong.id)).toHaveLength(1);
  });

  it("edits a shared part type definition with optimistic concurrency and records a correction event", () => {
    const { service } = makeService();

    service.registerQrBatch({
      actor: "lab-admin",
      prefix: "QR",
      startNumber: 6600,
      count: 1,
    });

    const entity = service.assignQr({
      qrCode: "QR-6600",
      actor: "labeler",
      entityKind: "bulk",
      location: "Shelf A",
      notes: null,
      partType: {
        kind: "new",
        canonicalName: "Black PLA typ0",
        category: "Materials / 3D Printing",
        aliases: [],
        notes: null,
        imageUrl: null,
        countable: false,
      },
      initialQuantity: 1,
      minimumQuantity: null,
    });

    const edited = service.editPartTypeDefinition({
      partTypeId: entity.partType.id,
      expectedUpdatedAt: entity.partType.updatedAt,
      canonicalName: "Black PLA+",
      category: "Materials / 3D Printing",
      actor: "admin",
      reason: "Fix shared label",
    });

    expect(edited.partType.canonicalName).toBe("Black PLA+");
    expect(edited.correctionEvent.correctionKind).toBe("part_type_definition_edited");
    expect(service.getCorrectionHistory("part_type", entity.partType.id)).toHaveLength(1);
  });

  it("rejects shared type renames that would collide with an existing seeded type", () => {
    const { service } = makeService();

    service.registerQrBatch({
      actor: "lab-admin",
      prefix: "QR",
      startNumber: 6610,
      count: 2,
    });

    const wrong = service.assignQr({
      qrCode: "QR-6610",
      actor: "labeler",
      entityKind: "instance",
      location: "Shelf A",
      notes: null,
      partType: {
        kind: "new",
        canonicalName: "6000 RPM Motor",
        category: "Motors / DC",
        aliases: [],
        notes: null,
        imageUrl: null,
        countable: true,
      },
      initialStatus: "available",
    });

    const seededEntity = service.assignQr({
      qrCode: "QR-6611",
      actor: "labeler",
      entityKind: "instance",
      location: "Shelf A",
      notes: null,
      partType: {
        kind: "new",
        canonicalName: "60 RPM Motor",
        category: "Motors / DC",
        aliases: [],
        notes: null,
        imageUrl: null,
        countable: true,
      },
      initialStatus: "available",
    });
    const seeded = service.reverseIngestAssignment({
      qrCode: "QR-6611",
      assignedKind: "instance",
      assignedId: seededEntity.id,
      actor: "admin",
      reason: "Keep as zero-stock seed type",
    });

    expect(() =>
      service.editPartTypeDefinition({
        partTypeId: wrong.partType.id,
        expectedUpdatedAt: wrong.partType.updatedAt,
        canonicalName: "60 RPM Motor",
        category: "Motors / DC",
        actor: "admin",
        reason: "Test rename collision",
      }),
    ).toThrowError(ConflictError);

    expect(service.searchPartTypes("6000 RPM Motor").map((partType) => partType.id)).toContain(wrong.partType.id);
    expect(seeded.qrCode.status).toBe("printed");
    expect(service.searchPartTypes("60 RPM Motor")).toHaveLength(1);
  });

  it("reverses a fresh ingest, returns the QR to printed, and records a correction event", () => {
    const { service } = makeService();

    service.registerQrBatch({
      actor: "lab-admin",
      prefix: "QR",
      startNumber: 6700,
      count: 1,
    });

    const entity = service.assignQr({
      qrCode: "QR-6700",
      actor: "labeler",
      entityKind: "bulk",
      location: "Shelf A",
      notes: null,
      partType: {
        kind: "new",
        canonicalName: "Mistaken Ingest",
        category: "Materials",
        aliases: [],
        notes: null,
        imageUrl: null,
        countable: false,
      },
      initialQuantity: 2,
      minimumQuantity: null,
    });

    const reversed = service.reverseIngestAssignment({
      qrCode: "QR-6700",
      assignedKind: "bulk",
      assignedId: entity.id,
      actor: "admin",
      reason: "Wrong barcode was ingested",
    });

    expect(reversed.qrCode.status).toBe("printed");
    expect(reversed.correctionEvent.correctionKind).toBe("ingest_reversed");
    expect(service.getCorrectionHistory("bulk", entity.id)).toHaveLength(1);
  });

  it("bulk labels multiple QR codes against one shared assignment and reuses the created part type", () => {
    const { service } = makeService();

    service.registerQrBatch({
      actor: "lab-admin",
      prefix: "QR",
      startNumber: 6750,
      count: 2,
    });

    const response = service.bulkAssignQrs({
      qrs: ["QR-6750", "QR-6751"],
      assignment: {
        entityKind: "instance",
        location: "Shelf A",
        notes: null,
        partType: {
          kind: "new",
          canonicalName: "Bulk Label Part",
          category: "Fixtures",
          aliases: [],
          notes: null,
          imageUrl: null,
          countable: true,
          unit: {
            symbol: "pcs",
            name: "Pieces",
            isInteger: true,
          },
        },
        initialStatus: "available",
      },
      actor: "labeler",
    });

    expect(response.processedCount).toBe(2);
    expect(new Set(response.entities.map((entity) => entity.partType.id)).size).toBe(1);
    expect(service.searchPartTypes("Bulk Label Part")).toHaveLength(1);
  });

  it("bulk labels reuse a pre-existing part type rather than creating a duplicate", () => {
    const { service } = makeService();

    const existing = service.assignQr({
      qrCode: "QR-6740",
      actor: "labeler",
      entityKind: "instance",
      location: "Shelf Z",
      notes: null,
      partType: {
        kind: "new",
        canonicalName: "Shared Fixture",
        category: "Fixtures",
        aliases: [],
        notes: null,
        imageUrl: null,
        countable: true,
      },
      initialStatus: "available",
    });

    service.registerQrBatch({
      actor: "lab-admin",
      prefix: "QR",
      startNumber: 6741,
      count: 3,
    });

    const response = service.bulkAssignQrs({
      qrs: ["QR-6741", "QR-6742", "QR-6743"],
      assignment: {
        entityKind: "instance",
        location: "Shelf A",
        notes: null,
        partType: {
          kind: "new",
          canonicalName: "Shared Fixture",
          category: "Fixtures",
          aliases: [],
          notes: null,
          imageUrl: null,
          countable: true,
          unit: {
            symbol: "pcs",
            name: "Pieces",
            isInteger: true,
          },
        },
        initialStatus: "available",
      },
      actor: "labeler",
    });

    expect(response.processedCount).toBe(3);
    expect(new Set(response.entities.map((entity) => entity.partType.id))).toEqual(new Set([existing.partType.id]));
    expect(service.searchPartTypes("Shared Fixture")).toHaveLength(1);
  });

  it("bulk moves mixed assigned targets with one shared location payload", () => {
    const { service } = makeService();

    service.registerQrBatch({
      actor: "lab-admin",
      prefix: "QR",
      startNumber: 6760,
      count: 2,
    });

    const instance = service.assignQr({
      qrCode: "QR-6760",
      actor: "labeler",
      entityKind: "instance",
      location: "Shelf A",
      notes: null,
      partType: {
        kind: "new",
        canonicalName: "Bulk Move Instance",
        category: "Fixtures",
        aliases: [],
        notes: null,
        imageUrl: null,
        countable: true,
      },
      initialStatus: "available",
    });

    const bulk = service.assignQr({
      qrCode: "QR-6761",
      actor: "labeler",
      entityKind: "bulk",
      location: "Shelf A",
      notes: null,
      partType: {
        kind: "new",
        canonicalName: "Bulk Move Stock",
        category: "Consumables",
        aliases: [],
        notes: null,
        imageUrl: null,
        countable: false,
      },
      initialQuantity: 2,
      minimumQuantity: null,
    });

    const moved = service.bulkMoveEntities({
      targets: [
        { targetType: "instance", targetId: instance.id, qrCode: "QR-6760" },
        { targetType: "bulk", targetId: bulk.id, qrCode: "QR-6761" },
      ],
      location: "Shelf B",
      notes: "Batch relocation",
      actor: "labeler",
    });

    expect(moved.processedCount).toBe(2);
    expect(moved.events.every((event) => event.location === "Shelf B")).toBe(true);
  });

  it("rolls back an entire bulk delete when any target is no longer reverse-ingest eligible", async () => {
    const { service } = makeService();

    service.registerQrBatch({
      actor: "lab-admin",
      prefix: "QR",
      startNumber: 6770,
      count: 2,
    });

    const fresh = service.assignQr({
      qrCode: "QR-6770",
      actor: "labeler",
      entityKind: "bulk",
      location: "Shelf A",
      notes: null,
      partType: {
        kind: "new",
        canonicalName: "Fresh Ingest",
        category: "Materials",
        aliases: [],
        notes: null,
        imageUrl: null,
        countable: false,
      },
      initialQuantity: 2,
      minimumQuantity: null,
    });

    const touched = service.assignQr({
      qrCode: "QR-6771",
      actor: "labeler",
      entityKind: "bulk",
      location: "Shelf A",
      notes: null,
      partType: {
        kind: "new",
        canonicalName: "Touched Ingest",
        category: "Materials",
        aliases: [],
        notes: null,
        imageUrl: null,
        countable: false,
      },
      initialQuantity: 2,
      minimumQuantity: null,
    });
    service.recordEvent({
      targetType: "bulk",
      targetId: touched.id,
      event: "moved",
      location: "Shelf B",
      notes: null,
      actor: "labeler",
    });

    expect(() =>
      service.bulkReverseIngest({
        targets: [
          { assignedKind: "bulk", assignedId: fresh.id, qrCode: "QR-6770" },
          { assignedKind: "bulk", assignedId: touched.id, qrCode: "QR-6771" },
        ],
        reason: "Undo bad batch",
        actor: "admin",
      }),
    ).toThrowError(ConflictError);

    await expect(service.scanCode("QR-6770")).resolves.toMatchObject({
      mode: "interact",
      entity: {
        id: fresh.id,
      },
    });
  });

  it("rejects ambiguous normalized barcode matches instead of choosing arbitrarily", async () => {
    const { db, service } = makeService();
    const now = new Date().toISOString();

    db.prepare(`INSERT INTO qr_batches (id, prefix, start_number, end_number, actor, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run("external", "EXT", 0, 0, "system", now);
    db.prepare(`INSERT INTO qrcodes (code, batch_id, status, assigned_kind, assigned_id, created_at, updated_at) VALUES (?, ?, ?, NULL, NULL, ?, ?)`)
      .run("AB-12", "external", "printed", now, now);
    db.prepare(`INSERT INTO qrcodes (code, batch_id, status, assigned_kind, assigned_id, created_at, updated_at) VALUES (?, ?, ?, NULL, NULL, ?, ?)`)
      .run("AB12", "external", "printed", now, now);

    await expect(service.scanCode("ab 12")).rejects.toThrowError(ConflictError);
  });

  it("rejects piece-counted bulk pools when the part type unit is fractional", () => {
    const { db, service } = makeService();
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO part_types (
        id, canonical_name, category, category_path_json, aliases_json, image_url, notes,
        countable, unit_symbol, unit_name, unit_is_integer, needs_review,
        partdb_part_id, partdb_category_id, partdb_unit_id, partdb_sync_status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "part-fractional-piece-pool",
      "Fractional Piece Pool",
      "Materials",
      JSON.stringify(["Materials"]),
      "[]",
      null,
      null,
      1,
      "kg",
      "Kilograms",
      0,
      0,
      null,
      null,
      null,
      "never",
      now,
      now,
    );

    service.registerQrBatch({
      actor: "lab-admin",
      prefix: "QR",
      startNumber: 6200,
      count: 1,
    });

    expect(() =>
      service.assignQr({
        qrCode: "QR-6200",
        actor: "labeler",
        entityKind: "bulk",
        location: "Resin shelf",
        notes: null,
        partType: {
          kind: "existing",
          existingPartTypeId: "part-fractional-piece-pool",
        },
        initialQuantity: 2,
        minimumQuantity: 1,
      }),
    ).toThrowError(ConflictError);
  });

  it("voids a QR code and disposes its assigned entity", () => {
    const { service } = makeService();

    service.registerQrBatch({ actor: "admin", prefix: "V", startNumber: 1, count: 3 });

    // Void a printed (unassigned) QR
    const voidedPrinted = service.voidQrCode("V-1", "admin");
    expect(voidedPrinted.status).toBe("voided");

    // Void again is a no-op (returns same voided QR)
    const voidedAgain = service.voidQrCode("V-1", "admin");
    expect(voidedAgain.status).toBe("voided");

    // Void an assigned instance QR
    const instance = service.assignQr({
      qrCode: "V-2",
      actor: "labeler",
      entityKind: "instance",
      location: "Shelf",
      notes: null,
      partType: { kind: "new", canonicalName: "Void Test", category: "Misc", aliases: [], notes: null, imageUrl: null, countable: true },
      initialStatus: "available",
    });
    const voidedAssigned = service.voidQrCode("V-2", "admin");
    expect(voidedAssigned.status).toBe("voided");
    // The instance should be consumed
    const dashboard = service.getDashboardSummary();
    const events = dashboard.recentEvents.filter((e) => e.targetId === instance.id && e.event === "disposed");
    expect(events.length).toBeGreaterThan(0);

    // Void a missing QR
    expect(() => service.voidQrCode("V-MISSING", "admin")).toThrowError(NotFoundError);

    // Void an assigned bulk QR
    const bulk = service.assignQr({
      qrCode: "V-3",
      actor: "labeler",
      entityKind: "bulk",
      location: "Bin",
      notes: null,
      partType: { kind: "new", canonicalName: "Bulk Void", category: "Misc", aliases: [], notes: null, imageUrl: null, countable: false },
      initialQuantity: 10,
      minimumQuantity: null,
    });
    const voidedBulk = service.voidQrCode("V-3", "admin");
    expect(voidedBulk.status).toBe("voided");
    const bulkEvents = service.getDashboardSummary().recentEvents.filter((e) => e.targetId === bulk.id && e.event === "consumed");
    expect(bulkEvents.length).toBeGreaterThan(0);
  });

  it("approves a provisional part type", () => {
    const { service } = makeService();

    service.registerQrBatch({ actor: "admin", prefix: "A", startNumber: 1, count: 1 });
    const entity = service.assignQr({
      qrCode: "A-1",
      actor: "labeler",
      entityKind: "instance",
      location: "Shelf",
      notes: null,
      partType: { kind: "new", canonicalName: "Approve Test", category: "Misc", aliases: [], notes: null, imageUrl: null, countable: true },
      initialStatus: "available",
    });

    expect(entity.partType.needsReview).toBe(true);
    const approved = service.approvePartType(entity.partType.id);
    expect(approved.needsReview).toBe(false);
    expect(approved.id).toBe(entity.partType.id);

    // Approve missing part type
    expect(() => service.approvePartType("missing-id")).toThrowError(NotFoundError);

    // Approve read-back invariant: spy on findPartType to return null after update
    const findSpy = vi.spyOn(service as never, "findPartType" as never);
    findSpy.mockReturnValueOnce(entity.partType).mockReturnValueOnce(null);
    expect(() => service.approvePartType(entity.partType.id)).toThrowError(InvariantError);
    findSpy.mockRestore();
  });

  it("rejects illegal bulk transitions", () => {
    const { service } = makeService();

    service.registerQrBatch({ actor: "admin", prefix: "BLK", startNumber: 1, count: 1 });
    const bulk = service.assignQr({
      qrCode: "BLK-1",
      actor: "labeler",
      entityKind: "bulk",
      location: "Bin",
      notes: null,
      partType: { kind: "new", canonicalName: "Empty Bulk", category: "Misc", aliases: [], notes: null, imageUrl: null, countable: false },
      initialQuantity: 10,
      minimumQuantity: null,
    });

    // Transition to empty
    service.recordEvent({ targetType: "bulk", targetId: bulk.id, actor: "admin", event: "consumed", location: "Bin", notes: null, quantityDelta: 10 });

    // consumed is not valid on empty bulk stock
    expect(() =>
      service.recordEvent({ targetType: "bulk", targetId: bulk.id, actor: "admin", event: "consumed", location: "Bin", notes: null, quantityDelta: 1 }),
    ).toThrowError(ConflictError);
  });

  it("enforces integer quantities for integer-backed bulk units", () => {
    const { service } = makeService();

    service.registerQrBatch({ actor: "admin", prefix: "UNIT", startNumber: 1, count: 2 });

    expect(() =>
      service.assignQr({
        qrCode: "UNIT-1",
        actor: "labeler",
        entityKind: "bulk",
        location: "Drawer",
        notes: null,
        partType: {
          kind: "new",
          canonicalName: "Discrete Screw Bin",
          category: "Hardware",
          aliases: [],
          notes: null,
          imageUrl: null,
          countable: false,
          unit: {
            symbol: "pcs",
            name: "Pieces",
            isInteger: true,
          },
        },
        initialQuantity: 1.5,
        minimumQuantity: null,
      }),
    ).toThrowError(InvariantError);

    const grams = service.assignQr({
      qrCode: "UNIT-2",
      actor: "labeler",
      entityKind: "bulk",
      location: "Drawer",
      notes: null,
      partType: {
        kind: "new",
        canonicalName: "Solder Paste",
        category: "Consumables",
        aliases: [],
        notes: null,
        imageUrl: null,
        countable: false,
        unit: {
          symbol: "g",
          name: "Grams",
          isInteger: false,
        },
      },
      initialQuantity: 1.5,
      minimumQuantity: 0.5,
    });

    expect(grams.state).toBe("1.5 g on hand");
  });

  it("treats malformed persisted records as invariant failures", async () => {
    const { db, service } = makeService();

    db.prepare(
      `
      INSERT INTO part_types
        (id, canonical_name, category, aliases_json, image_url, notes, countable, needs_review, partdb_part_id, created_at, updated_at)
      VALUES
        ('broken', 'Broken Row', 'Misc', 'not-json', NULL, NULL, 1, 1, NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
      `,
    ).run();

    const results = service.searchPartTypes("");
    const broken = results.find((pt) => pt.id === "broken");
    expect(broken).toBeDefined();
    expect(broken!.aliases).toEqual([]);
    expect(() => (service as any).latestEvent("instance", "missing")).toThrowError(
      InvariantError,
    );

    db.prepare(
      `
      INSERT INTO part_types
        (id, canonical_name, category, aliases_json, image_url, notes, countable, needs_review, partdb_part_id, created_at, updated_at)
      VALUES
        ('bad-shape', 'Bad Shape', 'Misc', '[]', NULL, NULL, 1, 1, NULL, 'not-a-date', '2026-01-01T00:00:00.000Z')
      `,
    ).run();
    expect(() => service.searchPartTypes("Bad Shape")).toThrowError(InvariantError);
    expect(inventoryServiceTestInternals.parseAliases(null)).toEqual([]);
    expect(() =>
      (service as { withTransaction: (work: () => void) => void }).withTransaction(() => {
        throw new Error("rollback");
      }),
    ).toThrowError("rollback");
    expect(
      (service as {
        getEntityByQr: (qrCode: {
          assignedId: string | null;
          assignedKind: "instance" | "bulk" | null;
        }) => unknown;
      }).getEntityByQr({
        assignedId: "missing-instance",
        assignedKind: "instance",
      }),
    ).toBeNull();
    expect(
      (service as {
        getEntityByQr: (qrCode: {
          assignedId: string | null;
          assignedKind: "instance" | "bulk" | null;
        }) => unknown;
      }).getEntityByQr({
        assignedId: "missing-bulk",
        assignedKind: "bulk",
      }),
    ).toBeNull();
    expect(
      (service as {
        getEntityByQr: (qrCode: {
          assignedId: string | null;
          assignedKind: "instance" | "bulk" | null;
        }) => unknown;
      }).getEntityByQr({
        assignedId: null,
        assignedKind: null,
      }),
    ).toBeNull();
    expect(() =>
      (service as {
        resolvePartType: (draft: { kind: "existing"; existingPartTypeId: string }) => unknown;
      }).resolvePartType({
        kind: "existing",
        existingPartTypeId: "missing-part",
      }),
    ).toThrowError(NotFoundError);

    service.registerQrBatch({
      actor: "lab-admin",
      prefix: "QR",
      startNumber: 4001,
      count: 2,
    });
    const mergeSource = service.assignQr({
      qrCode: "QR-4001",
      actor: "labeler",
      entityKind: "instance",
      location: "Shelf",
      notes: null,
      partType: {
        kind: "new",
        canonicalName: "Source",
        category: "Misc",
        aliases: [],
        notes: null,
        imageUrl: null,
        countable: true,
      },
      initialStatus: "available",
    });
    const mergeDestination = service.assignQr({
      qrCode: "QR-4002",
      actor: "labeler",
      entityKind: "instance",
      location: "Shelf",
      notes: null,
      partType: {
        kind: "new",
        canonicalName: "Destination",
        category: "Misc",
        aliases: [],
        notes: null,
        imageUrl: null,
        countable: true,
      },
      initialStatus: "available",
    });
    const findPartTypeSpy = vi.spyOn(service as never, "findPartType" as never);
    findPartTypeSpy
      .mockReturnValueOnce(mergeSource.partType)
      .mockReturnValueOnce(mergeDestination.partType)
      .mockReturnValueOnce(null);

    expect(() =>
      service.mergePartTypes({
        sourcePartTypeId: mergeSource.partType.id,
        destinationPartTypeId: mergeDestination.partType.id,
      }),
    ).toThrowError(InvariantError);

    service.registerQrBatch({
      actor: "lab-admin",
      prefix: "QR",
      startNumber: 5001,
      count: 1,
    });
    const entityLookupSpy = vi.spyOn(service as never, "getEntityByQr" as never);
    entityLookupSpy.mockReturnValueOnce(null);
    expect(() =>
      service.assignQr({
        qrCode: "QR-5001",
        actor: "labeler",
        entityKind: "instance",
        location: "Shelf",
        notes: null,
        partType: {
          kind: "new",
          canonicalName: "Broken Summary",
          category: "Misc",
          aliases: [],
          notes: null,
          imageUrl: null,
          countable: true,
        },
        initialStatus: "available",
      }),
    ).toThrowError(InvariantError);
    service.registerQrBatch({
      actor: "lab-admin",
      prefix: "QR",
      startNumber: 6001,
      count: 1,
    });
    const dangling = service.assignQr({
      qrCode: "QR-6001",
      actor: "labeler",
      entityKind: "instance",
      location: "Shelf",
      notes: null,
      partType: {
        kind: "new",
        canonicalName: "Dangling Instance",
        category: "Misc",
        aliases: [],
        notes: null,
        imageUrl: null,
        countable: true,
      },
      initialStatus: "available",
    });
    db.prepare(`DELETE FROM physical_instances WHERE id = ?`).run(dangling.id);
    await expect(service.scanCode("QR-6001")).rejects.toThrowError(InvariantError);
  });

  describe("borrow records", () => {
    function assignBorrowInstance(service: InventoryService, qrCode: string) {
      service.registerQrBatch({ actor: "admin", prefix: qrCode.split("-")[0]!, startNumber: Number(qrCode.split("-")[1]!), count: 1 });
      return service.assignQr({
        qrCode,
        actor: "labeler",
        entityKind: "instance",
        location: "Shelf A",
        notes: null,
        partType: {
          kind: "new",
          canonicalName: `Borrow ${qrCode}`,
          category: "Fixtures",
          aliases: [],
          notes: null,
          imageUrl: null,
          countable: true,
        },
        initialStatus: "available",
      });
    }

    function listBorrows(db: ReturnType<typeof createDatabase>, instanceId: string) {
      return db
        .prepare(
          `SELECT id, instance_id AS instanceId, borrower, borrowed_at AS borrowedAt, due_at AS dueAt, returned_at AS returnedAt, close_reason AS closeReason, actor FROM borrow_records WHERE instance_id = ? ORDER BY created_at, id`,
        )
        .all(instanceId) as Array<{
        id: string;
        instanceId: string;
        borrower: string;
        borrowedAt: string;
        dueAt: string | null;
        returnedAt: string | null;
        closeReason: string | null;
        actor: string;
      }>;
    }

    it("opens a borrow record when an instance is checked out", () => {
      const { db, service } = makeService();
      const instance = assignBorrowInstance(service, "BR-7100");

      service.recordEvent({
        targetType: "instance",
        targetId: instance.id,
        actor: "labeler",
        event: "checked_out",
        location: null,
        notes: null,
        assignee: "maker-jo",
      });

      const rows = listBorrows(db, instance.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        borrower: "maker-jo",
        returnedAt: null,
        closeReason: null,
        actor: "labeler",
      });
      expect(service.getOpenBorrow(instance.id)).toMatchObject({ borrower: "maker-jo", isOverdue: false });
    });

    it("closes the previous borrow with close_reason='re_checkout' on re-checkout", () => {
      const { db, service } = makeService();
      const instance = assignBorrowInstance(service, "BR-7101");

      service.recordEvent({
        targetType: "instance",
        targetId: instance.id,
        actor: "labeler",
        event: "checked_out",
        location: null,
        notes: null,
        assignee: "alice",
      });
      service.recordEvent({
        targetType: "instance",
        targetId: instance.id,
        actor: "labeler",
        event: "checked_out",
        location: null,
        notes: null,
        assignee: "bob",
      });

      const rows = listBorrows(db, instance.id);
      expect(rows).toHaveLength(2);
      const closed = rows.find((row) => row.returnedAt !== null);
      const open = rows.find((row) => row.returnedAt === null);
      expect(closed).toMatchObject({ borrower: "alice", closeReason: "re_checkout" });
      expect(open).toMatchObject({ borrower: "bob", closeReason: null });
    });

    it("closes the open borrow with close_reason='returned' on return", () => {
      const { db, service } = makeService();
      const instance = assignBorrowInstance(service, "BR-7102");

      service.recordEvent({
        targetType: "instance",
        targetId: instance.id,
        actor: "labeler",
        event: "checked_out",
        location: null,
        notes: null,
        assignee: "alice",
      });
      service.recordEvent({
        targetType: "instance",
        targetId: instance.id,
        actor: "labeler",
        event: "returned",
        location: null,
        notes: null,
        assignee: null,
      });

      const [row] = listBorrows(db, instance.id);
      expect(row).toMatchObject({ borrower: "alice", closeReason: "returned" });
      expect(row!.returnedAt).not.toBeNull();
      expect(service.getOpenBorrow(instance.id)).toBeNull();
    });

    it("closes the open borrow with close_reason='void_cascade' when the QR is voided", () => {
      const { db, service } = makeService();
      const instance = assignBorrowInstance(service, "BR-7103");

      service.recordEvent({
        targetType: "instance",
        targetId: instance.id,
        actor: "labeler",
        event: "checked_out",
        location: null,
        notes: null,
        assignee: "alice",
      });
      service.voidQrCode("BR-7103", "admin");

      const [row] = listBorrows(db, instance.id);
      expect(row).toMatchObject({ borrower: "alice", closeReason: "void_cascade" });
      expect(row!.returnedAt).not.toBeNull();
    });

    it("enforces one-open-borrow-per-instance via the unique partial index", () => {
      const { db, service } = makeService();
      const instance = assignBorrowInstance(service, "BR-7104");

      service.recordEvent({
        targetType: "instance",
        targetId: instance.id,
        actor: "labeler",
        event: "checked_out",
        location: null,
        notes: null,
        assignee: "alice",
      });

      expect(() =>
        db
          .prepare(
            `INSERT INTO borrow_records (id, instance_id, borrower, borrowed_at, due_at, returned_at, close_reason, notes, actor, created_at) VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?)`,
          )
          .run("dup-id", instance.id, "bob", new Date().toISOString(), "labeler", new Date().toISOString()),
      ).toThrowError(/UNIQUE|constraint/i);
    });

    it("backfills entities for every physical instance and bulk stock with matching ids", () => {
      const { db, service } = makeService();
      const instance = assignBorrowInstance(service, "BR-7190");
      service.registerQrBatch({ actor: "admin", prefix: "BR", startNumber: 7191, count: 1 });
      const bulk = service.assignQr({
        qrCode: "BR-7191",
        actor: "labeler",
        entityKind: "bulk",
        location: "Shelf C",
        notes: null,
        partType: { kind: "existing", existingPartTypeId: instance.partType.id },
        initialQuantity: 10,
        minimumQuantity: null,
      });

      // Fresh rows inserted through the service bypass the migration SQL, so we
      // backfill manually here to exercise the exact migration path.
      db.prepare(
        `INSERT OR IGNORE INTO entities (id, qr_code, part_type_id, location, quantity, minimum_quantity, status, assignee, version, partdb_lot_id, partdb_sync_status, created_at, updated_at, source_kind)
         SELECT id, qr_code, part_type_id, location, 1, NULL, status, assignee, version, partdb_lot_id, partdb_sync_status, created_at, updated_at, 'instance'
         FROM physical_instances`,
      ).run();
      db.prepare(
        `INSERT OR IGNORE INTO entities (id, qr_code, part_type_id, location, quantity, minimum_quantity, status, assignee, version, partdb_lot_id, partdb_sync_status, created_at, updated_at, source_kind)
         SELECT id, qr_code, part_type_id, location, quantity, minimum_quantity, 'available', NULL, version, partdb_lot_id, partdb_sync_status, created_at, updated_at, 'bulk'
         FROM bulk_stocks`,
      ).run();

      const entities = service.listEntitiesForPartType(instance.partType.id);
      expect(entities).toHaveLength(2);
      const byKind = new Map(entities.map((e) => [e.sourceKind, e]));
      expect(byKind.get("instance")!).toMatchObject({ id: instance.id, qrCode: "BR-7190", quantity: 1 });
      expect(byKind.get("bulk")!).toMatchObject({ id: bulk.id, qrCode: "BR-7191", sourceKind: "bulk" });
    });

    it("reverses only one of two sibling instances, leaving the other intact and printing the QR", async () => {
      const { service } = makeService();
      const first = assignBorrowInstance(service, "BR-7180");
      service.registerQrBatch({ actor: "lab-admin", prefix: "BR", startNumber: 7181, count: 1 });
      const second = service.assignQr({
        qrCode: "BR-7181",
        actor: "labeler",
        entityKind: "instance",
        location: "Shelf A",
        notes: null,
        partType: { kind: "existing", existingPartTypeId: first.partType.id },
        initialStatus: "available",
      });

      const itemsBefore = service.getPartTypeItems(first.partType.id);
      expect(itemsBefore.instances).toHaveLength(2);
      expect(itemsBefore.instances.every((row) => row.canReverseIngest)).toBe(true);

      service.bulkReverseIngest({
        targets: [{ assignedKind: "instance", assignedId: second.id, qrCode: "BR-7181" }],
        reason: "Mislabeled on intake",
        actor: "lab-admin",
      });

      const itemsAfter = service.getPartTypeItems(first.partType.id);
      expect(itemsAfter.instances).toHaveLength(1);
      expect(itemsAfter.instances[0]!.id).toBe(first.id);

      const rescan = await service.scanCode("BR-7181", "lab-admin");
      expect(rescan.mode).toBe("label");
    });

    it("listCorrectionEvents returns events ordered newest-first with a bounded limit", () => {
      const { service } = makeService();
      const instance = assignBorrowInstance(service, "BR-7170");
      service.reverseIngestAssignment({
        qrCode: "BR-7170",
        assignedKind: "instance",
        assignedId: instance.id,
        actor: "labeler",
        reason: "Fat-finger",
      });

      const all = service.listCorrectionEvents();
      expect(all).toHaveLength(1);
      expect(all[0]).toMatchObject({
        correctionKind: "ingest_reversed",
        reason: "Fat-finger",
        targetType: "instance",
      });

      const bounded = service.listCorrectionEvents(0);
      expect(bounded).toHaveLength(1);
      const big = service.listCorrectionEvents(999);
      expect(big.length).toBeLessThanOrEqual(200);
    });

    it("exposes canReverseIngest as true for a fresh assignment and false after any event", async () => {
      const { service } = makeService();
      const instance = assignBorrowInstance(service, "BR-7150");

      const fresh = await service.scanCode("BR-7150", "lab-admin");
      if (fresh.mode !== "interact") throw new Error("expected interact");
      expect(fresh.canReverseIngest).toBe(true);
      expect(fresh.canEditSharedType).toBe(true);

      service.recordEvent({
        targetType: "instance",
        targetId: instance.id,
        actor: "lab-admin",
        event: "checked_out",
        location: null,
        notes: null,
        assignee: "alice",
      });

      const after = await service.scanCode("BR-7150", "lab-admin");
      if (after.mode !== "interact") throw new Error("expected interact");
      expect(after.canReverseIngest).toBe(false);
      expect(after.canEditSharedType).toBe(true);
    });

    it("marks a record as overdue when due_at is past", () => {
      const { db, service } = makeService();
      const instance = assignBorrowInstance(service, "BR-7105");

      service.recordEvent({
        targetType: "instance",
        targetId: instance.id,
        actor: "labeler",
        event: "checked_out",
        location: null,
        notes: null,
        assignee: "alice",
      });

      const pastDue = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      db.prepare(`UPDATE borrow_records SET due_at = ? WHERE instance_id = ? AND returned_at IS NULL`).run(pastDue, instance.id);

      expect(service.getOpenBorrow(instance.id)).toMatchObject({ isOverdue: true });
    });
  });
});
