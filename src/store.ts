// Saved searches, pipeline and vetting history, stored in D1.

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
  for (const o of opps) {
    if (!known.has(o.noticeId)) {
      known.add(o.noticeId);
      if (!firstRun) fresh.add(o.noticeId); // the first run is the baseline, not "new"
    }
  }
  const knownList = [...known].slice(-2000);
  await db
    .prepare("UPDATE saved_searches SET last_run_at=?, last_total=?, known_ids=?, new_ids=? WHERE id=?")
    .bind(now(), env.data.totalRecords ?? opps.length, JSON.stringify(knownList), JSON.stringify([...fresh]), id)
    .run();
  return { opportunities: opps, total: env.data.totalRecords ?? opps.length, newIds: [...fresh] };
}

/** Cron: refresh every saved search. */
export async function runAllSavedSearches(db: D1Database, run: RunTool) {
  const { results } = await db.prepare("SELECT id FROM saved_searches").all<{ id: number }>();
  for (const r of results) {
    try {
      await runSavedSearch(db, r.id, run);
    } catch {
      // keep going; one failing search must not block the rest
    }
  }
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
