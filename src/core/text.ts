/** Text helpers shared by collectors and compactors. */

export function truncate(s: string, max: number): string {
  const t = s.trim();
  if (t.length <= max) return t;
  return t.slice(0, Math.max(0, max - 1)).trimEnd() + "…";
}

export function firstParagraph(s: string, max = 300): string {
  const cleaned = stripMarkdownNoise(s);
  const para = cleaned.split(/\n\s*\n/).find((p) => p.trim().length > 0) ?? cleaned;
  return truncate(para.replace(/\s+/g, " "), max);
}

export function oneLine(s: string, max = 200): string {
  return truncate(stripMarkdownNoise(s).replace(/\s+/g, " "), max);
}

/** Remove code fences, mermaid blocks, html comments & excessive markup for compact summaries. */
export function stripMarkdownNoise(s: string): string {
  return s
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\((?:file:\/\/)?[^)]*\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/^#+\s*/gm, "")
    .trim();
}

export function tailLines(s: string, n: number): string {
  const lines = s.split("\n");
  return lines.slice(Math.max(0, lines.length - n)).join("\n");
}

/** Split text into sentences (CJK + latin aware). */
export function sentences(s: string): string[] {
  return stripMarkdownNoise(s)
    .split("\n")
    .filter((l) => !/^\s*\|/.test(l)) // markdown table rows
    .join("\n")
    .split(/(?<=[。！？!?；;])\s*|\n+|(?<=\.)\s+(?=[A-Z])/)
    .map((x) => x.replace(/^[-*>\d.)\s]+/, "").trim())
    .filter((x) => x.length >= 6);
}

/** Token set for fuzzy de-dup (bigrams for CJK, words for latin). */
function tokens(s: string): Set<string> {
  const t = s.toLowerCase().replace(/[`'"*_()[\]{}<>]/g, " ");
  const set = new Set<string>();
  for (const w of t.split(/[^\p{L}\p{N}]+/u)) {
    if (!w) continue;
    if (/[\u4e00-\u9fff]/.test(w)) {
      for (let i = 0; i < w.length - 1; i++) set.add(w.slice(i, i + 2));
      if (w.length === 1) set.add(w);
    } else set.add(w);
  }
  return set;
}

export function similarity(a: string, b: string): number {
  const A = tokens(a);
  const B = tokens(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

/** De-duplicate items by fuzzy text similarity, keeping the first occurrence. */
export function dedupeBy<T>(items: T[], key: (t: T) => string, threshold = 0.6): T[] {
  const out: T[] = [];
  for (const it of items) {
    const k = key(it);
    if (!out.some((o) => similarity(key(o), k) >= threshold)) out.push(it);
  }
  return out;
}

export function hashString(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export function fmtTime(d: Date = new Date()): string {
  return d.toTimeString().slice(0, 8);
}

export function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
