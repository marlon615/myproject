import Link from "next/link";
import { BrandMark } from "@/components/Brand";

export default function NotFound() {
  return (
    <main className="container narrow center" style={{ paddingTop: 80 }}>
      <BrandMark size={44} />
      <h1 style={{ marginTop: 16 }}>Page not found</h1>
      <p className="muted">If you scanned a pew card, please ask an usher — we&apos;d love to help.</p>
      <Link href="/" className="btn btn-secondary">Go home</Link>
    </main>
  );
}
