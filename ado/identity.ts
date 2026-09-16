// Who prloop is, as far as Azure DevOps is concerned.
//
// The hidden-marker protocol (publish/markers.ts) decides "this thread is ours" from a
// string in the comment body, and nothing ever checked who wrote it — `ado/threads.ts` has
// parsed `author` since it was written and no reader touched it. Anyone who can comment on
// a PR, the author included, could therefore forge prloop's own state: a comment carrying
// `<!-- prloop --><!-- prloop:summary --><!-- prloop:iteration=9999 -->` makes `--since auto`
// resume from 9999 and review an empty diff, and a forged wontFix thread with a copied `fp=`
// lands in dismissals.jsonl and suppresses that finding on every future PR in the repo.
//
// connectionData is the cheapest way to ask. It is a collection-level GET that needs no
// extra scope beyond the one prloop already uses, and it answers for whichever credential
// is in play — a PAT, a pipeline's $(System.AccessToken), or an `az login` token — without
// prloop having to know which.
import { adoGet } from "./client";
import { BOT_IDENTITY_IDS } from "../config";
import { log, logVerbose } from "../libs/log";
import type { PrRef } from "../libs/types";

interface ConnectionData {
  authenticatedUser?: { id?: string };
}

let cached: Promise<string | undefined> | undefined;

/** Forgets the cached answer. For the selftest; a real run asks once and keeps it. */
export function resetIdentityCache(): void {
  cached = undefined;
}

/**
 * The identity id prloop's own credential writes comments as, or undefined when this
 * deployment cannot say.
 *
 * Undefined is a real answer, not an error: some on-prem Server versions do not serve
 * connectionData, and prloop must keep reviewing there. Every caller degrades to the old
 * marker-only behaviour in that case — but says so once, because a silent downgrade of an
 * authorization check is exactly the kind of thing that should never be quiet.
 *
 * Asked once per run. A failure is cached like a success: retrying a missing endpoint on
 * every thread read would cost one round trip per call for the same answer.
 */
export function selfIdentityId(ref: PrRef): Promise<string | undefined> {
  cached ??= (async () => {
    try {
      const data = await adoGet<ConnectionData>(`${ref.baseUrl}/_apis/connectionData`);
      const id = data.authenticatedUser?.id?.trim();
      if (!id) {
        log(
          "[WARN] Azure DevOps did not say which identity prloop authenticates as, so a comment " +
            "carrying prloop's markers is trusted on the markers alone. A PR participant can forge " +
            "them; see SECURITY.md.",
        );
        return undefined;
      }
      logVerbose(`prloop posts as identity ${id}`);
      return id.toLowerCase();
    } catch (e) {
      log(
        `[WARN] could not read prloop's own identity (${e instanceof Error ? e.message : String(e)}); ` +
          "comments carrying prloop's markers are trusted on the markers alone. See SECURITY.md.",
      );
      return undefined;
    }
  })();
  return cached;
}

/**
 * Whether `authorId` is prloop.
 *
 * `extra` exists for the one case the identity check would otherwise break: prloop's
 * credential legitimately changes. The documented path onto a pipeline is to trial it from
 * a laptop PAT and then move to the build service account, and the threads the laptop left
 * are genuinely prloop's even though a different identity wrote them. Without a way to say
 * so, the first pipeline run would re-review every PR from scratch and stop harvesting the
 * dismissals recorded against those threads.
 *
 * With no self identity to compare against, everything with a marker counts — the degraded
 * mode selfIdentityId() warns about.
 */
export function isSelfIdentity(
  authorId: string | undefined,
  selfId: string | undefined,
  extra: readonly string[] = BOT_IDENTITY_IDS,
): boolean {
  if (selfId === undefined) return true;
  const id = authorId?.trim().toLowerCase();
  if (!id) return false;
  return id === selfId || extra.includes(id);
}
