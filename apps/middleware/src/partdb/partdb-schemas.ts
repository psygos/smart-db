import { z } from "zod";

const partDbIriSchema = z.string().regex(/^\/api\/[a-z_]+\/\d+$/);
const partDbIdSchema = z.number().int().positive();

export const partDbCategoryResponseSchema = z.object({
  "@id": partDbIriSchema,
  id: partDbIdSchema,
  name: z.string(),
  parent: z.string().nullable().optional(),
  full_path: z.string().optional(),
});

export const partDbPartResponseSchema = z.object({
  "@id": partDbIriSchema,
  id: partDbIdSchema,
  name: z.string(),
  category: z.union([partDbIriSchema, partDbCategoryResponseSchema, z.null()]),
  description: z.string().optional(),
  tags: z.string().optional(),
  needs_review: z.boolean().optional(),
});

export const partDbLotResponseSchema = z.object({
  "@id": partDbIriSchema,
  id: partDbIdSchema,
  amount: z.number(),
  description: z.string().optional(),
  user_barcode: z.string().nullable().optional(),
  instock_unknown: z.boolean().optional(),
  storage_location: z
    .union([partDbIriSchema, z.object({ "@id": partDbIriSchema }), z.null()])
    .optional(),
});

export const partDbStorageLocationResponseSchema = z.object({
  "@id": partDbIriSchema,
  id: partDbIdSchema,
  name: z.string(),
  parent: z
    .union([partDbIriSchema, z.object({ "@id": partDbIriSchema }), z.null()])
    .optional(),
});

export const partDbMeasurementUnitResponseSchema = z.object({
  "@id": partDbIriSchema,
  id: partDbIdSchema,
  name: z.string(),
  unit: z.string().optional(),
  is_integer: z.boolean().optional(),
});

export const partDbErrorResponseSchema = z.object({
  "@type": z.string().optional(),
  title: z.string().optional(),
  detail: z.string().optional(),
  violations: z
    .array(
      z.object({
        propertyPath: z.string(),
        message: z.string(),
        code: z.string().optional(),
      }),
    )
    .optional(),
  status: z.number().optional(),
});

export type PartDbCategoryResponse = z.output<typeof partDbCategoryResponseSchema>;
export type PartDbPartResponse = z.output<typeof partDbPartResponseSchema>;
export type PartDbLotResponse = z.output<typeof partDbLotResponseSchema>;
export type PartDbStorageLocationResponse = z.output<typeof partDbStorageLocationResponseSchema>;
export type PartDbMeasurementUnitResponse = z.output<typeof partDbMeasurementUnitResponseSchema>;
export type PartDbErrorResponse = z.output<typeof partDbErrorResponseSchema>;
