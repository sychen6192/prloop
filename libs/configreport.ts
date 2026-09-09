// Configuration provenance, rendered for humans.
//
// config.ts records where every value came from; this is where that record becomes
// something you read — the startup warnings, `prloop --config`, and the config.json saved
// with every run. It exists because the one thing a normal run never said was which value
// won: a stale `export PRR_LLM_MAX_TOKENS=32768` in a shell profile beats .env silently,
// and so does an exported PRR_LLM_EXTRA_BODY that switches thinking back on. Debugging that
// from the outside means reading the model's behaviour and guessing at the cause.
//
// Rendering lives here rather than in config.ts because it needs libs/redact.ts, and
// redact.ts reads the configured credentials out of config.ts — importing it the other way
// would be a cycle that fails at module-init time.
import {
  DOTENV_PATH,
  KNOWN_KEYS,
  configReport,
  defaultOf,
  isSecret,
  shadowedKeys,
  unknownKeys,
  type ConfigEntry,
} from "../config";
import { REDACTED, redactSecrets } from "./redact";

/** How much of a value a warning line shows. Long enough to recognise, short enough to log. */
const MAX_SHOWN = 40;

/** Cuts a value down for display. Redaction runs FIRST: truncating a credential mid-token
 * would defeat the patterns that recognise it and print the prefix instead. */
export function truncateValue(v: string, max = MAX_SHOWN): string {
  const s = redactSecrets(v);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** A value as it may be shown: a registry secret never appears, whatever it looks like. */
export function displayValue(name: string, value: string, max = MAX_SHOWN): string {
  if (isSecret(name)) return value === "" ? "" : REDACTED;
  return truncateValue(value, max);
}

export interface ConfigWarning {
  /** One line, already phrased for a log. */
  message: string;
  /** What to do about it (doctor prints this; the run log does not). */
  fix: string;
}

/**
 * Everything wrong with the configuration that is worth saying before a run starts. Both
 * kinds are warnings, never fatal: prloop still runs with the shell's value, and a stray
 * variable harms nothing — the cost of both is silence, not failure.
 */
export function configWarnings(): ConfigWarning[] {
  const out: ConfigWarning[] = [];
  for (const e of shadowedKeys()) {
    const shell = displayValue(e.name, e.value);
    const file = displayValue(e.name, e.fileValue ?? "");
    out.push({
      message:
        `${e.name}: shell export "${shell}" shadows .env "${file}" ` +
        "(.env never overrides an exported variable)",
      fix: `unset ${e.name} in your shell, or change the exported value — editing .env cannot`,
    });
  }
  for (const name of unknownKeys()) {
    out.push({
      message: `unknown setting ${name} (not a prloop setting — check for a typo)`,
      fix: "prloop reads nothing under that name; `prloop --config` lists every setting it does read",
    });
  }
  return out;
}

/** True when the CLI was asked for the configuration table instead of a review. Pure. */
export function wantsConfigDump(args: readonly string[], showConfigEnv: boolean): boolean {
  return showConfigEnv || args.includes("--config");
}

const NAME_WIDTH = Math.max(...KNOWN_KEYS.map((k) => k.name.length));
const VALUE_WIDTH = 30;

/** Every setting, its effective value and where that value came from. */
export function renderConfigTable(): string {
  const values = new Map(configReport().map((e) => [e.name, e]));
  const lines = [
    `prloop settings — the value each knob has right now, and where it came from.`,
    `.env: ${DOTENV_PATH}`,
  ];
  let section = "";
  for (const k of KNOWN_KEYS) {
    if (k.section !== section) {
      section = k.section;
      lines.push("", section);
    }
    const e = values.get(k.name) ?? { name: k.name, source: "default" as const, value: "" };
    // Nothing set it → show the value that is therefore in force, as the readers in
    // config.ts recorded it. A secret's default is never worth printing (and "dummy"
    // rendered as [REDACTED] would only mislead), so those stay blank.
    const effective = e.value !== "" ? e.value : isSecret(k.name) ? "" : (defaultOf(k.name) ?? "");
    const shown = displayValue(k.name, effective, VALUE_WIDTH - 2);
    lines.push(
      `  ${k.name.padEnd(NAME_WIDTH)}  ${(shown || "—").padEnd(VALUE_WIDTH)}  ${e.source.padEnd(7)}  ${k.description}`,
    );
  }
  const warnings = configWarnings();
  if (warnings.length > 0) {
    lines.push("", "Warnings");
    for (const w of warnings) lines.push(`  [WARN] ${w.message}`, `         → ${w.fix}`);
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * What runs/<...>/config.json holds: the same entries, redacted, plus the two things a
 * table cannot show — which keys .env lost to the shell, and which names configure nothing.
 * A run is diagnosable a week later only if it recorded the configuration it actually ran
 * with; every other artifact records what the models did with it.
 */
export function configSnapshot(): {
  dotenv: string;
  entries: ConfigEntry[];
  shadowed: ConfigEntry[];
  unknown: string[];
} {
  const clean = (e: ConfigEntry): ConfigEntry => ({
    name: e.name,
    source: e.source,
    // Full values here, not truncated: the point of the artifact is to answer "what did it
    // actually run with", and half a model list answers nothing.
    value: displayValue(e.name, e.value, Number.MAX_SAFE_INTEGER),
    ...(e.fileValue !== undefined
      ? { fileValue: displayValue(e.name, e.fileValue, Number.MAX_SAFE_INTEGER) }
      : {}),
  });
  return {
    dotenv: DOTENV_PATH,
    entries: configReport().map(clean),
    shadowed: shadowedKeys().map(clean),
    unknown: unknownKeys(),
  };
}

/** One key's value and source, for probe.ts's provenance section. Any name, not just ours. */
export function describeEntry(e: ConfigEntry): string {
  const shown = isSecret(e.name)
    ? e.value
      ? `(set, length ${e.value.length})`
      : "(not set)"
    : e.value === ""
      ? "(not set)"
      : truncateValue(e.value, 60);
  if (e.fileValue !== undefined) {
    return `${shown}   ← ⚠️  shell env var overrides .env (.env says "${displayValue(e.name, e.fileValue, 60)}")`;
  }
  return `${shown}   ← ${e.source === "shell" ? "shell env var" : e.source}`;
}
