import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { buildQrBatchLabelsPdf, qrBatchLabelInternals } from "./qr-batch-labels";

describe("qr batch labels pdf", () => {
  it("builds a valid pdf for a single page of labels", async () => {
    const pdfBytes = await buildQrBatchLabelsPdf({
      id: "batch-1",
      prefix: "QR",
      startNumber: 1001,
      endNumber: 1003,
      actor: "labeler",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    expect(Buffer.from(pdfBytes).subarray(0, 4).toString("utf8")).toBe("%PDF");
    const pdf = await PDFDocument.load(pdfBytes);
    expect(pdf.getPageCount()).toBe(1);
  });

  it("paginates when the batch exceeds a single sheet", { timeout: 30_000 }, async () => {
    const perPage = qrBatchLabelInternals.labelsPerPage;
    const pdfBytes = await buildQrBatchLabelsPdf({
      id: "batch-2",
      prefix: "QR",
      startNumber: 1,
      endNumber: perPage + 1,
      actor: "labeler",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    const pdf = await PDFDocument.load(pdfBytes);
    expect(pdf.getPageCount()).toBe(2);
  });
});
