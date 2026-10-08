// doctor --smoke's question to an endpoint: does it enforce response_format, or only accept
// it? Kept out of models/schemas.ts, whose text the run stamp hashes as review prompt text
// (libs/stamp.ts): this shapes no review, and rewording it must not split identical runs.
import { parseJsonObject } from "../libs/json";

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
