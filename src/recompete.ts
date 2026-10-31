// Recompete watch: contracts whose current period ends in the next ~18 months, kept in D1 so each look is free.
import type { RunTool } from "./store.js";
import type { AlertItem } from "./alerts.js";

const iso = (t: number) => new Date(t).toISOString();
const DAY = 86_400_000;
export const MAX_WATCHES = 6;

/** Scan one watch and store what it finds. The first scan is the baseline, so nothing in it counts as new. */
export async function scanWatch(db: D1Database, run: RunTool, id: number): Promise<{ count: number } | { error: string }> {
  const w: any = await db.prepare("SELECT * FROM recompete_watch WHERE id=?1").bind(id).first();
  if (!w) return { error: "not found" };
  const args: Record<string, unknown> = { windowStartDays: 0, windowEndDays: 548, minAwardValue: w.min_value ?? 100000, pageSize: 100, scanBudgetPages: 5 };
  if (w.naics) args.naics = w.naics;
  if (w.agency) args.agency = w.agency;
  const env = await run("usas_search_recompetes", args);
  if (!env?.ok) return { error: env?.error?.message || "Recompete search failed" };
  const rows: any[] = env.data?.recompetes || [];
  const baseline = !w.last_scan_at;
  const now = iso(Date.now());
  const stmt = db.prepare(
    `INSERT INTO recompetes (watch_id,award_id,internal_id,incumbent,amount,agency,sub_agency,naics,description,end_date,first_seen,last_seen,seen,digested)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?11,?12,?12)
     ON CONFLICT(watch_id,award_id) DO UPDATE SET internal_id=?3, incumbent=?4, amount=?5, agency=?6, sub_agency=?7, naics=?8, description=?9, end_date=?10, last_seen=?11`,
  );
  const batch = rows
    .filter((r) => r.awardId && r.currentEndDate)
    .map((r) => stmt.bind(id, String(r.awardId), r.generatedInternalId ?? null, r.incumbent ?? null, r.amount ?? null, r.awardingAgency ?? null, r.awardingSubAgency ?? null, r.naicsCode ?? null, String(r.description ?? "").slice(0, 300), String(r.currentEndDate).slice(0, 10), now, baseline ? 1 : 0));
  for (let i = 0; i < batch.length; i += 50) await db.batch(batch.slice(i, i + 50));
  await db.prepare("UPDATE recompete_watch SET last_scan_at=?2, last_count=?3 WHERE id=?1").bind(id, now, rows.length).run();
  return { count: rows.length };
}

export async function scanAll(db: D1Database, run: RunTool) {
  const { results } = await db.prepare("SELECT id FROM recompete_watch ORDER BY COALESCE(last_scan_at,'') ASC LIMIT ?1").bind(MAX_WATCHES).all<{ id: number }>();
  for (const r of results) { try { await scanWatch(db, run, r.id); } catch { /* next watch */ } }
}

export async function purgeRecompetes(db: D1Database) {
  await db.prepare("DELETE FROM recompetes WHERE end_date < ?1 OR last_seen < ?2").bind(iso(Date.now() - 30 * DAY).slice(0, 10), iso(Date.now() - 45 * DAY)).run();
}

/** Newly found candidates for the morning digest. Call done() only after the digest went out. */
export async function collectRecompeteNew(db: D1Database): Promise<{ items: AlertItem[]; done: () => Promise<void> }> {
  const { results } = await db
    .prepare(
      `SELECT r.incumbent, r.description, r.agency, r.sub_agency, r.end_date, r.naics, w.name FROM recompetes r JOIN recompete_watch w ON w.id=r.watch_id
       WHERE r.digested=0 AND r.end_date >= ?1 ORDER BY r.end_date LIMIT 100`,
    )
    .bind(iso(Date.now()).slice(0, 10))
    .all<any>();
  const items: AlertItem[] = results.map((r) => ({
    kind: "recompete" as const, group: `Recompete: ${r.name}`, title: `${r.description || "NAICS " + (r.naics || "?") + " contract"} (incumbent ${r.incumbent || "unknown"})`, agency: r.sub_agency || r.agency, due: r.end_date,
  }));
  const done = async () => { await db.prepare("UPDATE recompetes SET digested=1 WHERE digested=0").run(); };
  return { items, done };
}
