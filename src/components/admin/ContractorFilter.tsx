import Link from "next/link";

/** "Showing one contractor" chip for the owner list pages. */
export function ContractorFilter({ name, base }: { name?: string | null; base: string }) {
  if (!name) return null;
  return <div className="chips"><span className="chip active">{name}</span><Link href={base} className="chip">Show all</Link></div>;
}
export const uuidOrUndefined = (s?: string) => (s && /^[0-9a-f-]{36}$/i.test(s) ? s : undefined);
export const pageNum = (s?: string) => Math.max(1, Math.min(10000, Number(s) || 1));
export function pageHref(base: string, c: string | undefined, p: number) {
  return `${base}?${new URLSearchParams({ ...(c && { c }), page: String(p) })}`;
}
