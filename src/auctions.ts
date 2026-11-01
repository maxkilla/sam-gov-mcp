// GSA Auctions (gsaauctions.gov). The API answers with a redirect to one JSON file holding every active and
// upcoming lot, so we fetch it once, trim it to the fields the dashboard shows, and keep it in KV for 6 hours.
const SOURCE = "https://api.gsa.gov/assets/gsaauctions/v2/auctions";
const FRESH_MS = 6 * 3600_000;
const KEY = "gsa:auctions";

const MAKES = "ford|chevrolet|chevy|dodge|toyota|honda|gmc|jeep|nissan|ram|kenworth|freightliner|international|peterbilt|mack|volvo|hyundai|kia|subaru|mazda|bmw|chrysler|buick|cadillac|lincoln|mercury|pontiac|saturn|volkswagen|isuzu|mitsubishi|lexus|acura|infiniti|tesla|mercedes|audi|harley|polaris|kawasaki|yamaha";
const VEHICLE = new RegExp(`\\b(19[789]\\d|20[0-3]\\d)\\b.*\\b(${MAKES}|bus|pickup|sedan|suv|van|truck)\\b|\\b(${MAKES})\\b.*\\b(19[789]\\d|20[0-3]\\d)\\b`, "i");

export interface Auction { id: string; name: string; start: string; end: string; city: string; st: string; status: string; bidders: number | null; bid: number | null; reserve: boolean; agency: string; link: string; img: string; veh: boolean }
export interface AuctionData { at: string; rows: Auction[]; stale?: boolean }

const clean = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim();

export async function loadAuctions(kv: KVNamespace | undefined, apiKey: string | undefined, force = false): Promise<AuctionData> {
  let cached: AuctionData | null = null;
  try { cached = kv ? ((await kv.get(KEY, "json")) as AuctionData | null) : null; } catch { /* treat as empty */ }
  if (cached && !force && Date.now() - Date.parse(cached.at) < FRESH_MS) return cached;
  try {
    const r = await fetch(`${SOURCE}?api_key=${encodeURIComponent(apiKey || "DEMO_KEY")}`, { headers: { "user-agent": "bid-desk/1.0 (+https://github.com/maxkilla/sam-gov-mcp)", accept: "application/json" }, signal: AbortSignal.timeout(40_000) });
    if (!r.ok) throw new Error("GSA Auctions answered " + r.status);
    const body: any = await r.json();
    const rows: Auction[] = (body?.Results || []).map((x: any): Auction => ({
      id: `${x.saleNo}-${x.lotNo}`,
      name: clean(x.itemName),
      start: clean(x.aucStartDt),
      end: clean(x.aucEndDt),
      city: clean(x.propertyCity),
      st: clean(x.propertyState),
      status: /^preview$/i.test(clean(x.auctionStatus)) ? "Preview" : "Active",
      bidders: typeof x.biddersCount === "number" ? x.biddersCount : null,
      bid: typeof x.highBidAmount === "number" ? x.highBidAmount : null,
      reserve: !!x.reserve,
      agency: clean(x.agencyName || x.bureauName),
      link: /^https?:\/\//.test(x.itemDescURL || "") ? x.itemDescURL : "",
      img: /^https?:\/\//.test(x.imageURL || "") ? x.imageURL : "",
      veh: VEHICLE.test(clean(x.itemName)),
    }));
    const data: AuctionData = { at: new Date().toISOString(), rows };
    if (kv) await kv.put(KEY, JSON.stringify(data)).catch(() => {});
    return data;
  } catch (e) {
    if (cached) return { ...cached, stale: true };
    throw e;
  }
}
