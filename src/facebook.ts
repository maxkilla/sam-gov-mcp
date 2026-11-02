// Facebook Marketplace search for the Worker (no login, no browser).
// Adapted from https://github.com/jlsookiki/secondhand-mcp (MIT, (c) 2025), which in turn follows
// kyleronayne/marketplace-api. Changes: one file, Workers fetch (no undici proxy), no offline city table
// (Facebook's own place lookup resolves locations), optional relay fallback for blocked Worker IPs.
// The doc_id values are Facebook's internal query ids and can go stale; update them here if searches start failing.

const GRAPHQL_URL = "https://www.facebook.com/api/graphql/";
const LOCATION_DOC_ID = "5585904654783609";
const SEARCH_DOC_ID = "27517490627932547";
const DETAIL_PHOTOS_DOC_ID = "10059604367394414";
const DETAIL_INFO_DOC_ID = "26090240497332612";
const PAGE_SIZE = 24;
const DEFAULT_RADIUS = 25;
const MAX_RADIUS = 500;
const MAX_PRICE_SENTINEL = 214748364700;
const CITY_PAGE_MAX_MILES = 50;
const UA_GQL = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const UA_PAGE = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export interface FbEnv { relay?: { base: string; token: string } }
export interface FbListing { id: string; title: string; price: string; priceNumeric?: number; location?: string; url: string; image?: string; seller?: string }
interface Coords { latitude: number; longitude: number }

const STATES: Record<string, string> = { AL: "alabama", AK: "alaska", AZ: "arizona", AR: "arkansas", CA: "california", CO: "colorado", CT: "connecticut", DE: "delaware", FL: "florida", GA: "georgia", HI: "hawaii", ID: "idaho", IL: "illinois", IN: "indiana", IA: "iowa", KS: "kansas", KY: "kentucky", LA: "louisiana", ME: "maine", MD: "maryland", MA: "massachusetts", MI: "michigan", MN: "minnesota", MS: "mississippi", MO: "missouri", MT: "montana", NE: "nebraska", NV: "nevada", NH: "new hampshire", NJ: "new jersey", NM: "new mexico", NY: "new york", NC: "north carolina", ND: "north dakota", OH: "ohio", OK: "oklahoma", OR: "oregon", PA: "pennsylvania", RI: "rhode island", SC: "south carolina", SD: "south dakota", TN: "tennessee", TX: "texas", UT: "utah", VT: "vermont", VA: "virginia", WA: "washington", WV: "west virginia", WI: "wisconsin", WY: "wyoming", DC: "district of columbia" };
const ALIASES: Record<string, string> = { nyc: "new york, new york", sf: "san francisco, california", la: "los angeles, california", philly: "philadelphia, pennsylvania", vegas: "las vegas, nevada", nola: "new orleans, louisiana", atl: "atlanta, georgia", chi: "chicago, illinois", "bay area": "san francisco, california" };

export class FbRefusal extends Error {}

// Direct first (works from many Worker IPs); if Facebook refuses, retry through the relay when one is configured.
async function fbFetch(env: FbEnv, url: string, init: RequestInit): Promise<Response> {
  const direct = async () => fetch(url, { ...init, redirect: "follow", signal: AbortSignal.timeout(12000) });
  let res: Response | undefined;
  try { res = await direct(); } catch { /* try the relay */ }
  if (res && res.ok) return res;
  if (env.relay) {
    const u = new URL(url);
    const h = new Headers(init.headers);
    h.set("x-relay-token", env.relay.token);
    const viaRelay = await fetch(`${env.relay.base}/${u.hostname}${u.pathname}${u.search}`, { ...init, headers: h, signal: AbortSignal.timeout(20000) });
    if (viaRelay.ok || !res) return viaRelay;
  }
  if (!res) throw new Error("Facebook could not be reached");
  return res;
}

async function graphql<T>(env: FbEnv, docId: string, variables: unknown): Promise<{ data?: T | null; errors?: { message?: string }[] }> {
  const body = new URLSearchParams({ variables: JSON.stringify(variables), doc_id: docId });
  let last: unknown;
  for (let i = 0; i < 2; i++) {
    try {
      const res = await fbFetch(env, GRAPHQL_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "same-origin", "user-agent": UA_GQL }, body: body.toString() });
      if (!res.ok) { if ([408, 429, 500, 502, 503, 504].includes(res.status)) throw new Error(`Facebook returned ${res.status}`); throw new FbRefusal(`Facebook returned ${res.status}`); }
      const text = await res.text();
      let json: any; try { json = JSON.parse(text.replace(/^for \(;;\);/, "")); } catch { throw new FbRefusal("Facebook answered with a page instead of data (likely a block or login wall)"); }
      if (json.errors?.length && !json.data) throw new FbRefusal(`Facebook GraphQL error: ${json.errors[0].message}`);
      return json;
    } catch (e) { if (e instanceof FbRefusal) throw e; last = e; await new Promise((r) => setTimeout(r, 600)); }
  }
  throw last ?? new Error("Facebook request failed");
}

// ---- places -------------------------------------------------------------------------------------
interface Place { subtitle?: string; single_line_address?: string; location?: Coords | null; page?: { id?: string } | null }
const kind = (n: Place) => n.subtitle?.split(" ·")[0];
const isCity = (n: Place) => kind(n) === "City";

function miles(a: Coords, b: Coords): number {
  const r = (d: number) => (d * Math.PI) / 180;
  const h = Math.sin(r(b.latitude - a.latitude) / 2) ** 2 + Math.cos(r(a.latitude)) * Math.cos(r(b.latitude)) * Math.sin(r(b.longitude - a.longitude) / 2) ** 2;
  return 3958.8 * 2 * Math.asin(Math.sqrt(h));
}

// "kansas city, mo" returns Mound City, Kansas on Facebook; spelling the state out is what lands.
function candidates(q: string): string[] {
  const typed = q.toLowerCase().trim();
  const alias = ALIASES[typed];
  if (alias) return [alias];
  const parts = typed.split(",").map((p) => p.trim());
  const state = parts.length > 1 ? STATES[parts[parts.length - 1].toUpperCase()] : undefined;
  return [...new Set([state ? `${parts[0]}, ${state}` : typed, parts[0]].filter(Boolean))];
}

async function places(env: FbEnv, q: string): Promise<Place[]> {
  const r = await graphql<any>(env, LOCATION_DOC_ID, { params: { caller: "MARKETPLACE", page_category: ["CITY", "SUBCITY", "NEIGHBORHOOD", "POSTAL_CODE"], query: q } });
  return (r.data?.city_street_search?.street_results?.edges ?? []).flatMap((e: any) => (e?.node ? [e.node as Place] : []));
}

async function resolve(env: FbEnv, location: string): Promise<{ coords: Coords; name: string; pageId?: string } | null> {
  for (const c of candidates(location)) {
    const list = await places(env, c);
    const node = list.find(isCity) ?? list[0];
    if (!node?.location) continue;
    const coords = node.location;
    const near = list.filter((n) => n.page?.id && n.location && miles(coords, n.location) <= CITY_PAGE_MAX_MILES).sort((a, b) => miles(coords, a.location!) - miles(coords, b.location!));
    const page = near.find(isCity) ?? near[0];
    return { coords, name: (isCity(node) ? node.single_line_address : kind(node) || node.single_line_address) ?? "", pageId: page?.page?.id };
  }
  return null;
}

// ---- search -------------------------------------------------------------------------------------
function searchVariables(query: string, c: Coords, count: number, min: number | undefined, max: number | undefined, radius: number) {
  return {
    buyLocation: { latitude: c.latitude, longitude: c.longitude }, contextual_data: null, count: Math.min(count, PAGE_SIZE), cursor: null,
    params: {
      bqf: { callsite: "COMMERCE_MKTPLACE_WWW", query },
      browse_request_params: { commerce_enable_local_pickup: true, commerce_enable_shipping: true, commerce_search_and_rp_available: true, commerce_search_and_rp_category_id: [], commerce_search_and_rp_condition: null, commerce_search_and_rp_ctime_days: null, filter_location_latitude: c.latitude, filter_location_longitude: c.longitude, filter_price_lower_bound: min ?? 0, filter_price_upper_bound: max ?? MAX_PRICE_SENTINEL, filter_radius_km: Math.round(radius * 1.609) },
      custom_request_params: { browse_context: null, contextual_filters: [], referral_code: null, referral_ui_component: null, saved_search_strid: null, search_vertical: "C2C", seo_url: null, serp_landing_settings: { virtual_category_id: "" }, surface: "SEARCH", virtual_contextual_filters: [] },
    },
    savedSearchID: null, savedSearchQuery: query, scale: 2, shouldDeferNonCritical: false, shouldIncludePopularSearches: false, topicPageParams: { location_id: null, url: null },
    __relay_internal__pv__GHLShouldChangeMarketplaceSponsoredDataFieldNamerelayprovider: true,
  };
}

const unavailable = (l: any) => l.is_sold === true || l.is_live === false || l.is_pending === true || l.is_hidden === true || /^(\[SOLD\]|SOLD -|SOLD$)/i.test(l.marketplace_listing_title || "");
function priceNum(s: string): number | undefined { const m = /(\d[\d,]*(?:\.\d+)?)/.exec(s); return m ? parseFloat(m[1].replace(/,/g, "")) : undefined; }

function parseEdges(edges: any[], limit: number, showSold: boolean): FbListing[] {
  const out: FbListing[] = [];
  for (const e of edges) {
    if (out.length >= limit) break;
    const l = e?.node?.listing;
    if (!l || (!showSold && unavailable(l))) continue;
    const price = l.listing_price?.formatted_amount || "Price not listed";
    const g = l.location?.reverse_geocode;
    out.push({ id: l.id, title: l.marketplace_listing_title || "Untitled Listing", price, priceNumeric: priceNum(price), location: g?.city_page?.display_name || (g?.city ? [g.city, g.state].filter(Boolean).join(", ") : undefined), url: `https://www.facebook.com/marketplace/item/${l.id}`, image: l.primary_listing_photo?.image?.uri ?? undefined, seller: l.marketplace_listing_seller?.name ?? undefined });
  }
  return out;
}

// Facebook sometimes serves non-browser callers a gated feed (stubs, or a single edge plus a cursor).
// The logged-out search page still carries the first page of results, so it is the fallback.
function extractArray(html: string, start: number): any[] | null {
  if (start === -1) return null;
  let depth = 0, inStr = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (inStr) { if (c === "\\") i++; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true; else if (c === "[" || c === "{") depth++; else if (c === "]" || c === "}") { depth--; if (depth === 0) { try { return JSON.parse(html.slice(start, i + 1)); } catch { return null; } } }
  }
  return null;
}
function pageEdges(html: string): any[] | null {
  let best: any[] | null = null, bestN = -1;
  for (let a = html.indexOf('"feed_units"'); a !== -1; a = html.indexOf('"feed_units"', a + 1)) {
    const at = html.indexOf('"edges":', a);
    if (at === -1 || at > a + 200) continue;
    const edges = extractArray(html, html.indexOf("[", at));
    const n = edges ? edges.filter((e) => e?.node?.listing).length : -1;
    if (edges && n > bestN) { best = edges; bestN = n; }
  }
  return best;
}

export interface FbSearchArgs { query: string; location?: string; radius?: number; minPrice?: number; maxPrice?: number; limit?: number; showSold?: boolean }

export async function fbSearch(env: FbEnv, a: FbSearchArgs) {
  const query = String(a.query ?? "").trim();
  if (!query) throw new Error("query is required");
  const location = a.location?.trim() || "san francisco";
  const limit = Math.max(1, Math.min(Math.floor(a.limit ?? PAGE_SIZE), PAGE_SIZE));
  const radius = !a.radius || a.radius <= 0 ? DEFAULT_RADIUS : Math.min(a.radius, MAX_RADIUS);
  const showSold = a.showSold === true;
  const place = await resolve(env, location);
  if (!place) throw new Error(`Could not find location "${location}". Try "city, state" (for example "Lakeport, CA").`);

  let listings: FbListing[] = [], gated = false, failure: unknown;
  try {
    const r = await graphql<any>(env, SEARCH_DOC_ID, searchVariables(query, place.coords, limit, a.minPrice, a.maxPrice, radius));
    const fu = r.data?.marketplace_search?.feed_units;
    const edges: any[] = fu?.edges ?? [];
    listings = parseEdges(edges, limit, showSold);
    const stubs = !fu?.edges || edges.some((e) => e?.node && !e.node.listing && e.node.__typename !== "MarketplaceSearchFeedNoResults");
    gated = listings.length < Math.min(limit, 5) && (stubs || fu?.page_info?.has_next_page === true);
  } catch (e) { failure = e; gated = true; }

  if (gated && place.pageId) {
    try {
      const qs = new URLSearchParams({ query });
      if (a.minPrice != null) qs.set("minPrice", String(a.minPrice));
      if (a.maxPrice != null) qs.set("maxPrice", String(a.maxPrice));
      qs.set("radius", String(Math.round(radius)));
      const res = await fbFetch(env, `https://www.facebook.com/marketplace/${place.pageId}/search?${qs}`, { headers: { accept: "text/html,application/xhtml+xml", "accept-language": "en-US,en;q=0.9", "sec-fetch-dest": "document", "sec-fetch-mode": "navigate", "sec-fetch-site": "none", "upgrade-insecure-requests": "1", "user-agent": UA_PAGE } });
      const html = res.ok ? await res.text() : "";
      const edges = html.includes("marketplace_search") ? pageEdges(html) : null;
      const fromPage = edges ? parseEdges(edges, limit, showSold) : [];
      if (fromPage.length > listings.length) { listings = fromPage; failure = undefined; }
    } catch { /* keep what the API gave */ }
  }
  if (!listings.length && failure) throw failure instanceof Error ? failure : new Error(String(failure));
  return { location: place.name || location, radiusMiles: radius, count: listings.length, listings };
}

// ---- listing details ----------------------------------------------------------------------------
export async function fbListing(env: FbEnv, listingId: string) {
  const id = String(listingId ?? "").trim().replace(/^.*\/item\/(\d+).*$/, "$1");
  if (!/^\d+$/.test(id)) throw new Error("listingId must be the numeric id from a search result (or a marketplace item URL)");
  const [photos, info] = await Promise.allSettled([
    graphql<any>(env, DETAIL_PHOTOS_DOC_ID, { targetId: id }),
    graphql<any>(env, DETAIL_INFO_DOC_ID, { targetId: id, scale: 2, feedbackSource: 56, feedLocation: "MARKETPLACE_MEGAMALL", referralCode: "marketplace_top_picks", enableJobEmployerActionBar: false, enableJobSeekerActionBar: false, useDefaultActor: false, __relay_internal__pv__CometUFICommentActionLinksRewriteEnabledrelayprovider: false, __relay_internal__pv__CometUFICommentAvatarStickerAnimatedImagerelayprovider: false, __relay_internal__pv__CometUFIReactionsEnableShortNamerelayprovider: false, __relay_internal__pv__CometUFIShareActionMigrationrelayprovider: true, __relay_internal__pv__CometUFI_dedicated_comment_routable_dialog_gkrelayprovider: false, __relay_internal__pv__GHLShouldChangeAdIdFieldNamerelayprovider: true, __relay_internal__pv__GHLShouldChangeSponsoredDataFieldNamerelayprovider: true, __relay_internal__pv__IsWorkUserrelayprovider: false, __relay_internal__pv__ShouldUpdateMarketplaceBoostListingBoostedStatusrelayprovider: false }),
  ]);
  const target = (s: PromiseSettledResult<any>) => (s.status === "fulfilled" ? s.value.data?.viewer?.marketplace_product_details_page?.target ?? undefined : undefined);
  const p = target(photos), i = target(info);
  if (!p && !i) {
    const failed = [photos, info].find((s) => s.status === "rejected") as PromiseRejectedResult | undefined;
    throw failed ? failed.reason : new Error(`Facebook returned no listing ${id}; it may have been removed`);
  }
  const missing = [!p && "photos", !i && "description"].filter(Boolean);
  return {
    id, url: `https://www.facebook.com/marketplace/item/${id}`,
    description: i?.redacted_description?.text ?? undefined,
    images: Array.isArray(p?.listing_photos) ? p.listing_photos.flatMap((x: any) => (x?.image?.uri ? [x.image.uri] : [])) : [],
    location: i?.location_text?.text ?? undefined, coordinates: i?.location ?? undefined,
    seller: i?.marketplace_listing_seller?.name ?? undefined,
    deliveryTypes: i?.delivery_types ?? undefined, shippingOffered: i?.is_shipping_offered ?? undefined,
    ...(missing.length ? { unavailable: missing } : {}),
  };
}

export const FB_TOOLS = [
  {
    name: "facebook_marketplace_search",
    description: "Search Facebook Marketplace (no login). Returns title, price, city, seller, photo and link for nearby listings. Use for used cars, parts, tools and gear. Location is a city such as \"Lakeport, CA\"; radius is in miles (default 25, max 500). Unofficial: Facebook can change or block this without notice.",
    inputSchema: { type: "object", properties: { query: { type: "string", description: "What to search for, e.g. \"honda civic si bumper\"" }, location: { type: "string", description: "City, e.g. \"Santa Rosa, CA\" (default san francisco)" }, radius: { type: "number", description: "Miles, default 25, max 500" }, minPrice: { type: "number" }, maxPrice: { type: "number" }, limit: { type: "number", description: "1-24, default 24" }, showSold: { type: "boolean", description: "Include sold/pending listings" } }, required: ["query"], additionalProperties: false },
  },
  {
    name: "facebook_marketplace_listing",
    description: "Full details for one Facebook Marketplace listing: description, all photos, seller, location and delivery options. Pass the numeric id from a search result (or the item URL).",
    inputSchema: { type: "object", properties: { listingId: { type: "string", description: "Numeric listing id or marketplace item URL" } }, required: ["listingId"], additionalProperties: false },
  },
];
