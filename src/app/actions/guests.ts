"use server";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db, visitors } from "@/db";
import { requireChurch } from "@/lib/session";

export async function setReturned(visitorId: string, returned: boolean) {
  const church = await requireChurch();
  await db
    .update(visitors)
    .set({ returnedAt: returned ? new Date() : null })
    .where(and(eq(visitors.id, visitorId), eq(visitors.churchId, church.id)));
  revalidatePath("/dashboard");
  revalidatePath(`/dashboard/guests/${visitorId}`);
}
