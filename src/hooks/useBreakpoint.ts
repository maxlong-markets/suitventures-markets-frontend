"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * Handoff breakpoints, by viewport width (the app root spans the viewport):
 * phone < 680, tablet 680–1179, desktop ≥ 1180. Layout is CSS-driven where
 * possible; this hook is for the few things that need a number (chip count,
 * row tap behaviour). The server snapshot is desktop.
 */
export type Breakpoint = "phone" | "tablet" | "desktop";

export const TABLET_QUERY = "(min-width: 680px)";
export const DESKTOP_QUERY = "(min-width: 1180px)";

function subscribe(onChange: () => void): () => void {
  const tablet = window.matchMedia(TABLET_QUERY);
  const desktop = window.matchMedia(DESKTOP_QUERY);
  tablet.addEventListener("change", onChange);
  desktop.addEventListener("change", onChange);
  return () => {
    tablet.removeEventListener("change", onChange);
    desktop.removeEventListener("change", onChange);
  };
}

function getSnapshot(): Breakpoint {
  if (window.matchMedia(DESKTOP_QUERY).matches) return "desktop";
  if (window.matchMedia(TABLET_QUERY).matches) return "tablet";
  return "phone";
}

export function useBreakpoint(): Breakpoint {
  return useSyncExternalStore(subscribe, getSnapshot, () => "desktop");
}

export function useMediaQuery(query: string, serverValue = false): boolean {
  const sub = useCallback(
    (onChange: () => void) => {
      const m = window.matchMedia(query);
      m.addEventListener("change", onChange);
      return () => m.removeEventListener("change", onChange);
    },
    [query],
  );
  return useSyncExternalStore(
    sub,
    () => window.matchMedia(query).matches,
    () => serverValue,
  );
}

/** Synchronous check for event handlers (row tap → expand vs navigate). */
export function isPhoneNow(): boolean {
  return (
    typeof window !== "undefined" && !window.matchMedia(TABLET_QUERY).matches
  );
}
