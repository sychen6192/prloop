// Blob fetching. This module is the reason anchors are trustworthy: we read the exact
// bytes ADO stores for the iteration, so line counting matches what the PR UI shows.
// Reading from a local checkout instead would apply core.autocrlf and silently shift
// every line number after the first CRLF difference.
import { AdoTooLargeError, adoGetBytes, repoBase } from "./client";
import { MAX_FILE_BYTES } from "../config";
import { splitLines } from "../libs/text";
import type { PrRef } from "../libs/types";

export interface BlobContent {
  lines: string[];
  binary: boolean;
  truncated: boolean;
  bytes: number;
}

const EMPTY: BlobContent = { lines: [], binary: false, truncated: false, bytes: 0 };

// A NUL byte in the first 8000 bytes is git's own binary heuristic; good enough here.
function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

export async function getBlob(ref: PrRef, objectId: string | undefined): Promise<BlobContent> {
  if (!objectId) return EMPTY;
  let buf: Buffer;
  try {
    buf = await adoGetBytes(`${repoBase(ref)}/blobs/${objectId}`, {
      query: { $format: "octetStream" },
      accept: "application/octet-stream",
      // The limit is enforced at the transport now. It used to be checked only after the
      // whole blob had been buffered, so an oversized reviewable file (a .sql dump, a
      // generated bundle) was downloaded twice — once per side of the diff — to be skipped.
      maxBytes: MAX_FILE_BYTES,
    });
  } catch (e) {
    // Same outcome as the old post-hoc check, so orchestrator's coverage accounting still
    // sees a "too large" skip. `bytes` is the declared length when the server sent one, and
    // otherwise how far the read got before it was cut off.
    if (e instanceof AdoTooLargeError) {
      return { lines: [], binary: false, truncated: true, bytes: e.bytes };
    }
    throw e;
  }
  if (looksBinary(buf)) {
    return { lines: [], binary: true, truncated: false, bytes: buf.length };
  }
  if (buf.length > MAX_FILE_BYTES) {
    return { lines: [], binary: false, truncated: true, bytes: buf.length };
  }
  return { lines: splitLines(buf), binary: false, truncated: false, bytes: buf.length };
}
