import Link from "next/link";

export function BrandMark({ size = 28 }: { size?: number }) {
  return (
    <span className="brand-mark" style={{ width: size, height: size }} aria-hidden>
      <svg width={size * 0.6} height={size * 0.6} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 3v6M9 6h6" />
        <path d="M5 21V12l7-4 7 4v9" />
        <path d="M10 21v-4a2 2 0 0 1 4 0v4" />
      </svg>
    </span>
  );
}

export function Brand({ href = "/" }: { href?: string }) {
  return (
    <Link href={href} className="brand">
      <BrandMark />
      ChurchFollow
    </Link>
  );
}
