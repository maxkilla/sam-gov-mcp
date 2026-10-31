// State and local bids: stored from dashboard scans and a background refresh of watched states.
import type { RunTool } from "./store.js";
import type { AlertItem } from "./alerts.js";

export interface LocalRow { id: string; src: string; gov: string; title: string; number?: string; text?: string; type?: string; due?: string | null; released?: string | null; link?: string }
interface Portal { src: "Bonfire" | "OpenGov"; gov: string; key: string }

const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();
const slDate = (s: unknown) => { const t = Date.parse(String(s || "")); return Number.isNaN(t) ? null : iso(t); };
const cut = (v: unknown, n: number) => String(v ?? "").slice(0, n);

export async function ensureState(db: D1Database, state: string) {
  await db.prepare("INSERT OR IGNORE INTO local_states (state) VALUES (?1)").bind(state).run();
}

/** Insert or refresh rows. first_seen is kept for rows already known. */
export async function upsertRows(db: D1Database, state: string, rows: LocalRow[]): Promise<number> {
  const now = iso(Date.now());
  const stmt = db.prepare(
    `INSERT INTO local_bids (id,state,src,gov,title,number,text,type,due,released,link,first_seen,last_seen)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?12)
     ON CONFLICT(id) DO UPDATE SET state=?2, title=?5, number=?6, text=?7, type=?8, due=?9, released=?10, link=?11, last_seen=?12`,
  );
  const list = rows.slice(0, 4000).filter((r) => r && r.id && r.title);
  for (let i = 0; i < list.length; i += 50) {
    await db.batch(
      list.slice(i, i + 50).map((r) =>
        stmt.bind(cut(r.id, 200), state, cut(r.src, 20), cut(r.gov, 200), cut(r.title, 300), cut(r.number, 100), cut(r.text, 500), cut(r.type, 100), r.due ? slDate(r.due) : null, r.released ? slDate(r.released) : null, cut(r.link, 500), now),
      ),
    );
  }
  return list.length;
}

/** Rows still worth showing for a state: seen in the last 3 days and not closed more than a day ago. */
export async function listRows(db: D1Database, state: string) {
  const { results } = await db
    .prepare("SELECT * FROM local_bids WHERE state=?1 AND last_seen >= ?2 AND (due IS NULL OR due >= ?3) ORDER BY (due IS NULL), due LIMIT 3000")
    .bind(state, iso(Date.now() - 3 * DAY), iso(Date.now() - DAY))
    .all<any>();
  return results.map((r) => ({ id: r.id, src: r.src, gov: r.gov, title: r.title, number: r.number || "", text: r.text || "", type: r.type || "", due: r.due, released: r.released, link: r.link, firstSeen: r.first_seen }));
}

export async function stateInfo(db: D1Database, state: string) {
  await ensureState(db, state);
  const s: any = await db.prepare("SELECT * FROM local_states WHERE state=?1").bind(state).first();
  return { watched: !!s.watched, baselined: !!s.baselined, lastViewed: s.last_viewed as string | null, lastScanAt: s.last_scan_at as string | null, portalsTotal: s.portals_total as number | null };
}

/** A full scan finished (from the dashboard or the background refresh). */
export async function markScanned(db: D1Database, state: string, total: number | null) {
  const now = iso(Date.now());
  await ensureState(db, state);
  // The first complete scan is the baseline: what it finds is not announced as new.
  await db.prepare("UPDATE local_states SET last_scan_at=?2, portals_total=COALESCE(?3,portals_total), last_digest_at=CASE WHEN baselined=0 THEN ?2 ELSE last_digest_at END, baselined=1 WHERE state=?1").bind(state, now, total).run();
}

export async function portalsFor(run: RunTool, state: string): Promise<Portal[]> {
  const [b, o] = await Promise.all([
    run("bonfire_list_organizations", { state, limit: 200 }),
    run("opengov_list_governments", { state, limit: 200 }),
  ]);
  const out: Portal[] = [
    ...(b.ok ? b.data.organizations || [] : []).map((x: any) => ({ src: "Bonfire" as const, gov: x.name, key: x.org })),
    ...(o.ok ? o.data.governments || [] : []).map((x: any) => ({ src: "OpenGov" as const, gov: x.name, key: x.code })),
  ];
  return out.sort((a, b) => (a.src + a.key).localeCompare(b.src + b.key));
}

async function scanPortal(run: RunTool, p: Portal): Promise<LocalRow[]> {
  if (p.src === "Bonfire") {
    const e = await run("bonfire_search_opportunities", { org: p.key, limit: 200 });
    if (!e.ok) throw new Error("portal failed");
    return (e.data.opportunities || []).map((x: any) => ({ src: p.src, gov: p.gov, id: p.key + "-" + (x.referenceNumber || x.name), title: x.name, number: x.referenceNumber || "", text: x.description || "", type: "", due: slDate(x.closeDate), released: slDate(x.pubDate), link: x.link }));
  }
  const e = await run("opengov_search_solicitations", { governmentCode: p.key, limit: 100 });
  if (!e.ok) throw new Error("portal failed");
  return (e.data.solicitations || []).filter((x: any) => x.status === "open").map((x: any) => ({ src: p.src, gov: p.gov, id: p.key + "-" + x.id, title: x.title, number: x.solicitationNumber || "", text: x.department || "", type: x.type || "", due: x.proposalDeadline || null, released: x.releaseDate || null, link: x.link }));
}

/** Scan up to `budget` portals of one state, continuing where the last run stopped. Returns how many it checked. */
async function scanChunk(db: D1Database, run: RunTool, state: string, budget: number): Promise<number> {
  const s: any = await db.prepare("SELECT cursor FROM local_states WHERE state=?1").bind(state).first();
  const portals = await portalsFor(run, state);
  if (!portals.length) { await markScanned(db, state, 0); return 0; }
  const start = (s?.cursor || 0) % portals.length;
  const slice = portals.slice(start, start + budget);
  const rows: LocalRow[] = [];
  let next = 0;
  await Promise.all(Array.from({ length: 5 }, async () => {
    while (next < slice.length) {
      const p = slice[next++];
      try { rows.push(...(await scanPortal(run, p))); } catch { /* one portal failing must not stop the rest */ }
    }
  }));
  await upsertRows(db, state, rows);
  const end = start + slice.length;
  const wrapped = end >= portals.length;
  await db.prepare("UPDATE local_states SET cursor=?2, portals_total=?3 WHERE state=?1").bind(state, wrapped ? 0 : end, portals.length).run();
  if (wrapped) await markScanned(db, state, portals.length);
  return slice.length;
}

/** Background refresh. A Worker may make only so many outside calls per run, so each run does a slice and picks up next time. */
export async function refreshWatched(db: D1Database, run: RunTool, budget = 40) {
  const { results } = await db.prepare("SELECT state FROM local_states WHERE watched=1 ORDER BY COALESCE(last_scan_at,'') ASC").all<{ state: string }>();
  let left = budget;
  for (const r of results) {
    if (left <= 0) break;
    try { left -= await scanChunk(db, run, r.state, left); } catch { /* try the next state */ }
  }
}

export async function purgeLocal(db: D1Database) {
  await db.prepare("DELETE FROM local_bids WHERE (due IS NOT NULL AND due < ?1) OR last_seen < ?2").bind(iso(Date.now() - DAY), iso(Date.now() - 30 * DAY)).run();
}

/** New solicitations in watched states since the last digest. Call only when a digest is about to be sent. */
export async function collectLocalNew(db: D1Database): Promise<{ items: AlertItem[]; done: () => Promise<void> }> {
  const { results: states } = await db.prepare("SELECT state, last_digest_at FROM local_states WHERE watched=1 AND baselined=1").all<any>();
  const items: AlertItem[] = [];
  for (const s of states) {
    const { results } = await db
      .prepare("SELECT title, gov, due, link FROM local_bids WHERE state=?1 AND first_seen > ?2 AND (due IS NULL OR due >= ?3) ORDER BY first_seen LIMIT 100")
      .bind(s.state, s.last_digest_at || iso(Date.now() - DAY), iso(Date.now()))
      .all<any>();
    for (const r of results) items.push({ kind: "new", group: `State and local ${s.state}`, title: r.title, agency: r.gov, due: r.due, link: r.link });
  }
  const done = async () => { await db.prepare("UPDATE local_states SET last_digest_at=?1 WHERE watched=1 AND baselined=1").bind(iso(Date.now())).run(); };
  return { items, done };
}
