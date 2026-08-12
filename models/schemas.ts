// JSON Schemas for model output. Backends with guided decoding (vLLM/xgrammar, Ollama
// format, LiteLLM json_schema pass-through) enforce these at the token level, so a weak
// open model spends its capability budget on judgement instead of on formatting.
//
// Note what is absent: no line numbers. Coordinates are the pipeline's job (PROPOSAL §9.8).
import { FINDING_CATEGORIES, SEVERITIES } from "../config";
import { REQ_VERDICTS } from "../libs/types";

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
          "context_after", "side", "claim", "evidence", "suggested_fix", "boundary_owner",
          "cites",
        ],
        properties: {
          category: { type: "string", enum: [...FINDING_CATEGORIES] },
          severity: { type: "string", enum: [...SEVERITIES] },
          confidence: { type: "number", minimum: 0, maximum: 1 },
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
          boundary_owner: { type: "string", enum: ["current", "external"] },
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
        required: ["workItemId", "criterion", "verdict", "note", "quote", "file"],
        properties: {
          workItemId: { type: "number" },
          criterion: {
            type: "string",
            description: "The acceptance criterion being judged, copied verbatim.",
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
      description: "Changes in the diff that no criterion asked for (scope creep).",
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
  required: ["refuted", "reason", "confidence", "suggested_severity"],
  properties: {
    refuted: {
      type: "boolean",
      description: "true only when you can state concretely why the finding is wrong.",
    },
    reason: { type: "string" },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    suggested_severity: {
      type: ["string", "null"],
      enum: [...SEVERITIES, null],
      description: "Only when the finding holds but at a different severity; otherwise null.",
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
          index: { type: "number" },
          keep: { type: "boolean" },
          reason: { type: "string" },
          severity: { type: ["string", "null"], enum: [...SEVERITIES, null] },
        },
      },
    },
  },
} as const;
