// Azure Boards stores rich-text fields (AcceptanceCriteria, Description, ReproSteps) as
// HTML. Feeding raw HTML to a model wastes tokens and hurts weak models' comprehension,
// so we flatten it — preserving list structure, which is exactly how acceptance criteria
// are almost always written.
const ENTITIES: Record<string, string> = {
  "&nbsp;": " ",
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
};

/**
 * Flattens list markup, keeping the two things the criterion splitter reads: an ordered
 * list's numbering and a nested item's depth.
 *
 * Both used to be destroyed here. Every `<li>` became "- ", so "1. / 2. / 3." arrived as
 * three identical bullets and a sub-bullet arrived at the same level as its parent — and
 * libs/criteria.ts, which splits top-level markers into criteria and attaches INDENTED
 * ones to the item above, therefore read one criterion with three sub-points as four
 * criteria. The denominator the whole axis is built on changed with the shape of the
 * author's HTML.
 */
function flattenLists(html: string): string {
  const stack: Array<{ ordered: boolean; n: number }> = [];
  return html.replace(/<(\/?)(ul|ol|li)\b[^>]*>/gi, (_m, slash: string, tag: string) => {
    const t = tag.toLowerCase();
    if (t !== "li") {
      if (slash) stack.pop();
      else stack.push({ ordered: t === "ol", n: 0 });
      return "\n";
    }
    if (slash) return "";
    const top = stack[stack.length - 1];
    // Two spaces per level of nesting: libs/criteria.ts treats an indented marker as a
    // continuation of the criterion above it, which is what a sub-bullet is.
    const indent = "  ".repeat(Math.max(0, stack.length - 1));
    // A stray <li> outside any list still gets a marker rather than losing its text.
    return `\n${indent}${top?.ordered ? `${++top.n}.` : "-"} `;
  });
}

export function htmlToText(html: string | undefined | null): string {
  if (!html) return "";
  let s = html;

  s = s.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "");
  s = flattenLists(s);
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/(p|div|tr|h[1-6]|table)>/gi, "\n");
  s = s.replace(/<\/t[dh]>/gi, "\t");
  // An image is often the whole criterion ("the dialog must look like this"), and stripping
  // the tag left an empty line: the criterion silently vanished from the denominator, or —
  // worse — the surrounding sentence was judged as if the screenshot had said nothing.
  s = s.replace(/<img\b[^>]*>/gi, (tag) => {
    const alt = /\balt\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    const text = (alt?.[2] ?? alt?.[3] ?? alt?.[4] ?? "").trim();
    return text ? `[image: ${text}]` : "[image]";
  });
  s = s.replace(/<[^>]+>/g, "");

  s = s.replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)));
  s = s.replace(/&#x([0-9a-f]+);/gi, (_m, h: string) => String.fromCodePoint(parseInt(h, 16)));
  for (const [ent, ch] of Object.entries(ENTITIES)) s = s.split(ent).join(ch);

  return s
    .split("\n")
    // Leading spaces survive, everything else collapses: the indent IS the nesting, and
    // trimming both ends (as this did) flattened every sub-bullet back to top level.
    .map((l) => {
      const indent = /^ +/.exec(l)?.[0] ?? "";
      const body = l.replace(/[ \t]+/g, " ").trim();
      return body ? indent + body : "";
    })
    .filter((l, i, arr) => l !== "" || (i > 0 && arr[i - 1] !== ""))
    .join("\n")
    .trim();
}
