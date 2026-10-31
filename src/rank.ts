// Rank notices by how well they match a short description of the company, using classifier.dev
// (keyless zero-shot classification). Only notice titles and agency names are sent, never the dashboard token.

const LABELS = ["strong fit", "possible fit", "not a fit"];
export type Fit = "strong" | "possible" | "weak";
export interface Ranked { score: number; fit: Fit }

export const fitOf = (score: number): Fit => (score >= 0.6 ? "strong" : score >= 0.25 ? "possible" : "weak");

/** Returns one result per text, or throws with a readable message. */
export async function rankTexts(texts: string[], profile: string): Promise<Ranked[]> {
  const out: Ranked[] = [];
  for (let i = 0; i < texts.length; i += 200) {
    const r = await fetch("https://classifier.dev/v1/classify", {
      method: "POST",
      headers: { "content-type": "application/json", "X-Classifier-Share-Data": "false" },
      body: JSON.stringify({
        inputs: texts.slice(i, i + 200).map((t) => t.slice(0, 400)),
        labels: LABELS,
        instructions: `The company: ${profile.slice(0, 1500)}\nJudge how well each federal contracting notice matches what this company does and wants to win.`,
      }),
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) throw new Error(`The ranking service answered ${r.status}`);
    const j: any = await r.json();
    for (const x of j.results || []) {
      const s = x.scores || {};
      const score = Math.round(((s["strong fit"] || 0) + 0.4 * (s["possible fit"] || 0)) * 100) / 100;
      out.push({ score, fit: fitOf(score) });
    }
  }
  if (out.length !== texts.length) throw new Error("The ranking service returned an unexpected answer");
  return out;
}

// ── Major categories (for the tag cloud) ──────────────────────────────────
export const CATEGORIES = [
  "IT and software",
  "Construction and repairs",
  "Facilities, janitorial and grounds",
  "Professional and consulting services",
  "Engineering and research",
  "Vehicles, equipment and parts",
  "Medical and lab",
  "Security and defense",
  "Supplies and furniture",
  "Transportation and logistics",
  "Food and hospitality",
  "Training and education",
  "Other",
];

/** One major category per text. */
export async function categorizeTexts(texts: string[]): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < texts.length; i += 200) {
    const r = await fetch("https://classifier.dev/v1/classify", {
      method: "POST",
      headers: { "content-type": "application/json", "X-Classifier-Share-Data": "false" },
      body: JSON.stringify({
        inputs: texts.slice(i, i + 200).map((t) => t.slice(0, 400)),
        labels: CATEGORIES,
        instructions: "Each text is a government contracting notice. Pick the single major kind of work or purchase it is for.",
      }),
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) throw new Error(`The sorting service answered ${r.status}`);
    const j: any = await r.json();
    for (const x of j.results || []) out.push(CATEGORIES.includes(x.label) ? x.label : "Other");
  }
  if (out.length !== texts.length) throw new Error("The sorting service returned an unexpected answer");
  return out;
}
