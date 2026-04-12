import { setZXingModuleOverrides, type BarcodeDetector as BarcodeDetectorType } from "barcode-detector/pure";
import jsQR from "jsqr";
import { useCallback, useEffect, useRef, useState } from "react";

// Locally hosted WASM (no CDN — works offline)
setZXingModuleOverrides({
  locateFile: (path: string, _prefix: string) => {
    if (path.endsWith(".wasm")) return "/zxing_reader.wasm";
    return path;
  },
});

// Lazy import the barcode-detector polyfill (handles 1D barcodes via WASM)
let detectorClassPromise: Promise<typeof BarcodeDetectorType> | null = null;
function getDetectorClass(): Promise<typeof BarcodeDetectorType> {
  if (!detectorClassPromise) {
    detectorClassPromise = import("barcode-detector/pure").then((m) => m.BarcodeDetector);
  }
  return detectorClassPromise;
}

type PermissionState = "prompt" | "granted" | "denied" | "unknown";

interface UseCameraResult {
  isSupported: boolean;
  permissionState: PermissionState;
  videoRef: React.RefCallback<HTMLVideoElement>;
  isScanning: boolean;
  start: () => Promise<void>;
  stop: () => void;
  lastResult: string | null;
  error: string | null;
}

const SCAN_INTERVAL_MS = 150;
const DUPLICATE_WINDOW_MS = 3000;

export function useCamera(onScan: (code: string) => void): UseCameraResult {
  const [isSupported] = useState(() => !!navigator.mediaDevices?.getUserMedia);
  const [permissionState, setPermissionState] = useState<PermissionState>("unknown");
  const [isScanning, setIsScanning] = useState(false);
  const [lastResult, setLastResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const videoElRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const detectorRef = useRef<InstanceType<typeof BarcodeDetectorType> | null>(null);
  const timerRef = useRef<number>(0);
  const recentCodesRef = useRef<Map<string, number>>(new Map());
  const onScanRef = useRef(onScan);
  const stoppedRef = useRef(false);
  const inFlightRef = useRef(false);
  onScanRef.current = onScan;

  const stopScanning = useCallback(() => {
    stoppedRef.current = true;
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = 0;
    }
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) track.stop();
      streamRef.current = null;
    }
    if (videoElRef.current) {
      videoElRef.current.srcObject = null;
    }
    setIsScanning(false);
  }, []);

  const acceptCode = useCallback(
    (code: string) => {
      if (!code) return false;
      const now = Date.now();
      const lastSeen = recentCodesRef.current.get(code);
      if (lastSeen && now - lastSeen < DUPLICATE_WINDOW_MS) return false;
      recentCodesRef.current.set(code, now);
      setLastResult(code);
      stopScanning();
      onScanRef.current(code);
      return true;
    },
    [stopScanning],
  );

  const runDetection = useCallback(async () => {
    if (inFlightRef.current) return;
    const video = videoElRef.current;
    if (!video || video.readyState < video.HAVE_ENOUGH_DATA) return;
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (w === 0 || h === 0) return;

    inFlightRef.current = true;
    try {
      // Capture the current frame to a canvas once, reuse for both detectors
      if (!canvasRef.current) {
        canvasRef.current = document.createElement("canvas");
      }
      const canvas = canvasRef.current;
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) return;
      ctx.drawImage(video, 0, 0, w, h);

      // ── Detector 1: jsQR (pure JS, fast, QR codes only) ────────
      try {
        const imageData = ctx.getImageData(0, 0, w, h);
        const result = jsQR(imageData.data, w, h, { inversionAttempts: "dontInvert" });
        if (result?.data && acceptCode(result.data)) {
          return;
        }
      } catch {
        // jsQR can fail on certain frames — ignore and try the polyfill
      }

      // ── Detector 2: barcode-detector polyfill (WASM, all formats) ──
      const detector = detectorRef.current;
      if (detector) {
        try {
          const barcodes = await detector.detect(video);
          if (stoppedRef.current) return;
          const first = barcodes[0];
          if (first?.rawValue) {
            acceptCode(first.rawValue);
          }
        } catch {
          // detect() can throw on empty/corrupt frames — ignore
        }
      }
    } finally {
      inFlightRef.current = false;
    }
  }, [acceptCode]);

  const startDetectionLoop = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = window.setInterval(() => void runDetection(), SCAN_INTERVAL_MS);
  }, [runDetection]);

  const videoRef: React.RefCallback<HTMLVideoElement> = useCallback(
    (el: HTMLVideoElement | null) => {
      videoElRef.current = el;
      if (el && streamRef.current && !stoppedRef.current) {
        el.srcObject = streamRef.current;
        el.play()
          .then(() => startDetectionLoop())
          .catch(() => {});
      }
    },
    [startDetectionLoop],
  );

  const start = useCallback(async () => {
    if (!isSupported) return;

    stopScanning();
    stoppedRef.current = false;
    setLastResult(null);
    setError(null);
    recentCodesRef.current.clear();

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } },
      });

      if (stoppedRef.current) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }

      streamRef.current = stream;
      setPermissionState("granted");
      setIsScanning(true);

      // Try to load the polyfill detector for 1D barcodes — but don't block scanning if it fails.
      // jsQR works regardless and handles QR codes, which is the primary use case.
      if (!detectorRef.current) {
        getDetectorClass()
          .then((DetectorClass) => {
            try {
              detectorRef.current = new DetectorClass({
                formats: ["qr_code", "ean_13", "ean_8", "code_128", "code_39", "upc_a", "upc_e", "itf"],
              });
            } catch (err) {
              console.warn("BarcodeDetector polyfill failed to init; QR-only mode:", err);
            }
          })
          .catch((err) => {
            console.warn("BarcodeDetector polyfill import failed; QR-only mode:", err);
          });
      }

      if (videoElRef.current) {
        videoElRef.current.srcObject = stream;
        await videoElRef.current.play();
        startDetectionLoop();
      }
    } catch (err) {
      console.error("Camera start failed:", err);
      const message = err instanceof Error ? err.message : "Could not start the camera.";
      setError(message);
      setPermissionState("denied");
    }
  }, [isSupported, stopScanning, startDetectionLoop]);

  useEffect(() => () => stopScanning(), [stopScanning]);

  useEffect(() => {
    const onHide = () => { if (document.hidden) stopScanning(); };
    document.addEventListener("visibilitychange", onHide);
    return () => document.removeEventListener("visibilitychange", onHide);
  }, [stopScanning]);

  return { isSupported, permissionState, videoRef, isScanning, start, stop: stopScanning, lastResult, error };
}
