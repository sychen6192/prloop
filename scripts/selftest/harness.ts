// The assertion helpers every selftest net shares. Each net used to carry its own copy of
// these twenty lines — eight copies, and a change to one of them reached none of the others.
let passed = 0;
let failed = 0;
let skipped = 0;

export function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    passed++;
    console.log(`  [OK]   ${name}`);
  } else {
    failed++;
    console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/**
 * An assertion this environment cannot settle — a missing tool, a sandbox that refuses
 * process-group signals. Counted apart from both columns on purpose: reporting an
 * environment restriction as a failure trains everyone to read a red suite as normal, and
 * a suite that is always red proves nothing when it goes red for a real reason.
 * The condition is always probed, never assumed, and the reason is printed.
 */
export function skip(name: string, reason: string) {
  skipped++;
  console.log(`  [SKIP] ${name} — ${reason}`);
}

export function eq<T>(name: string, actual: T, expected: T) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  check(name, a === e, `expected ${e}, got ${a}`);
}

export function section(t: string) {
  console.log(`\n${t}`);
}

/** A review logs its way through; keep that out of the assertion stream, but keep it. */
export async function capture<T>(fn: () => Promise<T>): Promise<{ value: T; lines: string[] }> {
  const lines: string[] = [];
  const real = console.log;
  console.log = (...a: unknown[]) => {
    lines.push(a.map(String).join(" "));
  };
  try {
    return { value: await fn(), lines };
  } finally {
    console.log = real;
  }
}

/** The last line of every net, and its exit status: 1 when anything failed. */
export function report(): never {
  console.log(`\nResult: ${passed} passed, ${failed} failed${skipped > 0 ? `, ${skipped} skipped` : ""}`);
  process.exit(failed > 0 ? 1 : 0);
}
