// Work items linked to the PR — the source of the requirement axis.
//
// Two things bite here:
//   1. GitPullRequest.workItemRefs is NOT populated by the plain Get Pull Request call.
//      You must hit the dedicated /workitems endpoint (azure-devops-node-api #502).
//   2. PRs are usually linked to a Task, but acceptance criteria live on its parent
//      PBI/User Story. So when a linked item has no criteria we walk up one level.
import { adoGet, orgBase, prBase, type AdoList } from "./client";
import { htmlToText } from "../libs/html";
import { logVerbose } from "../libs/log";
import type { PrRef, WorkItem } from "../libs/types";

const F_TITLE = "System.Title";
const F_TYPE = "System.WorkItemType";
const F_STATE = "System.State";
const F_DESC = "System.Description";
const F_AC = "Microsoft.VSTS.Common.AcceptanceCriteria";
const F_REPRO = "Microsoft.VSTS.TCM.ReproSteps";

interface RawWorkItem {
  id?: number;
  fields?: Record<string, unknown>;
  relations?: Array<{ rel?: string; url?: string }>;
  _links?: { html?: { href?: string } };
}

function fieldText(fields: Record<string, unknown> | undefined, key: string): string {
  const v = fields?.[key];
  return typeof v === "string" ? v : "";
}

function toWorkItem(raw: RawWorkItem): WorkItem {
  const f = raw.fields;
  const type = fieldText(f, F_TYPE);
  // Bugs carry their spec in ReproSteps rather than AcceptanceCriteria. Which field it came
  // from is carried forward, not just the text: reproduction steps describe the DEFECT, and
  // asking "is this step implemented?" of a fix diff answers "missing" every time — the
  // prompt asks whether the diff plausibly fixes the behavior instead (WorkItem.specSource).
  const ac = htmlToText(fieldText(f, F_AC));
  const repro = htmlToText(fieldText(f, F_REPRO));
  return {
    id: raw.id ?? 0,
    title: fieldText(f, F_TITLE),
    type,
    state: fieldText(f, F_STATE),
    description: htmlToText(fieldText(f, F_DESC)),
    acceptanceCriteria: ac || repro,
    specSource: ac ? "acceptance-criteria" : repro ? "repro-steps" : "description",
    url: raw._links?.html?.href ?? "",
    parentId: parentIdFrom(raw),
  };
}

function parentIdFrom(raw: RawWorkItem): number | undefined {
  const rel = raw.relations?.find((r) => r.rel === "System.LinkTypes.Hierarchy-Reverse");
  if (!rel?.url) return undefined;
  const m = /\/workItems\/(\d+)\s*$/i.exec(rel.url);
  return m?.[1] ? Number(m[1]) : undefined;
}

async function fetchWorkItems(ref: PrRef, ids: number[]): Promise<WorkItem[]> {
  if (ids.length === 0) return [];
  const res = await adoGet<AdoList<RawWorkItem>>(
    `${orgBase(ref)}/${encodeURIComponent(ref.project)}/_apis/wit/workitems`,
    { query: { ids: ids.join(","), $expand: "relations" } },
  );
  return (res.value ?? []).map(toWorkItem);
}

export interface LinkedRequirements {
  items: WorkItem[];
  // Parents pulled in because the directly-linked item had no criteria of its own.
  inheritedFrom: number[];
}

export async function getLinkedRequirements(ref: PrRef): Promise<LinkedRequirements> {
  const refs = await adoGet<AdoList<{ id?: string | number }>>(`${prBase(ref)}/workitems`);
  const ids = (refs.value ?? [])
    .map((r) => Number(r.id))
    .filter((n) => Number.isInteger(n) && n > 0);

  if (ids.length === 0) return { items: [], inheritedFrom: [] };
  logVerbose(`Work items linked to the PR: ${ids.join(", ")}`);

  const items = await fetchWorkItems(ref, ids);
  const inheritedFrom: number[] = [];

  // Walk up one level for items with no criteria — the common Task→PBI shape.
  const needParent = items.filter((w) => !w.acceptanceCriteria && w.parentId);
  const parentIds = [...new Set(needParent.map((w) => w.parentId!))].filter(
    (pid) => !ids.includes(pid),
  );
  if (parentIds.length > 0) {
    const parents = await fetchWorkItems(ref, parentIds);
    for (const p of parents) {
      if (p.acceptanceCriteria) {
        items.push(p);
        inheritedFrom.push(p.id);
        logVerbose(`work item #${p.id} (${p.type}) supplies the acceptance criteria`);
      }
    }
  }

  return { items, inheritedFrom };
}
