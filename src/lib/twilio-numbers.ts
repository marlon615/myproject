import "server-only";

/**
 * Buys a local US number in Twilio for a contractor and points its voice + text webhooks at
 * CallCairn. Uses TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN. If TWILIO_MESSAGING_SERVICE_SID is set
 * (needed for A2P 10DLC texting), the number is also added to that Messaging Service.
 */

const auth = () => {
  const sid = process.env.TWILIO_ACCOUNT_SID ?? "";
  const token = process.env.TWILIO_AUTH_TOKEN ?? "";
  return { sid, header: "Basic " + Buffer.from(`${sid}:${token}`).toString("base64") };
};

export function canProvisionNumbers() {
  return Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN);
}

async function twilio<T>(url: string, init: { method?: string; form?: Record<string, string> } = {}): Promise<T> {
  const res = await fetch(url, {
    method: init.method ?? "GET",
    headers: { Authorization: auth().header, ...(init.form && { "Content-Type": "application/x-www-form-urlencoded" }) },
    body: init.form ? new URLSearchParams(init.form) : undefined,
    cache: "no-store",
  });
  const data = (await res.json().catch(() => ({}))) as T & { message?: string };
  if (!res.ok) throw new Error(`Twilio: ${data.message ?? `HTTP ${res.status}`}`);
  return data;
}

type Available = { available_phone_numbers: { phone_number: string }[] };

/** Find a local number, preferring the contractor's own area code. */
async function findNumber(areaCode: string | null): Promise<string> {
  const base = `https://api.twilio.com/2010-04-01/Accounts/${auth().sid}/AvailablePhoneNumbers/US/Local.json?VoiceEnabled=true&SmsEnabled=true&PageSize=1`;
  if (areaCode) {
    const near = await twilio<Available>(`${base}&AreaCode=${areaCode}`);
    if (near.available_phone_numbers[0]) return near.available_phone_numbers[0].phone_number;
  }
  const any = await twilio<Available>(base);
  if (!any.available_phone_numbers[0]) throw new Error("Twilio has no local US numbers available right now.");
  return any.available_phone_numbers[0].phone_number;
}

export async function provisionNumber(opts: { businessPhone: string; baseUrl: string; label: string }) {
  const areaCode = opts.businessPhone.match(/^\+1(\d{3})/)?.[1] ?? null;
  const phoneNumber = await findNumber(areaCode);
  const bought = await twilio<{ sid: string; phone_number: string }>(
    `https://api.twilio.com/2010-04-01/Accounts/${auth().sid}/IncomingPhoneNumbers.json`,
    {
      method: "POST",
      form: {
        PhoneNumber: phoneNumber,
        FriendlyName: `CallCairn · ${opts.label}`.slice(0, 64),
        VoiceUrl: `${opts.baseUrl}/api/voice/incoming`,
        VoiceMethod: "POST",
        StatusCallback: `${opts.baseUrl}/api/voice/status`,
        StatusCallbackMethod: "POST",
        SmsUrl: `${opts.baseUrl}/api/sms/inbound`,
        SmsMethod: "POST",
      },
    },
  );
  const service = process.env.TWILIO_MESSAGING_SERVICE_SID;
  if (service) {
    try {
      await twilio(`https://messaging.twilio.com/v1/Services/${service}/PhoneNumbers`, { method: "POST", form: { PhoneNumberSid: bought.sid } });
    } catch (err) {
      console.error("[twilio] bought number but could not add it to the Messaging Service", err);
    }
  }
  return { phoneNumber: bought.phone_number, sid: bought.sid };
}
