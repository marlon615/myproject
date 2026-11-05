import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { churchBySlug } from "@/lib/church";
import { PastorNote, ServiceInfo } from "@/components/ChurchInfo";
import { BrandMark } from "@/components/Brand";
import { GuestForm } from "./GuestForm";

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const church = await churchBySlug((await params).slug);
  return church
    ? { title: `Welcome to ${church.name}`, description: `We're so glad you're here. Say hi to ${church.name}.`, robots: { index: false } }
    : { title: "Not found" };
}

export default async function GuestPage({ params }: Props) {
  const { slug } = await params;
  const church = await churchBySlug(slug);
  if (!church) notFound();

  return (
    <div className="guest-page">
      <div className="guest-hero">
        <div className="eyebrow">Welcome</div>
        <h1>We&apos;re so glad you&apos;re here!</h1>
        <p className="muted" style={{ margin: 0 }}>{church.name}{church.city ? ` · ${church.city}` : ""}</p>
      </div>
      <main className="container narrow stack" style={{ paddingTop: 16 }}>
        <div className="card">
          <h2 style={{ fontSize: "1.25rem" }}>Say hi 👋</h2>
          <p className="muted small">Leave your first name and number and we&apos;ll text you a quick welcome with everything you need to know. No app to download.</p>
          <GuestForm slug={church.slug} churchName={church.name} />
        </div>
        <PastorNote church={church} />
        <ServiceInfo church={church} />
        <p className="center tiny muted" style={{ paddingTop: 12, display: "flex", gap: 6, alignItems: "center", justifyContent: "center" }}>
          <BrandMark size={18} /> Powered by ChurchFollow · We never share your number.
        </p>
      </main>
    </div>
  );
}
