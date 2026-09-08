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
import { FINDER_CATEGORIES, SEVERITIES } from "../config";
import { REQ_VERDICTS, SKEPTIC_VERDICTS, type ChatRequest } from "../libs/types";

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
        },
      },
    },
  },
} as const;

// Requirement axis. Runs independently of the finder — it never sees code findings, and
// the finder never sees this, so neither can be used to excuse the other (PROPOSAL §6.1).
export const REQUIREMENT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["criteria", "extras"],
  properties: {
    criteria: {
      type: "array",
      items: {
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
            description: "The bracketed id of the criterion being judged, exactly as listed (e.g. \"4711-AC2\"). Never invent an id.",
          },
          verdict: { type: "string", enum: [...REQ_VERDICTS] },
          note: { type: "string" },
          quote: {
            type: ["string", "null"],
            description: "Exact source line(s) from the diff that evidence this verdict.",
          },
          file: { type: ["string", "null"] },
        },
      },
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
