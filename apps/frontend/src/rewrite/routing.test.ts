import { describe, expect, it } from "vitest";
import { patchFromUrl, urlFromState, urlsEqual } from "./routing";
import type { RewriteUiState } from "./ui-state";
import { defaultInventoryUiState } from "./ui-state";

function makeState(overrides: Partial<RewriteUiState>): RewriteUiState {
  return {
    activeTab: "scan",
    inventoryUi: defaultInventoryUiState,
    authState: { status: "authenticated", session: {
      subject: "u",
      username: "u",
      name: "u",
      email: "u@example.com",
      roles: [],
      issuedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: null,
    }, error: null },
    ...overrides,
  } as RewriteUiState;
}

describe("routing", () => {
  it("maps scan tab to /scan", () => {
    expect(urlFromState(makeState({ activeTab: "scan" }))).toBe("/scan");
  });

  it("maps dashboard tab to /dashboard", () => {
    expect(urlFromState(makeState({ activeTab: "dashboard" }))).toBe("/dashboard");
  });

  it("maps stock root to /stock", () => {
    expect(urlFromState(makeState({ activeTab: "inventory" }))).toBe("/stock");
  });

  it("encodes browse path into /stock/...", () => {
    const state = makeState({
      activeTab: "inventory",
      inventoryUi: { ...defaultInventoryUiState, browsePath: ["Electronics", "Boards"] },
    });
    expect(urlFromState(state)).toBe("/stock/Electronics/Boards");
  });

  it("percent-encodes browse path segments", () => {
    const state = makeState({
      activeTab: "inventory",
      inventoryUi: { ...defaultInventoryUiState, browsePath: ["3D Printing"] },
    });
    expect(urlFromState(state)).toBe("/stock/3D%20Printing");
  });

  it("appends /detail/<id> when a part detail is open", () => {
    const state = makeState({
      activeTab: "inventory",
      inventoryUi: {
        ...defaultInventoryUiState,
        browsePath: ["Boards"],
        detailPartTypeId: "arduino-uno-r3",
      },
    });
    expect(urlFromState(state)).toBe("/stock/Boards/detail/arduino-uno-r3");
  });

  it("returns null on root path (no hydration needed)", () => {
    expect(patchFromUrl("/")).toBeNull();
  });

  it("returns null on unknown path", () => {
    expect(patchFromUrl("/nope")).toBeNull();
  });

  it("parses /scan to scan tab", () => {
    expect(patchFromUrl("/scan")).toEqual({
      activeTab: "scan",
      browsePath: [],
      detailPartTypeId: null,
    });
  });

  it("parses /stock root", () => {
    expect(patchFromUrl("/stock")).toEqual({
      activeTab: "inventory",
      browsePath: [],
      detailPartTypeId: null,
    });
  });

  it("parses /stock/Boards/Arduino into browsePath", () => {
    expect(patchFromUrl("/stock/Boards/Arduino")).toEqual({
      activeTab: "inventory",
      browsePath: ["Boards", "Arduino"],
      detailPartTypeId: null,
    });
  });

  it("parses encoded segments", () => {
    expect(patchFromUrl("/stock/3D%20Printing/PLA")).toEqual({
      activeTab: "inventory",
      browsePath: ["3D Printing", "PLA"],
      detailPartTypeId: null,
    });
  });

  it("parses detail segment", () => {
    expect(patchFromUrl("/stock/Boards/detail/arduino-uno-r3")).toEqual({
      activeTab: "inventory",
      browsePath: ["Boards"],
      detailPartTypeId: "arduino-uno-r3",
    });
  });

  it("urlsEqual handles trailing slash normalization", () => {
    expect(urlsEqual("/stock", "/stock/")).toBe(true);
    expect(urlsEqual("/stock", "/scan")).toBe(false);
  });
});
