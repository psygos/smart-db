import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CameraScannerService,
  type CameraScannerServiceOptions,
  type CameraScannerSnapshot,
} from "./camera-scanner-service";

type ScanTick = (() => void) | null;

function createStream() {
  const stop = vi.fn();
  const track = {
    stop,
    getCapabilities: () => ({ focusMode: ["continuous", "manual"] }),
    getSettings: () => ({ facingMode: "environment" }),
    applyConstraints: vi.fn().mockResolvedValue(undefined),
  };
  return {
    stream: {
      getTracks: () => [track],
      getVideoTracks: () => [track],
    } as unknown as MediaStream,
    stop,
  };
}

function createVideo(playImpl = vi.fn().mockResolvedValue(undefined)) {
  const listeners = new Map<string, Set<EventListener>>();
  return {
    srcObject: null as MediaStream | null,
    play: playImpl,
    pause: vi.fn(),
    muted: false,
    playsInline: false,
    readyState: 4,
    HAVE_ENOUGH_DATA: 4,
    videoWidth: 1280,
    videoHeight: 720,
    addEventListener: vi.fn((type: string, listener: EventListener) => {
      const bucket = listeners.get(type) ?? new Set<EventListener>();
      bucket.add(listener);
      listeners.set(type, bucket);
    }),
    removeEventListener: vi.fn((type: string, listener: EventListener) => {
      listeners.get(type)?.delete(listener);
    }),
    style: { transform: "" },
  } as unknown as HTMLVideoElement & { HAVE_ENOUGH_DATA: number };
}

function createCanvas(
  context: {
    drawImage: ReturnType<typeof vi.fn>;
    getImageData: ReturnType<typeof vi.fn>;
  } | null,
) {
  return {
    width: 0,
    height: 0,
    getContext: vi.fn(() => context),
  } as unknown as HTMLCanvasElement;
}

function createDocumentStub() {
  let listener: (() => void) | null = null;
  const documentStub = {
    hidden: false,
    addEventListener: vi.fn((_type: string, cb: EventListenerOrEventListenerObject) => {
      listener = typeof cb === "function" ? cb : null;
    }),
    removeEventListener: vi.fn((_type: string, cb: EventListenerOrEventListenerObject) => {
      if (typeof cb === "function" && listener === cb) {
        listener = null;
      }
    }),
    dispatchHidden(hidden: boolean) {
      this.hidden = hidden;
      listener?.();
    },
  };

  return documentStub;
}

function buildService(overrides: Partial<CameraScannerServiceOptions> = {}) {
  let tick: ScanTick = null;
  let now = 1_000;
  const detect = vi.fn();
  const jsqr = vi.fn();
  const getUserMedia = vi.fn();
  const clearInterval = vi.fn();
  const setInterval = vi.fn((handler: () => void) => {
    tick = handler;
    return 1;
  });
  const warn = vi.fn();
  const error = vi.fn();

  const service = new CameraScannerService({
    onScan: vi.fn(),
    now: () => now,
    jsqr: jsqr as CameraScannerServiceOptions["jsqr"],
    mediaDevices: { getUserMedia },
    loadBarcodeDetectorClass: async () =>
      class {
        detect = detect;
      },
    createCanvas: () => createCanvas({
      drawImage: vi.fn(),
      getImageData: vi.fn(() => ({ data: new Uint8ClampedArray([1, 2, 3, 4]) })),
    }),
    setInterval: setInterval as CameraScannerServiceOptions["setInterval"],
    clearInterval: clearInterval as CameraScannerServiceOptions["clearInterval"],
    logger: { warn, error },
    observeVisibility: false,
    ...overrides,
  });

  return {
    service,
    getUserMedia,
    detect,
    jsqr,
    setInterval,
    clearInterval,
    warn,
    error,
    getTick: () => tick,
    advanceTime: (ms: number) => {
      now += ms;
    },
  };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

function expectIdle(snapshot: CameraScannerSnapshot) {
  expect(snapshot.phase).toBe("idle");
  expect(snapshot.activeStream).toBe(false);
  expect(snapshot.failure).toBeNull();
}

describe("CameraScannerService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports unsupported browsers as a capability failure", async () => {
    const service = new CameraScannerService({
      onScan: vi.fn(),
      mediaDevices: undefined,
      observeVisibility: false,
    });

    expect(service.getSnapshot().phase).toBe("unsupported");

    const result = await service.start();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.kind).toBe("capability");
      expect(result.failure.operation).toBe("camera.start");
      expect(result.failure.message).toBe(
        "navigator.mediaDevices is unavailable in this browser.",
      );
    }

    const snapshot = service.getSnapshot();
    expect(snapshot.phase).toBe("unsupported");
    expect(snapshot.permissionState).toBe("unknown");
    expect(snapshot.failure?.kind).toBe("capability");
  });

  it("classifies permission denials explicitly", async () => {
    const { service, getUserMedia } = buildService();
    getUserMedia.mockRejectedValueOnce(new DOMException("blocked", "NotAllowedError"));

    const result = await service.start();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.kind).toBe("permission");
      expect(result.failure.code).toBe("denied");
      expect(result.failure.message).toBe(
        "Camera permission was denied. Allow camera access in the browser and try again.",
      );
    }

    const snapshot = service.getSnapshot();
    expect(snapshot.phase).toBe("denied");
    expect(snapshot.permissionState).toBe("denied");
    expect(snapshot.failure?.kind).toBe("permission");
  });

  it("classifies missing camera hardware as an acquisition failure", async () => {
    const { service, getUserMedia } = buildService();
    getUserMedia.mockRejectedValueOnce(new DOMException("missing camera", "NotFoundError"));

    const result = await service.start();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.kind).toBe("acquisition");
      expect(result.failure.code).toBe("not-found");
      expect(result.failure.message).toBe(
        "No camera device was found. Connect a camera or choose a different input, then try again.",
      );
    }
  });

  it("binds a video element and stops cleanly when requested", async () => {
    const { service, getUserMedia, setInterval, clearInterval } = buildService();
    const { stream, stop } = createStream();
    getUserMedia.mockResolvedValueOnce(stream);
    const video = createVideo();

    await service.attachVideoElement(video);
    await service.start();

    expect(service.getSnapshot().phase).toBe("scanning");
    expect(video.srcObject).toBe(stream);
    expect(video.play).toHaveBeenCalled();
    expect(setInterval).toHaveBeenCalledTimes(1);

    service.stop();

    const snapshot = service.getSnapshot();
    expectIdle(snapshot);
    expect(snapshot.permissionState).toBe("granted");
    expect(snapshot.videoBound).toBe(false);
    expect(video.srcObject).toBeNull();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(clearInterval).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the video element rejects playback", async () => {
    const { service, getUserMedia } = buildService();
    const { stream, stop } = createStream();
    getUserMedia.mockResolvedValueOnce(stream);
    const video = createVideo(vi.fn().mockRejectedValueOnce(new Error("autoplay blocked")));

    await service.attachVideoElement(video);
    const startResult = await service.start();

    expect(startResult.ok).toBe(false);
    if (!startResult.ok) {
      expect(startResult.failure.kind).toBe("playback");
      expect(startResult.failure.code).toBe("play-rejected");
      expect(startResult.failure.message).toBe(
        "The browser refused to start camera playback. A user gesture may be required.",
      );
    }

    const snapshot = service.getSnapshot();
    expect(snapshot.phase).toBe("failure");
    expect(snapshot.failure?.kind).toBe("playback");
    expect(video.srcObject).toBeNull();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("falls back from jsQR errors to the barcode detector and still scans successfully", async () => {
    const scan = vi.fn();
    const { service, getUserMedia, jsqr, detect, getTick } = buildService({
      onScan: scan,
    });
    const { stream } = createStream();
    getUserMedia.mockResolvedValueOnce(stream);
    jsqr.mockImplementationOnce(() => {
      throw new Error("bad frame");
    });
    detect.mockResolvedValueOnce([{ rawValue: "qr_9001" }]);
    const video = createVideo();

    await service.attachVideoElement(video);
    await service.start();

    const tick = getTickOrThrow(getTick);
    tick();
    await flushMicrotasks();

    expect(scan).toHaveBeenCalledWith("qr_9001");
    const snapshot = service.getSnapshot();
    expect(snapshot.phase).toBe("idle");
    expect(snapshot.lastResult).toBe("qr_9001");
  });

  it("fails the scanner when the frame canvas is unavailable", async () => {
    const { service, getUserMedia, getTick } = buildService({
      createCanvas: () => createCanvas(null),
    });
    const { stream } = createStream();
    getUserMedia.mockResolvedValueOnce(stream);
    const video = createVideo();

    await service.attachVideoElement(video);
    await service.start();

    const tick = getTickOrThrow(getTick);
    tick();
    await flushMicrotasks();

    const snapshot = service.getSnapshot();
    expect(snapshot.phase).toBe("failure");
    expect(snapshot.failure?.kind).toBe("scan");
    expect(snapshot.failure?.code).toBe("canvas-context-unavailable");
    expect(snapshot.failure?.message).toBe("The scan canvas could not be created.");
  });

  it("cancels an in-flight start when stop is called before getUserMedia resolves", async () => {
    let resolveStream: ((stream: MediaStream) => void) | null = null;
    const pendingStream = new Promise<MediaStream>((resolve) => {
      resolveStream = resolve;
    });
    const { service, getUserMedia } = buildService();
    getUserMedia.mockReturnValueOnce(pendingStream);

    const startPromise = service.start();
    service.stop();

    const { stream, stop } = createStream();
    resolveStream?.(stream);

    await startPromise;
    await flushMicrotasks();

    const snapshot = service.getSnapshot();
    expectIdle(snapshot);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(snapshot.lastResult).toBeNull();
  });

  it("stops automatically when the document becomes hidden", async () => {
    const documentStub = createDocumentStub();
    const { service, getUserMedia } = buildService({
      document: documentStub as unknown as Pick<Document, "addEventListener" | "removeEventListener" | "hidden">,
      observeVisibility: true,
    });
    const { stream, stop } = createStream();
    getUserMedia.mockResolvedValueOnce(stream);
    const video = createVideo();

    await service.attachVideoElement(video);
    await service.start();

    documentStub.dispatchHidden(true);

    const snapshot = service.getSnapshot();
    expectIdle(snapshot);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(documentStub.addEventListener).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
  });

  it("walks the focus-mode priority chain and applies the first supported mode on start", async () => {
    const applyConstraints = vi.fn().mockResolvedValue(undefined);
    const track = {
      stop: vi.fn(),
      readyState: "live",
      getCapabilities: () => ({
        focusMode: ["single-shot", "manual"],
        exposureMode: ["continuous"],
        whiteBalanceMode: ["continuous"],
      }),
      applyConstraints,
    };
    const stream = {
      getTracks: () => [track],
      getVideoTracks: () => [track],
    } as unknown as MediaStream;
    const { service, getUserMedia } = buildService();
    getUserMedia.mockResolvedValueOnce(stream);

    await service.attachVideoElement(createVideo());
    const result = await service.start();
    expect(result.ok).toBe(true);

    // continuous is not supported, so chain walks to single-shot
    expect(applyConstraints).toHaveBeenCalledWith({
      advanced: [{ focusMode: "single-shot" }],
    });
    expect(applyConstraints).toHaveBeenCalledWith({
      advanced: [{ exposureMode: "continuous" }],
    });
    expect(applyConstraints).toHaveBeenCalledWith({
      advanced: [{ whiteBalanceMode: "continuous" }],
    });
  });

  it("warns via the logger when a device reports no focusMode capability at all", async () => {
    const track = {
      stop: vi.fn(),
      readyState: "live",
      getCapabilities: () => ({ focusMode: [] }),
      applyConstraints: vi.fn().mockResolvedValue(undefined),
    };
    const stream = {
      getTracks: () => [track],
      getVideoTracks: () => [track],
    } as unknown as MediaStream;
    const { service, getUserMedia, warn } = buildService();
    getUserMedia.mockResolvedValueOnce(stream);

    await service.attachVideoElement(createVideo());
    await service.start();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("no focusMode capability"));
  });

  it("refocus at a normalised point calls applyConstraints with pointsOfInterest when supported", async () => {
    const applyConstraints = vi.fn().mockResolvedValue(undefined);
    const track = {
      stop: vi.fn(),
      readyState: "live",
      getCapabilities: () => ({
        focusMode: ["continuous", "single-shot"],
        pointsOfInterest: { min: 0, max: 1 },
      }),
      applyConstraints,
    };
    const stream = {
      getTracks: () => [track],
      getVideoTracks: () => [track],
    } as unknown as MediaStream;
    const { service, getUserMedia } = buildService();
    getUserMedia.mockResolvedValueOnce(stream);

    await service.attachVideoElement(createVideo());
    await service.start();

    applyConstraints.mockClear();
    await service.refocus({ x: 0.4, y: 0.6 });
    expect(applyConstraints).toHaveBeenCalledWith({
      advanced: [
        {
          focusMode: "single-shot",
          pointsOfInterest: [{ x: 0.4, y: 0.6 }],
        },
      ],
    });
  });

  it("refocus without a point re-engages the continuous chain", async () => {
    const applyConstraints = vi.fn().mockResolvedValue(undefined);
    const track = {
      stop: vi.fn(),
      readyState: "live",
      getCapabilities: () => ({ focusMode: ["continuous"] }),
      applyConstraints,
    };
    const stream = {
      getTracks: () => [track],
      getVideoTracks: () => [track],
    } as unknown as MediaStream;
    const { service, getUserMedia } = buildService();
    getUserMedia.mockResolvedValueOnce(stream);

    await service.attachVideoElement(createVideo());
    await service.start();

    applyConstraints.mockClear();
    await service.refocus();
    expect(applyConstraints).toHaveBeenCalledWith({
      advanced: [{ focusMode: "continuous" }],
    });
  });

  it("refocus is a no-op when the track is ended", async () => {
    const applyConstraints = vi.fn().mockResolvedValue(undefined);
    const track = {
      stop: vi.fn(),
      readyState: "ended",
      getCapabilities: () => ({ focusMode: ["continuous"] }),
      applyConstraints,
    };
    const stream = {
      getTracks: () => [track],
      getVideoTracks: () => [track],
    } as unknown as MediaStream;
    const { service, getUserMedia } = buildService();
    getUserMedia.mockResolvedValueOnce(stream);

    await service.attachVideoElement(createVideo());
    await service.start();

    applyConstraints.mockClear();
    await service.refocus({ x: 0.5, y: 0.5 });
    expect(applyConstraints).not.toHaveBeenCalled();
  });
});

function getTickOrThrow(getTick: () => ScanTick) {
  const tick = getTick();
  if (!tick) {
    throw new Error("Scanner interval was not started.");
  }

  return tick;
}
