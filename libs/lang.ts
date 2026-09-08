// Language detection by extension. Drives per-language profiles (M4) and diff ordering.
const EXT_LANG: Record<string, string> = {
  ".py": "python",
  ".pyi": "python",
  ".java": "java",
  ".kt": "kotlin",
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".jsx": "jsx",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".json": "json",
  ".yml": "yaml",
  ".yaml": "yaml",
  ".sql": "sql",
  ".sh": "shell",
  ".md": "markdown",
  ".css": "css",
  ".scss": "scss",
  ".html": "html",
  ".xml": "xml",
};

// Files that are changed but never worth an LLM's attention.
const NOISE = [
  /(^|\/)package-lock\.json$/,
  /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)yarn\.lock$/,
  /(^|\/)poetry\.lock$/,
  /(^|\/)Pipfile\.lock$/,
  /(^|\/)go\.sum$/,
  /\.min\.(js|css)$/,
  /(^|\/)dist\//,
  /(^|\/)build\//,
  /(^|\/)node_modules\//,
  /(^|\/)__snapshots__\//,
  /\.snap$/,
  /(^|\/)\.next\//,
  /(^|\/)target\/(classes|generated-sources)\//,
];

export function detectLanguage(filePath: string): string {
  const i = filePath.lastIndexOf(".");
  if (i < 0) return "other";
  return EXT_LANG[filePath.slice(i).toLowerCase()] ?? "other";
}

export function isNoiseFile(filePath: string): boolean {
  return NOISE.some((re) => re.test(filePath));
}

// Code we actually want reviewed. Everything else can still appear in the file list.
const REVIEWABLE = new Set([
  "python",
  "java",
  "kotlin",
  "typescript",
  "tsx",
  "javascript",
  "jsx",
  "sql",
  "shell",
]);

export function isReviewable(filePath: string): boolean {
  return !isNoiseFile(filePath) && REVIEWABLE.has(detectLanguage(filePath));
}

// Tests and specs, in the layouts the four supported languages actually use. This is an
// ORDERING signal only — a test file is still reviewed, and a defect in one is still a
// defect. It decides who yields the context window when the diff does not fit: a 900-line
// generated test file must not push the service it exercises out of the payload.
const TEST_PATH = new RegExp(
  [
    "(^|/)(__tests__|__mocks__|tests?|specs?|testing)/", // dir: src/test/java/…, tests/…
    "(^|/)(test|spec)_[^/]+$", // python: test_refund.py
    "[._-](test|spec)s?\\.[A-Za-z0-9]+$", // foo.test.ts, foo_test.go, foo-spec.js
    "(Test|Tests|IT|Spec)\\.(java|kt|scala|cs)$", // InventoryServiceTest.java
  ].join("|"),
);

export function isTestPath(filePath: string): boolean {
  return TEST_PATH.test(filePath);
}
