import { animate, stagger } from "animejs";
import type { RewriteUiState } from "./ui-state";

export interface MotionSnapshot {
  readonly activeTab: RewriteUiState["activeTab"];
  readonly theme: RewriteUiState["theme"];
  readonly scanKey: string;
  readonly bulkQueueCount: number;
  readonly bulkAction: string;
  readonly pendingAction: RewriteUiState["pendingAction"];
  readonly toastCount: number;
  readonly syncPending: number;
}

function scanKeyFor(state: RewriteUiState): string {
  if (state.scanMode.kind === "bulk") {
    return `bulk:${state.bulkQueue.action}:${state.bulkQueue.rows.length}`;
  }
  const result = state.scanResult;
  if (!result) {
    return "oneByOne:idle";
  }
  if (result.mode === "unknown") {
    return `unknown:${result.code}`;
  }
  if (result.mode === "label") {
    return `label:${result.qrCode.code}`;
  }
  return `interact:${result.entity.targetType}:${result.entity.id}:${result.entity.state}`;
}

export function buildMotionSnapshot(state: RewriteUiState): MotionSnapshot {
  return {
    activeTab: state.activeTab,
    theme: state.theme,
    scanKey: scanKeyFor(state),
    bulkQueueCount: state.bulkQueue.summary.totalScanCount,
    bulkAction: state.bulkQueue.action,
    pendingAction: state.pendingAction,
    toastCount: state.toasts.length,
    syncPending: state.partDbSyncStatus?.pending ?? 0,
  };
}

function shouldReduceMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

function animateSafe(targets: Element | NodeListOf<Element>, params: Parameters<typeof animate>[1]): void {
  try {
    const length = targets instanceof Element ? 1 : targets.length;
    if (length === 0) return;
    animate(targets, params);
  } catch {
    // Animation must never affect the inventory workflow.
  }
}

function animateSurface(root: HTMLElement): void {
  const surfaces = root.querySelectorAll("[data-motion-surface]");
  animateSafe(surfaces, {
    opacity: [0.78, 1],
    translateY: [8, 0],
    duration: 420,
    delay: stagger(42),
    ease: "outCubic",
  });
}

function animateScanTrace(root: HTMLElement): void {
  animateSafe(root.querySelectorAll(".scan-viewfinder-corner"), {
    opacity: [0.35, 1],
    scale: [0.94, 1],
    duration: 520,
    delay: stagger(55, { from: "center" }),
    ease: "outCubic",
  });
  animateSafe(root.querySelectorAll(".scan-trace-line"), {
    opacity: [0, 1, 0.52],
    scaleX: [0.72, 1],
    duration: 700,
    delay: stagger(80),
    ease: "outCubic",
  });
}

function animateQueuePulse(root: HTMLElement): void {
  animateSafe(root.querySelectorAll(".queue-row-stepper .stepper-value, .queue-count"), {
    scale: [1, 1.08, 1],
    color: ["var(--blue)", "var(--orange)", "var(--ink)"],
    duration: 520,
    ease: "outCubic",
  });
}

function animateSyncPulse(root: HTMLElement): void {
  animateSafe(root.querySelectorAll(".sync-status-card, .dash-health-value"), {
    translateY: [2, 0],
    opacity: [0.78, 1],
    duration: 360,
    delay: stagger(35),
    ease: "outCubic",
  });
}

function animateThemeSweep(root: HTMLElement): void {
  const shell = root.querySelector(".app-shell, .shell-auth");
  if (!shell) return;
  animateSafe(shell, {
    opacity: [0.92, 1],
    filter: ["saturate(0.86)", "saturate(1)"],
    duration: 420,
    ease: "outCubic",
  });
}

export function runPostRenderMotion(
  root: HTMLElement,
  previous: MotionSnapshot | null,
  state: RewriteUiState,
): MotionSnapshot {
  const current = buildMotionSnapshot(state);
  if (shouldReduceMotion()) {
    root.dataset.motionReduced = "true";
    return current;
  }
  delete root.dataset.motionReduced;

  const firstRender = previous === null;
  if (firstRender || previous.activeTab !== current.activeTab || previous.scanKey !== current.scanKey) {
    animateSurface(root);
  }
  if (firstRender || previous.scanKey !== current.scanKey) {
    animateScanTrace(root);
  }
  if (previous && current.bulkQueueCount > previous.bulkQueueCount) {
    animateQueuePulse(root);
  }
  if (previous && current.syncPending !== previous.syncPending) {
    animateSyncPulse(root);
  }
  if (previous && current.theme !== previous.theme) {
    animateThemeSweep(root);
  }
  if (previous && current.toastCount > previous.toastCount) {
    animateSafe(root.querySelectorAll(".toast"), {
      opacity: [0, 1],
      translateY: [10, 0],
      duration: 280,
      ease: "outCubic",
    });
  }
  return current;
}
