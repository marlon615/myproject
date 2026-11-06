import type { Metadata } from "next";
import { requireContractor } from "@/lib/session";
import { conversationList } from "@/lib/dashboard";
import { ConversationItem } from "@/components/ConversationItem";

export const metadata: Metadata = { title: "Calls & texts" };

export default async function ActivityPage() {
  const c = await requireContractor();
  const rows = await conversationList(c, 200);
  return (
    <div className="stack-lg">
      <div>
        <h1 style={{ marginBottom: 4 }}>Calls &amp; texts</h1>
        <p className="muted" style={{ margin: 0 }}>Every caller the assistant talked to, newest first. Open one to see the transcript and texts.</p>
      </div>
      <div className="card">
        {rows.length === 0 ? <p className="muted" style={{ margin: 0 }}>No calls or texts yet.</p> : (
          <ul className="list">{rows.map((r) => <ConversationItem key={r.conv.id} {...r} />)}</ul>
        )}
      </div>
    </div>
  );
}
