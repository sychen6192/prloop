// Output parsers. Every tool gets normalized to ToolFinding so the rest of the pipeline
// never knows which linter a finding came from.
import { parseJsonObject } from "../libs/json";
import { log } from "../libs/log";
import type { Severity } from "../config";
import type { OutputFormat, ToolFinding, ToolSpec } from "./types";

function rel(p: string, workdir: string): string {
  const norm = p.replace(/\\/g, "/");
  const w = workdir.replace(/\\/g, "/").replace(/\/+$/, "");
  return norm.startsWith(`${w}/`) ? norm.slice(w.length + 1) : norm.replace(/^\.\//, "");
}

// SARIF level and most tools' severity words collapse to our four.
function mapSeverity(raw: string | undefined, fallback: Severity = "medium"): Severity {
  const s = (raw ?? "").toLowerCase();
  if (["critical", "blocker", "fatal"].includes(s)) return "critical";
  if (["error", "high", "major", "2"].includes(s)) return "high";
  if (["warning", "warn", "medium", "moderate", "1"].includes(s)) return "medium";
  if (["note", "info", "low", "minor", "convention", "0"].includes(s)) return "low";
  return fallback;
}

interface SarifLog {
  runs?: Array<{
    tool?: { driver?: { name?: string; rules?: Array<{ id?: string; helpUri?: string }> } };
    results?: Array<{
      ruleId?: string;
      level?: string;
      message?: { text?: string };
      locations?: Array<{
        physicalLocation?: {
          artifactLocation?: { uri?: string };
          region?: { startLine?: number; endLine?: number };
        };
      }>;
      properties?: { "security-severity"?: string | number };
    }>;
  }>;
}

function parseSarif(raw: string, spec: ToolSpec, workdir: string): ToolFinding[] {
  const parsed = parseJsonObject<SarifLog>(raw);
  if (!parsed.ok) return [];
  const out: ToolFinding[] = [];

  for (const run of parsed.value.runs ?? []) {
    const helpByRule = new Map<string, string>();
    for (const r of run.tool?.driver?.rules ?? []) {
      if (r.id && r.helpUri) helpByRule.set(r.id, r.helpUri);
    }
    for (const res of run.results ?? []) {
      const loc = res.locations?.[0]?.physicalLocation;
      const uri = loc?.artifactLocation?.uri;
      const line = loc?.region?.startLine;
      if (!uri || !line) continue;

      // GitHub's convention: security-severity outranks level when present, because a
      // rule can be level:note while describing a critical vulnerability.
      const secSev = Number(res.properties?.["security-severity"]);
      let severity = mapSeverity(res.level);
      if (Number.isFinite(secSev)) {
        severity = secSev >= 9 ? "critical" : secSev >= 7 ? "high" : secSev >= 4 ? "medium" : "low";
      }

      const ruleId = res.ruleId ?? "";
      out.push({
        tool: spec.name,
        tier: spec.tier,
        ruleId,
        message: res.message?.text ?? "",
        file: rel(decodeURIComponent(uri.replace(/^file:\/\//, "")), workdir),
        line,
        endLine: loc?.region?.endLine,
        severity,
        rawSeverity: res.level,
        helpUri: helpByRule.get(ruleId),
      });
    }
  }
  return out;
}

interface RuffFinding {
  code?: string;
  message?: string;
  filename?: string;
  location?: { row?: number };
  end_location?: { row?: number };
  url?: string;
}

function parseRuffJson(raw: string, spec: ToolSpec, workdir: string): ToolFinding[] {
  const parsed = parseJsonObject<RuffFinding[]>(raw);
  if (!parsed.ok || !Array.isArray(parsed.value)) return [];
  return parsed.value
    .filter((f) => f.filename && f.location?.row)
    .map((f) => ({
      tool: spec.name,
      tier: spec.tier,
      ruleId: f.code ?? "",
      message: f.message ?? "",
      file: rel(f.filename!, workdir),
      line: f.location!.row!,
      endLine: f.end_location?.row,
      // Ruff has no severity axis; the S-prefixed (bandit) rules are the security ones.
      severity: (f.code ?? "").startsWith("S") ? "high" : "medium",
      helpUri: f.url,
    }));
}

interface EslintFile {
  filePath?: string;
  messages?: Array<{
    ruleId?: string | null;
    severity?: number;
    message?: string;
    line?: number;
    endLine?: number;
  }>;
}

function parseEslintJson(raw: string, spec: ToolSpec, workdir: string): ToolFinding[] {
  const parsed = parseJsonObject<EslintFile[]>(raw);
  if (!parsed.ok || !Array.isArray(parsed.value)) return [];
  const out: ToolFinding[] = [];
  for (const file of parsed.value) {
    if (!file.filePath) continue;
    for (const m of file.messages ?? []) {
      if (!m.line) continue;
      out.push({
        tool: spec.name,
        tier: spec.tier,
        ruleId: m.ruleId ?? "",
        message: m.message ?? "",
        file: rel(file.filePath, workdir),
        line: m.line,
        endLine: m.endLine,
        severity: m.severity === 2 ? "high" : "medium",
        rawSeverity: String(m.severity ?? ""),
      });
    }
  }
  return out;
}

// Checkstyle XML, also spoken by PMD's xml renderer (<violation> instead of <error>).
// NOT spoken by SpotBugs, despite an earlier comment here claiming it was — see
// parseSpotbugsXml.
function parseCheckstyleXml(raw: string, spec: ToolSpec, workdir: string): ToolFinding[] {
  const out: ToolFinding[] = [];
  const fileRe = /<file[^>]*name="([^"]+)"[^>]*>([\s\S]*?)<\/file>/g;
  const errRe = /<(?:error|violation)\b([^>]*)\/?>/g;
  // \b matters: without it, `line="` also matches inside `beginline="` and `endline="`.
  // Checkstyle emits `line`, PMD emits `beginline`/`endline`, and the old pattern read PMD
  // correctly only because PMD happens to put beginline first — attribute order is not
  // guaranteed, and reversing it silently yielded the END line for every violation.
  const attr = (s: string, k: string) => new RegExp(`\\b${k}="([^"]*)"`).exec(s)?.[1];

  for (const fm of raw.matchAll(fileRe)) {
    const filePath = fm[1]!;
    for (const em of (fm[2] ?? "").matchAll(errRe)) {
      const a = em[1] ?? "";
      const line = Number(attr(a, "beginline") ?? attr(a, "line"));
      if (!Number.isFinite(line) || line <= 0) continue;
      const endLine = Number(attr(a, "endline"));
      const src = attr(a, "source") ?? attr(a, "rule") ?? "";
      // Checkstyle says `severity` in words; PMD's <violation> says `priority`, 1 = most
      // severe down to 5. The shared numeric mapping reads the other way ("2" is high
      // there, "1" medium), so every priority-1 PMD violation was filed as medium and
      // every priority-2 as high — inverted, in the tier where a model then ranks them.
      // Same direction as SpotBugs, same explicit mapping.
      const severityWord = attr(a, "severity");
      const priority = attr(a, "priority");
      const severity: Severity =
        severityWord !== undefined
          ? mapSeverity(severityWord)
          : priority !== undefined
            ? priority === "1"
              ? "high"
              : priority === "2"
                ? "medium"
                : "low"
            : mapSeverity(undefined);
      out.push({
        tool: spec.name,
        tier: spec.tier,
        // Checkstyle emits fully-qualified class names; the last segment is the rule.
        ruleId: src.split(".").pop() ?? src,
        message: decodeXml(attr(a, "message") ?? ""),
        file: rel(filePath, workdir),
        line,
        ...(Number.isFinite(endLine) && endLine >= line ? { endLine } : {}),
        severity,
        rawSeverity: severityWord ?? (priority !== undefined ? `priority ${priority}` : undefined),
      });
    }
  }
  return out;
}

/**
 * SpotBugs `-xml:withMessages`. Nothing like Checkstyle despite both being XML: the root is
 * BugCollection, findings are BugInstance, and there is no <file> element at all — which is
 * why routing it through parseCheckstyleXml yielded a silent zero.
 */
function parseSpotbugsXml(raw: string, spec: ToolSpec, workdir: string): ToolFinding[] {
  const out: ToolFinding[] = [];
  const attr = (s: string, k: string) => new RegExp(`\\b${k}="([^"]*)"`).exec(s)?.[1];
  const text = (s: string, tag: string) =>
    new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(s)?.[1]?.trim();

  for (const m of raw.matchAll(/<BugInstance\b([^>]*)>([\s\S]*?)<\/BugInstance>/g)) {
    const head = m[1] ?? "";
    const body = m[2] ?? "";

    // A BugInstance carries several SourceLines: one inside <Class> spanning the whole class,
    // one inside <Method> spanning the method, and one as a direct child marking the actual
    // bug. Only the direct child is the finding's location — the class-level one covers
    // hundreds of lines and would make every finding "touch" the diff no matter what changed.
    const direct = body
      .replace(/<Class\b[^>]*\/>|<Class\b[\s\S]*?<\/Class>/g, "")
      .replace(/<Method\b[^>]*\/>|<Method\b[\s\S]*?<\/Method>/g, "");
    const sl = /<SourceLine\b([^>]*?)\/?>/.exec(direct)?.[1];
    if (!sl) continue; // no precise location; a class-wide guess is worse than nothing

    const line = Number(attr(sl, "start"));
    if (!Number.isFinite(line) || line <= 0) continue;
    const endRaw = Number(attr(sl, "end"));
    const sourcepath = attr(sl, "sourcepath") ?? attr(sl, "sourcefile");
    if (!sourcepath) continue;

    // SpotBugs priority is 1 = most severe, the opposite direction to every severity word
    // mapSeverity knows, so it needs its own mapping rather than the shared one.
    const priority = attr(head, "priority") ?? "";
    const severity: Severity = priority === "1" ? "high" : priority === "2" ? "medium" : "low";

    out.push({
      tool: spec.name,
      tier: spec.tier,
      ruleId: attr(head, "type") ?? "SPOTBUGS",
      message: decodeXml(text(body, "LongMessage") ?? text(body, "ShortMessage") ?? attr(head, "type") ?? ""),
      file: rel(sourcepath, workdir),
      line,
      ...(Number.isFinite(endRaw) && endRaw >= line ? { endLine: endRaw } : {}),
      severity,
      rawSeverity: `priority ${priority}`,
    });
  }
  return out;
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, "&");
}

interface MypyFinding {
  file?: string;
  line?: number;
  severity?: string;
  message?: string;
  code?: string;
}

// mypy emits JSON Lines, not a JSON array.
function parseMypyJson(raw: string, spec: ToolSpec, workdir: string): ToolFinding[] {
  const out: ToolFinding[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    const parsed = parseJsonObject<MypyFinding>(line);
    if (!parsed.ok) continue;
    const f = parsed.value;
    if (!f.file || !f.line) continue;
    if (f.severity === "note") continue; // follow-up context for a previous error
    out.push({
      tool: spec.name,
      tier: spec.tier,
      ruleId: f.code ?? "",
      message: f.message ?? "",
      file: rel(f.file, workdir),
      line: f.line,
      severity: "high", // a type error is a fact
      rawSeverity: f.severity,
    });
  }
  return out;
}

// tsc has no machine-readable output; its text format is stable enough to parse.
// e.g. src/a.ts(12,5): error TS2345: Argument of type ...
function parseTscText(raw: string, spec: ToolSpec, workdir: string): ToolFinding[] {
  const re = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.*)$/gm;
  const out: ToolFinding[] = [];
  for (const m of raw.matchAll(re)) {
    out.push({
      tool: spec.name,
      tier: spec.tier,
      ruleId: m[5]!,
      message: m[6]!.trim(),
      file: rel(m[1]!, workdir),
      line: Number(m[2]),
      severity: m[4] === "error" ? "high" : "medium",
      rawSeverity: m[4],
    });
  }
  return out;
}

const PARSERS: Record<OutputFormat, (raw: string, spec: ToolSpec, workdir: string) => ToolFinding[]> = {
  sarif: parseSarif,
  "ruff-json": parseRuffJson,
  "eslint-json": parseEslintJson,
  "checkstyle-xml": parseCheckstyleXml,
  "spotbugs-xml": parseSpotbugsXml,
  "mypy-json": parseMypyJson,
  "tsc-text": parseTscText,
};

export function parseToolOutput(raw: string, spec: ToolSpec, workdir: string): ToolFinding[] {
  if (!raw.trim()) return [];
  try {
    return PARSERS[spec.format](raw, spec, workdir);
  } catch (e) {
    // A parser blowing up must not take the review down with it — but it must not look like
    // a clean tool run either. An empty array is exactly what a passing linter returns, so
    // without this line a parser bug (or a tool that changed its output format) removes a
    // whole tool from the review and nothing anywhere says so.
    log(
      `[WARN] ${spec.name}: could not parse ${spec.format} output, dropping its findings ` +
        `(${e instanceof Error ? e.message : String(e)})`,
    );
    return [];
  }
}
