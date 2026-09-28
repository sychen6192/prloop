// replay: re-run everything after the models over a saved run, under the current code and
// settings, and say what changed.
//
//   PRR_SAVE_REPLAY=1 prloop <PR URL>                         # a run that saves replay.json
//   PRR_MIN_INLINE_SEVERITY=high npx tsx scripts/replay.ts runs/<…>/iter-3-…
//
// No network, no model, no credentials: anchoring, dedupe, the skeptic's saved verdicts, the
// corroboration and severity gates and the cap all run as they would, against the saved
// answers. Settings are read the usual way, so a threshold is tried by setting it here.
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { replay, type ReplayBundle } from "../libs/replay";

interface Summary {
  inline: string[];
  belowBar: string[];
  degraded: number;
}

const describe = (f: { severity: string; file: string; anchor?: { startLine: number }; claim: string }) =>
  `${f.severity.padEnd(8)} ${f.file}:${f.anchor?.startLine ?? "?"}  ${f.claim.replace(/\s+/g, " ").slice(0, 100)}`;

/** Reads the run's own findings.json, for the comparison. Missing or unreadable: nothing to compare. */
function readOriginal(dir: string): { inline: Set<string>; belowBar: Set<string> } | undefined {
  try {
    const o = JSON.parse(fs.readFileSync(path.join(dir, "findings.json"), "utf8")) as Record<string, Array<{ fingerprint?: string }>>;
    const fps = (l: unknown) => new Set((Array.isArray(l) ? l : []).map((f) => String((f as { fingerprint?: string }).fingerprint ?? "")));
    return { inline: fps(o["inline"]), belowBar: fps(o["belowBar"]) };
  } catch {
    return undefined;
  }
}

function main(): void {
  const dir = process.argv.slice(2).find((a) => !a.startsWith("-"));
  if (!dir) {
    console.error("usage: npx tsx scripts/replay.ts <run directory>   (one written with PRR_SAVE_REPLAY=1)");
    process.exit(1);
  }
  const file = path.join(dir, "replay.json");
  if (!fs.existsSync(file)) {
    console.error(`No replay.json in ${dir}. Runs save one only with PRR_SAVE_REPLAY=1.`);
    process.exit(1);
  }
  const bundle = JSON.parse(fs.readFileSync(file, "utf8")) as ReplayBundle;
  const { agg, unverified } = replay(bundle);
  const before = readOriginal(dir);

  console.log(`replay of ${dir}\n`);
  console.log(
    `raw ${agg.stats.raw} → deduped ${agg.stats.afterDedupe} → anchored ${agg.stats.anchored} → ` +
      `survived ${agg.stats.survived} → inline ${agg.inline.length} (below the bar ${agg.belowBar.length}, unanchored ${agg.degraded.length})`,
  );
  if (unverified > 0) {
    console.log(`${unverified} candidate(s) no saved verdict covers — dedupe drew a line the run did not, so they replay unverified`);
  }
  console.log("\nInline:");
  for (const f of agg.inline) {
    const mark = before ? (before.inline.has(f.fingerprint) ? "  " : "+ ") : "  ";
    console.log(`${mark}${describe(f)}`);
  }
  if (before) {
    const now = new Set(agg.inline.map((f) => f.fingerprint));
    const dropped = [...before.inline].filter((fp) => fp && !now.has(fp));
    if (dropped.length > 0) console.log(`\n- ${dropped.length} finding(s) inline in the run are not inline now: ${dropped.join(", ")}`);
    console.log("\n(+ = inline now, not in the run)");
  }
  const summary: Summary = {
    inline: agg.inline.map((f) => f.fingerprint),
    belowBar: agg.belowBar.map((f) => f.fingerprint),
    degraded: agg.degraded.length,
  };
  if (process.argv.includes("--json")) console.log(JSON.stringify(summary));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
