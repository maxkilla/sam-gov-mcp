// Grants.gov search, shared by the dashboard route and saved grant searches.
const list = (v: unknown, ok: RegExp) => String(v ?? "").split("|").map((x) => x.trim()).filter((x) => ok.test(x)).join("|");
const STATUS = new Set(["forecasted", "posted", "closed", "archived"]);
const SORTS = new Set(["openDate|desc", "closeDate|asc", "closeDate|desc", "oppNum|asc"]);

/** Turn a request body into a Grants.gov search2 payload, keeping only allow-listed values. */
export function grantPayload(b: any): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    keyword: String(b.keyword ?? "").slice(0, 200),
    cfda: /^\d{2}\.\d{3}$/.test(String(b.cfda ?? "")) ? b.cfda : "",
    agencies: list(b.agencies, /^[A-Za-z0-9._-]{2,30}$/),
    eligibilities: list(b.eligibilities, /^\d{2}$/),
    fundingInstruments: list(b.fundingInstruments, /^[A-Z]{1,2}$/),
    fundingCategories: list(b.fundingCategories, /^[A-Z]{1,3}$/),
    oppStatuses: list(b.oppStatuses, /^[a-z]+$/).split("|").filter((x) => STATUS.has(x)).join("|") || "forecasted|posted",
    rows: Math.min(50, Math.max(1, Number(b.rows) || 50)),
    startRecordNum: Math.max(0, Math.floor(Number(b.start) || 0)),
  };
  if (SORTS.has(b.sortBy)) payload.sortBy = b.sortBy;
  if (/^(3|7|14|21|28|35|42|49|56)$/.test(String(b.dateRange ?? ""))) payload.dateRange = String(b.dateRange);
  return payload;
}

const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”" };
/** Grants.gov sends titles with HTML entities in them. */
const plain = (s: unknown) => String(s ?? "").replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e: string) => e[0] === "#" ? String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENT[e.toLowerCase()] ?? m).replace(/\s+/g, " ").trim();

export interface GrantItem { id: string; number: string; title: string; agency: string; agencyCode: string; openDate: string; closeDate: string; status: string; docType: string; cfda: string[] }

export async function searchGrants(payload: Record<string, unknown>) {
  const r = await fetch("https://api.grants.gov/v1/api/search2", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error("Grants.gov answered " + r.status);
  const d = ((await r.json()) as any)?.data;
  if (!d) throw new Error("Grants.gov returned no data");
  const facet = (a: any[]) => (a || []).map((x) => ({ value: x.value, label: x.label, count: x.count }));
  return {
    total: (d.hitCount ?? 0) as number,
    items: (d.oppHits || []).map((h: any): GrantItem => ({ id: h.id, number: h.number, title: plain(h.title), agency: plain(h.agency), agencyCode: h.agencyCode, openDate: h.openDate, closeDate: h.closeDate, status: h.oppStatus, docType: h.docType, cfda: h.cfdaList || [] })),
    facets: { fundingCategories: facet(d.fundingCategories), eligibilities: facet(d.eligibilities), fundingInstruments: facet(d.fundingInstruments) },
  };
}

/** MM/DD/YYYY from Grants.gov to an ISO date (end of day), or null. */
export function grantDate(s?: string | null): string | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(s || ""));
  return m ? `${m[3]}-${m[1]}-${m[2]}T23:59:00.000Z` : null;
}
export const grantLink = (id: string) => `https://www.grants.gov/search-results-detail/${id}`;
