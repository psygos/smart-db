import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  createPwaInstallController,
  pwaInstallNeverShowStorageKey,
  registerPwa,
} from "./pwa";

const serviceWorkerTemplatePath = resolve(process.cwd(), "apps/frontend/service-worker.template.js");
const stylesheetPath = resolve(process.cwd(), "apps/frontend/src/styles.css");
const indexPath = resolve(process.cwd(), "apps/frontend/index.html");

function windowStub(
  origin = "https://smartdb.example.com",
  options: {
    readonly userAgent?: string;
    readonly maxTouchPoints?: number;
    readonly standalone?: boolean;
    readonly displayModeStandalone?: boolean;
  } = {},
) {
  const listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  return {
    location: { origin },
    navigator: {
      userAgent: options.userAgent ?? "Mozilla/5.0",
      maxTouchPoints: options.maxTouchPoints ?? 0,
      standalone: options.standalone ?? false,
    },
    matchMedia: vi.fn((query: string) => ({
      matches: options.displayModeStandalone === true && query === "(display-mode: standalone)",
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
    addEventListener: vi.fn((type: string, listener: EventListenerOrEventListenerObject) => {
      const next = listeners.get(type) ?? new Set<EventListenerOrEventListenerObject>();
      next.add(listener);
      listeners.set(type, next);
    }),
    removeEventListener: vi.fn((type: string, listener: EventListenerOrEventListenerObject) => {
      listeners.get(type)?.delete(listener);
    }),
    dispatch(eventOrType: Event | string) {
      const event = typeof eventOrType === "string" ? new Event(eventOrType) : eventOrType;
      for (const listener of listeners.get(event.type) ?? []) {
        if (typeof listener === "function") {
          listener(event);
        } else {
          listener.handleEvent(event);
        }
      }
    },
  };
}

function storageStub(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, value);
    }),
  };
}

function beforeInstallPromptStub(outcome: "accepted" | "dismissed" = "accepted") {
  const event = new Event("beforeinstallprompt") as Event & {
    prompt: ReturnType<typeof vi.fn>;
    userChoice: Promise<{ readonly outcome: "accepted" | "dismissed"; readonly platform: string }>;
  };
  Object.assign(event, {
    prompt: vi.fn().mockResolvedValue(undefined),
    userChoice: Promise.resolve({ outcome, platform: "web" }),
  });
  vi.spyOn(event, "preventDefault");
  return event;
}

describe("registerPwa", () => {
  it("does nothing when disabled", () => {
    const worker = { register: vi.fn() } as unknown as ServiceWorkerContainer;
    const win = windowStub();

    registerPwa({ enabled: false, serviceWorker: worker, windowRef: win as unknown as Window });

    expect(win.addEventListener).not.toHaveBeenCalled();
    expect(worker.register).not.toHaveBeenCalled();
  });

  it("registers the service worker on load with a normalized scope", () => {
    const worker = { register: vi.fn().mockResolvedValue(undefined) } as unknown as ServiceWorkerContainer;
    const win = windowStub("https://smartdb.example.com");

    registerPwa({
      enabled: true,
      baseUrl: "lab",
      serviceWorker: worker,
      windowRef: win as unknown as Window,
    });

    expect(worker.register).not.toHaveBeenCalled();
    win.dispatch("load");

    expect(worker.register).toHaveBeenCalledWith(
      "https://smartdb.example.com/lab/service-worker.js",
      { scope: "/lab/" },
    );
  });

  it("logs registration failures without breaking app startup", async () => {
    const failure = new Error("registration blocked");
    const worker = { register: vi.fn().mockRejectedValue(failure) } as unknown as ServiceWorkerContainer;
    const logger = { warn: vi.fn() };
    const win = windowStub();

    registerPwa({
      enabled: true,
      serviceWorker: worker,
      windowRef: win as unknown as Window,
      logger,
    });
    win.dispatch("load");
    await Promise.resolve();

    expect(logger.warn).toHaveBeenCalledWith(
      "Smart DB service worker registration failed.",
      failure,
    );
  });

  it("serves precached static assets before falling back to network", () => {
    const template = readFileSync(serviceWorkerTemplatePath, "utf8");

    expect(template).toContain("await cache.match(request) ?? await caches.match(request)");
  });
});

describe("mobile form controls", () => {
  it("keeps every form-control override at or above iOS Safari's 16px zoom threshold", () => {
    const stylesheet = readFileSync(stylesheetPath, "utf8");

    expect(stylesheet).toMatch(/input, select, textarea \{[\s\S]*?font-size: 16px;/);
    expect(stylesheet).toMatch(/\.path-search input\[type="search"\] \{[\s\S]*?font-size: 16px;/);
    expect(stylesheet).toMatch(/\.panel-admin select,[\s\S]*?font-size: 16px;/);
    expect(stylesheet).toMatch(/\.scan-input-row input \{[\s\S]*?font-size: 16px;/);
    expect(stylesheet).toMatch(/\.location-card \.location-card-input input \{[\s\S]*?font-size: 16px;/);
  });

  it("stabilizes mobile text sizing and double-tap actions without disabling pinch zoom", () => {
    const stylesheet = readFileSync(stylesheetPath, "utf8");
    const index = readFileSync(indexPath, "utf8");

    expect(stylesheet).toContain("-webkit-text-size-adjust: 100%");
    expect(stylesheet).toContain("text-size-adjust: 100%");
    expect(stylesheet).toContain("touch-action: manipulation");
    expect(index).not.toMatch(/maximum-scale|user-scalable\s*=\s*no/i);
  });
});

describe("createPwaInstallController", () => {
  it("shows a prompt-capable Android banner after beforeinstallprompt and installs in one click", async () => {
    const win = windowStub("https://smartdb.example.com", {
      userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 9)",
    });
    const storage = storageStub();
    const controller = createPwaInstallController({
      enabled: true,
      windowRef: win,
      navigatorRef: win.navigator,
      storage,
    });

    expect(controller.getSnapshot()).toMatchObject({
      visible: false,
      device: "android",
      canPrompt: false,
    });

    const event = beforeInstallPromptStub("accepted");
    win.dispatch(event);

    expect(event.preventDefault).toHaveBeenCalled();
    expect(controller.getSnapshot()).toMatchObject({
      visible: true,
      device: "android",
      canPrompt: true,
    });

    await expect(controller.requestInstall()).resolves.toBe("accepted");

    expect(event.prompt).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot()).toMatchObject({
      visible: false,
      installed: true,
    });

    controller.destroy();
    expect(win.removeEventListener).toHaveBeenCalledWith("beforeinstallprompt", expect.any(Function));
    expect(win.removeEventListener).toHaveBeenCalledWith("appinstalled", expect.any(Function));
  });

  it("hides the banner when the app is already running standalone", () => {
    const win = windowStub("https://smartdb.example.com", {
      displayModeStandalone: true,
    });

    const controller = createPwaInstallController({
      enabled: true,
      windowRef: win,
      navigatorRef: win.navigator,
      storage: storageStub(),
    });

    expect(controller.getSnapshot()).toMatchObject({
      visible: false,
      installed: true,
    });

    controller.destroy();
  });

  it("shows iOS-specific guidance and persists never-show-again dismissal", () => {
    const win = windowStub("https://smartdb.example.com", {
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)",
    });
    const storage = storageStub();
    const controller = createPwaInstallController({
      enabled: true,
      windowRef: win,
      navigatorRef: win.navigator,
      storage,
    });

    expect(controller.getSnapshot()).toMatchObject({
      visible: true,
      device: "ios",
      canPrompt: false,
    });

    controller.dismiss({ neverShowAgain: true });

    expect(storage.setItem).toHaveBeenCalledWith(pwaInstallNeverShowStorageKey, "1");
    expect(controller.getSnapshot()).toMatchObject({
      visible: false,
      neverShowAgain: true,
    });

    const nextController = createPwaInstallController({
      enabled: true,
      windowRef: win,
      navigatorRef: win.navigator,
      storage,
    });

    expect(nextController.getSnapshot()).toMatchObject({
      visible: false,
      neverShowAgain: true,
    });

    controller.destroy();
    nextController.destroy();
  });
});
