// Applies SQL migrations in ./drizzle. Runs automatically before `next build`.
import { config } from "dotenv";

// Same precedence as Next.js: .env.local overrides .env. (On Vercel, real env vars win.)
config({ path: [".env.local", ".env"], quiet: true });
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) {
  console.warn("[migrate] DATABASE_URL not set — skipping migrations.");
  process.exit(0);
}
const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
try {
  await migrate(drizzle(sql), { migrationsFolder: "./drizzle" });
  console.log("[migrate] Database is up to date.");
} catch (err) {
  console.error("[migrate] Failed:", err);
  process.exitCode = 1;
} finally {
  await sql.end();
}
