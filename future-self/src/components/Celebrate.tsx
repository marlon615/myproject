"use client";

import { useEffect, useMemo } from "react";

/** Full-screen burst for a new win. Respects reduced-motion. */
export default function Celebrate({ text, onDone }: { text: string; onDone: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDone, 2800);
    try {
      navigator.vibrate?.([30, 40, 60]);
    } catch {}
    return () => clearTimeout(t);
  }, [onDone]);

  const bits = useMemo(
    () =>
      Array.from({ length: 36 }, (_, i) => ({
        angle: (i / 36) * 360 + Math.random() * 10,
        dist: 120 + Math.random() * 140,
        size: 6 + Math.random() * 8,
        delay: Math.random() * 0.15,
        tone: i % 3,
      })),
    [],
  );

  return (
    <div className="celebrate" role="status" aria-live="polite" onClick={onDone}>
      <div className="burst" aria-hidden>
        {bits.map((b, i) => (
          <i
            key={i}
            className={`spark tone-${b.tone}`}
            style={{ "--a": `${b.angle}deg`, "--d": `${b.dist}px`, "--s": `${b.size}px`, animationDelay: `${b.delay}s` } as React.CSSProperties}
          />
        ))}
      </div>
      <div className="celebrate-card">
        <div className="celebrate-kicker">WIN LOGGED</div>
        <div className="celebrate-text">{text}</div>
        <div className="celebrate-sub">Future you remembers this one.</div>
      </div>
    </div>
  );
}
