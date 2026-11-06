import "server-only";
import { cache } from "react";
import { eq } from "drizzle-orm";
import { db, churches } from "@/db";

export const churchBySlug = cache(async (slug: string) => {
  const [church] = await db.select().from(churches).where(eq(churches.slug, slug)).limit(1);
  return church ?? null;
});
