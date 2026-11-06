import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { churchBySlug } from "@/lib/church";
import { PastorNote, ServiceInfo } from "@/components/ChurchInfo";
import { BrandMark } from "@/components/Brand";

type Props = { params: Promise<{ slug: string }>; searchParams: Promise<{ name?: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const church = await churchBySlug((await params).slug);
  return church ? { title: `Your welcome pack · ${church.name}`, robots: { index: false } } : { title: "Not found" };
}

/** The "welcome pack": shown after submitting, and linked from the thank-you text. */
export default async function WelcomePage({ params, searchParams }: Props) {
  const [{ slug }, { name }] = await Promise.all([params, searchParams]);
  const church = await churchBySlug(slug);
  if (!church) notFound();
  const first = name?.trim().slice(0, 40);

  return (
    <div className="guest-page">
      <div className="guest-hero">
        <div className="eyebrow">{first ? "Thanks for saying hi" : "Your welcome pack"}</div>
        <h1>{first ? `Welcome, ${first}!` : `Welcome to ${church.name}`}</h1>
        <p className="muted" style={{ margin: 0 }}>
          {first ? "Check your phone — a welcome text is on its way." : `${church.name}${church.city ? ` · ${church.city}` : ""}`}
        </p>
      </div>
      <main className="container narrow stack" style={{ paddingTop: 16 }}>
        <PastorNote church={church} />
        <ServiceInfo church={church} />
        <p className="center tiny muted" style={{ paddingTop: 12, display: "flex", gap: 6, alignItems: "center", justifyContent: "center" }}>
          <BrandMark size={18} /> Powered by ChurchFollow
        </p>
      </main>
    </div>
  );
}
