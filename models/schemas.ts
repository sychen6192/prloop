// JSON Schemas for model output. Backends with guided decoding (vLLM/xgrammar, Ollama
// format, LiteLLM json_schema pass-through) enforce these at the token level, so a weak
// open model spends its capability budget on judgement instead of on formatting.
//
// Note what is absent: no line numbers. Coordinates are the pipeline's job (PROPOSAL §9.8).
//
// Also absent, on purpose: value constraints (minimum/maximum, min/maxItems, min/maxLength,
// pattern). Every backend enforces a different JSON Schema subset — Bedrock's structured
// output rejected `minimum`/`maximum` on a number with an HTTP 400 that took a whole finder
// down — and none of those constraints were load-bearing: confidence is clamped and extras
// are capped in code. The schemas describe SHAPE (types, enums, required keys); ranges
// live in descriptions and in the validators.
import { FINDER_CATEGORIES, SEVERITIES } from "../libs/taxonomy";
import { parseJsonObject } from "../libs/json";
import { CLAIM_KINDS, REQ_VERDICTS, SKEPTIC_VERDICTS, type ChatRequest } from "../libs/types";

export const FINDINGS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["findings"],
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        // Strict-mode json_schema (OpenAI, and LiteLLM in front of it) requires `required`
        // to list EVERY key in properties; optionality is expressed as a nullable type.
        // A schema that violates this is a hard HTTP 400 from those backends.
        required: [
          "category", "severity", "confidence", "file", "quote", "context_before",
          "context_after", "side", "claim", "evidence", "suggested_fix", "cites",
          "claim_kind", "claim_subject",
        ],
        properties: {
          // The finder's eight, not the full taxonomy: req-mismatch is the requirement
          // axis's category and a code-axis finding must not be able to claim it.
          category: { type: "string", enum: [...FINDER_CATEGORIES] },
          severity: { type: "string", enum: [...SEVERITIES] },
          confidence: { type: "number", description: "0 to 1." },
          file: { type: "string" },
          quote: {
            type: "string",
            description: "The exact source line(s) this finding is about, copied verbatim.",
          },
          context_before: { type: ["string", "null"] },
          context_after: { type: ["string", "null"] },
          // Described, not just enumerated: a required enum with no description is a coin
          // flip under guided decoding, and a guessed "left" on an added file used to make
          // the quote unmatchable. Anchoring now retries the other side, but getting it
          // right here saves the retry.
          side: {
            type: "string",
            enum: ["right", "left"],
            description:
              "\"right\" (the new code) for almost every finding. Only \"left\" when the quote is a line this PR DELETED.",
          },
          claim: { type: "string" },
          evidence: { type: ["string", "null"] },
          // Nullable AND undescribed made this the cheapest field in the schema to skip, so
          // whether a finding carried a fix was luck. It is rendered as a code block, so
          // say that it must be code.
          suggested_fix: {
            type: ["string", "null"],
            description:
              "The corrected code, ready to paste in place of the quote. Code only, no prose. Null only when no concrete fix can be written.",
          },
          // No boundary_owner. It was required, undescribed, absent from the prompt and read
          // by nothing — a coin flip under guided decoding, paid for on every finding.
          cites: {
            type: ["string", "null"],
            description:
              "For maintainability findings: the named smell or project rule this invokes (e.g. \"Feature Envy\"). Null for findings that rest on concrete broken behavior.",
          },
          claim_kind: {
            type: ["string", "null"],
            enum: [...CLAIM_KINDS, null],
            description:
              "Only when the whole claim is one of these checkable facts: \"unused\" (a symbol is never used), \"undefined\" (a symbol is used but not defined or imported), \"missing-file\" (a referenced file does not exist), \"duplicate\" (a symbol is defined twice). Null otherwise.",
          },
          claim_subject: {
            type: ["string", "null"],
            description: "With claim_kind: the symbol's name, or the file's path. Null otherwise.",
          },
        },
      },
    },
  },
} as const;

// One verdict on one listed criterion: the item both requirement-shaped schemas share, so
// the work-item call and the OpenSpec call cannot drift apart in what a verdict carries.
function criterionVerdictItem<E extends string>(example: E) {
  return {
    type: "object",
    additionalProperties: false,
    // No free-form criterion text: the pipeline enumerated the criteria with stable
    // ids, and the verdict binds to an id. A model that could restate the criterion
    // could also invent one — and an invented criterion is always, correctly per the
    // diff, "missing" (the false-accusation generator this replaced).
    required: ["criterionId", "verdict", "note", "quote", "file"],
    properties: {
      criterionId: {
        type: "string",
        description: `The bracketed id of the criterion being judged, exactly as listed (e.g. "${example}"). Never invent an id.`,
      },
      verdict: { type: "string", enum: [...REQ_VERDICTS] },
      note: { type: "string" },
      quote: {
        type: ["string", "null"],
        description: "Exact source line(s) from the diff that evidence this verdict.",
      },
      file: { type: ["string", "null"] },
    },
  } as const;
}

// Requirement axis. Runs independently of the finder — it never sees code findings, and
// the finder never sees this, so neither can be used to excuse the other (PROPOSAL §6.1).
export const REQUIREMENT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["criteria", "extras"],
  properties: {
    criteria: {
      type: "array",
      items: criterionVerdictItem("4711-AC2"),
    },
    extras: {
      type: "array",
      description: "Changes in the diff that no criterion asked for (scope creep), most significant first.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["claim", "file", "quote"],
        properties: {
          claim: { type: "string" },
          file: { type: "string" },
          quote: { type: ["string", "null"] },
        },
      },
    },
  },
} as const;

// The PR's own OpenSpec requirements: verdicts only, no extras. Scope creep is the work items'
// question; asked against the author's own spec, the spec would decide what counts as scope.
export const OPENSPEC_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["criteria"],
  properties: {
    criteria: {
      type: "array",
      items: criterionVerdictItem("SPEC1-R2"),
    },
  },
} as const;

// Skeptic verdict. Deliberately small: a refutation that needs a long JSON object is
// usually a refutation the model is inventing.
export const VERDICT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "reason", "evidence_quote", "confidence", "suggested_severity"],
  properties: {
    // Three answers, not two. A boolean forced "I could not check this" to be reported as
    // "I found no grounds to refute it", and downstream counted that as the finding having
    // been cleared — precision that was never earned (PROPOSAL §5.2).
    verdict: {
      type: "string",
      enum: [...SKEPTIC_VERDICTS],
      description:
        "\"refuted\": you can state concretely why the finding is wrong AND quote the line that proves it. " +
        "\"insufficient-context\": the claim is about code you were not shown. " +
        "\"holds\": you checked what the claim is about and found no grounds to refute it.",
    },
    reason: { type: "string" },
    // The teeth behind "refuted only with concrete evidence": the gate checks this quote
    // against the snippet the skeptic was shown, and a refutation it cannot find there is
    // downgraded to insufficient-context. Prompt text alone enforced nothing.
    evidence_quote: {
      type: ["string", "null"],
      description:
        "Required for \"refuted\": the source line(s) from the snippet above, copied verbatim, that prove the accusation wrong. Null otherwise.",
    },
    confidence: { type: "number", description: "0 to 1." },
    suggested_severity: {
      type: ["string", "null"],
      enum: [...SEVERITIES, null],
      description: "Only when the finding holds but at a different severity; otherwise null.",
    },
  },
} as const;

// Requirement-dispute verdicts, batched. Same three-way vocabulary as the code skeptic —
// only "refuted" disputes an accusation, and it must carry a quote — but keyed by criterion
// id, because one call now answers every accusation in the run instead of one call per
// accusation each re-sending the whole diff. No suggested_severity: a requirement verdict
// has no severity to lower, so asking for one only invites the model to invent a field.
export const REQ_DISPUTE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdicts"],
  properties: {
    verdicts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["criterionId", "verdict", "reason", "evidence_quote"],
        properties: {
          criterionId: {
            type: "string",
            description: "The bracketed id of the accusation being challenged, exactly as listed (e.g. \"4711-AC2\"). Never invent an id.",
          },
          verdict: {
            type: "string",
            enum: [...SKEPTIC_VERDICTS],
            description:
              "\"refuted\": the diff does address this criterion, and you can quote the code that shows it. " +
              "\"holds\": you searched the diff and found no such code. " +
              "\"insufficient-context\": judging this criterion needs code the diff does not show.",
          },
          reason: { type: "string" },
          evidence_quote: {
            type: ["string", "null"],
            description:
              "Required for \"refuted\": the line(s) from the diff above, copied verbatim, that show the criterion was addressed. Null otherwise.",
          },
        },
      },
    },
  },
} as const;

// Triage of static-analysis findings. The model judges tool output in context; it never
// invents findings, so the schema is a verdict list keyed back to the input indexes.
export const TRIAGE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["results"],
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["index", "keep", "reason", "severity"],
        properties: {
          index: { type: "integer" },
          keep: { type: "boolean" },
          reason: { type: "string" },
          severity: { type: ["string", "null"], enum: [...SEVERITIES, null] },
        },
      },
    },
  },
} as const;

// Benchmark judge (scripts/bench.ts, prompts/judge.ts): which numbered candidates describe the
// reference comment's issue. Numbers, not quotes or text: the judge's only job is to point.
export const JUDGE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["same_issue", "reason"],
  properties: {
    same_issue: {
      type: "array",
      items: { type: "integer" },
      description: "The numbers of the candidates that identify the same issue as the reference; empty when none do.",
    },
    reason: { type: "string", description: "One sentence." },
  },
} as const;

interface SchemaNode {
  type?: unknown;
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode;
  additionalProperties?: unknown;
}

/**
 * The answer's top-level JSON shape as one sentence, for a request whose schema rides in
 * response_format. A gateway can accept that field without enforcing it: LiteLLM in front of
 * google/gemini-37-flash returned 200 and 1389 characters of parseable JSON with no findings
 * array, to a prompt that said only "Emit JSON per the schema" — a schema the model was never
 * shown — and the run exited 3. Built from the schema the parser reads, so it cannot drift from
 * it. It is not the schema (inlineSchema still carries that where nothing enforces one), and it
 * names keys, never enum values: doctor's enforcement probe depends on that. Undefined for a
 * schema with no properties.
 */
export function envelopeLine(schema: object): string | undefined {
  const s = schema as SchemaNode;
  const entries = Object.entries(s.properties ?? {});
  if (entries.length === 0) return undefined;
  const keys = entries.map(([k, p]) => {
    if (p.type !== "array") return `"${k}"`;
    const inner = Object.keys(p.items?.properties ?? {});
    return inner.length > 0
      ? `"${k}" (an array of objects, each with the keys ${inner.map((q) => `"${q}"`).join(", ")})`
      : `"${k}" (an array)`;
  });
  // A finder told "an empty findings array is correct only after…" answers a bare [] often
  // enough to name the empty case: the list still goes inside the object.
  const only = entries.length === 1 && entries[0]![1].type === "array" ? entries[0]![0] : undefined;
  const empty = only === undefined ? "" : ` Even an empty list goes inside that object: {"${only}": []}.`;
  return (
    `Answer with a single JSON object — not a bare array, and nothing before or after it — whose top-level keys are ` +
    `${s.additionalProperties === false ? "exactly" : "at least"}: ${keys.join(", ")}.${empty}`
  );
}

/** The user message for a request whose schema goes out as response_format. */
export function withEnvelope(req: ChatRequest): string {
  const line = req.schema ? envelopeLine(req.schema) : undefined;
  return line ? `${req.user}\n\n${line}` : req.user;
}

/**
 * A request only an enforcing endpoint answers right: its one allowed value is in the enum,
 * which travels in response_format alone (envelopeLine names keys, never values). doctor
 * --smoke asks it of each finder model.
 */
export const ENFORCEMENT_PROBE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["probe"],
  properties: { probe: { type: "string", enum: ["prloop-enforced-7f3a"] } },
} as const;

/** What an answer to the enforcement probe says about the endpoint. */
export function readEnforcementProbe(text: string): "enforced" | "ignored" | "unparseable" {
  const parsed = parseJsonObject<{ probe?: unknown }>(text);
  if (!parsed.ok) return "unparseable";
  const v = parsed.value as unknown;
  return typeof v === "object" && v !== null && !Array.isArray(v) && (v as { probe?: unknown }).probe === "prloop-enforced-7f3a"
    ? "enforced"
    : "ignored";
}

/**
 * The schema as prompt text, for paths that cannot enforce it at the token layer: the
 * opencode runner (no response_format pass-through) and the HTTP runner with
 * PRR_LLM_STRUCTURED=0. Without this, a prompt that ends "emit JSON per the schema" reaches
 * a model that was never shown one — seen live: Claude invented its own field names and
 * every finding was dropped as "incomplete fields".
 */
export function inlineSchema(req: ChatRequest): string {
  if (!req.schema) return req.user;
  return `${req.user}

## Output format (follow exactly)

Output one JSON object matching the JSON Schema below. No explanatory text, no markdown
code fence, nothing before or after the JSON.

\`\`\`json
${JSON.stringify(req.schema, null, 2)}
\`\`\``;
}
