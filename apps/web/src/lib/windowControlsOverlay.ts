import { isWindowsPlatform } from "./utils";

const WCO_CLASS_NAME = "wco";
const PAGE_WINDOW_CONTROLS_CLASS_NAME = "page-window-controls";
const ELECTRON_CLASS_NAME = "electron";
const ELECTRON_WINDOWS_CLASS_NAME = "electron-windows";

interface WindowControlsOverlayLike {
  readonly visible: boolean;
  addEventListener(type: "geometrychange", listener: EventListener): void;
  removeEventListener(type: "geometrychange", listener: EventListener): void;
}

interface NavigatorWithWindowControlsOverlay extends Navigator {
  readonly windowControlsOverlay?: WindowControlsOverlayLike;
}

function getWindowControlsOverlay(): WindowControlsOverlayLike | null {
  if (typeof navigator === "undefined") {
    return null;
  }

  return (navigator as NavigatorWithWindowControlsOverlay).windowControlsOverlay ?? null;
}

/**
 * `.wco` lays the title bar out around the window controls. Chromium's
 * window-controls overlay reports their geometry through `titlebar-area-*`;
 * a shell that draws no native controls (`desktopBridge.windowControls`)
 * gets `.page-window-controls` too, where the geometry is the web-drawn
 * `WindowCaptionControls`' own (index.css).
 */
export function syncDocumentWindowControlsOverlayClass(): () => void {
  if (typeof document === "undefined") {
    return () => {};
  }

  if (window.desktopBridge?.windowControls !== undefined) {
    document.documentElement.classList.add(WCO_CLASS_NAME, PAGE_WINDOW_CONTROLS_CLASS_NAME);
    return () => {
      document.documentElement.classList.remove(WCO_CLASS_NAME, PAGE_WINDOW_CONTROLS_CLASS_NAME);
    };
  }

  const overlay = getWindowControlsOverlay();
  const update = () => {
    document.documentElement.classList.toggle(WCO_CLASS_NAME, overlay !== null && overlay.visible);
  };

  update();
  if (!overlay) {
    return () => {};
  }

  overlay.addEventListener("geometrychange", update);
  return () => {
    overlay.removeEventListener("geometrychange", update);
  };
}

function getElectronPlatformClassNames(
  platform: string,
):
  | readonly [typeof ELECTRON_CLASS_NAME]
  | readonly [typeof ELECTRON_CLASS_NAME, typeof ELECTRON_WINDOWS_CLASS_NAME] {
  return isWindowsPlatform(platform)
    ? [ELECTRON_CLASS_NAME, ELECTRON_WINDOWS_CLASS_NAME]
    : [ELECTRON_CLASS_NAME];
}

export function syncDocumentElectronPlatformClasses(platform: string): () => void {
  if (typeof document === "undefined") {
    return () => {};
  }

  const classNames = getElectronPlatformClassNames(platform);
  document.documentElement.classList.add(...classNames);
  return () => {
    document.documentElement.classList.remove(...classNames);
  };
}
