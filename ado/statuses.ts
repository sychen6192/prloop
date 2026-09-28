// PR status checks. A status bound to a branch policy is the clean way for a bot to gate a
// merge — casting a -10 vote fights with reviewer policies and reads as hostile.
import { adoPost, prBase } from "./client";
import { STATUS_GENRE, STATUS_NAME } from "../config";
import type { StatusState } from "../libs/host";
import type { PrRef } from "../libs/types";

export async function postStatus(
  ref: PrRef,
  state: StatusState,
  description: string,
  opts: { iterationId?: number; targetUrl?: string } = {},
): Promise<void> {
  await adoPost(`${prBase(ref)}/statuses`, {
    state,
    // ADO truncates hard at 400 chars.
    description: description.slice(0, 400),
    context: { name: STATUS_NAME, genre: STATUS_GENRE },
    ...(opts.targetUrl ? { targetUrl: opts.targetUrl } : {}),
    ...(opts.iterationId !== undefined ? { iterationId: opts.iterationId } : {}),
  });
}
