import { useEffect, useState } from "react";
import { useCamera } from "../hooks/useCamera";

interface QRScannerProps {
  onScan: (code: string) => void;
  enabled: boolean;
  isLookingUp?: boolean;
  blockedReason?: string | null;
  onScanNext?: () => void;
}

export function QRScanner({
  onScan,
  enabled,
  isLookingUp = false,
  blockedReason = null,
  onScanNext,
}: QRScannerProps) {
  const camera = useCamera(onScan);
  const [showManual, setShowManual] = useState(false);

  useEffect(() => {
    if (blockedReason) {
      camera.stop();
    }
  }, [blockedReason, camera]);

  if (!camera.isSupported) {
    return null;
  }

  if (camera.permissionState === "denied") {
    return (
      <div className="qr-scanner">
        <p className="banner error">{camera.error ?? "Camera permission denied. Use manual input instead."}</p>
      </div>
    );
  }

  return (
    <div className="qr-scanner">
      {blockedReason ? <p className="banner error">{blockedReason}</p> : null}

      {!camera.isScanning && camera.lastResult ? (
        <div className="scan-status" aria-live="polite">
          <strong>Detected {camera.lastResult}</strong>
          <p>{isLookingUp ? `Looking up ${camera.lastResult}...` : "Ready to scan the next item."}</p>
        </div>
      ) : null}

      {camera.permissionState !== "granted" && enabled ? (
        <button
          type="button"
          className="camera-btn"
          disabled={Boolean(blockedReason) || isLookingUp}
          onClick={() => {
            setShowManual(false);
            void camera.start();
          }}
        >
          <span className="camera-ascii" aria-hidden="true">
            {"┌──────────┐\n│  ◉  ▣▣  │\n└──────────┘"}
          </span>
          <span>Tap to scan</span>
        </button>
      ) : null}
      {camera.isScanning ? (
        <>
          <div className="viewfinder">
            <video ref={camera.videoRef} playsInline muted />
            <div className="viewfinder-guide" />
            {camera.lastResult ? <div className="scan-flash" /> : null}
          </div>
          <button
            type="button"
            onClick={() => {
              camera.stop();
              setShowManual(true);
            }}
          >
            Switch to manual input
          </button>
        </>
      ) : null}
      {!camera.isScanning && camera.lastResult && !isLookingUp ? (
        <button
          type="button"
          disabled={Boolean(blockedReason)}
          onClick={() => {
            onScanNext?.();
            setShowManual(false);
            void camera.start();
          }}
        >
          Scan next
        </button>
      ) : null}
      {showManual ? (
        <button
          type="button"
          disabled={Boolean(blockedReason) || isLookingUp}
          onClick={() => {
            setShowManual(false);
            void camera.start();
          }}
        >
          Switch to camera
        </button>
      ) : null}
    </div>
  );
}
