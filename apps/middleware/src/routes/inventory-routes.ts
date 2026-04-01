import type { FastifyInstance, preHandlerAsyncHookHandler } from "fastify";
import {
  assignQrRequestSchema,
  mergePartTypesRequestSchema,
  parseWithSchema,
  partTypeSearchQuerySchema,
  recordEventRequestSchema,
  registerQrBatchRequestSchema,
  scanRequestSchema,
  voidQrRequestSchema,
} from "@smart-db/contracts";
import { InventoryService } from "../services/inventory-service.js";
import { buildQrBatchLabelsPdf } from "../services/qr-batch-labels.js";

export async function registerInventoryRoutes(
  app: FastifyInstance,
  inventoryService: InventoryService,
  requireAuth: preHandlerAsyncHookHandler,
): Promise<void> {
  app.get("/health", async () => ({ ok: true }));

  app.get("/api/dashboard", { preHandler: requireAuth }, async () =>
    inventoryService.getDashboardSummary(),
  );

  app.get("/api/part-types/search", { preHandler: requireAuth }, async (request) => {
    const query = parseWithSchema(partTypeSearchQuerySchema, request.query, "part-type query");
    return inventoryService.searchPartTypes(query.q);
  });

  app.get("/api/part-types/provisional", { preHandler: requireAuth }, async () =>
    inventoryService.getProvisionalPartTypes(),
  );

  app.post("/api/qr-batches", { preHandler: requireAuth }, async (request) => {
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

  app.get("/api/qr-batches/latest", { preHandler: requireAuth }, async () =>
    inventoryService.getLatestQrBatch(),
  );

  app.get("/api/qr-batches/:id/labels.pdf", { preHandler: requireAuth }, async (request, reply) => {
    const params = request.params as { id: string };
    const batch = inventoryService.getQrBatchById(params.id);
    const pdf = await buildQrBatchLabelsPdf(batch);
    reply
      .header("Content-Type", "application/pdf")
      .header("Content-Disposition", `attachment; filename=\"${batch.id}-labels.pdf\"`)
      .send(Buffer.from(pdf));
  });

  app.post("/api/scan", { preHandler: requireAuth }, async (request) => {
    const command = parseWithSchema(scanRequestSchema, request.body, "scan request");
    return inventoryService.scanCode(command.code);
  });

  app.post("/api/assignments", { preHandler: requireAuth }, async (request) => {
    const command = parseWithSchema(assignQrRequestSchema, request.body, "assignment request");
    return inventoryService.assignQr({
      ...command,
      actor: request.authContext!.session.username,
    });
  });

  app.post("/api/events", { preHandler: requireAuth }, async (request) => {
    const command = parseWithSchema(recordEventRequestSchema, request.body, "stock event request");
    return inventoryService.recordEvent({
      ...command,
      actor: request.authContext!.session.username,
    });
  });

  app.post("/api/part-types/merge", { preHandler: requireAuth }, async (request) => {
    const command = parseWithSchema(
      mergePartTypesRequestSchema,
      request.body,
      "merge part types request",
    );
    return inventoryService.mergePartTypes(command);
  });

  app.post("/api/qr-codes/:code/void", { preHandler: requireAuth }, async (request) => {
    const params = request.params as { code: string };
    /* v8 ignore next -- Fastify always parses JSON body for POST */
    parseWithSchema(voidQrRequestSchema, request.body ?? {}, "void QR request");
    return inventoryService.voidQrCode(params.code, request.authContext!.session.username);
  });

  app.post("/api/part-types/:id/approve", { preHandler: requireAuth }, async (request) => {
    const params = request.params as { id: string };
    return inventoryService.approvePartType(params.id);
  });

  app.get("/api/partdb/status", { preHandler: requireAuth }, async () =>
    inventoryService.getPartDbStatus(),
  );
}
