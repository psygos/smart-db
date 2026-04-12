import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCamera } from "./useCamera";

const mockDetect = vi.fn();
const mockGetUserMedia = vi.fn();
const mockTrackStop = vi.fn();

function mockVideoElement() {
  return {
    srcObject: null as unknown,
    play: vi.fn().mockResolvedValue(undefined),
  } as unknown as HTMLVideoElement;
}

beforeEach(() => {
  mockDetect.mockReset();
  mockGetUserMedia.mockReset();
  mockTrackStop.mockReset();

  vi.stubGlobal("BarcodeDetector", class {
    detect = mockDetect;
  });

  Object.defineProperty(navigator, "mediaDevices", {
    value: { getUserMedia: mockGetUserMedia },
    writable: true,
    configurable: true,
  });

  mockGetUserMedia.mockResolvedValue({
    getTracks: () => [{ stop: mockTrackStop }],
  });

  mockDetect.mockResolvedValue([]);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useCamera", () => {
  it("detects BarcodeDetector support", () => {
    const { result } = renderHook(() => useCamera(vi.fn()));
    expect(result.current.isSupported).toBe(true);
  });

  it("reports unsupported when mediaDevices is unavailable and start is a no-op", async () => {
    Object.defineProperty(navigator, "mediaDevices", {
      value: undefined,
      writable: true,
      configurable: true,
    });
    const { result } = renderHook(() => useCamera(vi.fn()));
    expect(result.current.isSupported).toBe(false);

    await act(async () => {
      await result.current.start();
    });
    expect(result.current.permissionState).toBe("unknown");
  });

  it("starts the camera and sets granted + isScanning", async () => {
    const onScan = vi.fn();

    const { result } = renderHook(() => useCamera(onScan));

    await act(async () => {
      await result.current.start();
    });

    expect(result.current.permissionState).toBe("granted");
    expect(result.current.isScanning).toBe(true);
    expect(mockGetUserMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        video: expect.objectContaining({ facingMode: "environment" }),
      }),
    );
  });

  it("sets permission denied when getUserMedia fails", async () => {
    mockGetUserMedia.mockRejectedValueOnce(new DOMException("denied", "NotAllowedError"));

    const { result } = renderHook(() => useCamera(vi.fn()));

    await act(async () => {
      await result.current.start();
    });

    expect(result.current.permissionState).toBe("denied");
  });

  it("handles detection errors gracefully", async () => {
    const onScan = vi.fn();
    mockDetect.mockRejectedValueOnce(new Error("empty frame"));

    let rafCallback: FrameRequestCallback | null = null;
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      if (!rafCallback) rafCallback = cb;
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());

    const { result } = renderHook(() => useCamera(onScan));
    (result.current.videoRef as { current: HTMLVideoElement | null }).current = mockVideoElement();

    await act(async () => {
      await result.current.start();
    });

    if (rafCallback) {
      await act(async () => {
        await (rafCallback as FrameRequestCallback)(performance.now());
      });
    }

    expect(onScan).not.toHaveBeenCalled();
  });

  it("exposes an error field that is initially null", () => {
    const { result } = renderHook(() => useCamera(vi.fn()));
    expect(result.current.error).toBeNull();
  });

  it("stops the camera and cleans up tracks on unmount", async () => {
    vi.stubGlobal("requestAnimationFrame", vi.fn().mockReturnValue(1));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());

    const { result } = renderHook(() => useCamera(vi.fn()));
    (result.current.videoRef as { current: HTMLVideoElement | null }).current = mockVideoElement();

    await act(async () => {
      await result.current.start();
    });

    unmount(result);
    expect(mockTrackStop).toHaveBeenCalled();
  });

  it("stops the camera when the page becomes hidden", async () => {
    vi.stubGlobal("requestAnimationFrame", vi.fn().mockReturnValue(1));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());

    const { result } = renderHook(() => useCamera(vi.fn()));
    (result.current.videoRef as { current: HTMLVideoElement | null }).current = mockVideoElement();

    await act(async () => {
      await result.current.start();
    });

    act(() => {
      Object.defineProperty(document, "hidden", { value: true, configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });

    expect(mockTrackStop).toHaveBeenCalled();
    expect(result.current.isScanning).toBe(false);
  });
});

function unmount(result: { current: ReturnType<typeof useCamera> }) {
  act(() => {
    result.current.stop();
  });
}
