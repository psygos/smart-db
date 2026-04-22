import { describe, expect, it } from "vitest";
import {
  appendTreeChild,
  buildTreePickerView,
  parentTreePath,
  parseTreePath,
  serializeTreePath,
} from "./tree-picker";

const knownPaths = [
  "Electronics",
  "Electronics / Resistors",
  "Electronics / Resistors / SMD 0603",
  "Electronics / Resistors / Through-hole",
  "Electronics / Capacitors",
  "Materials",
  "Materials / 3D Printing",
];

describe("tree-picker", () => {
  it("parses and re-serialises a path without mangling segments", () => {
    const segments = parseTreePath("Electronics / Resistors / SMD 0603");
    expect(segments).toEqual(["Electronics", "Resistors", "SMD 0603"]);
    expect(serializeTreePath(segments)).toBe("Electronics / Resistors / SMD 0603");
  });

  it("returns root-level children when no current path is selected", () => {
    const view = buildTreePickerView(knownPaths, "");
    expect(view.currentPath).toEqual([]);
    expect(view.breadcrumb).toEqual([]);
    expect(view.children.map((child) => child.segment)).toEqual(["Electronics", "Materials"]);
    expect(view.matchesKnownPath).toBe(false);
  });

  it("drills into a branch and exposes grandchildren flags", () => {
    const view = buildTreePickerView(knownPaths, "Electronics");
    expect(view.breadcrumb).toEqual([
      { segment: "Electronics", pathUpToHere: "Electronics" },
    ]);
    expect(view.children).toEqual([
      { segment: "Capacitors", fullPath: "Electronics / Capacitors", hasChildren: false, isKnownLeaf: true },
      { segment: "Resistors", fullPath: "Electronics / Resistors", hasChildren: true, isKnownLeaf: true },
    ]);
  });

  it("reports a leaf when the current path has no descendants in the known set", () => {
    const view = buildTreePickerView(knownPaths, "Electronics / Resistors / SMD 0603");
    expect(view.children).toEqual([]);
    expect(view.matchesKnownPath).toBe(true);
  });

  it("matches current path case-insensitively against known paths", () => {
    const view = buildTreePickerView(knownPaths, "electronics / RESISTORS");
    expect(view.matchesKnownPath).toBe(true);
    expect(view.children.map((child) => child.segment)).toEqual(["SMD 0603", "Through-hole"]);
  });

  it("appends a trimmed child segment and ignores empty input", () => {
    expect(appendTreeChild("Electronics / Resistors", "SMD 0805")).toBe(
      "Electronics / Resistors / SMD 0805",
    );
    expect(appendTreeChild("Electronics", "   ")).toBe("Electronics");
  });

  it("returns the parent path or an empty string at the root", () => {
    expect(parentTreePath("Electronics / Resistors")).toBe("Electronics");
    expect(parentTreePath("Electronics")).toBe("");
    expect(parentTreePath("")).toBe("");
  });
});
