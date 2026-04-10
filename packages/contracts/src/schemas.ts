import { z } from "zod";

const nonEmptyString = z.string().trim().min(1);
const nullableString = z.string().trim().min(1).nullable();
const nullableLooseString = z.string().trim().nullable();
const normalizedOptionalString = z.string().trim().nullish().transform((value) => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
});

export const instanceStatuses = [
  "available",
  "checked_out",
  "consumed",
  "damaged",
  "lost",
] as const;

export const bulkLevels = ["full", "good", "low", "empty"] as const;
export const qrStatuses = ["printed", "assigned", "voided", "duplicate"] as const;
export const inventoryTargetKinds = ["instance", "bulk"] as const;
export const partDbSyncStatuses = ["never", "pending", "synced", "failed"] as const;
export const stockEventKinds = [
  "labeled",
  "moved",
  "checked_out",
  "returned",
  "consumed",
  "level_changed",
  "damaged",
  "lost",
  "disposed",
] as const;
export const instanceActionKinds = [
  "moved",
  "checked_out",
  "returned",
  "consumed",
  "damaged",
  "lost",
  "disposed",
] as const;
export const bulkActionKinds = ["moved", "level_changed", "consumed"] as const;

export const instanceStatusSchema = z.enum(instanceStatuses);
export const bulkLevelSchema = z.enum(bulkLevels);
export const qrStatusSchema = z.enum(qrStatuses);
export const inventoryTargetKindSchema = z.enum(inventoryTargetKinds);
export const partDbSyncStatusSchema = z.enum(partDbSyncStatuses);
export const stockEventKindSchema = z.enum(stockEventKinds);
export const instanceActionSchema = z.enum(instanceActionKinds);
export const bulkActionSchema = z.enum(bulkActionKinds);

const isoTimestampSchema = z.string().datetime();
const identifierSchema = nonEmptyString;
const booleanEnvironmentSchema = z
  .union([
    z.boolean(),
    z.enum(["true", "false", "1", "0"]),
  ])
  .transform((value) => value === true || value === "true" || value === "1");

export const measurementUnitSchema = z
  .object({
    symbol: z.string().trim().min(1).max(10),
    name: nonEmptyString,
    isInteger: z.boolean(),
  })
  .strict();

export const categoryPathSchema = z
  .array(z.string().trim().min(1).max(255))
  .min(1)
  .max(6);

export const partTypeSchema = z
  .object({
    id: identifierSchema,
    canonicalName: nonEmptyString,
    category: nonEmptyString,
    categoryPath: categoryPathSchema.default(["Uncategorized"]),
    aliases: z.array(nonEmptyString).default([]),
    imageUrl: nullableLooseString.default(null),
    notes: nullableLooseString.default(null),
    countable: z.boolean(),
    unit: measurementUnitSchema.default({
      symbol: "pcs",
      name: "Pieces",
      isInteger: true,
    }),
    needsReview: z.boolean(),
    partDbPartId: nullableLooseString.default(null),
    partDbCategoryId: nullableLooseString.default(null),
    partDbUnitId: nullableLooseString.default(null),
    partDbSyncStatus: partDbSyncStatusSchema.default("never"),
    createdAt: isoTimestampSchema,
    updatedAt: isoTimestampSchema,
  })
  .strict();

export const physicalInstanceSchema = z
  .object({
    id: identifierSchema,
    qrCode: nonEmptyString,
    partTypeId: identifierSchema,
    status: instanceStatusSchema,
    location: nonEmptyString,
    assignee: nullableLooseString.default(null),
    createdAt: isoTimestampSchema,
    updatedAt: isoTimestampSchema,
  })
  .strict();

export const bulkStockSchema = z
  .object({
    id: identifierSchema,
    qrCode: nonEmptyString,
    partTypeId: identifierSchema,
    level: bulkLevelSchema,
    quantity: z.number().nonnegative().default(0),
    minimumQuantity: z.number().nonnegative().nullable().default(null),
    location: nonEmptyString,
    partDbLotId: nullableLooseString.default(null),
    partDbSyncStatus: partDbSyncStatusSchema.default("never"),
    createdAt: isoTimestampSchema,
    updatedAt: isoTimestampSchema,
  })
  .strict();

export const qrCodeSchema = z
  .object({
    code: nonEmptyString,
    batchId: identifierSchema,
    status: qrStatusSchema,
    assignedKind: inventoryTargetKindSchema.nullable().default(null),
    assignedId: nullableLooseString.default(null),
    createdAt: isoTimestampSchema,
    updatedAt: isoTimestampSchema,
  })
  .strict();

export const qrBatchSchema = z
  .object({
    id: identifierSchema,
    prefix: nonEmptyString,
    startNumber: z.number().int().nonnegative(),
    endNumber: z.number().int().nonnegative(),
    actor: nonEmptyString,
    createdAt: isoTimestampSchema,
  })
  .strict();

export const stockEventSchema = z
  .object({
    id: identifierSchema,
    targetType: inventoryTargetKindSchema,
    targetId: identifierSchema,
    event: stockEventKindSchema,
    fromState: nullableLooseString.default(null),
    toState: nullableLooseString.default(null),
    location: nullableLooseString.default(null),
    actor: nonEmptyString,
    notes: nullableLooseString.default(null),
    createdAt: isoTimestampSchema,
  })
  .strict();

export const inventoryEntitySummarySchema = z
  .object({
    id: identifierSchema,
    targetType: inventoryTargetKindSchema,
    qrCode: nonEmptyString,
    partType: partTypeSchema,
    location: nonEmptyString,
    state: nonEmptyString,
    assignee: nullableLooseString.default(null),
  })
  .strict();

export const dashboardSummarySchema = z
  .object({
    partTypeCount: z.number().int().nonnegative(),
    instanceCount: z.number().int().nonnegative(),
    bulkStockCount: z.number().int().nonnegative(),
    provisionalCount: z.number().int().nonnegative(),
    unassignedQrCount: z.number().int().nonnegative(),
    recentEvents: z.array(stockEventSchema),
  })
  .strict();

export const authSessionSchema = z
  .object({
    subject: nullableLooseString.default(null),
    username: nonEmptyString,
    name: nullableLooseString.default(null),
    email: nullableLooseString.default(null),
    roles: z.array(nonEmptyString).default([]),
    issuedAt: isoTimestampSchema,
    expiresAt: isoTimestampSchema.nullable(),
  })
  .strict();

export const loginRequestSchema = z
  .object({
    apiToken: nonEmptyString,
  })
  .strict();

export const loginResponseSchema = z
  .object({
    session: authSessionSchema,
  })
  .strict();

export const logoutResponseSchema = z
  .object({
    ok: z.literal(true),
    redirectUrl: nullableLooseString.default(null),
  })
  .strict();

export const registerQrBatchRequestSchema = z
  .object({
    batchId: nonEmptyString.optional(),
    prefix: nonEmptyString.regex(/^[A-Za-z0-9_-]+$/).default("QR"),
    startNumber: z.number().int().nonnegative(),
    count: z.number().int().positive().max(500),
  })
  .strict();

export const registerQrBatchCommandSchema = registerQrBatchRequestSchema
  .extend({
    actor: nonEmptyString,
  })
  .strict();

export const registerQrBatchResponseSchema = z
  .object({
    batch: qrBatchSchema,
    created: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
  })
  .strict();

export const latestQrBatchResponseSchema = qrBatchSchema.nullable();

export const existingPartTypeDraftSchema = z
  .object({
    kind: z.literal("existing"),
    existingPartTypeId: identifierSchema,
  })
  .strict();

export const newPartTypeDraftSchema = z
  .object({
    kind: z.literal("new"),
    canonicalName: nonEmptyString,
    category: nonEmptyString,
    aliases: z.array(nonEmptyString).default([]),
    notes: nullableLooseString.default(null),
    imageUrl: nullableLooseString.default(null),
    countable: z.boolean(),
  })
  .strict();

export const partTypeDraftSchema = z.discriminatedUnion("kind", [
  existingPartTypeDraftSchema,
  newPartTypeDraftSchema,
]);

export const instanceAssignQrRequestSchema = z
  .object({
    qrCode: nonEmptyString,
    entityKind: z.literal("instance"),
    location: nonEmptyString,
    notes: nullableLooseString.default(null),
    partType: partTypeDraftSchema,
    initialStatus: instanceStatusSchema.default("available"),
  })
  .strict();

export const bulkAssignQrRequestSchema = z
  .object({
    qrCode: nonEmptyString,
    entityKind: z.literal("bulk"),
    location: nonEmptyString,
    notes: nullableLooseString.default(null),
    partType: partTypeDraftSchema,
    initialLevel: bulkLevelSchema.default("good"),
  })
  .strict();

export const assignQrRequestSchema = z.discriminatedUnion("entityKind", [
  instanceAssignQrRequestSchema,
  bulkAssignQrRequestSchema,
]);

export const instanceAssignQrCommandSchema = instanceAssignQrRequestSchema
  .extend({
    actor: nonEmptyString,
  })
  .strict();

export const bulkAssignQrCommandSchema = bulkAssignQrRequestSchema
  .extend({
    actor: nonEmptyString,
  })
  .strict();

export const assignQrCommandSchema = z.discriminatedUnion("entityKind", [
  instanceAssignQrCommandSchema,
  bulkAssignQrCommandSchema,
]);

export const instanceRecordEventRequestSchema = z
  .discriminatedUnion("event", [
    z
      .object({
        targetType: z.literal("instance"),
        targetId: identifierSchema,
        event: z.literal("moved"),
        notes: normalizedOptionalString,
        location: nonEmptyString,
      })
      .strict(),
    z
      .object({
        targetType: z.literal("instance"),
        targetId: identifierSchema,
        event: z.literal("checked_out"),
        notes: normalizedOptionalString,
        location: normalizedOptionalString,
        assignee: normalizedOptionalString,
      })
      .strict(),
    z
      .object({
        targetType: z.literal("instance"),
        targetId: identifierSchema,
        event: z.literal("returned"),
        notes: normalizedOptionalString,
        location: normalizedOptionalString,
      })
      .strict(),
    z
      .object({
        targetType: z.literal("instance"),
        targetId: identifierSchema,
        event: z.literal("consumed"),
        notes: normalizedOptionalString,
        location: normalizedOptionalString,
      })
      .strict(),
    z
      .object({
        targetType: z.literal("instance"),
        targetId: identifierSchema,
        event: z.literal("damaged"),
        notes: normalizedOptionalString,
        location: normalizedOptionalString,
      })
      .strict(),
    z
      .object({
        targetType: z.literal("instance"),
        targetId: identifierSchema,
        event: z.literal("lost"),
        notes: normalizedOptionalString,
        location: normalizedOptionalString,
      })
      .strict(),
    z
      .object({
        targetType: z.literal("instance"),
        targetId: identifierSchema,
        event: z.literal("disposed"),
        notes: normalizedOptionalString,
        location: normalizedOptionalString,
      })
      .strict(),
  ]);

export const bulkRecordEventRequestSchema = z.discriminatedUnion("event", [
  z
    .object({
      targetType: z.literal("bulk"),
      targetId: identifierSchema,
      event: z.literal("moved"),
      notes: normalizedOptionalString,
      location: nonEmptyString,
    })
    .strict(),
  z
    .object({
      targetType: z.literal("bulk"),
      targetId: identifierSchema,
      event: z.literal("level_changed"),
      notes: normalizedOptionalString,
      location: normalizedOptionalString,
      nextLevel: bulkLevelSchema,
    })
    .strict(),
  z
    .object({
      targetType: z.literal("bulk"),
      targetId: identifierSchema,
      event: z.literal("consumed"),
      notes: normalizedOptionalString,
      location: normalizedOptionalString,
      nextLevel: bulkLevelSchema,
    })
    .strict(),
]);

export const recordEventRequestSchema = z.union([
  instanceRecordEventRequestSchema,
  bulkRecordEventRequestSchema,
]);

const actorSchema = z
  .object({
    actor: nonEmptyString,
  })
  .strict();

export const instanceRecordEventCommandSchema = z.intersection(
  instanceRecordEventRequestSchema,
  actorSchema,
);

export const bulkRecordEventCommandSchema = z.intersection(
  bulkRecordEventRequestSchema,
  actorSchema,
);

export const recordEventCommandSchema = z.union([
  instanceRecordEventCommandSchema,
  bulkRecordEventCommandSchema,
]);

export const mergePartTypesRequestSchema = z
  .object({
    sourcePartTypeId: identifierSchema,
    destinationPartTypeId: identifierSchema,
    aliasLabel: normalizedOptionalString,
  })
  .strict()
  .refine(
    (value) => value.sourcePartTypeId !== value.destinationPartTypeId,
    {
      message: "Source and destination part types must be different.",
      path: ["destinationPartTypeId"],
    },
  );

export const voidQrRequestSchema = z
  .object({
    reason: z.string().trim().default("No reason provided"),
  })
  .strict();

export const partTypeSearchQuerySchema = z
  .object({
    q: z.string().trim().default(""),
  })
  .strict();

export const scanRequestSchema = z
  .object({
    code: nonEmptyString,
  })
  .strict();

export const partDbDiscoveredResourcesSchema = z
  .object({
    tokenInfoPath: nullableLooseString.default(null),
    openApiPath: nullableLooseString.default(null),
    partsPath: nullableLooseString.default(null),
    partLotsPath: nullableLooseString.default(null),
    storageLocationsPath: nullableLooseString.default(null),
  })
  .strict();

export const partDbConnectionStatusSchema = z
  .object({
    configured: z.boolean(),
    connected: z.boolean(),
    baseUrl: nullableLooseString.default(null),
    tokenLabel: nullableLooseString.default(null),
    userLabel: nullableLooseString.default(null),
    message: nonEmptyString,
    discoveredResources: partDbDiscoveredResourcesSchema,
  })
  .strict();

export const partDbLookupSummarySchema = z
  .object({
    configured: z.boolean(),
    connected: z.boolean(),
    message: nonEmptyString,
  })
  .strict();

export const applicationErrorResponseSchema = z
  .object({
    error: z
      .object({
        code: z.enum([
          "parse_input",
          "unauthenticated",
          "forbidden",
          "not_found",
          "conflict",
          "integration",
          "invariant",
        ]),
        message: nonEmptyString,
        details: z.record(z.unknown()),
      })
      .strict(),
  })
  .strict();

export const interactInstanceScanResponseSchema = z
  .object({
    mode: z.literal("interact"),
    qrCode: qrCodeSchema,
    entity: inventoryEntitySummarySchema.extend({
      targetType: z.literal("instance"),
    }),
    recentEvents: z.array(stockEventSchema),
    availableActions: z.array(instanceActionSchema),
    partDb: partDbLookupSummarySchema,
  })
  .strict();

export const interactBulkScanResponseSchema = z
  .object({
    mode: z.literal("interact"),
    qrCode: qrCodeSchema,
    entity: inventoryEntitySummarySchema.extend({
      targetType: z.literal("bulk"),
    }),
    recentEvents: z.array(stockEventSchema),
    availableActions: z.array(bulkActionSchema),
    partDb: partDbLookupSummarySchema,
  })
  .strict();

export const scanResponseSchema = z.union([
  z
    .object({
      mode: z.literal("label"),
      qrCode: qrCodeSchema,
      suggestions: z.array(partTypeSchema),
      partDb: partDbLookupSummarySchema,
    })
    .strict(),
  interactInstanceScanResponseSchema,
  interactBulkScanResponseSchema,
  z
    .object({
      mode: z.literal("unknown"),
      code: nonEmptyString,
      partDb: partDbLookupSummarySchema,
    })
    .strict(),
]);

export type InstanceStatus = z.output<typeof instanceStatusSchema>;
export type BulkLevel = z.output<typeof bulkLevelSchema>;
export type QrStatus = z.output<typeof qrStatusSchema>;
export type PartDbSyncStatus = z.output<typeof partDbSyncStatusSchema>;
export type StockEventKind = z.output<typeof stockEventKindSchema>;
export type InstanceActionKind = z.output<typeof instanceActionSchema>;
export type BulkActionKind = z.output<typeof bulkActionSchema>;
export type InventoryTargetKind = z.output<typeof inventoryTargetKindSchema>;
export type MeasurementUnit = z.output<typeof measurementUnitSchema>;
export type CategoryPath = z.output<typeof categoryPathSchema>;
export type PartType = z.output<typeof partTypeSchema>;
export type PhysicalInstance = z.output<typeof physicalInstanceSchema>;
export type BulkStock = z.output<typeof bulkStockSchema>;
export type QRCode = z.output<typeof qrCodeSchema>;
export type QrBatch = z.output<typeof qrBatchSchema>;
export type StockEvent = z.output<typeof stockEventSchema>;
export type InventoryEntitySummary = z.output<typeof inventoryEntitySummarySchema>;
export type DashboardSummary = z.output<typeof dashboardSummarySchema>;
export type AuthSession = z.output<typeof authSessionSchema>;
export type LoginRequest = z.output<typeof loginRequestSchema>;
export type LoginResponse = z.output<typeof loginResponseSchema>;
export type LogoutResponse = z.output<typeof logoutResponseSchema>;
export type RegisterQrBatchRequest = z.output<typeof registerQrBatchRequestSchema>;
export type RegisterQrBatchCommand = z.output<typeof registerQrBatchCommandSchema>;
export type RegisterQrBatchResponse = z.output<typeof registerQrBatchResponseSchema>;
export type LatestQrBatchResponse = z.output<typeof latestQrBatchResponseSchema>;
export type ExistingPartTypeDraft = z.output<typeof existingPartTypeDraftSchema>;
export type NewPartTypeDraft = z.output<typeof newPartTypeDraftSchema>;
export type PartTypeDraft = z.output<typeof partTypeDraftSchema>;
export type AssignQrRequest = z.output<typeof assignQrRequestSchema>;
export type AssignQrCommand = z.output<typeof assignQrCommandSchema>;
export type RecordEventRequest = z.output<typeof recordEventRequestSchema>;
export type RecordEventCommand = z.output<typeof recordEventCommandSchema>;
export type MergePartTypesRequest = z.output<typeof mergePartTypesRequestSchema>;
export type PartTypeSearchQuery = z.output<typeof partTypeSearchQuerySchema>;
export type PartDbDiscoveredResources = z.output<typeof partDbDiscoveredResourcesSchema>;
export type PartDbConnectionStatus = z.output<typeof partDbConnectionStatusSchema>;
export type PartDbLookupSummary = z.output<typeof partDbLookupSummarySchema>;
export type ApplicationErrorResponse = z.output<typeof applicationErrorResponseSchema>;
export type ScanResponse = z.output<typeof scanResponseSchema>;

export const configEnvironmentSchema = z
  .object({
    PORT: z.coerce.number().int().positive().default(4000),
    FRONTEND_ORIGIN: nonEmptyString.default("http://localhost:5173"),
    PUBLIC_BASE_URL: nonEmptyString.default("http://localhost:4000"),
    SMART_DB_DATA_PATH: nonEmptyString.optional(),
    PARTDB_BASE_URL: nullableString.nullish().transform((value) => value ?? null).default(null),
    PARTDB_PUBLIC_BASE_URL: nullableString.nullish().transform((value) => value ?? null).default(null),
    PARTDB_API_TOKEN: nullableString.nullish().transform((value) => value ?? null).default(null),
    PARTDB_SYNC_ENABLED: booleanEnvironmentSchema.default(false),
    SESSION_COOKIE_SECRET: nullableString.nullish().transform((value) => value ?? null).default(null),
    ZITADEL_ISSUER: nullableString.nullish().transform((value) => value ?? null).default(null),
    ZITADEL_CLIENT_ID: nullableString.nullish().transform((value) => value ?? null).default(null),
    ZITADEL_CLIENT_SECRET: nullableString.nullish().transform((value) => value ?? null).default(null),
    ZITADEL_POST_LOGOUT_REDIRECT_URI: nullableString.nullish().transform((value) => value ?? null).default(null),
    ZITADEL_ROLE_CLAIM: nullableString.nullish().transform((value) => value ?? null).default(null),
  })
  .strict();

export type ConfigEnvironment = z.output<typeof configEnvironmentSchema>;
