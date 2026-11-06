import { appUrl } from "@/lib/config";
import { churchBySlug } from "@/lib/church";
import { qrPng } from "@/lib/qr";

export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const church = await churchBySlug(slug);
  if (!church) return new Response("Not found", { status: 404 });
  const png = await qrPng(`${await appUrl()}/g/${church.slug}`, 1200);
  const download = new URL(req.url).searchParams.has("download");
  return new Response(new Uint8Array(png), {
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "public, max-age=3600",
      ...(download && { "Content-Disposition": `attachment; filename="${church.slug}-qr.png"` }),
    },
  });
}
