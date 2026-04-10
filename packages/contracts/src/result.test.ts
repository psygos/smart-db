import { describe, expect, it } from "vitest";
import { Err, Ok, andThenResult, mapResult } from "./result";

describe("result helpers", () => {
  it("creates ok and err variants", () => {
    expect(Ok(42)).toEqual({ ok: true, value: 42 });
    expect(Err("boom")).toEqual({ ok: false, error: "boom" });
  });

  it("maps only ok results", () => {
    expect(mapResult(Ok(2), (value) => value * 2)).toEqual({ ok: true, value: 4 });
    expect(mapResult(Err("nope"), (value: number) => value * 2)).toEqual({
      ok: false,
      error: "nope",
    });
  });

  it("chains async continuations only for ok results", async () => {
    await expect(
      andThenResult(Ok(2), async (value) => Ok(value * 3)),
    ).resolves.toEqual({ ok: true, value: 6 });

    await expect(
      andThenResult(Err("blocked"), async (value: number) => Ok(value * 3)),
    ).resolves.toEqual({ ok: false, error: "blocked" });
  });
});
