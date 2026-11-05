"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

export function NavLinks({ links }: { links: { href: string; label: string; exact?: boolean }[] }) {
  const path = usePathname();
  return (
    <>
      {links.map((l) => {
        const active = l.exact ? path === l.href : path === l.href || path.startsWith(l.href + "/");
        return (
          <Link key={l.href} href={l.href} className={active ? "active" : undefined}>
            {l.label}
          </Link>
        );
      })}
    </>
  );
}
