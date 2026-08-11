// Shared types (SSOT: all other modules import from here).
import type { Severity } from "../config";

// --- Azure DevOps intake ---

export interface PrRef {
  // Collection base URL, derived from the PR URL itself. Carries the scheme, host and any
  // on-prem virtual directory / collection path, so REST paths never have to be rebuilt
  // from a configured host.
  baseUrl: string;
  // Collection (or org) name. Display only — routing uses baseUrl.
  org: string;
  project: string;
  repoId: string;
  prId: number;
}

export interface PrInfo {
  title: string;
  description: string;
  sourceBranch: string;
  targetBranch: string;
  createdBy: string;
  status: string;
}

export interface Iteration {
  id: number;
  sourceRefCommit: string;
  targetRefCommit: string;
  commonRefCommit: string;
  createdDate: string;
}

export type ChangeType = "add" | "edit" | "delete" | "rename" | "other";

// One entry from .../iterations/{id}/changes. objectId/originalObjectId are the blob
// SHAs we fetch raw bytes by — never read files from a local checkout (CRLF/BOM drift).
export interface ChangeEntry {
  // Repo-relative path with leading slash, as ADO returns it.
  path: string;
  originalPath?: string;
  changeType: ChangeType;
  // Right side (source branch) blob SHA. Absent for deletes.
  objectId?: string;
  // Left side (target/base) blob SHA. Absent for adds.
  originalObjectId?: string;
  // Must be echoed back in pullRequestThreadContext for threads to track across iterations.
  changeTrackingId?: number;
  isFolder?: boolean;
}

// --- Local diff (we compute hunks ourselves; ADO only gives us blob SHAs) ---

export interface Hunk {
  // 1-based, inclusive. Right-side (new file) line span.
  rightStart: number;
  rightCount: number;
  // 1-based, inclusive. Left-side (old file) line span.
  leftStart: number;
  leftCount: number;
  // Rendered unified-diff body for this hunk (with +/-/space prefixes).
  body: string;
}

export interface FileDiff {
  // Canonical: no leading slash, forward separators. Both intakes guarantee it at
  // construction (libs/fileindex.ts normalizePath owns the rule); provider shapes are
  // translated at the provider edges (e.g. ADO threads re-add the slash on write).
  path: string;
  originalPath?: string;
  changeType: ChangeType;
  hunks: Hunk[];
  // Raw right-side content split into lines (index 0 = line 1). The anchoring SSOT.
  rightLines: string[];
  leftLines: string[];
  // Right-side line numbers that this PR added or modified. Findings should land here;
  // anything outside is likely the model drifting into untouched code.
  changedRightLines: Set<number>;
  binary: boolean;
  truncated: boolean;
  language: string;
}

// --- Requirement axis ---

export interface WorkItem {
  id: number;
  title: string;
  type: string;
  state: string;
  description: string;
  // Plain text, flattened from the field's HTML.
  acceptanceCriteria: string;
  url: string;
  parentId?: number;
}

// Verdicts name the *way* a requirement failed, not how much of it was done. "60% covered"
// tells a developer nothing; "you solved the wrong problem" tells them what to do.
export const REQ_VERDICTS = [
  "satisfied",
  "missing",
  "partial",
  "misunderstood",
  "not-verifiable",
] as const;
export type ReqVerdict = (typeof REQ_VERDICTS)[number];

export interface CriterionCheck {
  workItemId: number;
  criterion: string;
  verdict: ReqVerdict;
  note: string;
  // Evidence in the diff, same quote contract as code findings.
  quote?: string;
  file?: string;
}

// Scope creep: present in the diff, asked for by nothing.
export interface ExtraChange {
  claim: string;
  file: string;
  quote?: string;
}

export interface RequirementResult {
  workItems: WorkItem[];
  criteria: CriterionCheck[];
  extras: ExtraChange[];
  // Set when the axis could not run (no linked work item, no criteria, model failure).
  skipped?: string;
  error?: string;
}

// --- Findings (produced by finders, consumed by aggregate/publish) ---

// What the model is allowed to emit. Deliberately has NO line number field:
// line numbers are the pipeline's job (PROPOSAL §9.8).
export interface RawFinding {
  category: string;
  severity: Severity;
  confidence: number;
  file: string;
  quote: string;
  context_before?: string;
  context_after?: string;
  side?: "right" | "left";
  claim: string;
  evidence?: string;
  suggested_fix?: string;
  boundary_owner?: "current" | "external";
}

export type AnchorFailure =
  | "quote-not-found"
  | "quote-ambiguous"
  | "file-not-in-diff"
  // The cited path matched MORE than one changed file — distinct from not-in-diff, whose
  // label ("file not in this change") would be actively false here.
  | "file-ambiguous"
  | "outside-changed-lines";

export interface Anchor {
  side: "right" | "left";
  // 1-based, inclusive.
  startLine: number;
  endLine: number;
  // Character offset of the last line's end; ADO wants 1-based-ish offsets (see PROPOSAL §5.1).
  startOffset: number;
  endOffset: number;
}

// A finding after anchoring. Either it has an anchor (postable inline) or a reason why not
// (degraded into the summary comment) — never a guessed line number.
export interface AnchoredFinding extends RawFinding {
  // Which model produced it (M3: how many independently did).
  sources: string[];
  anchor?: Anchor;
  anchorFailure?: AnchorFailure;
  // Stable identity across pushes, for dedup against already-posted threads.
  fingerprint: string;
  changeTrackingId?: number;
  // Adversarial verification results (M3); undefined when the skeptic stage didn't run.
  skepticVerdicts?: number;
  skepticRefuted?: number;
  // Why this finding did not reach an inline comment, when it didn't.
  suppressedBy?: "severity" | "cap" | "no-corroboration" | "dismissed";
}

// --- Model runner (the interface that keeps the core free of SDK imports) ---

export interface ChatRequest {
  model: string;
  system: string;
  user: string;
  // JSON Schema; backends that support guided decoding enforce it at the engine layer.
  schema?: object;
  schemaName?: string;
  temperature?: number;
  maxTokens?: number;
  // Per-call timeout. Defaults to PRR_LLM_TIMEOUT_MS; the skeptic overrides it because
  // verifying one finding against 25 lines is nothing like reading a whole diff.
  timeoutMs?: number;
}

export interface ChatResponse {
  text: string;
  model: string;
  promptTokens?: number;
  completionTokens?: number;
  // Set when the call failed after retries; text is then empty.
  error?: string;
}

export interface ModelRunner {
  chat(req: ChatRequest): Promise<ChatResponse>;
}
