// Suppression markers: the comments and annotations a codebase uses to tell its linters,
// type checkers and scanners "I looked at this line and meant it".
//
// A reviewer that flags such a line argues with a decision already made — the `any` an
// eslint-disable allows, the broad except a noqa excuses, the test password a nosec waves
// through — and Anthropic's review plugin lists findings "explicitly silenced in the code" among
// its false positives for that reason. Line-local, like the markers themselves: the lines a
// finding is anchored on, and the comment or annotation lines directly above them, which is
// where `eslint-disable-next-line`, `@ts-ignore`, `@SuppressWarnings` and their kin are
// written. Only the marker's NAME leaves this module, never the text around it: the line is the
// PR author's, and what the summary prints is prloop's own word for it.

const MARKERS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\beslint-disable(?:-next-line|-line)?\b/, "eslint-disable"],
  [/\bbiome-ignore\b/, "biome-ignore"],
  [/@ts-(?:ignore|expect-error)\b/, "@ts-ignore"],
  [/#\s*noqa\b/i, "# noqa"],
  [/#\s*type:\s*ignore\b/, "# type: ignore"],
  [/#\s*pyright:\s*ignore\b/, "# pyright: ignore"],
  [/#\s*pylint:\s*disable\b/, "# pylint: disable"],
  [/#\s*nosec\b/, "# nosec"],
  [/\bNOSONAR\b/, "NOSONAR"],
  [/\bNOPMD\b/, "NOPMD"],
  [/\/\/\s*noinspection\b/, "//noinspection"],
  [/@SuppressWarnings\b/, "@SuppressWarnings"],
  [/@(?:\w+:)?Suppress\s*\(/, "@Suppress"],
  [/\bSuppressMessage(?:Attribute)?\s*\(/, "SuppressMessage"],
  [/#\s*pragma\s+warning\s*\(?\s*disable\b/, "#pragma warning disable"],
  [/#\s*pragma\s+(?:GCC|clang)\s+diagnostic\s+ignored\b/, "#pragma diagnostic ignored"],
  [/\/\/\s*nolint\b/, "//nolint"],
  [/\bNOLINT(?:NEXTLINE|BEGIN)?\b/, "NOLINT"],
  [/#!?\[\s*allow\s*\(/, "#[allow]"],
  [/\brubocop:disable\b/, "rubocop:disable"],
  [/\bswiftlint:disable\b/, "swiftlint:disable"],
  [/\bshellcheck\s+disable=/, "shellcheck disable"],
  [/\bphpcs:(?:ignore|disable)\b/, "phpcs:ignore"],
  [/@phpstan-ignore/, "@phpstan-ignore"],
];

// A line that holds only a comment, an annotation or an attribute: a marker there is written
// for the code below it. A marker after code (`x = f()  # noqa`) belongs to its own line, so a
// line above that holds code ends the search — its marker is not this finding's.
const NOT_CODE = /^(?:\/\/|\/\*|\*(?:\s|\/|$)|#|--|<!--|@|\[[A-Z][\w.]*\s*[(\]])/;
// Stacked annotations, or a comment between the marker and its line; no further than that.
const MAX_LINES_ABOVE = 3;

const markerIn = (line: string) => MARKERS.find(([re]) => re.test(line))?.[1];

/**
 * The suppression marker that covers lines `startLine`..`endLine` (1-based, inclusive) of
 * `lines`, by name, or undefined. On one of those lines, or on the comment and annotation
 * lines directly above the first.
 */
export function suppressionMarker(lines: readonly string[], startLine: number, endLine: number): string | undefined {
  for (let n = Math.max(1, startLine); n <= Math.min(endLine, lines.length); n++) {
    const hit = markerIn(lines[n - 1] ?? "");
    if (hit) return hit;
  }
  for (let n = startLine - 1; n >= 1 && n >= startLine - MAX_LINES_ABOVE; n--) {
    const text = (lines[n - 1] ?? "").trim();
    if (!NOT_CODE.test(text)) break;
    const hit = markerIn(text);
    if (hit) return hit;
  }
  return undefined;
}
