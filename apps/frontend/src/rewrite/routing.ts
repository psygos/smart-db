import type { RewriteUiState, TabId } from "./ui-state";

export interface UrlPatch {
  readonly activeTab: TabId;
  readonly browsePath: readonly string[];
  readonly detailPartTypeId: string | null;
}

const TAB_BY_SEGMENT: Record<string, TabId> = {
  dashboard: "dashboard",
  scan: "scan",
  stock: "inventory",
  activity: "activity",
  admin: "admin",
};

const SEGMENT_BY_TAB: Record<TabId, string> = {
  dashboard: "dashboard",
  scan: "scan",
  inventory: "stock",
  activity: "activity",
  admin: "admin",
};

export function urlFromState(state: RewriteUiState): string {
  if (state.authState.status !== "authenticated") {
    return typeof window !== "undefined" ? window.location.pathname : "/";
  }
  if (state.activeTab === "inventory") {
    const segs = state.inventoryUi.browsePath.map(encodeURIComponent);
    const detailId = state.inventoryUi.detailPartTypeId;
    const parts: string[] = ["stock", ...segs];
    if (detailId) {
      parts.push("detail", encodeURIComponent(detailId));
    }
    return `/${parts.join("/")}`;
  }
  return `/${SEGMENT_BY_TAB[state.activeTab]}`;
}

export function patchFromUrl(pathname: string): UrlPatch | null {
  const segs = pathname.split("/").filter(Boolean);
  if (segs.length === 0) {
    return null;
  }
  const head = segs[0];
  if (!head) return null;
  const tab = TAB_BY_SEGMENT[head];
  if (!tab) return null;
  if (tab !== "inventory") {
    return { activeTab: tab, browsePath: [], detailPartTypeId: null };
  }
  const rest = segs.slice(1);
  const detailIdx = rest.indexOf("detail");
  if (detailIdx >= 0 && rest[detailIdx + 1]) {
    return {
      activeTab: "inventory",
      browsePath: rest.slice(0, detailIdx).map(safeDecode),
      detailPartTypeId: safeDecode(rest[detailIdx + 1]!),
    };
  }
  return {
    activeTab: "inventory",
    browsePath: rest.map(safeDecode),
    detailPartTypeId: null,
  };
}

function safeDecode(input: string): string {
  try {
    return decodeURIComponent(input);
  } catch {
    return input;
  }
}

export function urlsEqual(a: string, b: string): boolean {
  return normalizeUrl(a) === normalizeUrl(b);
}

function normalizeUrl(input: string): string {
  if (input === "") return "/";
  if (input.length > 1 && input.endsWith("/")) return input.slice(0, -1);
  return input;
}
