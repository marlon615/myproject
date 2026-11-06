import Link from "next/link";

/** A cairn: three stacked stones. */
export function BrandMark({ size = 28 }: { size?: number }) {
  return (
    <span className="brand-mark" style={{ width: size, height: size }} aria-hidden>
      <svg width={size * 0.64} height={size * 0.64} viewBox="0 0 24 24" fill="currentColor">
        <ellipse cx="12" cy="19" rx="8.5" ry="3" />
        <ellipse cx="12" cy="12.6" rx="6" ry="2.6" fill="#f5a37c" />
        <ellipse cx="12" cy="7" rx="3.6" ry="2.2" />
      </svg>
    </span>
  );
}

export function Brand({ href = "/" }: { href?: string }) {
  return (
    <Link href={href} className="brand">
      <BrandMark />
      CallCairn
    </Link>
  );
}
