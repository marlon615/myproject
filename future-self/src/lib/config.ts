import "server-only";

export const MODEL = process.env.FUTURE_SELF_MODEL || "claude-opus-5-5";
export const DAILY_CHAT_LIMIT = Math.max(1, Number(process.env.DAILY_CHAT_LIMIT) || 60);
export const APP_TZ = process.env.APP_TIMEZONE || "America/Chicago";
export const hasDatabase = () => Boolean(process.env.DATABASE_URL);
