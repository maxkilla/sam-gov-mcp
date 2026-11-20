/**
 * Business profile for one UEI. Combines, in parallel and independently (one failing source never blanks the rest):
 *  - SAM.gov Entity Management registration (needs SAM_GOV_API_KEY): name, status, expiry, CAGE, NAICS, certifications.
 *    Cached in KV for 6 hours so opening the tab does not spend a SAM call each time. Without a key (or when the key is
 *    rejected or out of quota) it falls back to a keyless mirror of SAM.gov's public monthly Entity Registration extract
 *    (hosted by Pipeworx, up to about a month old). Set ENTITY_FALLBACK=off to never send the UEI to that service.
 *  - SAM exclusions + OFAC screen
 *  - USAspending recipient record and recent federal awards
 * Every section reports its own { ok, error } so the page can say exactly what is missing.
 */

export type Run = (name: string, args: Record<string, unknown>) => Promise<any>;

export const UEI_RE = /^[A-Z0-9]{12}$/;

export function normalizeUei(v: unknown): string {
  return String(v ?? "").trim().toUpperCase().replace(/\s+/g, "");
}

const pick = (o: any, ...keys: string[]) => {
  for (const k of keys) if (o && o[k] != null && o[k] !== "") return o[k];
  return null;
};

async function samRegistration(uei: string, apiKey: string | undefined) {
  if (!apiKey) return { ok: false, error: "no_key" as const };
  const u = new URL("https://api.sam.gov/entity-information/v3/entities");
  u.searchParams.set("api_key", apiKey);
  u.searchParams.set("ueiSAM", uei);
  u.searchParams.set("includeSections", "entityRegistration,coreData,assertions");
  const res = await fetch(u.href, { headers: { accept: "application/json" }, redirect: "manual" });
  if (res.status === 403 || res.status === 401) return { ok: false, error: "key_rejected" as const };
  if (res.status === 429) return { ok: false, error: "rate_limited" as const };
  if (!res.ok) return { ok: false, error: `sam_http_${res.status}` };
  const j: any = await res.json().catch(() => null);
  const e = j?.entityData?.[0];
  if (!e) return { ok: false, error: "not_found" as const };
  const reg = e.entityRegistration || {};
  const core = e.coreData || {};
  const addr = core.physicalAddress || {};
  const naicsList: any[] = e.assertions?.goodsAndServices?.naicsList || [];
  const sba: any[] = core.businessTypes?.sbaBusinessTypeList || [];
  const biz: any[] = core.businessTypes?.businessTypeList || [];
  return {
    ok: true,
    source: "sam",
    fetchedAt: new Date().toISOString(),
    legalName: pick(reg, "legalBusinessName"),
    dba: pick(reg, "dbaName"),
    uei: pick(reg, "ueiSAM") || uei,
    cage: pick(reg, "cageCode"),
    status: pick(reg, "registrationStatus"),
    activeDate: pick(reg, "activationDate"),
    expires: pick(reg, "registrationExpirationDate"),
    purpose: pick(reg, "purposeOfRegistrationDesc"),
    startDate: pick(core.entityInformation, "entityStartDate"),
    website: pick(core.entityInformation, "entityURL"),
    address: [addr.addressLine1, addr.city, addr.stateOrProvinceCode, addr.zipCode].filter(Boolean).join(", ") || null,
    state: addr.stateOrProvinceCode || null,
    naics: naicsList
      .map((n) => ({
        code: String(n.naicsCode || ""),
        primary: n.isPrimary === "Y" || String(n.naicsCode || "") === String(e.assertions?.goodsAndServices?.primaryNaics || ""),
        name: n.naicsDescription || "",
      }))
      .filter((n) => n.code),
    sbaCerts: sba.map((s) => ({ name: s.sbaBusinessTypeDesc || s.sbaBusinessTypeCode, expires: s.certificationExitDate || null })),
    businessTypes: biz.map((b) => b.businessTypeDesc || b.businessTypeCode).filter(Boolean),
  };
}

export interface EntityOpts {
  samKey?: string;
  kv?: KVNamespace;
  /** Skip the KV cache read and fetch fresh. */
  fresh?: boolean;
  /** Use the keyless public-extract mirror when live SAM data is unavailable. Default true. */
  fallback?: boolean;
}

const REG_TTL_SECONDS = 6 * 3600;
const MIRROR_URL = "https://gateway.pipeworx.io/v1/tools/sam_entity_search";

/** Keyless fallback: SAM.gov's public Entity Registration extract, mirrored by Pipeworx. Same shape as samRegistration. */
async function mirrorRegistration(uei: string): Promise<any> {
  const res = await fetch(MIRROR_URL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ business_name: uei, limit: 1 }),
    redirect: "manual",
    signal: AbortSignal.timeout(10000),
  });
  if (res.status === 429) return { ok: false, error: "rate_limited" };
  if (!res.ok) return { ok: false, error: `mirror_http_${res.status}` };
  const j: any = await res.json().catch(() => null);
  const e = (j?.entities || []).find((x: any) => String(x?.uei || "").toUpperCase() === uei);
  if (!e) return { ok: false, error: "not_found" };
  const a = e.address || {};
  const primary = String(e.primary_naics || "").slice(0, 6);
  // all_naics_codes looks like "423110Y~423120Y": six digits plus a one-letter flag.
  const codes = [...new Set([primary, ...String(e.all_naics_codes || "").split("~").map((c) => c.trim().slice(0, 6))].filter((c) => /^\d{6}$/.test(c)))];
  const certs = String(e.sba_certifications || "").split(/[~,;]/).map((c) => c.trim()).filter(Boolean);
  return {
    ok: true,
    source: "mirror",
    snapshotDate: j?.mirror?.snapshot_date || null,
    fetchedAt: new Date().toISOString(),
    legalName: e.legal_business_name || null,
    dba: e.dba_name || null,
    uei: e.uei,
    cage: e.cage_code || null,
    status: e.registration_status || null,
    activeDate: e.registration_date || null,
    expires: e.expiration_date || null,
    purpose: null,
    startDate: null,
    website: e.entity_url || null,
    address: [a.line1, a.city, a.state, a.zip].filter(Boolean).join(", ") || null,
    state: a.state || null,
    naics: codes.map((c) => ({ code: c, primary: c === primary, name: "" })),
    sbaCerts: certs.map((c) => ({ name: c, expires: null })),
    businessTypes: [],
  };
}

/** Registration section: KV cache, then live SAM, then the keyless mirror. Errors are never cached. */
export async function loadRegistration(uei: string, o: EntityOpts): Promise<any> {
  const ck = `entity:reg:${uei}`;
  if (o.kv && !o.fresh) {
    const hit: any = await o.kv.get(ck, "json").catch(() => null);
    // A mirror snapshot is not served once a key exists (the live answer is better), unless the key is out of quota.
    if (hit?.ok && !(hit.source === "mirror" && o.samKey && hit.liveError !== "rate_limited")) return { ...hit, cached: true };
  }
  const fail = (e: any) => ({ ok: false, error: String(e?.message || e) });
  const live: any = await samRegistration(uei, o.samKey).catch(fail);
  let out = live;
  // A live "not found" is an answer; anything else (no key, bad key, quota, outage) may use the mirror.
  if (!live.ok && live.error !== "not_found" && o.fallback !== false) {
    const fb: any = await mirrorRegistration(uei).catch(fail);
    if (fb.ok) out = { ...fb, liveError: live.error };
    else out = { ok: false, error: fb.error === "not_found" && live.error === "no_key" ? "snapshot_miss" : live.error, liveError: live.error, fallbackError: fb.error };
  }
  if (out.ok && o.kv) await o.kv.put(ck, JSON.stringify(out), { expirationTtl: REG_TTL_SECONDS }).catch(() => {});
  return out;
}

async function exclusions(uei: string, run: Run) {
  const r = await run("sam_integrity_lookup", { uei });
  if (r?.ok === false) return { ok: false, error: r.error?.message || "lookup failed" };
  const d = r.data || {};
  return {
    ok: true,
    excluded: !!d.exclusions?.excluded,
    activeCount: d.exclusions?.activeCount ?? 0,
    records: (d.exclusions?.records || []).slice(0, 5),
    fapiisUrl: d.fapiisUrl || null,
  };
}

async function ofac(name: string | null, run: Run) {
  if (!name) return { ok: false, error: "no_name" };
  const r = await run("ofac_screen_entity", { name });
  if (r?.ok === false) return { ok: false, error: r.error?.message || "screen failed" };
  return { ok: true, result: r.data?.result, matchCount: r.data?.matchCount ?? 0, published: r.data?.snapshot?.publishedDate || null };
}

async function usaspending(uei: string, run: Run) {
  const s = await run("usas_search_recipients", { keyword: uei, limit: 5 });
  if (s?.ok === false) return { ok: false, error: s.error?.message || "search failed" };
  const rows: any[] = s.data?.recipients || s.data?.results || [];
  const hit = rows.find((x) => String(x.uei || "").toUpperCase() === uei) || null;
  if (!hit) return { ok: true, found: false };
  const p = await run("usas_get_recipient_profile", { recipientId: hit.id || hit.recipient_id });
  const d = p?.ok === false ? {} : p.data || {};
  const a = await run("usas_search_awards_by_recipient", { recipientName: d.name || hit.name, limit: 5 });
  const awards: any[] = a?.ok === false ? [] : a.data?.awards || [];
  return {
    ok: true,
    found: true,
    name: d.name || hit.name || null,
    parent: d.parent_name || null,
    businessTypes: d.business_types || [],
    totalAmount: d.total_transaction_amount ?? d.total_amount ?? hit.amount ?? null,
    totalTransactions: d.total_transactions ?? null,
    awards: awards.slice(0, 5).map((x) => ({ id: x.awardId, description: x.description, agency: x.awardingSubAgency || x.awardingAgency, amount: x.amount })),
  };
}

export async function loadEntity(uei: string, o: EntityOpts, run: Run) {
  const guard = <T>(p: Promise<T>) => p.catch((e: any) => ({ ok: false, error: String(e?.message || e) }) as any);
  const [registration, usas, excl] = await Promise.all([guard(loadRegistration(uei, o)), guard(usaspending(uei, run)), guard(exclusions(uei, run))]);
  const name = (registration as any).legalName || (usas as any).name || null;
  const sanctions = await guard(ofac(name, run));
  return { uei, name, registration, usaspending: usas, exclusions: excl, ofac: sanctions, checkedAt: new Date().toISOString() };
}
