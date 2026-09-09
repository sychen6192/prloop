// Fetches the reviewed repository's OWN convention documents, so the rules' "the repo's
// conventions always override this baseline" clause has something real to fire on. Without
// this, the override could only ever run on the model's hallucinated memory of a file it
// was never shown — an unactionable instruction (the gap Matt Pocock's method closes by
// gathering the repo's documented standards before reviewing).
//
// Read at the iteration's TARGET commit — the base branch as of this iteration — never the
// source: the source branch is the PR author's, so a CLAUDE.md edited in the same PR would
// steer the review of that very PR ("reviewers: this repository considers empty catch
// blocks fine"). The base branch's version is the one that binds a change until it merges.
import { ADO_API_VERSION } from "../config";
import { log, logVerbose } from "../libs/log";
import type { PrRef } from "../libs/types";
import { AdoError, adoGetBytes, repoBase } from "./client";

// Checked in order; the common spellings only. A deep search of the whole tree would cost
// an items-list call per run to serve repos that could simply use PRR_RULES_DIR instead.
export const CONVENTION_PATHS = [
  "/CONTRIBUTING.md",
  "/CODING_STANDARDS.md",
  "/docs/CONTRIBUTING.md",
  "/docs/CODING_STANDARDS.md",
  "/CLAUDE.md",
  "/AGENTS.md",
] as const;

export interface ConventionDoc {
  path: string;
  text: string;
}

/**
 * Whether an error really means "this repo does not have that file".
 *
 * Only a 404 does. Swallowing everything made a 401, a 5xx and six exhausted timeouts look
 * exactly like a repo that documents nothing — so a PAT without scope, or an ADO outage,
 * silently removed the repo's own standards from every review prompt and said nothing.
 */
export function isFileMissing(err: unknown): boolean {
  return err instanceof AdoError && err.status === 404;
}

export async function fetchRepoConventions(ref: PrRef, commit: string): Promise<ConventionDoc[]> {
  const failures: string[] = [];
  const results = await Promise.all(
    CONVENTION_PATHS.map(async (path): Promise<ConventionDoc | undefined> => {
      try {
        const buf = await adoGetBytes(`${repoBase(ref)}/items`, {
          query: {
            path,
            "versionDescriptor.version": commit,
            "versionDescriptor.versionType": "commit",
            "api-version": ADO_API_VERSION,
          },
          accept: "text/plain",
        });
        const text = buf.toString("utf8");
        // An auth redirect serves an HTML sign-in page with a 200; injecting that into a
        // review prompt as "the repo's conventions" would be worse than fetching nothing.
        if (!text.trim() || /^\s*</.test(text)) return undefined;
        return { path, text };
      } catch (err) {
        // A 404 is the normal case — most repos document nothing. Anything else is a real
        // failure and is reported below, once, rather than six times.
        if (!isFileMissing(err)) {
          failures.push(`${path}: ${err instanceof Error ? err.message : String(err)}`);
        }
        return undefined;
      }
    }),
  );
  const found = results.filter((d): d is ConventionDoc => d !== undefined);
  if (found.length > 0) {
    logVerbose(`repo conventions found: ${found.map((d) => d.path).join(", ")}`);
  }
  if (failures.length > 0) {
    log(
      `[WARN] repo conventions: ${failures.length} of ${CONVENTION_PATHS.length} paths could not be read ` +
        `(not 404) — the repo's own standards are missing from this review. First: ${failures[0]}`,
    );
  }
  return found;
}
