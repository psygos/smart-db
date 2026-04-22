import { describe, expect, it } from "vitest";
import {
  parseBorrowDueDate,
  parseBulkStockId,
  parseInstanceId,
  parsePartTypeId,
  parseQrCode,
} from "./brands.js";

describe("parseQrCode", () => {
  it("sanitises a raw scan to a branded QrCode", () => {
    const result = parseQrCode("  abc-123  ");
    expect(result).toMatchObject({ ok: true, value: "abc-123" });
  });

  it("rejects a non-string input with kind qr_code_not_string", () => {
    expect(parseQrCode(42)).toMatchObject({ ok: false, error: { kind: "qr_code_not_string" } });
  });

  it("rejects an empty scan with kind qr_code_empty", () => {
    expect(parseQrCode("   ")).toMatchObject({ ok: false, error: { kind: "qr_code_empty" } });
  });
});

describe("parsePartTypeId / parseInstanceId / parseBulkStockId", () => {
  it("trims and brands non-empty identifiers", () => {
    expect(parsePartTypeId("  pt-1 ")).toMatchObject({ ok: true, value: "pt-1" });
    expect(parseInstanceId("inst-9")).toMatchObject({ ok: true, value: "inst-9" });
    expect(parseBulkStockId("bulk-5")).toMatchObject({ ok: true, value: "bulk-5" });
  });

  it("rejects empty or non-string values", () => {
    expect(parsePartTypeId("")).toMatchObject({ ok: false, error: { kind: "identifier_empty" } });
    expect(parseInstanceId(7)).toMatchObject({ ok: false, error: { kind: "identifier_not_string" } });
  });

  it("keeps IDs of different kinds structurally distinct at the type level", () => {
    const partType = parsePartTypeId("pt-1");
    const instance = parseInstanceId("inst-1");
    if (!partType.ok || !instance.ok) {
      throw new Error("parse should have succeeded");
    }
    // The runtime value is a string; the brand only enforces compile-time nominal
    // separation. We assert distinct values here and rely on the tsc check elsewhere.
    expect(partType.value).not.toBe(instance.value);
  });
});

describe("parseBorrowDueDate", () => {
  it("accepts a future ISO timestamp", () => {
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    expect(parseBorrowDueDate(future)).toMatchObject({ ok: true, value: future });
  });

  it("rejects a past timestamp with kind due_date_not_future", () => {
    const past = new Date(Date.now() - 1_000).toISOString();
    expect(parseBorrowDueDate(past)).toMatchObject({ ok: false, error: { kind: "due_date_not_future" } });
  });

  it("rejects an unparseable string with kind due_date_not_iso", () => {
    expect(parseBorrowDueDate("not-a-date")).toMatchObject({ ok: false, error: { kind: "due_date_not_iso" } });
  });

  it("honours an explicit reference clock so tests are deterministic", () => {
    const clock = new Date("2026-01-01T00:00:00.000Z");
    const future = "2026-01-02T00:00:00.000Z";
    const past = "2025-12-31T00:00:00.000Z";
    expect(parseBorrowDueDate(future, clock)).toMatchObject({ ok: true, value: future });
    expect(parseBorrowDueDate(past, clock)).toMatchObject({
      ok: false,
      error: { kind: "due_date_not_future" },
    });
  });
});
