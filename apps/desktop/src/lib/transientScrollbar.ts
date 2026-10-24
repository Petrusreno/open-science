import { useCallback, useRef } from "react";

/** How long the scrollbar stays after the last touch or scroll. */
const LINGER_MS = 1000;

/**
 * Show a `.scrollbar-transient` box's scrollbar only while it is being
 * touched or scrolled: marks the box `data-scrolling` from the first touch
 * until a moment after the last scroll.
 *
 * Returns a callback ref, so a box that mounts later (the pane row appears
 * only once a Screen has two panes) is still wired up.
 */
export function useTransientScrollbar(): (el: HTMLElement | null) => void {
  const cleanup = useRef<(() => void) | null>(null);
  return useCallback((el: HTMLElement | null) => {
    cleanup.current?.();
    cleanup.current = null;
    if (!el) return;
    let timer: number | undefined;
    const hideLater = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => el.removeAttribute("data-scrolling"), LINGER_MS);
    };
    const show = () => {
      el.setAttribute("data-scrolling", "");
      hideLater();
    };
    el.addEventListener("scroll", show, { passive: true });
    el.addEventListener("touchstart", show, { passive: true });
    el.addEventListener("touchend", hideLater, { passive: true });
    cleanup.current = () => {
      window.clearTimeout(timer);
      el.removeEventListener("scroll", show);
      el.removeEventListener("touchstart", show);
      el.removeEventListener("touchend", hideLater);
    };
  }, []);
}
