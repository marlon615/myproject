import type { FormState } from "@/app/actions/auth";
import { US_TIMEZONES } from "@/lib/constants";

export function FieldError({ state, name }: { state: FormState; name: string }) {
  const msg = state.fieldErrors?.[name];
  return msg ? <div className="field-error">{msg}</div> : null;
}

type Defaults = Partial<Record<"businessName" | "ownerName" | "businessPhone" | "alertPhone" | "serviceArea" | "timezone", string>>;

/** Company fields shared by signup and settings. */
export function BusinessFields({ state, defaults = {} }: { state: FormState; defaults?: Defaults }) {
  const v = (k: keyof Defaults) => state.values?.[k] ?? defaults[k] ?? "";
  return (
    <>
      <div className="field">
        <label htmlFor="businessName">Company name <span className="hint">(the assistant says this on every call)</span></label>
        <input id="businessName" name="businessName" type="text" required defaultValue={v("businessName")} placeholder="Summit Heating & Air" />
        <FieldError state={state} name="businessName" />
      </div>
      <div className="field">
        <label htmlFor="ownerName">Your name</label>
        <input id="ownerName" name="ownerName" type="text" autoComplete="name" required defaultValue={v("ownerName")} />
        <FieldError state={state} name="ownerName" />
      </div>
      <div className="grid grid-2" style={{ gap: 0, columnGap: 16 }}>
        <div className="field">
          <label htmlFor="businessPhone">Business phone <span className="hint">(the number customers call)</span></label>
          <input id="businessPhone" name="businessPhone" type="tel" autoComplete="tel" required defaultValue={v("businessPhone")} placeholder="(555) 555-0123" />
          <FieldError state={state} name="businessPhone" />
        </div>
        <div className="field">
          <label htmlFor="alertPhone">On-call mobile <span className="hint">(gets emergency &amp; booking texts)</span></label>
          <input id="alertPhone" name="alertPhone" type="tel" defaultValue={v("alertPhone")} placeholder="Same as business phone" />
          <FieldError state={state} name="alertPhone" />
        </div>
      </div>
      <div className="grid grid-2" style={{ gap: 0, columnGap: 16 }}>
        <div className="field">
          <label htmlFor="serviceArea">Service area <span className="hint">(optional)</span></label>
          <input id="serviceArea" name="serviceArea" type="text" defaultValue={v("serviceArea")} placeholder="Denver metro" />
          <FieldError state={state} name="serviceArea" />
        </div>
        <div className="field">
          <label htmlFor="timezone">Time zone</label>
          <select id="timezone" name="timezone" defaultValue={v("timezone") || "America/Chicago"}>
            {US_TIMEZONES.map((z) => <option key={z.value} value={z.value}>{z.label}</option>)}
          </select>
          <FieldError state={state} name="timezone" />
        </div>
      </div>
    </>
  );
}
