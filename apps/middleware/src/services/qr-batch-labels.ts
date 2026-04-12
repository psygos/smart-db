import QRCode from "qrcode";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import type { QrBatch } from "@smart-db/contracts";

// ── A4 page constants ──────────────────────────────────────────────
const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MM = 2.834645669;          // 1 mm in PDF points
const MARGIN = 10 * MM;          // 10mm margin all sides

const COLUMNS = 6;
const ROWS = 15;

// Cells touch — borders are shared (no gap)
const USABLE_W = PAGE_WIDTH - 2 * MARGIN;
const USABLE_H = PAGE_HEIGHT - 2 * MARGIN;
const CELL_W = USABLE_W / COLUMNS;
const CELL_H = USABLE_H / ROWS;

const LABEL_H = 8 * MM;          // 8mm bottom strip for code text
const CELL_PAD = 2;              // 2pt internal padding around QR
const FONT_SIZE = Math.min(7, LABEL_H * 0.55);

export async function buildQrBatchLabelsPdf(batch: QrBatch): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const codes = codesForBatch(batch);

  // Pre-generate QR images in parallel
  const images = await Promise.all(
    codes.map((code) => embedQrImage(pdf, code)),
  );

  let page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  const labelsPerPage = COLUMNS * ROWS;

  for (let i = 0; i < codes.length; i++) {
    if (i > 0 && i % labelsPerPage === 0) {
      page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    }

    const slot = i % labelsPerPage;
    const col = slot % COLUMNS;
    const row = Math.floor(slot / COLUMNS);

    // Bottom-left of the cell (PDF origin is bottom-left)
    const x = MARGIN + col * CELL_W;
    const y = PAGE_HEIGHT - MARGIN - (row + 1) * CELL_H;

    // Cell border — adjacent cells share edges, single line where they meet
    page.drawRectangle({
      x,
      y,
      width: CELL_W,
      height: CELL_H,
      borderWidth: 0.5,
      borderColor: rgb(0, 0, 0),
    });

    // QR image — centred above the label strip
    const code = codes[i]!;
    const qrAreaH = CELL_H - LABEL_H;
    const qrSize = Math.min(CELL_W - 2 * CELL_PAD, qrAreaH - 2 * CELL_PAD);
    const qrX = x + (CELL_W - qrSize) / 2;
    const qrY = y + LABEL_H + (qrAreaH - qrSize) / 2;

    page.drawImage(images[i]!, {
      x: qrX,
      y: qrY,
      width: qrSize,
      height: qrSize,
    });

    // Code text — centred in the bottom label strip
    const codeWidth = bold.widthOfTextAtSize(code, FONT_SIZE);
    page.drawText(code, {
      x: x + (CELL_W - codeWidth) / 2,
      y: y + (LABEL_H - FONT_SIZE) / 2,
      size: FONT_SIZE,
      font: bold,
      color: rgb(0, 0, 0),
    });
  }

  // Footer on page 1 with batch metadata
  const meta = `${batch.id}  |  ${batch.prefix}-${batch.startNumber}  to  ${batch.prefix}-${batch.endNumber}  |  ${codes.length} labels`;
  const firstPage = pdf.getPage(0);
  firstPage.drawText(meta, {
    x: MARGIN,
    y: MARGIN / 2 - 2,
    size: 5.5,
    font,
    color: rgb(0.55, 0.57, 0.6),
  });

  return pdf.save();
}

export const qrBatchLabelInternals = {
  codesForBatch,
  labelsPerPage: COLUMNS * ROWS,
};

function codesForBatch(batch: QrBatch): string[] {
  const codes: string[] = [];
  for (let n = batch.startNumber; n <= batch.endNumber; n++) {
    codes.push(`${batch.prefix}-${n}`);
  }
  return codes;
}

async function embedQrImage(pdf: PDFDocument, code: string) {
  const buffer = await (QRCode as unknown as { toBuffer: (text: string, opts: Record<string, unknown>) => Promise<Buffer> }).toBuffer(code, {
    errorCorrectionLevel: "M",
    margin: 1,
    width: 256,
    color: { dark: "#000000", light: "#FFFFFF" },
  });
  return pdf.embedPng(buffer);
}
