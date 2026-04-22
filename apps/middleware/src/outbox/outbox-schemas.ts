import { z } from "zod";

const targetSchema = z
  .object({
    table: z.enum(["part_types", "physical_instances", "bulk_stocks"]),
    rowId: z.string().trim().min(1),
    column: z.enum([
      "partdb_part_id",
      "partdb_lot_id",
      "partdb_category_id",
      "partdb_unit_id",
    ]),
  })
  .strict();

const createCategoryPayloadSchema = z
  .object({
    path: z.array(z.string().trim().min(1)).min(1),
    parentIri: z.string().trim().nullable(),
  })
  .strict();

const createMeasurementUnitPayloadSchema = z
  .object({
    name: z.string().trim().min(1),
    symbol: z.string().trim().min(1).max(10),
    isInteger: z.boolean(),
  })
  .strict();

const createPartPayloadSchema = z
  .object({
    name: z.string().trim().min(1),
    categoryIri: z.string().trim().nullable(),
    categoryPath: z.array(z.string().trim().min(1)).min(1),
    unitIri: z.string().trim().nullable(),
    unit: createMeasurementUnitPayloadSchema,
    description: z.string(),
    tags: z.array(z.string()),
    needsReview: z.boolean(),
    minAmount: z.number().nullable(),
  })
  .strict();

const updatePartPayloadSchema = z
  .object({
    partIri: z.string().trim().nullable(),
    patch: z
      .object({
        name: z.string().trim().min(1).optional(),
        categoryIri: z.string().trim().nullable().optional(),
        categoryPath: z.array(z.string().trim().min(1)).min(1).optional(),
        unitIri: z.string().trim().nullable().optional(),
        unit: createMeasurementUnitPayloadSchema.optional(),
        description: z.string().optional(),
        tags: z.array(z.string()).optional(),
      })
      .strict(),
  })
  .strict();

const createStorageLocationPayloadSchema = z
  .object({
    name: z.string().trim().min(1),
  })
  .strict();

const deletePartPayloadSchema = z
  .object({
    partIri: z.string().trim().nullable(),
  })
  .strict();

const createLotPayloadSchema = z
  .object({
    partIri: z.string().trim().nullable(),
    storageLocationName: z.string().trim().min(1),
    storageLocationPath: z.array(z.string().trim().min(1)).min(1).optional(),
    amount: z.number().nonnegative(),
    description: z.string(),
    userBarcode: z.string().trim().min(1),
    instockUnknown: z.boolean(),
  })
  .strict();

const updateLotPayloadSchema = z
  .object({
    lotIri: z.string().trim().nullable(),
    patch: z
      .object({
        amount: z.number().optional(),
        storageLocationName: z.string().trim().min(1).optional(),
        storageLocationPath: z.array(z.string().trim().min(1)).min(1).optional(),
        description: z.string().optional(),
      })
      .strict(),
  })
  .strict();

const deleteLotPayloadSchema = z
  .object({
    lotIri: z.string().trim().nullable(),
  })
  .strict();

export const outboxOperationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("create_category"), payload: createCategoryPayloadSchema, target: targetSchema.nullable(), dependsOnId: z.string().trim().min(1).nullable() }).strict(),
  z.object({ kind: z.literal("create_measurement_unit"), payload: createMeasurementUnitPayloadSchema, target: targetSchema, dependsOnId: z.null() }).strict(),
  z.object({ kind: z.literal("create_part"), payload: createPartPayloadSchema, target: targetSchema, dependsOnId: z.string().trim().min(1).nullable() }).strict(),
  z.object({ kind: z.literal("update_part"), payload: updatePartPayloadSchema, target: targetSchema.nullable(), dependsOnId: z.string().trim().min(1).nullable() }).strict(),
  z.object({ kind: z.literal("create_storage_location"), payload: createStorageLocationPayloadSchema, target: z.null(), dependsOnId: z.null() }).strict(),
  z.object({ kind: z.literal("delete_part"), payload: deletePartPayloadSchema, target: z.null(), dependsOnId: z.string().trim().min(1).nullable() }).strict(),
  z.object({ kind: z.literal("create_lot"), payload: createLotPayloadSchema, target: targetSchema, dependsOnId: z.string().trim().min(1).nullable() }).strict(),
  z.object({ kind: z.literal("update_lot"), payload: updateLotPayloadSchema, target: targetSchema.nullable(), dependsOnId: z.string().trim().min(1).nullable() }).strict(),
  z.object({ kind: z.literal("delete_lot"), payload: deleteLotPayloadSchema, target: targetSchema.nullable(), dependsOnId: z.string().trim().min(1).nullable() }).strict(),
]);
