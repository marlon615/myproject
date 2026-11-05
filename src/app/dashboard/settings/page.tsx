import type { Metadata } from "next";
import { requireChurch } from "@/lib/session";
import { SettingsForm } from "./SettingsForm";

export const metadata: Metadata = { title: "Church info" };

export default async function SettingsPage() {
  const church = await requireChurch();
  return (
    <div className="stack-lg" style={{ maxWidth: 680 }}>
      <div>
        <h1 style={{ marginBottom: 4 }}>Church info</h1>
        <p className="muted" style={{ margin: 0 }}>This appears on your guest page and in your welcome texts. Your QR code stays the same.</p>
      </div>
      <div className="card">
        <SettingsForm
          defaults={{
            name: church.name, city: church.city, pastorName: church.pastorName,
            serviceTimes: church.serviceTimes, whatToExpect: church.whatToExpect, welcomeMessage: church.welcomeMessage,
          }}
        />
      </div>
      <p className="small muted">Logged in as {church.email}</p>
    </div>
  );
}
