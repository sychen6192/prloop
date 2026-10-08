// Offline self-test: the pipeline's pure halves, one module per area under scripts/selftest/.
// Anchoring is the piece that decides whether comments land on the right line, so it gets
// the most coverage — those assertions are the regression net for the class of bug that
// motivated the whole project.
//
//   npx tsx scripts/selftest.ts                   # every area, in order
//   npx tsx scripts/selftest.ts anchoring finder  # just these
//
// One file of 6,000 lines and 1,450 assertions had no way to run a subset: checking an
// anchoring change meant waiting on the opencode and worktree sections too.
import { report } from "./selftest/harness";

// In order, and one at a time: a module's top-level awaits finish before the next starts,
// so no two areas interleave their output or their process.env.
const AREAS = {
  anchoring: () => import("./selftest/anchoring"),
  finder: () => import("./selftest/finder"),
  skeptic: () => import("./selftest/skeptic"),
  aggregate: () => import("./selftest/aggregate"),
  requirement: () => import("./selftest/requirement"),
  openspec: () => import("./selftest/openspec"),
  static: () => import("./selftest/static"),
  rules: () => import("./selftest/rules"),
  publish: () => import("./selftest/publish"),
  models: () => import("./selftest/models"),
  security: () => import("./selftest/security"),
  config: () => import("./selftest/config"),
  measure: () => import("./selftest/measure"),
} as const;

const wanted = process.argv.slice(2);
const unknown = wanted.filter((a) => !(a in AREAS));
if (unknown.length > 0) {
  console.error(`No such area: ${unknown.join(", ")}. The areas: ${Object.keys(AREAS).join(", ")}`);
  process.exit(1);
}
for (const [name, load] of Object.entries(AREAS)) {
  if (wanted.length === 0 || wanted.includes(name)) await load();
}
report();
