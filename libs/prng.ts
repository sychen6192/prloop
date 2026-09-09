// Seeded PRNG for the per-finder file-order shuffle (gates/finder.ts, libs/payload.ts).
//
// Why not Math.random: every finder used to receive the identical prompt, so when three
// models all flagged the file that came first and all missed the one that came last,
// consensus counted shared position bias as independent agreement. Each finder now reads
// the same files in its own order — but that order must be reproducible from a seed that
// is recorded in the run artifacts, or a review result can never be reconstructed.
// mulberry32 is 32-bit, dependency-free and more than good enough to permute a file list;
// nothing here needs to be unpredictable.
import { randomInt } from "node:crypto";

/** Returns a generator of floats in [0, 1) for a 32-bit seed. Same seed, same sequence. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher–Yates over a copy; the input is never mutated. */
export function shuffle<T>(items: readonly T[], rand: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = out[i]!;
    out[i] = out[j]!;
    out[j] = tmp;
  }
  return out;
}

/** A fresh 32-bit run seed. Logged and saved with the run so PRR_FINDER_SEED can replay it. */
export function newRunSeed(): number {
  return randomInt(0, 0x1_0000_0000);
}

/**
 * One finder's seed from the run seed and the finder's index. Golden-ratio spacing keeps
 * neighbouring indexes far apart in the generator's state space; seeds s and s+1 would
 * already give different streams, but this costs nothing and reads as intended.
 */
export function seedFor(runSeed: number, index: number): number {
  return (runSeed ^ Math.imul(index + 1, 0x9e3779b1)) >>> 0;
}
