// Saved searches, pipeline and vetting history, stored in D1.
import { ensureState, upsertRows, listRows, stateInfo, markScanned } from "./local.js";
import { grantPayload, searchGrants } from "./grants.js";
import { scanWatch, MAX_WATCHES } from "./recompete.js";

export type RunTool = (name: string, args: Record<string, unknown>) => Promise<any>;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

const STATUSES = new Set(["watching", "bidding", "submitted", "won", "lost", "passed"]);
const now = () => new Date().toISOString();
const parse = (s: unknown, fallback: unknown) => {
  try {
    return JSON.parse(String(s));
  } catch {
    return fallback;
  }
};

/** Run one saved search, record which notices are new, and return the result. */
export async function runSavedSearch(db: D1Database, id: number, run: RunTool) {
  const row: any = await db.prepare("SELECT * FROM saved_searches WHERE id = ?").bind(id).first();
  if (!row) return null;
  const env = await run("sam_search_opportunities", { ...parse(row.params, {}), limit: 50 });
  if (!env.ok) return { error: env.error?.message || "Search failed" };
  const opps: any[] = env.data.opportunities || [];
  const known = new Set<string>(parse(row.known_ids, []));
  const fresh = new Set<string>(parse(row.new_ids, []));
  const firstRun = !row.last_run_at;
  const added: any[] = [];
  for (const o of opps) {
    if (!known.has(o.noticeId)) {
      known.add(o.noticeId);
      if (!firstRun) { fresh.add(o.noticeId); added.push(o); } // the first run is the baseline, not "new"
    }
  }
  const knownList = [...known].slice(-2000);
  await db
    .prepare("UPDATE saved_searches SET last_run_at=?, last_total=?, known_ids=?, new_ids=? WHERE id=?")
    .bind(now(), env.data.totalRecords ?? opps.length, JSON.stringify(knownList), JSON.stringify([...fresh]), id)
    .run();
  return { opportunities: opps, total: env.data.totalRecords ?? opps.length, newIds: [...fresh], added };
}

/** Run one saved grant search (newest first, so fresh postings are always in the first page) and record what is new. */
export async function runGrantSearch(db: D1Database, id: number) {
  const row: any = await db.prepare("SELECT * FROM grant_searches WHERE id = ?").bind(id).first();
  if (!row) return null;
  const res = await searchGrants(grantPayload({ ...parse(row.params, {}), sortBy: "openDate|desc", start: 0, rows: 50 }));
  const known = new Set<string>(parse(row.known_ids, []));
  const fresh = new Set<string>(parse(row.new_ids, []));
  const firstRun = !row.last_run_at;
  const added: any[] = [];
  for (const g of res.items) {
    if (!known.has(String(g.id))) {
      known.add(String(g.id));
      if (!firstRun) { fresh.add(String(g.id)); added.push(g); }
    }
  }
  await db
    .prepare("UPDATE grant_searches SET last_run_at=?, last_total=?, known_ids=?, new_ids=? WHERE id=?")
    .bind(now(), res.total, JSON.stringify([...known].slice(-2000)), JSON.stringify([...fresh]), id)
    .run();
  return { items: res.items, total: res.total, newIds: [...fresh], added };
}

export async function handleStore(req: Request, url: URL, db: D1Database | undefined, run: RunTool): Promise<Response> {
  if (!db) return json({ error: "Storage is not set up (no D1 binding named DB)." }, 503);
  const parts = url.pathname.replace(/^\/api\/store\/?/, "").split("/").filter(Boolean);
  const [kind, idPart, action] = parts;
  const m = req.method;
  const body = async (): Promise<any> => {
    try {
      return await req.json();
    } catch {
      return {};
    }
  };

  if (kind === "searches") {
    if (!idPart && m === "GET") {
      const { results } = await db.prepare("SELECT * FROM saved_searches ORDER BY created_at DESC").all<any>();
      return json({
        searches: results.map((r) => ({
          id: r.id, name: r.name, params: parse(r.params, {}), createdAt: r.created_at,
          lastRunAt: r.last_run_at, lastTotal: r.last_total, newCount: (parse(r.new_ids, []) as string[]).length,
        })),
      });
    }
    if (!idPart && m === "POST") {
      const b = await body();
      const name = String(b.name || "").trim().slice(0, 80);
      if (!name || typeof b.params !== "object" || !b.params) return json({ error: "name and params are required" }, 400);
      const r = await db.prepare("INSERT INTO saved_searches (name, params, created_at) VALUES (?,?,?)")
        .bind(name, JSON.stringify(b.params), now()).run();
      const id = Number(r.meta.last_row_id);
      await runSavedSearch(db, id, run); // baseline run
      return json({ id }, 201);
    }
    const id = Number(idPart);
    if (!Number.isInteger(id)) return json({ error: "bad id" }, 400);
    if (m === "DELETE" && !action) {
      await db.prepare("DELETE FROM saved_searches WHERE id=?").bind(id).run();
      return json({ ok: true });
    }
    if (m === "POST" && action === "seen") {
      await db.prepare("UPDATE saved_searches SET new_ids='[]' WHERE id=?").bind(id).run();
      return json({ ok: true });
    }
    if (m === "POST" && action === "run") {
      const r = await runSavedSearch(db, id, run);
      return r ? json(r) : json({ error: "not found" }, 404);
    }
  }

  if (kind === "grantsearches") {
    if (!idPart && m === "GET") {
      const { results } = await db.prepare("SELECT * FROM grant_searches ORDER BY created_at DESC").all<any>();
      return json({
        searches: results.map((r) => ({
          id: r.id, name: r.name, params: parse(r.params, {}), createdAt: r.created_at,
          lastRunAt: r.last_run_at, lastTotal: r.last_total, newCount: (parse(r.new_ids, []) as string[]).length,
        })),
      });
    }
    if (!idPart && m === "POST") {
      const b = await body();
      const name = String(b.name || "").trim().slice(0, 80);
      if (!name || typeof b.params !== "object" || !b.params) return json({ error: "name and params are required" }, 400);
      const { n } = (await db.prepare("SELECT COUNT(*) AS n FROM grant_searches").first<{ n: number }>()) || { n: 0 };
      if (n >= 20) return json({ error: "You have 20 saved grant searches. Remove one first." }, 400);
      const r = await db.prepare("INSERT INTO grant_searches (name, params, created_at) VALUES (?,?,?)")
        .bind(name, JSON.stringify(grantPayload(b.params)), now()).run();
      const id = Number(r.meta.last_row_id);
      try { await runGrantSearch(db, id); } catch { /* the baseline runs again on the next refresh */ }
      return json({ id }, 201);
    }
    const id = Number(idPart);
    if (!Number.isInteger(id)) return json({ error: "bad id" }, 400);
    if (m === "DELETE" && !action) { await db.prepare("DELETE FROM grant_searches WHERE id=?").bind(id).run(); return json({ ok: true }); }
    if (m === "POST" && action === "seen") { await db.prepare("UPDATE grant_searches SET new_ids='[]' WHERE id=?").bind(id).run(); return json({ ok: true }); }
    if (m === "POST" && action === "run") {
      try { const r = await runGrantSearch(db, id); return r ? json(r) : json({ error: "not found" }, 404); }
      catch (e: any) { return json({ error: String(e?.message || e) }, 502); }
    }
  }

  if (kind === "recompete") {
    if (!idPart && m === "GET") {
      const months = Math.min(18, Math.max(1, Number(url.searchParams.get("months")) || 18));
      const today = new Date().toISOString().slice(0, 10);
      const until = new Date(Date.now() + months * 30.44 * 86_400_000).toISOString().slice(0, 10);
      const { results: watches } = await db.prepare("SELECT * FROM recompete_watch ORDER BY created_at").all<any>();
      const { results: rows } = await db
        .prepare(
          `SELECT award_id, MIN(watch_id) AS watch_id, internal_id, incumbent, amount, agency, sub_agency, naics, description, end_date, MIN(seen) AS seen, MIN(first_seen) AS first_seen
           FROM recompetes WHERE end_date >= ?1 AND end_date <= ?2 GROUP BY award_id ORDER BY end_date LIMIT 1500`,
        )
        .bind(today, until)
        .all<any>();
      return json({
        watches: watches.map((w) => ({ id: w.id, name: w.name, naics: w.naics, agency: w.agency, minValue: w.min_value, lastScanAt: w.last_scan_at, lastCount: w.last_count })),
        items: rows.map((r) => ({ id: r.award_id, internalId: r.internal_id, incumbent: r.incumbent, amount: r.amount, agency: r.agency, subAgency: r.sub_agency, naics: r.naics, description: r.description, endDate: r.end_date, isNew: r.seen === 0 })),
      });
    }
    if (!idPart && m === "POST") {
      const b = await body();
      const naics = String(b.naics || "").trim();
      const agency = String(b.agency || "").trim().slice(0, 120);
      if (naics && !/^\d{6}$/.test(naics)) return json({ error: "NAICS must be 6 digits" }, 400);
      if (!naics && !agency) return json({ error: "Give a NAICS code, an agency, or both." }, 400);
      const { n } = (await db.prepare("SELECT COUNT(*) AS n FROM recompete_watch").first<{ n: number }>()) || { n: 0 };
      if (n >= MAX_WATCHES) return json({ error: `You can watch ${MAX_WATCHES} combinations. Remove one first.` }, 400);
      const minValue = Math.max(0, Math.min(1e9, Math.floor(Number(b.minValue) || 100000)));
      const name = String(b.name || "").trim().slice(0, 80) || [agency, naics && "NAICS " + naics].filter(Boolean).join(" · ");
      const r = await db.prepare("INSERT INTO recompete_watch (name, naics, agency, min_value, created_at) VALUES (?,?,?,?,?)")
        .bind(name, naics || null, agency || null, minValue, now()).run();
      const id = Number(r.meta.last_row_id);
      const scan = await scanWatch(db, run, id).catch((e) => ({ error: String(e?.message || e) }));
      return json({ id, scan }, 201);
    }
    if (idPart === "seen" && m === "POST") { await db.prepare("UPDATE recompetes SET seen=1 WHERE seen=0").run(); return json({ ok: true }); }
    const id = Number(idPart);
    if (!Number.isInteger(id)) return json({ error: "bad id" }, 400);
    if (m === "DELETE" && !action) {
      await db.prepare("DELETE FROM recompetes WHERE watch_id=?").bind(id).run();
      await db.prepare("DELETE FROM recompete_watch WHERE id=?").bind(id).run();
      return json({ ok: true });
    }
    if (m === "POST" && action === "scan") {
      const r = await scanWatch(db, run, id).catch((e) => ({ error: String(e?.message || e) }));
      return "error" in r ? json(r, 502) : json(r);
    }
  }

  if (kind === "local") {
    const stateOf = (v: unknown) => { const st = String(v || "").toUpperCase(); return /^[A-Z]{2}$/.test(st) ? st : null; };
    if (!idPart && m === "GET") {
      const st = stateOf(url.searchParams.get("state"));
      if (!st) return json({ error: "state is required" }, 400);
      return json({ ...(await stateInfo(db, st)), items: await listRows(db, st) });
    }
    if (!idPart && m === "POST") {
      // The dashboard sends what a scan found. The reply says when each row was first seen so new ones can be flagged.
      const b = await body();
      const st = stateOf(b.state);
      if (!st || !Array.isArray(b.items)) return json({ error: "state and items are required" }, 400);
      const before = await stateInfo(db, st);
      await upsertRows(db, st, b.items);
      if (b.complete) await markScanned(db, st, Number.isInteger(b.total) ? b.total : null);
      const rows = await listRows(db, st);
      return json({ watched: before.watched, since: before.baselined ? before.lastViewed : null, firstSeen: Object.fromEntries(rows.map((r) => [r.id, r.firstSeen])) });
    }
    if (idPart === "seen" && m === "POST") {
      const st = stateOf((await body()).state); if (!st) return json({ error: "bad state" }, 400);
      await ensureState(db, st);
      await db.prepare("UPDATE local_states SET last_viewed=?2 WHERE state=?1").bind(st, now()).run();
      return json({ ok: true });
    }
    if (idPart === "watch" && m === "PUT") {
      const b = await body(); const st = stateOf(b.state); if (!st) return json({ error: "bad state" }, 400);
      await ensureState(db, st);
      await db.prepare("UPDATE local_states SET watched=?2 WHERE state=?1").bind(st, b.watched ? 1 : 0).run();
      return json({ ok: true });
    }
  }

  if (kind === "pipeline") {
    if (!idPart && m === "GET") {
      const { results } = await db.prepare("SELECT * FROM pipeline ORDER BY (due IS NULL), due ASC").all<any>();
      return json({ items: results });
    }
    if (idPart && m === "PUT") {
      const b = await body();
      const status = STATUSES.has(b.status) ? b.status : "watching";
      const t = now();
      await db.prepare(
        `INSERT INTO pipeline (notice_id,title,agency,due,ui_link,naics,status,notes,created_at,updated_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?9)
         ON CONFLICT(notice_id) DO UPDATE SET
           status=?7, notes=COALESCE(?10, notes), updated_at=?9,
           title=COALESCE(NULLIF(?2,''), title), due=COALESCE(?4, due), naics=COALESCE(?6, naics)`,
      ).bind(idPart, String(b.title || "").slice(0, 300), b.agency ?? null, b.due ?? null, b.uiLink ?? null,
        b.naics ?? null, status, String(b.notes ?? "").slice(0, 4000), t, b.notes === undefined ? null : String(b.notes).slice(0, 4000)).run();
      return json({ ok: true });
    }
    if (idPart && m === "DELETE") {
      await db.prepare("DELETE FROM pipeline WHERE notice_id=?").bind(idPart).run();
      return json({ ok: true });
    }
  }

  if (kind === "vet") {
    if (m === "GET") {
      const name = url.searchParams.get("name");
      const q = name
        ? db.prepare("SELECT * FROM vet_history WHERE name = ?1 COLLATE NOCASE ORDER BY checked_at DESC LIMIT 20").bind(name)
        : db.prepare("SELECT * FROM vet_history ORDER BY checked_at DESC LIMIT 50");
      const { results } = await q.all<any>();
      return json({ checks: results.map((r) => ({ ...r, detail: parse(r.detail, null) })) });
    }
    if (m === "POST") {
      const b = await body();
      const ok = (v: unknown) => ["clear", "hit", "error"].includes(String(v));
      if (!b.name || !ok(b.exclusions) || !ok(b.ofac)) return json({ error: "name, exclusions, ofac required" }, 400);
      await db.prepare("INSERT INTO vet_history (name,uei,checked_at,exclusions,ofac,detail) VALUES (?,?,?,?,?,?)")
        .bind(String(b.name).slice(0, 200), b.uei || null, now(), b.exclusions, b.ofac, JSON.stringify(b.detail ?? null).slice(0, 20000)).run();
      return json({ ok: true }, 201);
    }
  }

  return json({ error: "not found" }, 404);
}
