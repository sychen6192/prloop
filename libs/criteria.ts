// Deterministic acceptance-criteria extraction. The requirement axis's dominant failure
// was letting the model both DEFINE the unit of judgment and judge it: the AC field went
// in as one flattened blob, the model chose how to split it into criteria, and the split
// changed every run — so "missing 3" vs "missing 1" on the same PR was a moving
// denominator, not a changed verdict, and an invented criterion was judged (correctly,
// per the diff) "missing". This module fixes the unit: criteria are split HERE, once,
// deterministically, and each gets a stable id the model must echo back. The same
// anchoring philosophy as code quotes — the pipeline owns coordinates, models own
// judgment — applied to the spec side.

export interface CriterionRef {
  // Stable across runs for the same work-item text: "<workItemId>-AC<n>".
  id: string;
  workItemId: number;
  // Verbatim from the work item (post html flattening). The SSOT the verdict binds to.
  text: string;
}

// A top-level list marker: -, *, •, "1." or "1)". Indented markers are sub-bullets and
// attach to the criterion above them (htmlToText keeps nested items indented).
const MARKER = /^([-*•]|\d+[.)])\s+/;

/**
 * Splits a flattened AC/description field into criterion units.
 *
 * List items are the units; continuation lines and indented sub-bullets attach to the
 * item above; framing prose before the first marker ("The following must hold:") is
 * dropped. A field with no list structure at all is ONE criterion — a fixed denominator
 * beats a clever guess at prose segmentation.
 */
export function splitCriteria(text: string): string[] {
  const lines = text.split("\n");
  const items: string[] = [];
  let cur: string[] | undefined;
  for (const raw of lines) {
    if (!raw.trim()) continue;
    const unindented = raw.replace(/^\s+/, "");
    const m = MARKER.exec(unindented);
    const isTopLevel = m !== null && !/^\s/.test(raw);
    if (isTopLevel) {
      if (cur) items.push(cur.join(" "));
      cur = [unindented.slice(m![0].length).trim()];
    } else if (cur) {
      // Continuation prose or an indented sub-bullet: part of the criterion above.
      cur.push(unindented.replace(MARKER, "").trim());
    }
    // Lines before the first marker are framing, not criteria.
  }
  if (cur) items.push(cur.join(" "));
  if (items.length > 0) return items;
  const whole = text.trim();
  return whole ? [whole] : [];
}

/**
 * Criteria for one work item, with stable ids. Falls back to the description when the AC
 * field is empty (same precedence the gate's withSpec filter uses).
 */
export function extractCriteria(w: {
  id: number;
  acceptanceCriteria: string;
  description: string;
}): CriterionRef[] {
  const source = w.acceptanceCriteria.trim() || w.description.trim();
  return splitCriteria(source).map((text, i) => ({
    id: `${w.id}-AC${i + 1}`,
    workItemId: w.id,
    text,
  }));
}
