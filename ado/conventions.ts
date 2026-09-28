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
import { CONVENTION_PATHS, gatherConventions, type ConventionDoc, type ConventionReader } from "../libs/conventions";
import { log } from "../libs/log";
import type { PrRef } from "../libs/types";
import { AdoError, adoGet, adoGetBytes, repoBase } from "./client";

// Which files, and how each is scoped, is libs/conventions.ts: shared with the local reader.
export { CONVENTION_PATHS, type ConventionDoc };

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

// An auth redirect serves an HTML sign-in page with a 200; injecting that into a review prompt
// as "the repo's conventions" would be worse than fetching nothing. The page, not any file
// that starts with `<`: a markdown file opening with `<!-- markdownlint-disable -->` is text.
const SIGN_IN_PAGE = /^\s*<(?:!doctype\s+html|html[\s>])/i;

function adoReader(ref: PrRef, commit: string): ConventionReader {
  const version = {
    "versionDescriptor.version": commit,
    "versionDescriptor.versionType": "commit",
    "api-version": ADO_API_VERSION,
  };
  return {
    async read(path) {
      try {
        const buf = await adoGetBytes(`${repoBase(ref)}/items`, { query: { path, ...version }, accept: "text/plain" });
        const text = buf.toString("utf8");
        return SIGN_IN_PAGE.test(text) ? undefined : text;
      } catch (err) {
        // A 404 is the normal case — most repos document nothing.
        if (isFileMissing(err)) return undefined;
        throw err;
      }
    },
    async list(dir, deep) {
      try {
        const res = await adoGet<{ value?: Array<{ path?: string; isFolder?: boolean; gitObjectType?: string }> }>(
          `${repoBase(ref)}/items`,
          { query: { scopePath: dir, recursionLevel: deep ? "Full" : "OneLevel", ...version } },
        );
        return (res.value ?? [])
          .filter((i) => typeof i.path === "string" && !i.isFolder && i.gitObjectType !== "tree")
          .map((i) => i.path!);
      } catch (err) {
        if (isFileMissing(err)) return [];
        throw err;
      }
    },
  };
}

/**
 * The instruction documents that apply to a change touching `changedPaths`, read at `commit`
 * (the iteration's target — see the top of this file).
 */
export async function fetchRepoConventions(ref: PrRef, commit: string, changedPaths: readonly string[] = []): Promise<ConventionDoc[]> {
  const { docs, failures, tried } = await gatherConventions(adoReader(ref, commit), changedPaths);
  // Reported once, rather than once per path: six failing paths are one problem.
  if (failures.length > 0) {
    log(
      `[WARN] repo conventions: ${failures.length} of ${tried} paths could not be read ` +
        `(not 404) — the repo's own standards are missing from this review. First: ${failures[0]}`,
    );
  }
  return docs;
}
