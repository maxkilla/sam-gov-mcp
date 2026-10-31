// Daily digest: new notices from saved searches, and pipeline deadlines coming up.
import { runSavedSearch, runGrantSearch, type RunTool } from "./store.js";
import { rankTexts } from "./rank.js";
import { collectLocalNew } from "./local.js";
import { scanAll, collectRecompeteNew } from "./recompete.js";
import { grantDate, grantLink } from "./grants.js";

export interface AlertItem { kind: "new" | "due" | "recompete"; fit?: "strong" | "possible" | "weak"; title: string; agency?: string; due?: string | null; link?: string; group?: string }

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

/** Refresh every saved grant search and collect the opportunities that are new. */
export async function collectGrantsNew(db: D1Database): Promise<AlertItem[]> {
  const { results } = await db.prepare("SELECT id, name FROM grant_searches").all<{ id: number; name: string }>();
  const out: AlertItem[] = [];
  for (const r of results) {
    try {
      const res: any = await runGrantSearch(db, r.id);
      for (const g of res?.added || []) out.push({ kind: "new", group: `Grants: ${r.name}`, title: g.title, agency: g.agency, due: grantDate(g.closeDate), link: grantLink(g.id) });
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
  const rec = items.filter((i) => i.kind === "recompete");
  if (rec.length) {
    if (lines.length) lines.push("");
    lines.push(`${rec.length} contract${rec.length === 1 ? "" : "s"} newly ending soon`);
    for (const i of rec.slice(0, 15)) lines.push(`• ${i.fit === "strong" ? "★ " : ""}${i.title} (${i.agency || "agency n/a"}), ends ${day(i.due)} [${i.group}]`);
    if (rec.length > 15) lines.push(`…and ${rec.length - 15} more in the dashboard`);
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
  fresh.push(...(await collectGrantsNew(db)));
  await scanAll(db, run).catch(() => {});
  if (!webhook) return;
  const rec = await collectRecompeteNew(db).catch(() => ({ items: [] as AlertItem[], done: async () => {} }));
  const local = await collectLocalNew(db).catch(() => ({ items: [] as AlertItem[], done: async () => {} }));
  fresh.push(...local.items);
  const rankable = [...fresh, ...rec.items];
  if (profile && rankable.length) {
    // Put the best matches first and star the strong ones. If ranking fails the digest still goes out in search order.
    try {
      const r = await rankTexts(rankable.map((i) => `${i.title} (${i.agency || ""})`), profile);
      rankable.forEach((i, k) => (i.fit = r[k].fit));
      const score = new Map(rankable.map((i, k) => [i, r[k].score]));
      fresh.sort((a, b) => (score.get(b) || 0) - (score.get(a) || 0));
      rec.items.sort((a, b) => (score.get(b) || 0) - (score.get(a) || 0));
    } catch {}
  }
  const items = [...fresh, ...rec.items, ...(await collectDue(db))];
  if (items.length) await sendWebhook(webhook, digestText(items), items);
  await local.done().catch(() => {});
  await rec.done().catch(() => {});
}
