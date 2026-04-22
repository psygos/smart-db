import jsQR from "jsqr";
import { sanitizeScannedCode, scanLookupCompactKey } from "@smart-db/contracts";

type HTMLVideoElementWithFocusHandler = HTMLVideoElement & {
  __smartDbFocusClickHandler?: ((event: Event) => void) | undefined;
};

export type CameraScannerPermissionState = "unknown" | "granted" | "denied";

export type CameraScannerPhase =
  | "idle"
  | "requestingPermission"
  | "ready"
  | "scanning"
  | "unsupported"
  | "denied"
  | "failure";

export type CameraScannerResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly failure: CameraScannerFailure };

interface CameraScannerFailureBase {
  readonly message: string;
  readonly retryability: "never" | "safe" | "after-user-action";
  readonly cause?: unknown;
}

export interface CameraScannerCapabilityFailure extends CameraScannerFailureBase {
  readonly kind: "capability";
  readonly operation: "camera.start";
  readonly code:
    | "navigator-unavailable"
    | "mediaDevices-unavailable"
    | "getUserMedia-unavailable"
    | "insecure-context";
  readonly retryability: "never";
  readonly details: {
    readonly hasNavigator: boolean;
    readonly hasMediaDevices: boolean;
    readonly hasGetUserMedia: boolean;
    readonly secureContext: boolean | null;
  };
}

export interface CameraScannerPermissionFailure extends CameraScannerFailureBase {
  readonly kind: "permission";
  readonly operation: "camera.start";
  readonly code: "blocked" | "denied";
  readonly retryability: "after-user-action";
  readonly details: {
    readonly errorName: string;
    readonly errorMessage: string | null;
    readonly secureContext: boolean | null;
  };
}

export interface CameraScannerAcquisitionFailure extends CameraScannerFailureBase {
  readonly kind: "acquisition";
  readonly operation: "camera.start";
  readonly code: "not-found" | "not-readable" | "aborted" | "constraint" | "unknown";
  readonly retryability: "safe" | "after-user-action";
  readonly details: {
    readonly errorName: string;
    readonly errorMessage: string | null;
    readonly constraint: string | null;
  };
}

export interface CameraScannerPlaybackFailure extends CameraScannerFailureBase {
  readonly kind: "playback";
  readonly operation: "camera.attach";
  readonly code: "missing-video" | "play-rejected" | "no-stream";
  readonly retryability: "after-user-action";
  readonly details: {
    readonly hasVideoElement: boolean;
    readonly hasStream: boolean;
    readonly errorName: string | null;
    readonly errorMessage: string | null;
  };
}

export interface CameraScannerScanFailure extends CameraScannerFailureBase {
  readonly kind: "scan";
  readonly operation: "camera.scan";
  readonly code: "canvas-context-unavailable" | "frame-draw-failed" | "image-read-failed";
  readonly retryability: "safe";
  readonly details: {
    readonly errorName: string | null;
    readonly errorMessage: string | null;
  };
}

export interface CameraScannerUnexpectedFailure extends CameraScannerFailureBase {
  readonly kind: "unexpected";
  readonly operation: "camera.lifecycle";
  readonly code: "unexpected";
  readonly retryability: "never";
  readonly details: {
    readonly phase: CameraScannerPhase;
    readonly hasStream: boolean;
    readonly videoBound: boolean;
    readonly errorName: string;
    readonly errorMessage: string | null;
  };
}

export type CameraScannerFailure =
  | CameraScannerCapabilityFailure
  | CameraScannerPermissionFailure
  | CameraScannerAcquisitionFailure
  | CameraScannerPlaybackFailure
  | CameraScannerScanFailure
  | CameraScannerUnexpectedFailure;

export interface CameraScannerSnapshot {
  readonly phase: CameraScannerPhase;
  readonly supported: boolean;
  readonly permissionState: CameraScannerPermissionState;
  readonly lastResult: string | null;
  readonly activeStream: boolean;
  readonly videoBound: boolean;
  readonly failure: CameraScannerFailure | null;
}

interface BarcodeDetectorLike {
  detect(source: ImageBitmapSource): Promise<Array<{ readonly rawValue: string }>>;
}

type BarcodeDetectorConstructor = new (options?: { readonly formats?: readonly string[] }) => BarcodeDetectorLike;

export interface CameraScannerServiceOptions {
  readonly onScan: (code: string) => void;
  readonly scanIntervalMs?: number;
  readonly duplicateWindowMs?: number;
  readonly videoConstraints?: MediaStreamConstraints;
  readonly mediaDevices?: Pick<MediaDevices, "getUserMedia">;
  readonly document?: Pick<Document, "addEventListener" | "removeEventListener" | "hidden">;
  readonly now?: () => number;
  readonly setInterval?: (handler: () => void, timeout: number) => number;
  readonly clearInterval?: (handle: number) => void;
  readonly createCanvas?: () => CameraScannerCanvasLike;
  readonly loadBarcodeDetectorClass?: () => Promise<BarcodeDetectorConstructor>;
  readonly jsqr?: typeof jsQR;
  readonly logger?: Pick<Console, "warn" | "error">;
  readonly observeVisibility?: boolean;
}

interface CameraScannerCanvasContextLike {
  drawImage(
    image: CanvasImageSource,
    dx: number,
    dy: number,
    dw: number,
    dh: number,
  ): void;
  getImageData(sx: number, sy: number, sw: number, sh: number): { readonly data: Uint8ClampedArray };
}

interface CameraScannerCanvasLike {
  width: number;
  height: number;
  getContext(
    contextId: "2d",
    options?: { readonly willReadFrequently?: boolean },
  ): CameraScannerCanvasContextLike | null;
}

const DEFAULT_SCAN_INTERVAL_MS = 120;
const DEFAULT_DUPLICATE_WINDOW_MS = 3000;
const FOCUS_MODE_PRIORITY = ["continuous", "auto", "single-shot", "manual"] as const;
type FocusMode = (typeof FOCUS_MODE_PRIORITY)[number];

const DEFAULT_VIDEO_CONSTRAINTS: MediaStreamConstraints = {
  // Keep initial constraints minimal - just the facing preference. Driver-
  // specific knobs (focus/exposure/white-balance/resolution) are handled via
  // applyConstraints AFTER the track is live, because some Android camera
  // HALs reject advanced constraints at getUserMedia time with
  // OverConstrainedError, which fails the entire stream acquisition. The
  // post-start path in engageContinuousAutoTuning is always safe because each
  // applyConstraints call there is individually caught and logged.
  video: {
    facingMode: "environment",
  },
};

let defaultDetectorClassPromise: Promise<BarcodeDetectorConstructor> | null = null;

function loadDefaultBarcodeDetectorClass(): Promise<BarcodeDetectorConstructor> {
  if (!defaultDetectorClassPromise) {
    defaultDetectorClassPromise = import("barcode-detector/pure").then((module) => {
      module.setZXingModuleOverrides({
        locateFile: (path: string, _prefix: string) => (path.endsWith(".wasm") ? "/zxing_reader.wasm" : path),
      });
      return module.BarcodeDetector as BarcodeDetectorConstructor;
    });
  }

  return defaultDetectorClassPromise;
}

function readSecureContext(): boolean | null {
  return typeof globalThis.isSecureContext === "boolean" ? globalThis.isSecureContext : null;
}

function createUnsupportedFailure(
  hasNavigator: boolean,
  hasMediaDevices: boolean,
  hasGetUserMedia: boolean,
): CameraScannerFailure {
  const secureContext = readSecureContext();
  let code: CameraScannerCapabilityFailure["code"] = "getUserMedia-unavailable";
  let message = "Camera scanning is unavailable in this browser.";

  if (!hasNavigator) {
    code = "navigator-unavailable";
    message = "Camera scanning is unavailable because this environment does not expose navigator.";
  } else if (!hasMediaDevices) {
    code = "mediaDevices-unavailable";
    message = "navigator.mediaDevices is unavailable in this browser.";
  } else if (!hasGetUserMedia) {
    code = "getUserMedia-unavailable";
    message = "navigator.mediaDevices.getUserMedia is unavailable in this browser.";
  } else if (secureContext === false) {
    code = "insecure-context";
    message = "Camera scanning requires a secure context. Open the app over HTTPS or localhost, then try again.";
  }

  return {
    kind: "capability",
    operation: "camera.start",
    code,
    message,
    retryability: "never",
    details: {
      hasNavigator,
      hasMediaDevices,
      hasGetUserMedia,
      secureContext,
    },
  };
}

function createPermissionFailure(error: unknown): CameraScannerFailure {
  const name = readErrorName(error);
  const secureContext = readSecureContext();
  const message =
    name === "SecurityError"
      ? "Camera access is blocked in this context. Serve the app over HTTPS or localhost, then try again."
      : "Camera permission was denied. Allow camera access in the browser and try again.";
  return {
    kind: "permission",
    operation: "camera.start",
    code: name === "SecurityError" ? "blocked" : "denied",
    message,
    retryability: "after-user-action",
    details: {
      errorName: name,
      errorMessage: readErrorMessage(error),
      secureContext,
    },
    cause: error,
  };
}

function createAcquisitionFailure(error: unknown): CameraScannerFailure {
  const name = readErrorName(error);
  const code =
    name === "NotFoundError"
      ? "not-found"
      : name === "NotReadableError"
        ? "not-readable"
        : name === "AbortError"
          ? "aborted"
          : name === "OverconstrainedError"
            ? "constraint"
            : "unknown";
  const message =
    code === "not-found"
      ? "No camera device was found. Connect a camera or choose a different input, then try again."
      : code === "not-readable"
        ? "The camera is already in use or could not be opened."
        : code === "aborted"
          ? "Camera startup was aborted before a stream was opened."
          : code === "constraint"
            ? "The requested camera constraints cannot be satisfied."
            : "The browser could not start the camera.";
  return {
    kind: "acquisition",
    operation: "camera.start",
    code,
    message,
    retryability: code === "aborted" ? "safe" : "after-user-action",
    details: {
      errorName: name,
      errorMessage: readErrorMessage(error),
      constraint: readErrorConstraint(error),
    },
    cause: error,
  };
}

function createPlaybackFailure(code: "missing-video" | "play-rejected" | "no-stream", error?: unknown): CameraScannerFailure {
  const message =
    code === "missing-video"
      ? "Attach a video element before starting camera playback."
      : code === "no-stream"
        ? "Start the camera stream before attaching the video element."
        : "The browser refused to start camera playback. A user gesture may be required.";

  return {
    kind: "playback",
    operation: "camera.attach",
    code,
    message,
    retryability: "after-user-action",
    details: {
      hasVideoElement: code !== "missing-video",
      hasStream: code !== "no-stream",
      errorName: error ? readErrorName(error) : null,
      errorMessage: error ? readErrorMessage(error) : null,
    },
    cause: error,
  };
}

function createScanFailure(code: "canvas-context-unavailable" | "frame-draw-failed" | "image-read-failed", error?: unknown): CameraScannerFailure {
  return {
    kind: "scan",
    operation: "camera.scan",
    code,
    message:
      code === "canvas-context-unavailable"
        ? "The scan canvas could not be created."
        : code === "frame-draw-failed"
          ? "The current camera frame could not be copied into the scan canvas."
          : "The frame pixels could not be read for decoding.",
    retryability: "safe",
    details: {
      errorName: error ? readErrorName(error) : null,
      errorMessage: error ? readErrorMessage(error) : null,
    },
    cause: error,
  };
}

function createUnexpectedFailure(
  phase: CameraScannerPhase,
  error: unknown,
  hasStream: boolean,
  videoBound: boolean,
): CameraScannerFailure {
  return {
    kind: "unexpected",
    operation: "camera.lifecycle",
    code: "unexpected",
    message: "Camera scanning hit an unexpected lifecycle failure. Stop and restart the scanner.",
    retryability: "never",
    details: {
      phase,
      hasStream,
      videoBound,
      errorName: readErrorName(error),
      errorMessage: readErrorMessage(error),
    },
    cause: error,
  };
}

function readErrorConstraint(error: unknown): string | null {
  if (error && typeof error === "object" && "constraint" in error && typeof (error as { constraint: unknown }).constraint === "string") {
    return (error as { constraint: string }).constraint;
  }

  return null;
}

function readErrorName(error: unknown): string {
  if (error && typeof error === "object" && "name" in error && typeof (error as { name: unknown }).name === "string") {
    return (error as { name: string }).name;
  }

  return error instanceof Error ? error.name : "Error";
}

function readErrorMessage(error: unknown): string | null {
  if (error && typeof error === "object" && "message" in error && typeof (error as { message: unknown }).message === "string") {
    return (error as { message: string }).message;
  }

  return error instanceof Error ? error.message : null;
}

export class CameraScannerService {
  readonly isSupported: boolean;

  private readonly onScan: (code: string) => void;
  private readonly scanIntervalMs: number;
  private readonly duplicateWindowMs: number;
  private readonly videoConstraints: MediaStreamConstraints;
  private readonly mediaDevices: Pick<MediaDevices, "getUserMedia"> | null;
  private readonly doc: Pick<Document, "addEventListener" | "removeEventListener" | "hidden"> | null;
  private readonly now: () => number;
  private readonly setIntervalFn: (handler: () => void, timeout: number) => number;
  private readonly clearIntervalFn: (handle: number) => void;
  private readonly createCanvas: () => CameraScannerCanvasLike;
  private readonly loadBarcodeDetectorClass: () => Promise<BarcodeDetectorConstructor>;
  private readonly jsqr: typeof jsQR;
  private readonly logger: Pick<Console, "warn" | "error">;
  private readonly observeVisibility: boolean;

  private readonly listeners = new Set<(snapshot: CameraScannerSnapshot) => void>();
  private readonly recentCodes = new Map<string, number>();

  private snapshot: CameraScannerSnapshot;
  private videoElement: HTMLVideoElement | null = null;
  private stream: MediaStream | null = null;
  private detector: BarcodeDetectorLike | null = null;
  private detectorPromise: Promise<BarcodeDetectorLike | null> | null = null;
  private timerHandle: number | null = null;
  private inFlight = false;
  private sessionToken = 0;
  private destroyed = false;
  private readonly visibilityHandler: (() => void) | null;

  constructor(options: CameraScannerServiceOptions) {
    const mediaDevices = options.mediaDevices ?? globalThis.navigator?.mediaDevices ?? null;
    const documentRef = options.document ?? globalThis.document ?? null;

    this.onScan = options.onScan;
    this.scanIntervalMs = options.scanIntervalMs ?? DEFAULT_SCAN_INTERVAL_MS;
    this.duplicateWindowMs = options.duplicateWindowMs ?? DEFAULT_DUPLICATE_WINDOW_MS;
    this.videoConstraints = options.videoConstraints ?? DEFAULT_VIDEO_CONSTRAINTS;
    this.mediaDevices = mediaDevices;
    this.doc = documentRef;
    this.now = options.now ?? (() => Date.now());
    this.setIntervalFn = options.setInterval ?? ((handler, timeout) => globalThis.setInterval(handler, timeout));
    this.clearIntervalFn = options.clearInterval ?? ((handle) => globalThis.clearInterval(handle));
    this.createCanvas = options.createCanvas ?? (() => {
      if (documentRef && "createElement" in documentRef) {
        return (documentRef as Document).createElement("canvas") as CameraScannerCanvasLike;
      }

      return {
        width: 0,
        height: 0,
        getContext: () => null,
      } as CameraScannerCanvasLike;
    });
    this.loadBarcodeDetectorClass = options.loadBarcodeDetectorClass ?? loadDefaultBarcodeDetectorClass;
    this.jsqr = options.jsqr ?? jsQR;
    this.logger = options.logger ?? console;
    this.observeVisibility = options.observeVisibility ?? true;
    this.isSupported = Boolean(mediaDevices?.getUserMedia);

    this.snapshot = this.isSupported
      ? {
          phase: "idle",
          supported: true,
          permissionState: "unknown",
          lastResult: null,
          activeStream: false,
          videoBound: false,
          failure: null,
        }
      : {
          phase: "unsupported",
          supported: false,
          permissionState: "unknown",
          lastResult: null,
          activeStream: false,
          videoBound: false,
          failure: createUnsupportedFailure(Boolean(globalThis.navigator), Boolean(mediaDevices), Boolean(mediaDevices?.getUserMedia)),
        };

    this.visibilityHandler = this.observeVisibility && this.doc
      ? () => {
          if (this.doc?.hidden) {
            this.stop();
          }
        }
      : null;

    if (this.visibilityHandler && this.doc) {
      this.doc.addEventListener("visibilitychange", this.visibilityHandler);
    }
  }

  subscribe(listener: (snapshot: CameraScannerSnapshot) => void): () => void {
    if (this.destroyed) {
      return () => {};
    }

    this.listeners.add(listener);
    listener(this.snapshot);

    return () => {
      this.listeners.delete(listener);
    };
  }

  getSnapshot(): CameraScannerSnapshot {
    return this.snapshot;
  }

  async start(): Promise<CameraScannerResult> {
    if (this.destroyed) {
      return {
        ok: false,
        failure: createUnexpectedFailure(
          this.snapshot.phase,
          new Error("CameraScannerService has been destroyed."),
          Boolean(this.stream),
          Boolean(this.videoElement),
        ),
      };
    }

    if (!this.isSupported || !this.mediaDevices) {
      const failure = this.snapshot.failure ?? createUnsupportedFailure(Boolean(globalThis.navigator), Boolean(this.mediaDevices), Boolean(this.mediaDevices?.getUserMedia));
      this.setSnapshot({
        phase: "unsupported",
        supported: false,
        permissionState: "unknown",
        lastResult: null,
        activeStream: false,
        videoBound: Boolean(this.videoElement),
        failure,
      });
      return { ok: false, failure };
    }

    this.stopInternal({ preserveLastResult: false, preserveVideoBinding: true });
    this.sessionToken += 1;
    const token = this.sessionToken;

    this.recentCodes.clear();
    this.setSnapshot({
      phase: "requestingPermission",
      supported: true,
      permissionState: "unknown",
      lastResult: null,
      activeStream: false,
      videoBound: Boolean(this.videoElement),
      failure: null,
    });

    let stream: MediaStream;
    try {
      stream = await this.mediaDevices.getUserMedia(this.videoConstraints);

      const videoTrack = stream.getVideoTracks()[0];
      if (videoTrack) {
        // Fire-and-forget. applyConstraints against real camera hardware can
        // take hundreds of milliseconds on some Android devices and must never
        // hold up stream binding. If it resolves, great. If it rejects, the
        // helper logs the diagnosis and the scanner keeps working with
        // whatever focus state the driver started with.
        void this.engageContinuousAutoTuning(videoTrack);
      }
    } catch (error) {
      const failure = classifyStartFailure(error);
      if (failure.kind === "permission") {
        this.setSnapshot({
          phase: "denied",
          supported: true,
          permissionState: "denied",
          lastResult: null,
          activeStream: false,
          videoBound: Boolean(this.videoElement),
          failure,
        });
      } else {
        this.setSnapshot({
          phase: "failure",
          supported: true,
          permissionState: "unknown",
          lastResult: null,
          activeStream: false,
          videoBound: Boolean(this.videoElement),
          failure,
        });
      }

      return { ok: false, failure };
    }

    if (this.destroyed || token !== this.sessionToken) {
      stopStream(stream);
      return { ok: true };
    }

    this.stream = stream;
    this.setSnapshot({
      phase: "ready",
      supported: true,
      permissionState: "granted",
      lastResult: null,
      activeStream: true,
      videoBound: Boolean(this.videoElement),
      failure: null,
    });

    void this.ensureBarcodeDetector();

    if (this.videoElement) {
      const result = await this.bindStreamToVideo(this.videoElement, token);
      if (!result.ok) {
        return result;
      }
    }

    return { ok: true };
  }

  async attachVideoElement(video: HTMLVideoElement | null): Promise<CameraScannerResult> {
    if (this.destroyed) {
      return {
        ok: false,
        failure: createUnexpectedFailure(
          this.snapshot.phase,
          new Error("CameraScannerService has been destroyed."),
          Boolean(this.stream),
          Boolean(this.videoElement),
        ),
      };
    }

    if (video === null) {
      const previousVideo = this.videoElement;
      this.videoElement = null;
      if (previousVideo) {
        this.detachVideo(previousVideo);
      }
      if (this.stream) {
        this.stopInternal({ preserveLastResult: true });
      } else if (this.snapshot.videoBound) {
        this.setSnapshot({ ...this.snapshot, videoBound: false });
      }

      return { ok: true };
    }

    if (this.videoElement && this.videoElement !== video) {
      this.detachVideo(this.videoElement);
    }

    this.videoElement = video;
    this.bindFocusTapHandler(video);

    if (this.stream && this.videoElement === video && video.srcObject === this.stream && this.snapshot.phase === "scanning") {
      return { ok: true };
    }

    if (!this.stream) {
      this.setSnapshot({
        ...this.snapshot,
        videoBound: true,
      });
      return { ok: true };
    }

    return this.bindStreamToVideo(video, this.sessionToken);
  }

  stop(): void {
    this.stopInternal({ preserveLastResult: true });
  }

  destroy(): void {
    if (this.destroyed) {
      return;
    }

    this.destroyed = true;
    this.stopInternal({ preserveLastResult: true });
    if (this.visibilityHandler && this.doc) {
      this.doc.removeEventListener("visibilitychange", this.visibilityHandler);
    }
    this.listeners.clear();
  }

  private async bindStreamToVideo(video: HTMLVideoElement, token: number): Promise<CameraScannerResult> {
    if (!this.stream) {
      return { ok: false, failure: createPlaybackFailure("no-stream") };
    }

    try {
      video.muted = true;
      video.playsInline = true;
      video.autoplay = true;
      video.srcObject = this.stream;
      // Muted autoplay is allowed without gesture on all modern mobile browsers.
      // play() can still reject on desktop or restrictive browsers.
      await video.play();
    } catch (error) {
      // AbortError means autoplay already started playback — not a real failure.
      if (error instanceof DOMException && error.name === "AbortError") {
        // Already playing via autoplay, continue.
      } else {
        const failure = createPlaybackFailure("play-rejected", error);
        this.failAndStop(failure);
        return { ok: false, failure };
      }
    }

    if (this.destroyed || token !== this.sessionToken) {
      this.detachVideo(video);
      return { ok: true };
    }

    this.videoElement = video;
    this.bindFocusTapHandler(video);

    // Mirror the video preview when using a user-facing (laptop / selfie) camera.
    // The scan loop reads raw pixels from the stream, so mirroring is CSS-only.
    const track = this.stream.getVideoTracks()[0];
    const facing = track?.getSettings?.().facingMode;
    video.style.transform = (!facing || facing === "user") ? "scaleX(-1)" : "";
    this.setSnapshot({
      phase: "scanning",
      supported: true,
      permissionState: "granted",
      lastResult: this.snapshot.lastResult,
      activeStream: true,
      videoBound: true,
      failure: null,
    });
    this.startLoop();
    return { ok: true };
  }

  private startLoop(): void {
    this.stopLoop();
    this.timerHandle = this.setIntervalFn(() => {
      void this.scanFrame();
    }, this.scanIntervalMs);
  }

  private stopLoop(): void {
    if (this.timerHandle !== null) {
      this.clearIntervalFn(this.timerHandle);
      this.timerHandle = null;
    }
  }

  private async scanFrame(): Promise<void> {
    if (this.destroyed || this.inFlight || !this.stream || !this.videoElement || this.snapshot.phase !== "scanning") {
      return;
    }

    const video = this.videoElement;
    if (video.readyState < video.HAVE_ENOUGH_DATA) {
      return;
    }

    const width = video.videoWidth;
    const height = video.videoHeight;
    if (width === 0 || height === 0) {
      return;
    }

    this.inFlight = true;

    try {
      if (!this.snapshot.videoBound) {
        return;
      }

      const canvas = this.createCanvas();
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) {
        this.failAndStop(createScanFailure("canvas-context-unavailable"));
        return;
      }

      canvas.width = width;
      canvas.height = height;

      try {
        context.drawImage(video, 0, 0, width, height);
      } catch (error) {
        this.failAndStop(createScanFailure("frame-draw-failed", error));
        return;
      }

      try {
        const imageData = context.getImageData(0, 0, width, height);
        // attemptBoth is jsQR's default and the only sensible production setting:
        // many printed QRs and any code captured under changing light land in the
        // inverted orientation from jsQR's perspective, and skipping the second
        // pass means the decoder quietly refuses valid codes. The "dontInvert"
        // CPU optimisation this replaces was the root cause of scans failing
        // on laptop webcams.
        const result = this.jsqr(imageData.data, width, height, { inversionAttempts: "attemptBoth" });
        if (result?.data) {
          this.acceptCode(result.data);
          return;
        }
      } catch (error) {
        if (error instanceof Error || typeof error === "object") {
          this.logger.warn("CameraScannerService jsQR frame read failed; continuing with detector fallback.", error);
        }
      }

      const detector = await this.ensureBarcodeDetector();
      if (!detector || this.destroyed || this.snapshot.phase !== "scanning") {
        return;
      }

      try {
        const barcodes = await detector.detect(video);
        if (this.destroyed || this.snapshot.phase !== "scanning") {
          return;
        }
        const first = barcodes[0];
        if (first?.rawValue) {
          this.acceptCode(first.rawValue);
        }
      } catch (error) {
        this.logger.warn("CameraScannerService barcode detector rejected a frame; continuing.", error);
      }
    } catch (error) {
      this.failAndStop(createUnexpectedFailure(this.snapshot.phase, error, Boolean(this.stream), Boolean(this.videoElement)));
    } finally {
      this.inFlight = false;
    }
  }

  private acceptCode(code: string): void {
    const normalized = sanitizeScannedCode(code);
    if (!normalized) {
      return;
    }

    const now = this.now();
    const lookupKey = scanLookupCompactKey(normalized);
    const lastSeen = this.recentCodes.get(lookupKey);
    if (typeof lastSeen === "number" && now - lastSeen < this.duplicateWindowMs) {
      return;
    }

    this.recentCodes.set(lookupKey, now);
    this.stopInternal({ preserveLastResult: true });
    this.setSnapshot({
      phase: "idle",
      supported: this.snapshot.supported,
      permissionState: this.snapshot.permissionState,
      lastResult: normalized,
      activeStream: false,
      videoBound: Boolean(this.videoElement),
      failure: null,
    });

    try {
      this.onScan(normalized);
    } catch (error) {
      this.logger.error("CameraScannerService onScan callback threw.", error);
    }
  }

  private async ensureBarcodeDetector(): Promise<BarcodeDetectorLike | null> {
    if (this.detector) {
      return this.detector;
    }

    if (!this.detectorPromise) {
      this.detectorPromise = this.loadBarcodeDetectorClass()
        .then((DetectorClass) => {
          try {
            this.detector = new DetectorClass({
              formats: ["qr_code", "data_matrix", "ean_13", "ean_8", "code_128", "code_39", "upc_a", "upc_e", "itf"],
            });
            return this.detector;
          } catch (error) {
            this.logger.warn("CameraScannerService barcode detector failed to initialize; QR-only mode enabled.", error);
            return null;
          }
        })
        .catch((error) => {
          this.logger.warn("CameraScannerService barcode detector load failed; QR-only mode enabled.", error);
          return null;
        });
    }

    return this.detectorPromise;
  }

  private stopInternal(options: { readonly preserveLastResult: boolean; readonly preserveVideoBinding?: boolean }): void {
    this.sessionToken += 1;
    this.stopLoop();
    this.inFlight = false;

    if (this.stream) {
      stopStream(this.stream);
      this.stream = null;
    }

    if (this.videoElement && !options.preserveVideoBinding) {
      this.detachVideo(this.videoElement);
      this.videoElement = null;
    }

    this.setSnapshot({
      phase: "idle",
      supported: this.snapshot.supported,
      permissionState: this.snapshot.permissionState === "denied" ? "denied" : this.snapshot.permissionState,
      lastResult: options.preserveLastResult ? this.snapshot.lastResult : null,
      activeStream: false,
      videoBound: Boolean(this.videoElement),
      failure: null,
    });
  }

  private failAndStop(failure: CameraScannerFailure): void {
    this.stopLoop();
    this.inFlight = false;
    if (this.stream) {
      stopStream(this.stream);
      this.stream = null;
    }

    if (this.videoElement) {
      this.detachVideo(this.videoElement);
      this.videoElement = null;
    }

    this.setSnapshot({
      phase: "failure",
      supported: this.snapshot.supported,
      permissionState: this.snapshot.permissionState,
      lastResult: this.snapshot.lastResult,
      activeStream: false,
      videoBound: false,
      failure,
    });
  }

  private detachVideo(video: HTMLVideoElement): void {
    try {
      video.style.transform = "";
      if (video.srcObject) {
        video.srcObject = null;
      }
      video.pause();
      const handler = (video as HTMLVideoElementWithFocusHandler).__smartDbFocusClickHandler;
      if (handler) {
        video.removeEventListener("click", handler);
        (video as HTMLVideoElementWithFocusHandler).__smartDbFocusClickHandler = undefined;
      }
    } catch (error) {
      this.logger.warn("CameraScannerService failed to detach the video element cleanly.", error);
    }
  }

  /**
   * Ask the active camera track to refocus at the given (optional) point, or
   * to re-engage continuous autofocus if no point is supplied. Safe to call
   * repeatedly; if the device exposes no focus control at all, this is a no-op
   * (and any underlying rejection is logged rather than thrown).
   */
  async refocus(point?: { x: number; y: number }): Promise<void> {
    const track = this.stream?.getVideoTracks()[0] ?? null;
    if (!track || track.readyState !== "live") {
      return;
    }

    try {
      if (point) {
        await this.applySingleShotFocusAtPoint(track, point);
        return;
      }
      await this.engageContinuousAutoTuning(track);
    } catch (error) {
      this.logger.warn("CameraScannerService refocus failed.", error);
    }
  }

  private getTrackFocusCapabilities(track: MediaStreamTrack): {
    readonly focusModes: readonly string[];
    readonly exposureModes: readonly string[];
    readonly whiteBalanceModes: readonly string[];
    readonly hasPointsOfInterest: boolean;
  } {
    const capabilities = (typeof track.getCapabilities === "function"
      ? track.getCapabilities()
      : undefined) as Record<string, unknown> | undefined;
    const focusModes = Array.isArray(capabilities?.focusMode)
      ? (capabilities!.focusMode as string[])
      : [];
    const exposureModes = Array.isArray(capabilities?.exposureMode)
      ? (capabilities!.exposureMode as string[])
      : [];
    const whiteBalanceModes = Array.isArray(capabilities?.whiteBalanceMode)
      ? (capabilities!.whiteBalanceMode as string[])
      : [];
    const hasPointsOfInterest =
      capabilities !== undefined && "pointsOfInterest" in capabilities;
    return { focusModes, exposureModes, whiteBalanceModes, hasPointsOfInterest };
  }

  private async engageContinuousAutoTuning(track: MediaStreamTrack): Promise<void> {
    const { focusModes, exposureModes, whiteBalanceModes } =
      this.getTrackFocusCapabilities(track);

    // Focus: walk continuous → auto → manual → single-shot, apply the first
    // supported mode. Report the full capability set to the logger so diagnosis
    // of "no autofocus" on an unfamiliar device no longer requires reading
    // source.
    const preferredFocus = FOCUS_MODE_PRIORITY.find((mode) => focusModes.includes(mode));
    if (preferredFocus) {
      try {
        await track.applyConstraints({
          advanced: [{ focusMode: preferredFocus } as MediaTrackConstraintSet],
        });
      } catch (error) {
        this.logger.warn(
          `CameraScannerService could not apply focusMode='${preferredFocus}'; supported=${focusModes.join(",") || "(none)"}`,
          error,
        );
      }
    } else if (focusModes.length === 0) {
      this.logger.warn(
        "CameraScannerService: track reports no focusMode capability. Device will use its default (often fixed) focus; tap-to-focus on the viewfinder may still engage native AF on iOS.",
      );
    }

    // Exposure and white-balance are best-effort; they dramatically improve
    // decode reliability under changing light when available, but missing
    // support is silent (not all drivers report these capabilities even when
    // they engage the underlying modes automatically).
    if (exposureModes.includes("continuous")) {
      try {
        await track.applyConstraints({
          advanced: [{ exposureMode: "continuous" } as MediaTrackConstraintSet],
        });
      } catch (error) {
        this.logger.warn("CameraScannerService: exposureMode=continuous rejected.", error);
      }
    }
    if (whiteBalanceModes.includes("continuous")) {
      try {
        await track.applyConstraints({
          advanced: [{ whiteBalanceMode: "continuous" } as MediaTrackConstraintSet],
        });
      } catch (error) {
        this.logger.warn("CameraScannerService: whiteBalanceMode=continuous rejected.", error);
      }
    }
  }

  private async applySingleShotFocusAtPoint(
    track: MediaStreamTrack,
    point: { x: number; y: number },
  ): Promise<void> {
    const clampedX = Math.min(Math.max(point.x, 0), 1);
    const clampedY = Math.min(Math.max(point.y, 0), 1);
    const { focusModes, hasPointsOfInterest } = this.getTrackFocusCapabilities(track);

    // Chromium exposes a `single-shot` focus mode plus a `pointsOfInterest`
    // constraint — applying both in one call is the supported recipe. If the
    // device lacks single-shot, fall back to re-engaging continuous so a move
    // of the camera still triggers a hunt.
    const preferred = focusModes.includes("single-shot")
      ? "single-shot"
      : FOCUS_MODE_PRIORITY.find((mode) => focusModes.includes(mode));
    if (!preferred) {
      return;
    }

    const base: Record<string, unknown> = { focusMode: preferred };
    if (hasPointsOfInterest) {
      base.pointsOfInterest = [{ x: clampedX, y: clampedY }];
    }
    try {
      await track.applyConstraints({
        advanced: [base as MediaTrackConstraintSet],
      });
    } catch (error) {
      this.logger.warn(
        `CameraScannerService tap-to-focus failed (mode=${preferred}, point=${clampedX.toFixed(2)}x${clampedY.toFixed(2)}).`,
        error,
      );
    }
  }

  private bindFocusTapHandler(video: HTMLVideoElement): void {
    const element = video as HTMLVideoElementWithFocusHandler;
    if (element.__smartDbFocusClickHandler) {
      return;
    }
    const handler = (event: Event) => {
      const mouse = event as MouseEvent;
      const target = event.currentTarget;
      if (!(target instanceof HTMLVideoElement)) {
        return;
      }
      const rect = target.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) {
        void this.refocus();
        return;
      }
      const x = (mouse.clientX - rect.left) / rect.width;
      const y = (mouse.clientY - rect.top) / rect.height;
      void this.refocus({ x, y });
    };
    video.addEventListener("click", handler);
    element.__smartDbFocusClickHandler = handler;
  }

  private setSnapshot(snapshot: CameraScannerSnapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch (error) {
        this.logger.error("CameraScannerService listener threw.", error);
      }
    }
  }
}

function classifyStartFailure(error: unknown): CameraScannerFailure {
  const name = readErrorName(error);
  if (name === "NotAllowedError" || name === "SecurityError") {
    return createPermissionFailure(error);
  }

  return createAcquisitionFailure(error);
}

function stopStream(stream: MediaStream): void {
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {
      // Track cleanup should never interrupt the caller.
    }
  }
}
