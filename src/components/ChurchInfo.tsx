import type { Church } from "@/db";
import { ClockIcon, InfoIcon, HeartIcon } from "@/components/Icons";

export function PastorNote({ church }: { church: Church }) {
  return (
    <div className="card">
      <div className="pastor-note">
        <span style={{ color: "var(--accent)" }}><HeartIcon size={18} /></span>{" "}
        &ldquo;{church.welcomeMessage}&rdquo;
        <div className="pastor-sig">— {church.pastorName}</div>
      </div>
    </div>
  );
}

export function ServiceInfo({ church }: { church: Church }) {
  return (
    <>
      <div className="card info-block">
        <h3><span className="icon-circle"><ClockIcon /></span> Service times</h3>
        <p className="pre" style={{ margin: 0 }}>{church.serviceTimes}</p>
      </div>
      <div className="card info-block">
        <h3><span className="icon-circle"><InfoIcon /></span> What to expect</h3>
        <p className="pre" style={{ margin: 0 }}>{church.whatToExpect}</p>
      </div>
    </>
  );
}
