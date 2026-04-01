import QRCode from "qrcode";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import type { QrBatch } from "@smart-db/contracts";

const pageWidth = 595.28; // A4 portrait
const pageHeight = 841.89;
const margin = 24;
const columns = 3;
const rows = 7;
const horizontalGap = 8;
const verticalGap = 8;
const labelWidth = (pageWidth - margin * 2 - horizontalGap * (columns - 1)) / columns;
const labelHeight = (pageHeight - margin * 2 - verticalGap * (rows - 1)) / rows;
const qrSize = 88;

export async function buildQrBatchLabelsPdf(batch: QrBatch): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const codes = codesForBatch(batch);

  let page = pdf.addPage([pageWidth, pageHeight]);
  for (let index = 0; index < codes.length; index += 1) {
    if (index > 0 && index % (columns * rows) === 0) {
      page = pdf.addPage([pageWidth, pageHeight]);
    }

    const slot = index % (columns * rows);
    const column = slot % columns;
    const row = Math.floor(slot / columns);
    const x = margin + column * (labelWidth + horizontalGap);
    const y = pageHeight - margin - (row + 1) * labelHeight - row * verticalGap;
    const code = codes[index]!;
    const image = await embedQrImage(pdf, code);

    page.drawRectangle({
      x,
      y,
      width: labelWidth,
      height: labelHeight,
      borderWidth: 0.75,
      borderColor: rgb(0.78, 0.8, 0.84),
      color: rgb(1, 1, 1),
    });

    page.drawImage(image, {
      x: x + (labelWidth - qrSize) / 2,
      y: y + 24,
      width: qrSize,
      height: qrSize,
    });

    page.drawText(code, {
      x: x + 10,
      y: y + 12,
      size: 9.5,
      font: bold,
      color: rgb(0.1, 0.12, 0.16),
      maxWidth: labelWidth - 20,
    });

    if (row === 0) {
      page.drawText(batch.id, {
        x: x + 10,
        y: y + labelHeight - 12,
        size: 6.5,
        font,
        color: rgb(0.45, 0.47, 0.5),
        maxWidth: labelWidth - 20,
      });
    }
  }

  return pdf.save();
}

export const qrBatchLabelInternals = {
  codesForBatch,
  labelsPerPage: columns * rows,
};

function codesForBatch(batch: QrBatch): string[] {
  const codes: string[] = [];
  for (let number = batch.startNumber; number <= batch.endNumber; number += 1) {
    codes.push(`${batch.prefix}-${number}`);
  }
  return codes;
}

async function embedQrImage(pdf: PDFDocument, code: string) {
  const dataUrl = await QRCode.toDataURL(code, {
    errorCorrectionLevel: "M",
    margin: 1,
    width: 256,
    color: {
      dark: "#111111",
      light: "#FFFFFF",
    },
  });
  return pdf.embedPng(dataUrl);
}
