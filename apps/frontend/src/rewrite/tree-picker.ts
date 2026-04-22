export interface TreePickerBreadcrumbEntry {
  readonly segment: string;
  readonly pathUpToHere: string;
}

export interface TreePickerChild {
  readonly segment: string;
  readonly fullPath: string;
  readonly hasChildren: boolean;
  readonly isKnownLeaf: boolean;
}

export interface TreePickerView {
  readonly currentPath: readonly string[];
  readonly currentSerialized: string;
  readonly breadcrumb: readonly TreePickerBreadcrumbEntry[];
  readonly children: readonly TreePickerChild[];
  readonly matchesKnownPath: boolean;
}

const SEPARATOR = " / ";

export function parseTreePath(serialized: string): readonly string[] {
  if (!serialized || serialized.trim().length === 0) {
    return [];
  }
  return serialized
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

export function serializeTreePath(segments: readonly string[]): string {
  return segments.join(SEPARATOR);
}

export function buildTreePickerView(
  knownPaths: readonly string[],
  currentSerialized: string,
): TreePickerView {
  const currentPath = parseTreePath(currentSerialized);
  const serializedPaths = knownPaths
    .map((path) => parseTreePath(path))
    .filter((segments) => segments.length > 0);

  const breadcrumb: TreePickerBreadcrumbEntry[] = currentPath.map((segment, index) => ({
    segment,
    pathUpToHere: serializeTreePath(currentPath.slice(0, index + 1)),
  }));

  const childMap = new Map<string, { segment: string; hasChildren: boolean; isKnownLeaf: boolean }>();
  const matchesKnownPath = serializedPaths.some((segments) =>
    segments.length === currentPath.length &&
    segments.every((seg, index) => seg.toLowerCase() === (currentPath[index] ?? "").toLowerCase()),
  );

  for (const segments of serializedPaths) {
    if (segments.length <= currentPath.length) {
      continue;
    }
    const matchesPrefix = currentPath.every(
      (seg, index) => seg.toLowerCase() === (segments[index] ?? "").toLowerCase(),
    );
    if (!matchesPrefix) {
      continue;
    }
    const childSegment = segments[currentPath.length];
    if (!childSegment) {
      continue;
    }
    const key = childSegment.toLowerCase();
    const existing = childMap.get(key);
    const hasChildren = segments.length > currentPath.length + 1;
    const isKnownLeaf = segments.length === currentPath.length + 1;
    if (existing) {
      childMap.set(key, {
        segment: existing.segment,
        hasChildren: existing.hasChildren || hasChildren,
        isKnownLeaf: existing.isKnownLeaf || isKnownLeaf,
      });
    } else {
      childMap.set(key, { segment: childSegment, hasChildren, isKnownLeaf });
    }
  }

  const children: TreePickerChild[] = Array.from(childMap.values())
    .sort((a, b) => a.segment.localeCompare(b.segment))
    .map((child) => ({
      segment: child.segment,
      fullPath: serializeTreePath([...currentPath, child.segment]),
      hasChildren: child.hasChildren,
      isKnownLeaf: child.isKnownLeaf,
    }));

  return {
    currentPath,
    currentSerialized: serializeTreePath(currentPath),
    breadcrumb,
    children,
    matchesKnownPath,
  };
}

export function appendTreeChild(currentSerialized: string, child: string): string {
  const trimmed = child.trim();
  if (trimmed.length === 0) {
    return currentSerialized;
  }
  const segments = parseTreePath(currentSerialized);
  return serializeTreePath([...segments, trimmed]);
}

export function parentTreePath(currentSerialized: string): string {
  const segments = parseTreePath(currentSerialized);
  if (segments.length === 0) {
    return "";
  }
  return serializeTreePath(segments.slice(0, -1));
}
