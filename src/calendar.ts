// Calendar feed (.ics) of pipeline deadlines.
const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
/** Lines over 75 octets are folded with a leading space, as the format requires. */
const fold = (line: string) => {
  const enc = new TextEncoder(); if (enc.encode(line).length <= 75) return line;
  const out: string[] = []; let cur = ""; let n = 0;
  for (const ch of line) { const b = enc.encode(ch).length; if (n + b > (out.length ? 74 : 75)) { out.push(cur); cur = ""; n = 0; } cur += ch; n += b; }
  out.push(cur); return out.join("\r\n ");
};
const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

export async function buildIcs(db: D1Database): Promise<string> {
  const { results } = await db
    .prepare("SELECT notice_id, title, agency, due, ui_link, status FROM pipeline WHERE status IN ('watching','bidding') AND due IS NOT NULL")
    .all<any>();
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Bid desk//Deadlines//EN", "CALSCALE:GREGORIAN", "X-WR-CALNAME:Bid deadlines", "REFRESH-INTERVAL;VALUE=DURATION:PT6H"];
  const now = stamp(new Date());
  for (const r of results) {
    const t = Date.parse(r.due);
    if (Number.isNaN(t)) continue;
    const end = new Date(t);
    lines.push("BEGIN:VEVENT", `UID:${r.notice_id}@bid-desk`, `DTSTAMP:${now}`);
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(r.due))) {
      const next = new Date(t + 86_400_000);
      lines.push(`DTSTART;VALUE=DATE:${stamp(end).slice(0, 8)}`, `DTEND;VALUE=DATE:${stamp(next).slice(0, 8)}`);
    } else {
      lines.push(`DTSTART:${stamp(new Date(t - 30 * 60_000))}`, `DTEND:${stamp(end)}`);
    }
    lines.push(`SUMMARY:${esc("Due: " + r.title)}`);
    const desc = [r.agency, r.status && "Status: " + r.status, r.ui_link].filter(Boolean).join("\n");
    if (desc) lines.push(`DESCRIPTION:${esc(desc)}`);
    if (r.ui_link && /^https?:\/\//.test(r.ui_link)) lines.push(`URL:${r.ui_link}`);
    lines.push("BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${esc("Due tomorrow: " + r.title)}`, "TRIGGER:-P1D", "END:VALARM", "END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}
