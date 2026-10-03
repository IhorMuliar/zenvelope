import { useEffect, useState, type RefObject } from "react";

/** True when the visitor asked for less motion. Read once per call; cheap. */
export function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  } catch {
    return false;
  }
}

/** The same, as React state that follows the setting while the page is open. */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(prefersReducedMotion);
  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!mq) return;
    const on = () => setReduced(mq.matches);
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
  }, []);
  return reduced;
}

/**
 * Tilt, glare and foil for a note, driven only through CSS custom properties.
 *
 * A mouse or pen over the note tilts it; on a phone the device's own tilt does,
 * where the browser hands out orientation events without a permission prompt
 * (iOS asks, so there the note simply stays flat). Every input is coalesced
 * into one write per animation frame, and nothing here reads layout except the
 * note's own box on pointer move, which the browser has ready anyway.
 */
export function useTilt(ref: RefObject<HTMLElement>, enabled = true): void {
  const reduced = useReducedMotion();
  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled || reduced) return;

    let frame = 0;
    let next: { x: number; y: number } | null = null;
    const write = () => {
      frame = 0;
      if (!next) return;
      const { x, y } = next; // 0..1 each, 0.5 is flat
      el.style.setProperty("--ry", `${((x - 0.5) * 14).toFixed(2)}deg`);
      el.style.setProperty("--rx", `${((0.5 - y) * 10).toFixed(2)}deg`);
      el.style.setProperty("--mx", (x * 100).toFixed(1));
      el.style.setProperty("--my", (y * 100).toFixed(1));
      el.style.setProperty("--fx", ((x - 0.5) * 60).toFixed(1));
    };
    const queue = (x: number, y: number) => {
      next = { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
      if (!frame) frame = requestAnimationFrame(write);
    };

    let box: DOMRect | null = null;
    const onEnter = (e: PointerEvent) => {
      if (e.pointerType === "touch") return;
      box = el.getBoundingClientRect();
    };
    const onMove = (e: PointerEvent) => {
      if (e.pointerType === "touch") return;
      // Only a hand on the mouse tilts it: a note rising under a cursor that
      // is standing still must not lurch.
      if (e.movementX === 0 && e.movementY === 0) return;
      if (!box) box = el.getBoundingClientRect();
      queue((e.clientX - box.left) / box.width, (e.clientY - box.top) / box.height);
    };
    const onLeave = () => {
      box = null;
      queue(0.5, 0.5);
    };
    el.addEventListener("pointerenter", onEnter);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerleave", onLeave);

    // Device tilt, only where it needs no permission prompt.
    let base: { b: number; g: number } | null = null;
    const onOrient = (e: DeviceOrientationEvent) => {
      if (e.beta === null || e.gamma === null) return;
      if (!base) base = { b: e.beta, g: e.gamma };
      const dx = (e.gamma - base.g) / 40;
      const dy = (e.beta - base.b) / 40;
      queue(0.5 + dx, 0.5 + dy);
    };
    type WithPermission = { requestPermission?: () => Promise<string> };
    const needsPrompt =
      typeof DeviceOrientationEvent !== "undefined" &&
      typeof (DeviceOrientationEvent as unknown as WithPermission).requestPermission === "function";
    const coarse = window.matchMedia?.("(pointer: coarse)").matches ?? false;
    const useOrientation = coarse && !needsPrompt && "DeviceOrientationEvent" in window;
    if (useOrientation) window.addEventListener("deviceorientation", onOrient);

    return () => {
      el.removeEventListener("pointerenter", onEnter);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerleave", onLeave);
      if (useOrientation) window.removeEventListener("deviceorientation", onOrient);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [ref, enabled, reduced]);
}
