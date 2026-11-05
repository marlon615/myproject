import type { FormState } from "@/app/actions/auth";

type Defaults = Partial<Record<"name" | "city" | "pastorName" | "serviceTimes" | "whatToExpect" | "welcomeMessage", string | null>>;

export function FieldError({ state, name }: { state: FormState; name: string }) {
  const msg = state.fieldErrors?.[name];
  return msg ? <div className="field-error">{msg}</div> : null;
}

/** Church profile fields shared by signup and settings. */
export function ChurchFields({ state, defaults = {} }: { state: FormState; defaults?: Defaults }) {
  const val = (k: keyof Defaults) => state.values?.[k] ?? defaults[k] ?? "";
  return (
    <>
      <div className="field">
        <label htmlFor="name">Church name</label>
        <input id="name" name="name" type="text" required maxLength={100} defaultValue={val("name")} placeholder="Grace Community Church" />
        <FieldError state={state} name="name" />
      </div>
      <div className="grid grid-2" style={{ gap: 0, columnGap: 16 }}>
        <div className="field">
          <label htmlFor="pastorName">Your name <span className="hint">(as guests will see it)</span></label>
          <input id="pastorName" name="pastorName" type="text" required maxLength={80} defaultValue={val("pastorName")} placeholder="Pastor Mike" />
          <FieldError state={state} name="pastorName" />
        </div>
        <div className="field">
          <label htmlFor="city">City <span className="hint">(optional)</span></label>
          <input id="city" name="city" type="text" maxLength={80} defaultValue={val("city")} placeholder="Springfield, MO" />
          <FieldError state={state} name="city" />
        </div>
      </div>
      <div className="field">
        <label htmlFor="serviceTimes">Service times <span className="hint">(one per line)</span></label>
        <textarea id="serviceTimes" name="serviceTimes" required maxLength={400} rows={3} defaultValue={val("serviceTimes")} placeholder={"Sundays 9:00 & 10:30 AM\nWednesday Bible study 7:00 PM"} />
        <FieldError state={state} name="serviceTimes" />
      </div>
      <div className="field">
        <label htmlFor="whatToExpect">What to expect <span className="hint">(a short, friendly note)</span></label>
        <textarea id="whatToExpect" name="whatToExpect" required maxLength={1200} rows={4} defaultValue={val("whatToExpect")} placeholder="Come as you are! Services last about an hour with modern worship and a practical message. Kids ages 0–5th grade have their own fun, safe classes. Free coffee in the lobby." />
        <FieldError state={state} name="whatToExpect" />
      </div>
      <div className="field">
        <label htmlFor="welcomeMessage">Your personal welcome message <span className="hint">(included in the first text — keep it short)</span></label>
        <textarea id="welcomeMessage" name="welcomeMessage" required maxLength={320} rows={3} defaultValue={val("welcomeMessage")} placeholder="We're so glad you joined us! I'd love to meet you — come say hi after the service and the coffee's on me." />
        <FieldError state={state} name="welcomeMessage" />
      </div>
    </>
  );
}
