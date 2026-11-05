import { config } from "dotenv";

// Same precedence as Next.js: .env.local overrides .env. (On Vercel, real env vars win.)
config({ path: [".env.local", ".env"], quiet: true });
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DATABASE_URL ?? "" },
});
