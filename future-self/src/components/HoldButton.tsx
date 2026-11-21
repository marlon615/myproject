"use client";

import { useRef } from "react";

/**
 * Press-and-hold control. Works with touch, mouse and keyboard (hold Space/Enter).
 * If the finger slides off or the browser cancels the touch, it still ends cleanly.
 */
export default function HoldButton({
  onStart, onEnd, onTap, className, children, label, disabled,
}: {
  onStart: () => void;
  onEnd: () => void;
  onTap?: () => boolean; // return true to swallow the press (e.g. "stop speaking")
  className?: string;
  children: React.ReactNode;
  label: string;
  disabled?: boolean;
}) {
  const down = useRef(false);
  const begin = (e: React.PointerEvent | React.KeyboardEvent) => {
    if (disabled || down.current) return;
    if ("pointerId" in e) {
      try {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      } catch {}
    }
    if (onTap?.()) return;
    down.current = true;
    onStart();
  };
  const end = () => {
    if (!down.current) return;
    down.current = false;
    onEnd();
  };
  return (
    <button
      type="button"
      className={className}
      aria-label={label}
      disabled={disabled}
      onPointerDown={(e) => {
        e.preventDefault();
        begin(e);
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        if ((e.key === " " || e.key === "Enter") && !e.repeat) {
          e.preventDefault();
          begin(e);
        }
      }}
      onKeyUp={(e) => {
        if (e.key === " " || e.key === "Enter") end();
      }}
    >
      {children}
    </button>
  );
}
