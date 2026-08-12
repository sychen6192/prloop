// Fetches the reviewed repository's OWN convention documents, so the rules' "the repo's
// conventions always override this baseline" clause has something real to fire on. Without
// this, the override could only ever run on the model's hallucinated memory of a file it
// was never shown — an unactionable instruction (the gap Matt Pocock's method closes by
// gathering the repo's documented standards before reviewing).
//
// Read at the iteration's source commit, like everything else: the PR may itself be
// changing the conventions, and the version under review is the one that binds it.
import { ADO_API_VERSION } from "../config";
import { logVerbose } from "../libs/log";
import type { PrRef } from "../libs/types";
import { adoGetBytes, repoBase } from "./client";

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

export async function fetchRepoConventions(ref: PrRef, commit: string): Promise<ConventionDoc[]> {
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
      } catch {
        // Missing file. The 404 is the normal case — most repos document nothing.
        return undefined;
      }
    }),
  );
  const found = results.filter((d): d is ConventionDoc => d !== undefined);
  if (found.length > 0) {
    logVerbose(`repo conventions found: ${found.map((d) => d.path).join(", ")}`);
  }
  return found;
}
