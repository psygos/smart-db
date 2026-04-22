import { describe, expect, it } from "vitest";
import {
  applicationErrorResponseSchema,
  assignQrRequestSchema,
  bulkAssignQrsRequestSchema,
  bulkAssignQrsResponseSchema,
  bulkMoveEntitiesRequestSchema,
  bulkMoveEntitiesResponseSchema,
  bulkReverseIngestRequestSchema,
  bulkReverseIngestResponseSchema,
  categoryLeafFromPath,
  categoryPathSchema,
  configEnvironmentSchema,
  correctionEventSchema,
  correctionHistoryQuerySchema,
  describeCategoryPathParseError,
  defaultMeasurementUnit,
  editPartTypeDefinitionRequestSchema,
  editPartTypeDefinitionResponseSchema,
  getMeasurementUnitBySymbol,
  latestQrBatchResponseSchema,
  loginRequestSchema,
  loginResponseSchema,
  logoutResponseSchema,
  measurementUnitSchema,
  mergePartTypesRequestSchema,
  parseCategoryPathInput,
  partTypeSchema,
  qrCodeSchema,
  reassignEntityPartTypeRequestSchema,
  reassignEntityPartTypeResponseSchema,
  recordEventRequestSchema,
  registerQrBatchRequestSchema,
  reverseIngestAssignmentRequestSchema,
  reverseIngestAssignmentResponseSchema,
  scanResponseSchema,
} from "./index";

describe("schemas", () => {
  it("applies defaults to QR batch requests and environment config", () => {
    expect(
      registerQrBatchRequestSchema.parse({
        startNumber: 1001,
        count: 500,
      }),
    ).toEqual({
      prefix: "QR",
      startNumber: 1001,
      count: 500,
    });

    expect(configEnvironmentSchema.parse({})).toEqual({
      PORT: 4000,
      FRONTEND_ORIGIN: "http://localhost:5173",
      PUBLIC_BASE_URL: "http://localhost:4000",
      PARTDB_BASE_URL: null,
      PARTDB_PUBLIC_BASE_URL: null,
      PARTDB_API_TOKEN: null,
      PARTDB_SYNC_ENABLED: false,
      SESSION_COOKIE_SECRET: null,
      ZITADEL_ISSUER: null,
      ZITADEL_CLIENT_ID: null,
      ZITADEL_CLIENT_SECRET: null,
      ZITADEL_ROLE_CLAIM: null,
    });
  });

  it("parses category paths and measurement units with bounded structure", () => {
    expect(categoryPathSchema.parse(["Electronics", "Resistors", "SMD 0603"])).toEqual([
      "Electronics",
      "Resistors",
      "SMD 0603",
    ]);

    expect(
      measurementUnitSchema.parse({
        symbol: "pcs",
        name: "Pieces",
        isInteger: true,
      }),
    ).toEqual({
      symbol: "pcs",
      name: "Pieces",
      isInteger: true,
    });

    expect(() => categoryPathSchema.parse([])).toThrow();
    expect(() => categoryPathSchema.parse(new Array(7).fill("too-deep"))).toThrow();
    expect(parseCategoryPathInput("Electronics/Resistors/SMD 0603")).toEqual({
      ok: true,
      value: ["Electronics", "Resistors", "SMD 0603"],
    });
    expect(parseCategoryPathInput(" / / ")).toEqual({
      ok: false,
      error: { kind: "empty" },
    });
    expect(describeCategoryPathParseError({ kind: "too_deep", maxDepth: 6 })).toBe(
      "Category paths can have at most 6 levels.",
    );
    expect(categoryLeafFromPath(["Electronics", "Resistors", "SMD 0603"])).toBe("SMD 0603");
    expect(getMeasurementUnitBySymbol("g")).toEqual({
      symbol: "g",
      name: "Grams",
      isInteger: false,
    });
    expect(defaultMeasurementUnit).toEqual({
      symbol: "pcs",
      name: "Pieces",
      isInteger: true,
    });
  });

  it("rejects out-of-bounds batch count and invalid prefix characters", () => {
    expect(() =>
      registerQrBatchRequestSchema.parse({
        startNumber: 0,
        count: 501,
      }),
    ).toThrow();

    expect(() =>
      registerQrBatchRequestSchema.parse({
        prefix: "QR!",
        startNumber: 0,
        count: 1,
      }),
    ).toThrow();

    expect(
      registerQrBatchRequestSchema.parse({
        prefix: "QR_2-A",
        startNumber: 0,
        count: 500,
      }),
    ).toEqual({
      prefix: "QR_2-A",
      startNumber: 0,
      count: 500,
    });
  });

  it("parses assignment commands as discriminated unions", () => {
    expect(
      assignQrRequestSchema.parse({
        qrCode: "QR-1001",
        entityKind: "instance",
        location: "Shelf A",
        partType: {
          kind: "existing",
          existingPartTypeId: "part-1",
        },
      }),
    ).toEqual({
      qrCode: "QR-1001",
      entityKind: "instance",
      location: "Shelf A",
      notes: null,
      partType: {
        kind: "existing",
        existingPartTypeId: "part-1",
      },
      initialStatus: "available",
    });

    expect(
      assignQrRequestSchema.parse({
        qrCode: "QR-1002",
        entityKind: "bulk",
        location: "Bin 4",
        partType: {
          kind: "new",
          canonicalName: "M3 Screw",
          category: "Fasteners",
          countable: false,
        },
        initialQuantity: 1,
      }),
    ).toEqual({
      qrCode: "QR-1002",
      entityKind: "bulk",
      location: "Bin 4",
      notes: null,
      partType: {
        kind: "new",
        canonicalName: "M3 Screw",
        category: "Fasteners",
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
      initialQuantity: 1,
      minimumQuantity: null,
    });

    expect(() =>
      assignQrRequestSchema.parse({
        qrCode: "QR-1003",
        entityKind: "instance",
        location: "Shelf A",
        partType: {
          kind: "new",
          canonicalName: "Bad Category",
          category: "Electronics/Bad|Segment",
          countable: true,
        },
      }),
    ).toThrow(/unsupported characters/i);

    expect(() =>
      assignQrRequestSchema.parse({
        qrCode: "QR-1003A",
        entityKind: "bulk",
        location: "Bin 4",
        partType: {
          kind: "new",
          canonicalName: "Zero Bulk",
          category: "Fasteners",
          countable: false,
        },
        initialQuantity: 0,
      }),
    ).toThrow();

    expect(() =>
      assignQrRequestSchema.parse({
        qrCode: "QR-1004",
        entityKind: "bulk",
        location: "Bin 4",
        partType: {
          kind: "new",
          canonicalName: "Bad Unit",
          category: "Fasteners",
          countable: true,
          unit: {
            symbol: "g",
            name: "Grams",
            isInteger: false,
          },
        },
        initialQuantity: 1,
      }),
    ).toThrow(/integer unit/i);
  });

  it("parses lifecycle events, merge requests, responses, and error envelopes", () => {
    expect(
      recordEventRequestSchema.parse({
        targetType: "instance",
        targetId: "instance-1",
        event: "checked_out",
      }),
    ).toEqual({
      targetType: "instance",
      targetId: "instance-1",
      event: "checked_out",
      notes: null,
      location: null,
      assignee: null,
    });

    expect(
      recordEventRequestSchema.parse({
        targetType: "bulk",
        targetId: "bulk-1",
        event: "consumed",
        quantityDelta: 2,
      }),
    ).toEqual({
      targetType: "bulk",
      targetId: "bulk-1",
      event: "consumed",
      notes: null,
      location: null,
      quantityDelta: 2,
    });

    expect(
      recordEventRequestSchema.parse({
        targetType: "bulk",
        targetId: "bulk-1",
        event: "stocktaken",
        quantity: 11,
      }),
    ).toEqual({
      targetType: "bulk",
      targetId: "bulk-1",
      event: "stocktaken",
      notes: null,
      location: null,
      quantity: 11,
    });

    expect(() =>
      recordEventRequestSchema.parse({
        targetType: "instance",
        targetId: "instance-1",
        event: "moved",
      }),
    ).toThrow();

    expect(() =>
      recordEventRequestSchema.parse({
        targetType: "bulk",
        targetId: "bulk-1",
        event: "consumed",
      }),
    ).toThrow();

    expect(() =>
      recordEventRequestSchema.parse({
        targetType: "bulk",
        targetId: "bulk-1",
        event: "adjusted",
        quantityDelta: -3,
        notes: null,
      }),
    ).toThrow();

    expect(
      mergePartTypesRequestSchema.parse({
        sourcePartTypeId: "source",
        destinationPartTypeId: "destination",
      }),
    ).toEqual({
      sourcePartTypeId: "source",
      destinationPartTypeId: "destination",
      aliasLabel: null,
    });

    expect(() =>
      mergePartTypesRequestSchema.parse({
        sourcePartTypeId: "same",
        destinationPartTypeId: "same",
      }),
    ).toThrow();

    expect(
      reassignEntityPartTypeRequestSchema.parse({
        targetType: "instance",
        targetId: "instance-1",
        fromPartTypeId: "part-a",
        toPartTypeId: "part-b",
        reason: "Wrong type",
      }),
    ).toEqual({
      targetType: "instance",
      targetId: "instance-1",
      fromPartTypeId: "part-a",
      toPartTypeId: "part-b",
      reason: "Wrong type",
    });

    expect(() =>
      reassignEntityPartTypeRequestSchema.parse({
        targetType: "instance",
        targetId: "instance-1",
        fromPartTypeId: "part-a",
        toPartTypeId: "part-a",
        reason: "Wrong type",
      }),
    ).toThrow();

    expect(
      editPartTypeDefinitionRequestSchema.parse({
        partTypeId: "part-a",
        expectedUpdatedAt: "2026-01-01T00:00:00.000Z",
        canonicalName: "Black PLA+",
        category: "Materials / 3D Printing",
        reason: "Fix shared type",
      }),
    ).toEqual({
      partTypeId: "part-a",
      expectedUpdatedAt: "2026-01-01T00:00:00.000Z",
      canonicalName: "Black PLA+",
      category: "Materials / 3D Printing",
      reason: "Fix shared type",
    });

    expect(
      reverseIngestAssignmentRequestSchema.parse({
        qrCode: "QR-1001",
        assignedKind: "bulk",
        assignedId: "bulk-1",
        reason: "Wrong ingest",
      }),
    ).toEqual({
      qrCode: "QR-1001",
      assignedKind: "bulk",
      assignedId: "bulk-1",
      reason: "Wrong ingest",
    });

    expect(
      correctionHistoryQuerySchema.parse({
        targetType: "part_type",
        targetId: "part-a",
      }),
    ).toEqual({
      targetType: "part_type",
      targetId: "part-a",
    });

    const correctionEvent = correctionEventSchema.parse({
      id: "corr-1",
      targetType: "instance",
      targetId: "instance-1",
      correctionKind: "entity_part_type_reassigned",
      actor: "admin",
      reason: "Wrong type",
      before: { partTypeId: "part-a" },
      after: { partTypeId: "part-b" },
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    expect(
      reassignEntityPartTypeResponseSchema.parse({
        entity: {
          id: "instance-1",
          targetType: "instance",
          qrCode: "QR-1001",
          partType: {
            id: "part-b",
            canonicalName: "Correct Type",
            category: "Misc",
            categoryPath: ["Misc"],
            aliases: [],
            imageUrl: null,
            notes: null,
            countable: true,
            unit: {
              symbol: "pcs",
              name: "Pieces",
              isInteger: true,
            },
            needsReview: false,
            partDbPartId: null,
            partDbCategoryId: null,
            partDbUnitId: null,
            partDbSyncStatus: "never",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
          location: "Shelf A",
          state: "available",
          assignee: null,
          partDbSyncStatus: "never",
          quantity: null,
          minimumQuantity: null,
        },
        correctionEvent,
      }),
    ).toBeTruthy();

    expect(
      editPartTypeDefinitionResponseSchema.parse({
        partType: partTypeSchema.parse({
          id: "part-a",
          canonicalName: "Black PLA+",
          category: "3D Printing",
          categoryPath: ["Materials", "3D Printing"],
          aliases: [],
          imageUrl: null,
          notes: null,
          countable: false,
          unit: {
            symbol: "kg",
            name: "Kilograms",
            isInteger: false,
          },
          needsReview: false,
          partDbPartId: null,
          partDbCategoryId: null,
          partDbUnitId: null,
          partDbSyncStatus: "never",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        }),
        correctionEvent: {
          ...correctionEvent,
          targetType: "part_type",
          targetId: "part-a",
          correctionKind: "part_type_definition_edited",
        },
      }),
    ).toBeTruthy();

    expect(
      reverseIngestAssignmentResponseSchema.parse({
        qrCode: qrCodeSchema.parse({
          code: "QR-1001",
          batchId: "batch-1",
          status: "printed",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        }),
        correctionEvent: {
          ...correctionEvent,
          correctionKind: "ingest_reversed",
        },
      }),
    ).toBeTruthy();

    expect(
      bulkAssignQrsRequestSchema.parse({
        qrs: ["QR-1001", "QR-1002"],
        assignment: {
          entityKind: "instance",
          location: "Shelf A",
          notes: null,
          partType: {
            kind: "existing",
            existingPartTypeId: "part-a",
          },
          initialStatus: "available",
        },
      }),
    ).toEqual({
      qrs: ["QR-1001", "QR-1002"],
      assignment: {
        entityKind: "instance",
        location: "Shelf A",
        notes: null,
        partType: {
          kind: "existing",
          existingPartTypeId: "part-a",
        },
        initialStatus: "available",
      },
    });

    expect(() =>
      bulkAssignQrsRequestSchema.parse({
        qrs: ["QR-1001", "QR-1001"],
        assignment: {
          entityKind: "instance",
          location: "Shelf A",
          notes: null,
          partType: {
            kind: "existing",
            existingPartTypeId: "part-a",
          },
          initialStatus: "available",
        },
      }),
    ).toThrow();

    expect(
      bulkMoveEntitiesRequestSchema.parse({
        targets: [
          {
            targetType: "instance",
            targetId: "instance-1",
            qrCode: "QR-1001",
          },
          {
            targetType: "bulk",
            targetId: "bulk-1",
            qrCode: "QR-1002",
          },
        ],
        location: "Shelf B",
        notes: null,
      }),
    ).toEqual({
      targets: [
        {
          targetType: "instance",
          targetId: "instance-1",
          qrCode: "QR-1001",
        },
        {
          targetType: "bulk",
          targetId: "bulk-1",
          qrCode: "QR-1002",
        },
      ],
      location: "Shelf B",
      notes: null,
    });

    expect(
      bulkReverseIngestRequestSchema.parse({
        targets: [
          {
            assignedKind: "instance",
            assignedId: "instance-1",
            qrCode: "QR-1001",
          },
        ],
        reason: "Undo bad ingest",
      }),
    ).toEqual({
      targets: [
        {
          assignedKind: "instance",
          assignedId: "instance-1",
          qrCode: "QR-1001",
        },
      ],
      reason: "Undo bad ingest",
    });

    expect(
      bulkAssignQrsResponseSchema.parse({
        entities: [
          {
            id: "instance-1",
            targetType: "instance",
            qrCode: "QR-1001",
            partType: {
              id: "part-a",
              canonicalName: "Correct Type",
              category: "Misc",
              categoryPath: ["Misc"],
              aliases: [],
              imageUrl: null,
              notes: null,
              countable: true,
              unit: {
                symbol: "pcs",
                name: "Pieces",
                isInteger: true,
              },
              needsReview: false,
              partDbPartId: null,
              partDbCategoryId: null,
              partDbUnitId: null,
              partDbSyncStatus: "never",
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
            location: "Shelf A",
            state: "available",
            assignee: null,
            partDbSyncStatus: "never",
            quantity: null,
            minimumQuantity: null,
          },
        ],
        processedCount: 1,
      }),
    ).toBeTruthy();

    expect(
      bulkMoveEntitiesResponseSchema.parse({
        events: [
          {
            id: "event-1",
            targetType: "instance",
            targetId: "instance-1",
            event: "moved",
            fromState: "available",
            toState: "available",
            location: "Shelf B",
            actor: "lab-admin",
            notes: null,
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ],
        processedCount: 1,
      }),
    ).toBeTruthy();

    expect(
      bulkReverseIngestResponseSchema.parse({
        qrCodes: [
          qrCodeSchema.parse({
            code: "QR-1001",
            batchId: "batch-1",
            status: "printed",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          }),
        ],
        correctionEvents: [
          {
            ...correctionEvent,
            correctionKind: "ingest_reversed",
          },
        ],
        processedCount: 1,
      }),
    ).toBeTruthy();

    expect(
      scanResponseSchema.parse({
        mode: "interact",
        qrCode: {
          code: "QR-1001",
          batchId: "batch-1",
          status: "assigned",
          assignedKind: "instance",
          assignedId: "instance-1",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        entity: {
          id: "instance-1",
          targetType: "instance",
          qrCode: "QR-1001",
          partType: {
            id: "part-1",
            canonicalName: "Arduino Uno",
            category: "Microcontrollers",
            categoryPath: ["Uncategorized"],
            aliases: [],
            imageUrl: null,
            notes: null,
            countable: true,
            unit: {
              symbol: "pcs",
              name: "Pieces",
              isInteger: true,
            },
            needsReview: false,
            partDbPartId: null,
            partDbCategoryId: null,
            partDbUnitId: null,
            partDbSyncStatus: "never",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
          location: "Shelf A",
          state: "available",
          assignee: null,
        },
        recentEvents: [],
        availableActions: ["moved", "checked_out"],
        partDb: {
          configured: false,
          connected: false,
          message: "Not configured",
        },
        currentBorrow: null,
        canReverseIngest: true,
        canEditSharedType: true,
      }),
    ).toEqual({
      mode: "interact",
      qrCode: {
        code: "QR-1001",
        batchId: "batch-1",
        status: "assigned",
        assignedKind: "instance",
        assignedId: "instance-1",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      entity: {
        id: "instance-1",
        targetType: "instance",
        qrCode: "QR-1001",
        partType: {
          id: "part-1",
          canonicalName: "Arduino Uno",
          category: "Microcontrollers",
          categoryPath: ["Uncategorized"],
          aliases: [],
          imageUrl: null,
          notes: null,
          countable: true,
          unit: {
            symbol: "pcs",
            name: "Pieces",
            isInteger: true,
          },
          needsReview: false,
          partDbPartId: null,
          partDbCategoryId: null,
          partDbUnitId: null,
          partDbSyncStatus: "never",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        location: "Shelf A",
        state: "available",
        assignee: null,
        partDbSyncStatus: "never",
        quantity: null,
        minimumQuantity: null,
      },
      recentEvents: [],
      availableActions: ["moved", "checked_out"],
      partDb: {
        configured: false,
        connected: false,
        message: "Not configured",
      },
      currentBorrow: null,
      canReverseIngest: true,
      canEditSharedType: true,
    });

    expect(
      loginRequestSchema.parse({
        apiToken: "token-123",
      }),
    ).toEqual({
      apiToken: "token-123",
    });

    expect(
      loginResponseSchema.parse({
        session: {
          subject: "zitadel-user-1",
          username: "labeler",
          name: "Labeler User",
          email: "labeler@example.com",
          roles: ["smartdb.labeler"],
          issuedAt: "2026-01-01T00:00:00.000Z",
          expiresAt: null,
        },
      }),
    ).toEqual({
      session: {
        subject: "zitadel-user-1",
        username: "labeler",
        name: "Labeler User",
        email: "labeler@example.com",
        roles: ["smartdb.labeler"],
        issuedAt: "2026-01-01T00:00:00.000Z",
        expiresAt: null,
      },
    });

    expect(
      applicationErrorResponseSchema.parse({
        error: {
          code: "forbidden",
          message: "Admins only.",
          details: {
            requiredRole: "smartdb.admin",
          },
        },
      }),
    ).toEqual({
      error: {
        code: "forbidden",
        message: "Admins only.",
        details: {
          requiredRole: "smartdb.admin",
        },
      },
    });

    expect(
      applicationErrorResponseSchema.parse({
        error: {
          code: "unauthenticated",
          message: "Authentication is required.",
          details: {
            source: "partdb",
          },
        },
      }),
    ).toEqual({
      error: {
        code: "unauthenticated",
        message: "Authentication is required.",
        details: {
          source: "partdb",
        },
      },
    });

    expect(
      logoutResponseSchema.parse({
        ok: true,
      }),
    ).toEqual({
      ok: true,
      redirectUrl: null,
    });

    expect(latestQrBatchResponseSchema.parse(null)).toBeNull();
  });
});
