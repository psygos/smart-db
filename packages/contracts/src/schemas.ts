import { z } from "zod";
import { Err, Ok, type Result } from "./result.js";

const nonEmptyString = z.string().trim().min(1);
const nullableString = z.string().trim().min(1).nullable();
const nullableLooseString = z.string().trim().nullable();
const normalizedOptionalString = z.string().trim().nullish().transform((value) => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
});
const categorySegmentPattern = /^[A-Za-z0-9 _\-+&().#]+$/;
export const measurementUnitCatalog = [
  { symbol: "pcs", name: "Pieces", isInteger: true },
  { symbol: "g", name: "Grams", isInteger: false },
  { symbol: "kg", name: "Kilograms", isInteger: false },
  { symbol: "mg", name: "Milligrams", isInteger: false },
  { symbol: "m", name: "Meters", isInteger: false },
  { symbol: "cm", name: "Centimeters", isInteger: false },
  { symbol: "mm", name: "Millimeters", isInteger: false },
  { symbol: "mL", name: "Milliliters", isInteger: false },
  { symbol: "L", name: "Liters", isInteger: false },
  { symbol: "oz", name: "Ounces", isInteger: false },
  { symbol: "lb", name: "Pounds", isInteger: false },
] as const;
export const defaultMeasurementUnit = measurementUnitCatalog[0];

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
export const correctionTargetKinds = ["instance", "bulk", "part_type"] as const;
export const partDbSyncStatuses = ["never", "pending", "synced", "failed"] as const;
export const stockEventKinds = [
  "labeled",
  "moved",
  "checked_out",
  "returned",
  "consumed",
  "restocked",
  "stocktaken",
  "adjusted",
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
export const bulkActionKinds = ["moved", "restocked", "consumed", "stocktaken", "adjusted"] as const;
export const correctionKinds = [
  "entity_part_type_reassigned",
  "part_type_definition_edited",
  "ingest_reversed",
] as const;

export const instanceStatusSchema = z.enum(instanceStatuses);
export const bulkLevelSchema = z.enum(bulkLevels);
export const qrStatusSchema = z.enum(qrStatuses);
export const inventoryTargetKindSchema = z.enum(inventoryTargetKinds);
export const correctionTargetKindSchema = z.enum(correctionTargetKinds);
export const partDbSyncStatusSchema = z.enum(partDbSyncStatuses);
export const stockEventKindSchema = z.enum(stockEventKinds);
export const instanceActionSchema = z.enum(instanceActionKinds);
export const bulkActionSchema = z.enum(bulkActionKinds);
export const correctionKindSchema = z.enum(correctionKinds);

const isoTimestampSchema = z.string().datetime();
const identifierSchema = nonEmptyString;

export const borrowDueDateSchema = isoTimestampSchema.refine(
  (value) => Date.parse(value) > Date.now(),
  { message: "Due date must be in the future." },
);
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

export type CategoryPathParseError =
  | { kind: "empty" }
  | { kind: "too_deep"; maxDepth: number }
  | { kind: "invalid_segment"; segment: string };

export function parseCategoryPathInput(
  input: string,
): Result<z.output<typeof categoryPathSchema>, CategoryPathParseError> {
  const segments = input
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);

  if (segments.length === 0) {
    return Err({ kind: "empty" });
  }

  if (segments.length > 6) {
    return Err({ kind: "too_deep", maxDepth: 6 });
  }

  for (const segment of segments) {
    if (segment.length > 255 || !categorySegmentPattern.test(segment)) {
      return Err({ kind: "invalid_segment", segment });
    }
  }

  return Ok(segments);
}

export function describeCategoryPathParseError(error: CategoryPathParseError): string {
  switch (error.kind) {
    case "empty":
      return "Category is required.";
    case "too_deep":
      return `Category paths can have at most ${error.maxDepth} levels.`;
    case "invalid_segment":
      return `Category segment '${error.segment}' contains unsupported characters.`;
  }
}

export function categoryLeafFromPath(path: z.output<typeof categoryPathSchema>): string {
  return path[path.length - 1] ?? "Uncategorized";
}

const locationSegmentPattern = /^[A-Za-z0-9 _\-+&().#]+$/;

export const locationPathSchema = z
  .array(z.string().trim().min(1).max(255))
  .min(1)
  .max(6);

export type LocationPathParseError =
  | { kind: "empty" }
  | { kind: "too_deep"; maxDepth: number }
  | { kind: "invalid_segment"; segment: string };

export function parseLocationPathInput(
  input: string,
): Result<z.output<typeof locationPathSchema>, LocationPathParseError> {
  const segments = input
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);

  if (segments.length === 0) {
    return Err({ kind: "empty" });
  }

  if (segments.length > 6) {
    return Err({ kind: "too_deep", maxDepth: 6 });
  }

  for (const segment of segments) {
    if (segment.length > 255 || !locationSegmentPattern.test(segment)) {
      return Err({ kind: "invalid_segment", segment });
    }
  }

  return Ok(segments);
}

export function describeLocationPathParseError(error: LocationPathParseError): string {
  switch (error.kind) {
    case "empty":
      return "Location is required.";
    case "too_deep":
      return `Location paths can have at most ${error.maxDepth} levels.`;
    case "invalid_segment":
      return `Location segment '${error.segment}' contains unsupported characters.`;
  }
}

export function locationLeafFromPath(path: z.output<typeof locationPathSchema>): string {
  return path[path.length - 1] ?? "";
}

export function getMeasurementUnitBySymbol(symbol: string): z.output<typeof measurementUnitSchema> | null {
  return (
    measurementUnitCatalog.find((unit) => unit.symbol === symbol) ?? null
  );
}

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
    unit: measurementUnitSchema.default(defaultMeasurementUnit),
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
    partDbSyncStatus: partDbSyncStatusSchema.default("never"),
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

export const entityStatusSchema = z.enum([
  "available",
  "checked_out",
  "consumed",
  "damaged",
  "lost",
]);

export type EntityStatus = z.output<typeof entityStatusSchema>;

export const entitySourceKindSchema = z.enum(["instance", "bulk"]);
export type EntitySourceKind = z.output<typeof entitySourceKindSchema>;

export const entitySchema = z
  .object({
    id: identifierSchema,
    qrCode: nonEmptyString,
    partTypeId: identifierSchema,
    location: nonEmptyString,
    quantity: z.number().nonnegative(),
    minimumQuantity: z.number().nonnegative().nullable(),
    status: entityStatusSchema,
    assignee: z.string().nullable(),
    sourceKind: entitySourceKindSchema,
    partDbLotId: nullableLooseString.nullable(),
    partDbSyncStatus: partDbSyncStatusSchema,
    createdAt: isoTimestampSchema,
    updatedAt: isoTimestampSchema,
  })
  .strict();

export type Entity = z.output<typeof entitySchema>;

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
    partName: nullableLooseString.default(null),
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
    partDbSyncStatus: partDbSyncStatusSchema.default("never"),
    quantity: z.number().nonnegative().nullable().default(null),
    minimumQuantity: z.number().nonnegative().nullable().default(null),
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
    category: nonEmptyString.superRefine((value, context) => {
      const parsed = parseCategoryPathInput(value);
      if (!parsed.ok) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: describeCategoryPathParseError(parsed.error),
        });
      }
    }),
    aliases: z.array(nonEmptyString).default([]),
    notes: nullableLooseString.default(null),
    imageUrl: nullableLooseString.default(null),
    countable: z.boolean(),
    unit: measurementUnitSchema.default(defaultMeasurementUnit),
  })
  .strict();

export const partTypeDraftSchema = z
  .discriminatedUnion("kind", [
    existingPartTypeDraftSchema,
    newPartTypeDraftSchema,
  ])
  .superRefine((value, context) => {
    if (value.kind === "new" && value.countable && !value.unit.isInteger) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["unit"],
        message: "Countable part types require an integer unit.",
      });
    }
  });

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
    initialQuantity: z.number().positive(),
    minimumQuantity: z.number().nonnegative().nullable().default(null),
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

const uniqueQrCodesSchema = z
  .array(nonEmptyString)
  .min(1)
  .superRefine((codes, context) => {
    const seen = new Set<string>();
    for (const [index, code] of codes.entries()) {
      if (seen.has(code)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index],
          message: "Each QR/Data Matrix code may appear only once in a batch.",
        });
      }
      seen.add(code);
    }
  });

export const sharedInstanceAssignRequestSchema = instanceAssignQrRequestSchema
  .omit({
    qrCode: true,
  })
  .strict();

export const sharedBulkAssignRequestSchema = bulkAssignQrRequestSchema
  .omit({
    qrCode: true,
  })
  .strict();

export const sharedAssignRequestSchema = z.discriminatedUnion("entityKind", [
  sharedInstanceAssignRequestSchema,
  sharedBulkAssignRequestSchema,
]);

export const bulkAssignQrsRequestSchema = z
  .object({
    qrs: uniqueQrCodesSchema,
    assignment: sharedAssignRequestSchema,
  })
  .strict();

export const bulkAssignQrsCommandSchema = bulkAssignQrsRequestSchema
  .extend({
    actor: nonEmptyString,
  })
  .strict();

export const bulkEntityTargetSchema = z
  .object({
    targetType: inventoryTargetKindSchema,
    targetId: identifierSchema,
    qrCode: nonEmptyString,
  })
  .strict();

const uniqueBulkEntityTargetsSchema = z
  .array(bulkEntityTargetSchema)
  .min(1)
  .superRefine((targets, context) => {
    const seenTargets = new Set<string>();
    const seenCodes = new Set<string>();
    for (const [index, target] of targets.entries()) {
      const targetKey = `${target.targetType}:${target.targetId}`;
      if (seenTargets.has(targetKey)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, "targetId"],
          message: "Each inventory target may appear only once in a batch.",
        });
      }
      if (seenCodes.has(target.qrCode)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, "qrCode"],
          message: "Each QR/Data Matrix code may appear only once in a batch.",
        });
      }
      seenTargets.add(targetKey);
      seenCodes.add(target.qrCode);
    }
  });

export const bulkMoveEntitiesRequestSchema = z
  .object({
    targets: uniqueBulkEntityTargetsSchema,
    location: nonEmptyString,
    notes: nullableLooseString.default(null),
  })
  .strict();

export const bulkMoveEntitiesCommandSchema = bulkMoveEntitiesRequestSchema
  .extend({
    actor: nonEmptyString,
  })
  .strict();

export const bulkReverseIngestTargetSchema = z
  .object({
    assignedKind: inventoryTargetKindSchema,
    assignedId: identifierSchema,
    qrCode: nonEmptyString,
  })
  .strict();

const uniqueBulkReverseTargetsSchema = z
  .array(bulkReverseIngestTargetSchema)
  .min(1)
  .superRefine((targets, context) => {
    const seenTargets = new Set<string>();
    const seenCodes = new Set<string>();
    for (const [index, target] of targets.entries()) {
      const targetKey = `${target.assignedKind}:${target.assignedId}`;
      if (seenTargets.has(targetKey)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, "assignedId"],
          message: "Each inventory target may appear only once in a batch.",
        });
      }
      if (seenCodes.has(target.qrCode)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, "qrCode"],
          message: "Each QR/Data Matrix code may appear only once in a batch.",
        });
      }
      seenTargets.add(targetKey);
      seenCodes.add(target.qrCode);
    }
  });

export const bulkReverseIngestRequestSchema = z
  .object({
    targets: uniqueBulkReverseTargetsSchema,
    reason: nonEmptyString,
  })
  .strict();

export const bulkReverseIngestCommandSchema = bulkReverseIngestRequestSchema
  .extend({
    actor: nonEmptyString,
  })
  .strict();

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
        dueAt: borrowDueDateSchema.nullable().optional(),
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
      event: z.literal("restocked"),
      notes: normalizedOptionalString,
      location: normalizedOptionalString,
      quantityDelta: z.number().positive(),
    })
    .strict(),
  z
    .object({
      targetType: z.literal("bulk"),
      targetId: identifierSchema,
      event: z.literal("consumed"),
      notes: normalizedOptionalString,
      location: normalizedOptionalString,
      quantityDelta: z.number().positive(),
    })
    .strict(),
  z
    .object({
      targetType: z.literal("bulk"),
      targetId: identifierSchema,
      event: z.literal("stocktaken"),
      notes: normalizedOptionalString,
      location: normalizedOptionalString,
      quantity: z.number().nonnegative(),
    })
    .strict(),
  z
    .object({
      targetType: z.literal("bulk"),
      targetId: identifierSchema,
      event: z.literal("adjusted"),
      notes: nonEmptyString,
      location: normalizedOptionalString,
      quantityDelta: z.number(),
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

export const bulkSplitRequestSchema = z
  .object({
    quantity: z.number().positive(),
    destinationLocation: nonEmptyString,
    notes: nullableLooseString.default(null),
  })
  .strict();

export type BulkSplitRequest = z.output<typeof bulkSplitRequestSchema>;

export const correctionEventSchema = z
  .object({
    id: identifierSchema,
    targetType: correctionTargetKindSchema,
    targetId: identifierSchema,
    correctionKind: correctionKindSchema,
    actor: nonEmptyString,
    reason: nonEmptyString,
    before: z.record(z.unknown()),
    after: z.record(z.unknown()),
    createdAt: isoTimestampSchema,
  })
  .strict();

const reassignEntityPartTypeBaseSchema = z
  .object({
    targetType: inventoryTargetKindSchema,
    targetId: identifierSchema,
    fromPartTypeId: identifierSchema,
    toPartTypeId: identifierSchema,
    reason: nonEmptyString,
  })
  .strict();

export const reassignEntityPartTypeRequestSchema = reassignEntityPartTypeBaseSchema
  .refine((value) => value.fromPartTypeId !== value.toPartTypeId, {
    message: "Current and replacement part types must be different.",
    path: ["toPartTypeId"],
  });

export const reassignEntityPartTypeCommandSchema = z.intersection(
  reassignEntityPartTypeBaseSchema,
  z.object({
    actor: nonEmptyString,
  }).strict(),
)
  .refine((value) => value.fromPartTypeId !== value.toPartTypeId, {
    message: "Current and replacement part types must be different.",
    path: ["toPartTypeId"],
  });

export const editPartTypeDefinitionRequestSchema = z
  .object({
    partTypeId: identifierSchema,
    expectedUpdatedAt: isoTimestampSchema,
    canonicalName: nonEmptyString,
    category: nonEmptyString.superRefine((value, context) => {
      const parsed = parseCategoryPathInput(value);
      if (!parsed.ok) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: describeCategoryPathParseError(parsed.error),
        });
      }
    }),
    reason: nonEmptyString,
  })
  .strict();

export const editPartTypeDefinitionCommandSchema = editPartTypeDefinitionRequestSchema
  .extend({
    actor: nonEmptyString,
  })
  .strict();

export const reverseIngestAssignmentRequestSchema = z
  .object({
    qrCode: nonEmptyString,
    assignedKind: inventoryTargetKindSchema,
    assignedId: identifierSchema,
    reason: nonEmptyString,
  })
  .strict();

export const reverseIngestAssignmentCommandSchema = reverseIngestAssignmentRequestSchema
  .extend({
    actor: nonEmptyString,
  })
  .strict();

export const correctionHistoryQuerySchema = z
  .object({
    targetType: correctionTargetKindSchema,
    targetId: identifierSchema,
  })
  .strict();

export const reassignEntityPartTypeResponseSchema = z
  .object({
    entity: inventoryEntitySummarySchema,
    correctionEvent: correctionEventSchema,
  })
  .strict();

export const editPartTypeDefinitionResponseSchema = z
  .object({
    partType: partTypeSchema,
    correctionEvent: correctionEventSchema,
  })
  .strict();

export const reverseIngestAssignmentResponseSchema = z
  .object({
    qrCode: qrCodeSchema,
    correctionEvent: correctionEventSchema,
  })
  .strict();

export const bulkAssignQrsResponseSchema = z
  .object({
    entities: z.array(inventoryEntitySummarySchema).min(1),
    processedCount: z.number().int().positive(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.processedCount !== value.entities.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["processedCount"],
        message: "processedCount must equal the number of returned entities.",
      });
    }
  });

export const bulkMoveEntitiesResponseSchema = z
  .object({
    events: z.array(stockEventSchema).min(1),
    processedCount: z.number().int().positive(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.processedCount !== value.events.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["processedCount"],
        message: "processedCount must equal the number of returned events.",
      });
    }
  });

export const bulkReverseIngestResponseSchema = z
  .object({
    qrCodes: z.array(qrCodeSchema).min(1),
    correctionEvents: z.array(correctionEventSchema).min(1),
    processedCount: z.number().int().positive(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.processedCount !== value.qrCodes.length || value.processedCount !== value.correctionEvents.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["processedCount"],
        message: "processedCount must equal the number of returned QR codes and correction events.",
      });
    }
  });

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

export const partDbSyncStatusResponseSchema = z
  .object({
    enabled: z.boolean(),
    pending: z.number().int().nonnegative(),
    inFlight: z.number().int().nonnegative(),
    failedLast24h: z.number().int().nonnegative(),
    deadTotal: z.number().int().nonnegative(),
  })
  .strict();

export const partDbSyncFailureSchema = z
  .object({
    id: identifierSchema,
    operation: nonEmptyString,
    status: z.enum(["failed", "dead"]),
    targetTable: nullableLooseString.default(null),
    targetRowId: nullableLooseString.default(null),
    attemptCount: z.number().int().nonnegative(),
    nextAttemptAt: isoTimestampSchema,
    lastFailureAt: isoTimestampSchema.nullable().default(null),
    lastError: z.record(z.unknown()).nullable().default(null),
    createdAt: isoTimestampSchema,
  })
  .strict();

export const partDbSyncDrainResponseSchema = z
  .object({
    claimed: z.number().int().nonnegative(),
    delivered: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
  })
  .strict();

export const partDbSyncBackfillResponseSchema = z
  .object({
    queuedPartTypes: z.number().int().nonnegative(),
    queuedLots: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
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

export const borrowCloseReasonSchema = z.enum([
  "returned",
  "returned_after_lost",
  "disposed",
  "consumed",
  "lost",
  "re_checkout",
  "void_cascade",
]);

export type BorrowCloseReason = z.output<typeof borrowCloseReasonSchema>;

export const borrowRecordSchema = z
  .object({
    id: nonEmptyString,
    instanceId: nonEmptyString,
    borrower: nonEmptyString,
    borrowedAt: isoTimestampSchema,
    dueAt: isoTimestampSchema.nullable(),
    returnedAt: isoTimestampSchema.nullable(),
    closeReason: borrowCloseReasonSchema.nullable(),
    notes: z.string().nullable(),
    actor: nonEmptyString,
    createdAt: isoTimestampSchema,
  })
  .strict();

export type BorrowRecord = z.output<typeof borrowRecordSchema>;

export const openBorrowSummarySchema = z
  .object({
    id: nonEmptyString,
    instanceId: nonEmptyString,
    borrower: nonEmptyString,
    borrowedAt: isoTimestampSchema,
    dueAt: isoTimestampSchema.nullable(),
    isOverdue: z.boolean(),
  })
  .strict();

export type OpenBorrowSummary = z.output<typeof openBorrowSummarySchema>;

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
    currentBorrow: openBorrowSummarySchema.nullable(),
    canReverseIngest: z.boolean(),
    canEditSharedType: z.boolean(),
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
    autoIncremented: z.boolean().optional(),
    canReverseIngest: z.boolean(),
    canEditSharedType: z.boolean(),
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
export type CorrectionTargetKind = z.output<typeof correctionTargetKindSchema>;
export type CorrectionKind = z.output<typeof correctionKindSchema>;
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
export type SharedAssignRequest = z.output<typeof sharedAssignRequestSchema>;
export type BulkAssignQrsRequest = z.output<typeof bulkAssignQrsRequestSchema>;
export type BulkAssignQrsCommand = z.output<typeof bulkAssignQrsCommandSchema>;
export type BulkEntityTarget = z.output<typeof bulkEntityTargetSchema>;
export type BulkMoveEntitiesRequest = z.output<typeof bulkMoveEntitiesRequestSchema>;
export type BulkMoveEntitiesCommand = z.output<typeof bulkMoveEntitiesCommandSchema>;
export type BulkReverseIngestTarget = z.output<typeof bulkReverseIngestTargetSchema>;
export type BulkReverseIngestRequest = z.output<typeof bulkReverseIngestRequestSchema>;
export type BulkReverseIngestCommand = z.output<typeof bulkReverseIngestCommandSchema>;
export type RecordEventRequest = z.output<typeof recordEventRequestSchema>;
export type RecordEventCommand = z.output<typeof recordEventCommandSchema>;
export type CorrectionEvent = z.output<typeof correctionEventSchema>;
export type ReassignEntityPartTypeRequest = z.output<typeof reassignEntityPartTypeRequestSchema>;
export type ReassignEntityPartTypeCommand = z.output<typeof reassignEntityPartTypeCommandSchema>;
export type EditPartTypeDefinitionRequest = z.output<typeof editPartTypeDefinitionRequestSchema>;
export type EditPartTypeDefinitionCommand = z.output<typeof editPartTypeDefinitionCommandSchema>;
export type ReverseIngestAssignmentRequest = z.output<typeof reverseIngestAssignmentRequestSchema>;
export type ReverseIngestAssignmentCommand = z.output<typeof reverseIngestAssignmentCommandSchema>;
export type CorrectionHistoryQuery = z.output<typeof correctionHistoryQuerySchema>;
export type ReassignEntityPartTypeResponse = z.output<typeof reassignEntityPartTypeResponseSchema>;
export type EditPartTypeDefinitionResponse = z.output<typeof editPartTypeDefinitionResponseSchema>;
export type ReverseIngestAssignmentResponse = z.output<typeof reverseIngestAssignmentResponseSchema>;
export type BulkAssignQrsResponse = z.output<typeof bulkAssignQrsResponseSchema>;
export type BulkMoveEntitiesResponse = z.output<typeof bulkMoveEntitiesResponseSchema>;
export type BulkReverseIngestResponse = z.output<typeof bulkReverseIngestResponseSchema>;
export type MergePartTypesRequest = z.output<typeof mergePartTypesRequestSchema>;
export type PartTypeSearchQuery = z.output<typeof partTypeSearchQuerySchema>;
export type PartDbDiscoveredResources = z.output<typeof partDbDiscoveredResourcesSchema>;
export type PartDbConnectionStatus = z.output<typeof partDbConnectionStatusSchema>;
export type PartDbLookupSummary = z.output<typeof partDbLookupSummarySchema>;
export type PartDbSyncStatusResponse = z.output<typeof partDbSyncStatusResponseSchema>;
export type PartDbSyncFailure = z.output<typeof partDbSyncFailureSchema>;
export type PartDbSyncDrainResponse = z.output<typeof partDbSyncDrainResponseSchema>;
export type PartDbSyncBackfillResponse = z.output<typeof partDbSyncBackfillResponseSchema>;
export type ApplicationErrorResponse = z.output<typeof applicationErrorResponseSchema>;
export type ScanResponse = z.output<typeof scanResponseSchema>;

export const configEnvironmentSchema = z
  .object({
    PORT: z.coerce.number().int().positive().default(4000),
    FRONTEND_ORIGIN: nonEmptyString.default("http://localhost:5173"),
    PUBLIC_BASE_URL: nonEmptyString.default("http://localhost:4000"),
    SMART_DB_DATA_PATH: nonEmptyString.optional(),
    PARTDB_BASE_URL: normalizedOptionalString,
    PARTDB_PUBLIC_BASE_URL: normalizedOptionalString,
    PARTDB_API_TOKEN: normalizedOptionalString,
    PARTDB_SYNC_ENABLED: booleanEnvironmentSchema.default(false),
    SESSION_COOKIE_SECRET: normalizedOptionalString,
    ZITADEL_ISSUER: normalizedOptionalString,
    ZITADEL_CLIENT_ID: normalizedOptionalString,
    ZITADEL_CLIENT_SECRET: normalizedOptionalString,
    ZITADEL_ROLE_CLAIM: normalizedOptionalString,
  })
  .strict();

export type ConfigEnvironment = z.output<typeof configEnvironmentSchema>;
