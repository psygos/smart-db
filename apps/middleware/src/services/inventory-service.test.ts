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
      initialQuantity: 0,
      minimumQuantity: null,
    });

    expect(bulkSummary.targetType).toBe("bulk");
    expect(fallbackBulk.state).toBe("0 pcs on hand");
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

    expect(() =>
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
      }),
    ).toThrowError(ConflictError);

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
      mode: "label",
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
});
