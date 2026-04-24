import type { FastifyInstance, preHandlerAsyncHookHandler } from "fastify";
import {
  assignQrRequestSchema,
  bulkAssignQrsRequestSchema,
  bulkMoveEntitiesRequestSchema,
  bulkSplitRequestSchema,
  bulkReverseIngestRequestSchema,
  correctionHistoryQuerySchema,
  correctionListQuerySchema,
  editPartTypeDefinitionRequestSchema,
  knownCategoryRequestSchema,
  knownLocationRequestSchema,
  mergePartTypesRequestSchema,
  parseWithSchema,
  partTypeArtBackfillResponseSchema,
  partTypeSearchQuerySchema,
  reassignEntityPartTypeRequestSchema,
  recordEventRequestSchema,
  scanOptionsQuerySchema,
  registerQrBatchRequestSchema,
  reverseIngestAssignmentRequestSchema,
  scanRequestSchema,
  voidQrRequestSchema,
} from "@smart-db/contracts";
import { InventoryService } from "../services/inventory-service.js";
import type { IdempotencyHooks } from "../middleware/idempotency.js";
import { buildQrBatchLabelsPdf } from "../services/qr-batch-labels.js";

interface InventoryRouteGuards {
  requireAuth: preHandlerAsyncHookHandler;
  requireAdmin: preHandlerAsyncHookHandler;
  idempotency: IdempotencyHooks;
}

export async function registerInventoryRoutes(
  app: FastifyInstance,
  inventoryService: InventoryService,
  guards: InventoryRouteGuards,
): Promise<void> {
  const authenticated = {
    preHandler: guards.requireAuth,
  };
  const admin = {
    preHandler: guards.requireAdmin,
  };
  const adminMutation = {
    preHandler: [guards.requireAdmin, guards.idempotency.preHandler],
    onSend: [guards.idempotency.onSend],
  };
  const authenticatedMutation = {
    preHandler: [guards.requireAuth, guards.idempotency.preHandler],
    onSend: [guards.idempotency.onSend],
  };

  app.get("/health", async () => ({ ok: true }));

  app.get("/api/dashboard", authenticated, async () =>
    inventoryService.getDashboardSummary(),
  );

  app.get("/api/part-types/search", authenticated, async (request) => {
    const query = parseWithSchema(partTypeSearchQuerySchema, request.query, "part-type query");
    return inventoryService.searchPartTypes(query.q);
  });

  app.get("/api/inventory/summary", authenticated, async () =>
    inventoryService.getInventorySummary(),
  );

  app.get("/api/locations", authenticated, async () =>
    inventoryService.getKnownLocations(),
  );

  app.post("/api/locations", authenticated, async (request) => {
    const body = parseWithSchema(knownLocationRequestSchema, request.body, "known location request");
    inventoryService.createKnownLocation(body.path);
    return body;
  });

  app.get("/api/categories", authenticated, async () =>
    inventoryService.getKnownCategories(),
  );

  app.post("/api/categories", authenticated, async (request) => {
    const body = parseWithSchema(knownCategoryRequestSchema, request.body, "known category request");
    inventoryService.createKnownCategory(body.path);
    return body;
  });

  app.get("/api/part-types/:id/items", authenticated, async (request) => {
    const params = request.params as { id: string };
    return inventoryService.getPartTypeItems(params.id);
  });

  app.get("/api/part-types/provisional", admin, async () =>
    inventoryService.getProvisionalPartTypes(),
  );

  app.get("/api/corrections/history", admin, async (request) => {
    const query = parseWithSchema(correctionHistoryQuerySchema, request.query, "correction history query");
    return inventoryService.getCorrectionHistory(query.targetType, query.targetId);
  });

  app.get("/api/corrections", admin, async (request) => {
    const query = parseWithSchema(correctionListQuerySchema, request.query, "correction list query");
    return inventoryService.listCorrectionEvents(query.limit);
  });

  app.post("/api/qr-batches", adminMutation, async (request) => {
    const command = parseWithSchema(
      registerQrBatchRequestSchema,
      request.body,
      "register QR batch request",
    );
    return inventoryService.registerQrBatch({
      ...command,
      actor: request.authContext!.session.username,
    });
  });

  app.get("/api/qr-batches/latest", admin, async () =>
    inventoryService.getLatestQrBatch(),
  );

  app.get("/api/qr-batches/:id/labels.pdf", admin, async (request, reply) => {
    const params = request.params as { id: string };
    const batch = inventoryService.getQrBatchById(params.id);
    const pdf = await buildQrBatchLabelsPdf(batch);
    return reply
      .header("Content-Type", "application/pdf")
      .header("Content-Disposition", `attachment; filename="${safeBatchLabelsFilename(batch.id)}"`)
      .send(Buffer.from(pdf));
  });

  app.post("/api/scan", authenticated, async (request) => {
    const command = parseWithSchema(scanRequestSchema, request.body, "scan request");
    const query = parseWithSchema(scanOptionsQuerySchema, request.query, "scan options query");
    return inventoryService.scanCode(
      command.code,
      request.authContext?.session.username ?? null,
      { autoIncrement: query.count, incrementAmount: query.amount },
    );
  });

  app.post("/api/assignments", authenticatedMutation, async (request) => {
    const command = parseWithSchema(assignQrRequestSchema, request.body, "assignment request");
    return inventoryService.assignQr({
      ...command,
      actor: request.authContext!.session.username,
    });
  });

  app.post("/api/bulk/assign", authenticatedMutation, async (request) => {
    const command = parseWithSchema(bulkAssignQrsRequestSchema, request.body, "bulk assignment request");
    return inventoryService.bulkAssignQrs({
      ...command,
      actor: request.authContext!.session.username,
    });
  });

  app.post("/api/events", authenticatedMutation, async (request) => {
    const command = parseWithSchema(recordEventRequestSchema, request.body, "stock event request");
    return inventoryService.recordEvent({
      ...command,
      actor: request.authContext!.session.username,
    });
  });

  app.post("/api/bulk/move", authenticatedMutation, async (request) => {
    const command = parseWithSchema(bulkMoveEntitiesRequestSchema, request.body, "bulk move request");
    return inventoryService.bulkMoveEntities({
      ...command,
      actor: request.authContext!.session.username,
    });
  });

  app.post("/api/bulk-stocks/:id/split", authenticatedMutation, async (request) => {
    const params = request.params as { id: string };
    const body = parseWithSchema(bulkSplitRequestSchema, request.body, "bulk split request");
    return inventoryService.splitBulkStock(
      params.id,
      body.quantity,
      body.destinationLocation,
      request.authContext!.session.username,
      body.notes,
    );
  });

  app.post("/api/part-types/merge", adminMutation, async (request) => {
    const command = parseWithSchema(
      mergePartTypesRequestSchema,
      request.body,
      "merge part types request",
    );
    return inventoryService.mergePartTypes(command);
  });

  app.post("/api/qr-codes/:code/void", adminMutation, async (request) => {
    const params = request.params as { code: string };
    /* v8 ignore next -- Fastify always parses JSON body for POST */
    parseWithSchema(voidQrRequestSchema, request.body ?? {}, "void QR request");
    return inventoryService.voidQrCode(params.code, request.authContext!.session.username);
  });

  app.post("/api/part-types/:id/approve", adminMutation, async (request) => {
    const params = request.params as { id: string };
    return inventoryService.approvePartType(params.id);
  });

  app.post("/api/part-types/art/backfill", adminMutation, async () =>
    parseWithSchema(
      partTypeArtBackfillResponseSchema,
      inventoryService.backfillPartTypeArt(),
      "part type art backfill response",
    ),
  );

  app.post("/api/corrections/reassign-part-type", adminMutation, async (request) => {
    const command = parseWithSchema(
      reassignEntityPartTypeRequestSchema,
      request.body,
      "reassign entity part type request",
    );
    return inventoryService.reassignEntityPartType({
      ...command,
      actor: request.authContext!.session.username,
    });
  });

  app.post("/api/corrections/edit-part-type", adminMutation, async (request) => {
    const command = parseWithSchema(
      editPartTypeDefinitionRequestSchema,
      request.body,
      "edit part type definition request",
    );
    return inventoryService.editPartTypeDefinition({
      ...command,
      actor: request.authContext!.session.username,
    });
  });

  app.post("/api/corrections/reverse-ingest", adminMutation, async (request) => {
    const command = parseWithSchema(
      reverseIngestAssignmentRequestSchema,
      request.body,
      "reverse ingest request",
    );
    return inventoryService.reverseIngestAssignment({
      ...command,
      actor: request.authContext!.session.username,
    });
  });

  app.post("/api/bulk/reverse-ingest", adminMutation, async (request) => {
    const command = parseWithSchema(
      bulkReverseIngestRequestSchema,
      request.body,
      "bulk reverse ingest request",
    );
    return inventoryService.bulkReverseIngest({
      ...command,
      actor: request.authContext!.session.username,
    });
  });

  app.get("/api/partdb/status", authenticated, async () =>
    inventoryService.getPartDbStatus(),
  );
}

function safeBatchLabelsFilename(batchId: string): string {
  const sanitized = batchId.replace(/[^A-Za-z0-9._-]+/g, "_");
  return `${sanitized || "batch"}-labels.pdf`;
}
