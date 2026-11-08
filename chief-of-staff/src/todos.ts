import type { Env } from "./types";

export interface Todo { id: number; text: string; status: "open" | "done"; created_at: string; done_at: string | null }

export async function openTodos(env: Env): Promise<Todo[]> {
  return (await env.DB.prepare("select * from todos where status = 'open' order by id limit 100").all<Todo>()).results;
}

export async function addTodo(env: Env, text: string): Promise<Todo | null> {
  const t = text.trim().replace(/[.!?]+$/, "").slice(0, 300);
  if (t.length < 2) return null;
  return env.DB.prepare("insert into todos (text) values (?) returning *").bind(t).first<Todo>();
}

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
const STOP = new Set(["the", "a", "an", "to", "my", "with", "and", "for", "of", "on", "about", "that", "it"]);

/** Finds the open item a spoken phrase most likely means. */
export async function findTodo(env: Env, spoken: string): Promise<Todo | null> {
  const words = norm(spoken).split(" ").filter((w) => w.length > 1 && !STOP.has(w));
  if (!words.length) return null;
  let best: Todo | null = null, score = 0;
  for (const t of await openTodos(env)) {
    const hay = norm(t.text);
    const s = words.reduce((a, w) => a + (hay.includes(w) ? w.length : 0), 0);
    if (s > score) { best = t; score = s; }
  }
  return score >= 3 ? best : null;
}

export async function completeTodo(env: Env, id: number) {
  await env.DB.prepare("update todos set status = 'done', done_at = ? where id = ?").bind(new Date().toISOString(), id).run();
}
