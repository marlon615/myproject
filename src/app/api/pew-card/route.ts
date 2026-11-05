import { currentChurch } from "@/lib/session";
import { appUrl } from "@/lib/config";
import { buildPewCardPdf } from "@/lib/pewcard";

export async function GET() {
  const church = await currentChurch();
  if (!church) return new Response("Please log in", { status: 401 });
  const pdf = await buildPewCardPdf({
    churchName: church.name,
    serviceTimes: church.serviceTimes,
    guestUrl: `${await appUrl()}/g/${church.slug}`,
  });
  return new Response(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${church.slug}-pew-cards.pdf"`,
      "Cache-Control": "private, no-store",
    },
  });
}
