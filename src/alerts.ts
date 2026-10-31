// Daily digest: new notices from saved searches, and pipeline deadlines coming up.
import { runSavedSearch, type RunTool } from "./store.js";
import { rankTexts } from "./rank.js";
import { collectLocalNew } from "./local.js";

export interface AlertItem { kind: "new" | "due"; fit?: "strong" | "possible" | "weak"; title: string; agency?: string; due?: string | null; link?: string; group?: string }

const DAY = 86_400_000;

/** Refresh every saved search and collect what is new since the last run. */
export async function collectNew(db: D1Database, run: RunTool): Promise<AlertItem[]> {
  const { results } = await db.prepare("SELECT id, name FROM saved_searches").all<{ id: number; name: string }>();
  const out: AlertItem[] = [];
  for (const r of results) {
    try {
      const res: any = await runSavedSearch(db, r.id, run);
      for (const o of res?.added || []) out.push({ kind: "new", group: r.name, title: o.title, agency: o.agency, due: o.responseDeadline, link: o.uiLink });
    } catch {
      // one failing search must not block the rest
    }
  }
  return out;
}

/** Pipeline items still being worked whose deadline is within `days`. */
export async function collectDue(db: D1Database, days = 3): Promise<AlertItem[]> {
  const { results } = await db
    .prepare("SELECT title, agency, due, ui_link FROM pipeline WHERE status IN ('watching','bidding') AND due IS NOT NULL")
    .all<any>();
  const now = Date.now();
  return results
    .filter((r) => { const t = Date.parse(r.due); return !Number.isNaN(t) && t >= now - DAY && t <= now + days * DAY; })
    .sort((a, b) => Date.parse(a.due) - Date.parse(b.due))
    .map((r) => ({ kind: "due" as const, title: r.title, agency: r.agency, due: r.due, link: r.ui_link }));
}

const day = (s?: string | null) => (s ? String(s).slice(0, 10) : "no date");

export function digestText(items: AlertItem[]): string {
  const lines: string[] = [];
  const fresh = items.filter((i) => i.kind === "new");
  const due = items.filter((i) => i.kind === "due");
  if (fresh.length) {
    lines.push(`${fresh.length} new notice${fresh.length === 1 ? "" : "s"}`);
    for (const i of fresh.slice(0, 25)) lines.push(`• ${i.fit === "strong" ? "★ " : ""}${i.title} (${i.agency || "agency n/a"}, due ${day(i.due)}) [${i.group}]${i.link ? "\n  " + i.link : ""}`);
    if (fresh.length > 25) lines.push(`…and ${fresh.length - 25} more in the dashboard`);
  }
  if (due.length) {
    if (lines.length) lines.push("");
    lines.push(`Due within 3 days`);
    for (const i of due) lines.push(`• ${i.title} (${i.agency || "agency n/a"}), due ${day(i.due)}${i.link ? "\n  " + i.link : ""}`);
  }
  return lines.join("\n");
}

/** POST to the webhook. Works with Slack, Discord, n8n and ntfy. Returns an error string or null. */
export async function sendWebhook(url: string, text: string, items: AlertItem[] = []): Promise<string | null> {
  try {
    const ntfy = /(^|\/\/)ntfy\./.test(url);
    const r = ntfy
      ? await fetch(url, { method: "POST", headers: { Title: "Gov contracting alerts" }, body: text })
      : await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          // text = Slack and n8n, content = Discord. items is for n8n and other automations.
          body: JSON.stringify({ text, content: text.slice(0, 1900), items }),
        });
    return r.ok ? null : `Webhook answered ${r.status}`;
  } catch (e: any) {
    return String(e?.message || e);
  }
}

export async function runDailyAlerts(db: D1Database, run: RunTool, webhook?: string, profile?: string | null) {
  const fresh = await collectNew(db, run); // always refresh, even with no webhook, so the badge stays current
  if (!webhook) return;
  const local = await collectLocalNew(db).catch(() => ({ items: [] as AlertItem[], done: async () => {} }));
  fresh.push(...local.items);
  if (profile && fresh.length) {
    // Put the best matches first and star the strong ones. If ranking fails the digest still goes out in search order.
    try {
      const r = await rankTexts(fresh.map((i) => `${i.title} (${i.agency || ""})`), profile);
      fresh.forEach((i, k) => (i.fit = r[k].fit));
      const score = new Map(fresh.map((i, k) => [i, r[k].score]));
      fresh.sort((a, b) => (score.get(b) || 0) - (score.get(a) || 0));
    } catch {}
  }
  const items = [...fresh, ...(await collectDue(db))];
  if (items.length) await sendWebhook(webhook, digestText(items), items);
  await local.done().catch(() => {});
}
