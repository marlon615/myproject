import type { Metadata } from "next";
import { requireContractor } from "@/lib/session";
import { SettingsForm } from "./SettingsForm";
import { formatPhone } from "@/lib/utils";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage() {
  const c = await requireContractor();
  return (
    <div className="stack-lg" style={{ maxWidth: 720 }}>
      <div>
        <h1 style={{ marginBottom: 4 }}>Settings</h1>
        <p className="muted" style={{ margin: 0 }}>How the assistant introduces you, when it books jobs, and who it alerts.</p>
      </div>
      <div className="card">
        <SettingsForm
          d={{
            businessName: c.businessName, ownerName: c.ownerName, businessPhone: formatPhone(c.businessPhone), alertPhone: formatPhone(c.alertPhone),
            serviceArea: c.serviceArea ?? "", timezone: c.timezone, hoursStart: c.hoursStart, hoursEnd: c.hoursEnd, workDays: c.workDays,
            slotMinutes: c.slotMinutes, jobsPerSlot: c.jobsPerSlot, emergencyDispatch: c.emergencyDispatch, emergencyNote: c.emergencyNote ?? "",
          }}
        />
      </div>
      <p className="small muted">Logged in as {c.email}</p>
    </div>
  );
}
