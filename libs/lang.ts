// Every file type prloop knows, in one place: its id — the language name the prompts use and
// the tag a code fence gets — and whether the code axis reviews it.
//
// It was three lists that had to agree: an extension table, a separate set of the ids the
// finders would read, and the static-analysis profiles. The middle one held nine languages,
// and none of them was C# — the most common language in an Azure DevOps shop — or Go, Rust,
// PHP or C++. A pull request written entirely in one of those had "no reviewable code
// changes": the requirement axis was skipped along with the finders, although it does not
// depend on language at all, and the status read `Reviewed 0 files, no blockers` in green.
//
// `code` is read by the finders and the requirement axis. Everything else here —
// configuration, markup, documentation — is read by the requirement axis only: a criterion
// is often met in a config file or a document, while a prompt about correctness and
// concurrency has nothing useful to say about a README. A file type not listed at all is
// read by neither, and the summary names it.
interface FileType {
  id: string;
  code: boolean;
  extensions: readonly string[];
  /** Whole file names, for the types a name identifies instead of an extension. */
  names?: RegExp;
}

const FILE_TYPES: readonly FileType[] = [
  { id: "python", code: true, extensions: [".py", ".pyi"] },
  { id: "java", code: true, extensions: [".java"] },
  { id: "kotlin", code: true, extensions: [".kt", ".kts"] },
  { id: "scala", code: true, extensions: [".scala", ".sc"] },
  { id: "groovy", code: true, extensions: [".groovy", ".gradle"], names: /^Jenkinsfile$/ },
  { id: "typescript", code: true, extensions: [".ts", ".mts", ".cts"] },
  { id: "tsx", code: true, extensions: [".tsx"] },
  { id: "javascript", code: true, extensions: [".js", ".mjs", ".cjs"] },
  { id: "jsx", code: true, extensions: [".jsx"] },
  { id: "vue", code: true, extensions: [".vue"] },
  { id: "svelte", code: true, extensions: [".svelte"] },
  { id: "csharp", code: true, extensions: [".cs", ".csx"] },
  { id: "razor", code: true, extensions: [".cshtml", ".razor"] },
  { id: "fsharp", code: true, extensions: [".fs", ".fsi", ".fsx"] },
  { id: "vbnet", code: true, extensions: [".vb"] },
  { id: "go", code: true, extensions: [".go"] },
  { id: "rust", code: true, extensions: [".rs"] },
  { id: "c", code: true, extensions: [".c", ".h"] },
  { id: "cpp", code: true, extensions: [".cc", ".cpp", ".cxx", ".hh", ".hpp", ".hxx"] },
  { id: "objectivec", code: true, extensions: [".mm"] },
  { id: "swift", code: true, extensions: [".swift"] },
  { id: "dart", code: true, extensions: [".dart"] },
  { id: "php", code: true, extensions: [".php"] },
  { id: "ruby", code: true, extensions: [".rb"], names: /^(Gemfile|Rakefile)$/ },
  { id: "perl", code: true, extensions: [".pl", ".pm"] },
  { id: "lua", code: true, extensions: [".lua"] },
  { id: "r", code: true, extensions: [".r"] },
  { id: "sql", code: true, extensions: [".sql"] },
  { id: "shell", code: true, extensions: [".sh", ".bash", ".zsh"] },
  { id: "powershell", code: true, extensions: [".ps1", ".psm1"] },
  { id: "hcl", code: true, extensions: [".tf", ".tfvars", ".hcl"] },
  { id: "bicep", code: true, extensions: [".bicep"] },
  { id: "dockerfile", code: true, extensions: [".dockerfile"], names: /^(Dockerfile|Containerfile)(\..+)?$/ },
  { id: "makefile", code: true, extensions: [".mk"], names: /^(GNUmakefile|Makefile|makefile)$/ },
  { id: "cmake", code: true, extensions: [".cmake"], names: /^CMakeLists\.txt$/ },
  { id: "protobuf", code: true, extensions: [".proto"] },
  { id: "graphql", code: true, extensions: [".graphql", ".gql"] },

  { id: "json", code: false, extensions: [".json", ".jsonc"] },
  { id: "yaml", code: false, extensions: [".yml", ".yaml"] },
  { id: "xml", code: false, extensions: [".xml", ".csproj", ".vbproj", ".fsproj", ".props", ".targets", ".config", ".resx", ".xaml"] },
  { id: "toml", code: false, extensions: [".toml"] },
  { id: "ini", code: false, extensions: [".ini", ".cfg", ".properties", ".conf"] },
  { id: "markdown", code: false, extensions: [".md", ".mdx"] },
  { id: "text", code: false, extensions: [".txt", ".rst", ".adoc"] },
  { id: "css", code: false, extensions: [".css"] },
  { id: "scss", code: false, extensions: [".scss", ".sass", ".less"] },
  { id: "html", code: false, extensions: [".html", ".htm"] },
  { id: "csv", code: false, extensions: [".csv"] },
];

const BY_EXTENSION = new Map<string, FileType>(FILE_TYPES.flatMap((t) => t.extensions.map((e) => [e, t] as const)));

function fileTypeOf(filePath: string): FileType | undefined {
  const name = filePath.slice(filePath.lastIndexOf("/") + 1);
  const byName = FILE_TYPES.find((t) => t.names?.test(name));
  if (byName) return byName;
  const i = name.lastIndexOf(".");
  return i < 0 ? undefined : BY_EXTENSION.get(name.slice(i).toLowerCase());
}

/** The extensions registered for a language id, for callers that must agree with this table. */
export function extensionsOf(id: string): readonly string[] {
  return FILE_TYPES.find((t) => t.id === id)?.extensions ?? [];
}

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
  return fileTypeOf(filePath)?.id ?? "other";
}

export function isNoiseFile(filePath: string): boolean {
  return NOISE.some((re) => re.test(filePath));
}

/** The skip reason intakes record for a file of a type this table does not list. */
export const UNKNOWN_FILE_TYPE = "a file type prloop does not read";

/**
 * Who reads a changed file: `code` goes to both axes, `text` to the requirement axis only,
 * `unknown` to neither (and is named in the summary). Noise — lock files, build output,
 * vendored code — is decided separately, by isNoiseFile, before this is asked.
 */
export function fileKind(filePath: string): "code" | "text" | "unknown" {
  const t = fileTypeOf(filePath);
  return t === undefined ? "unknown" : t.code ? "code" : "text";
}

/** Code the finders review. */
export function isReviewable(filePath: string): boolean {
  return !isNoiseFile(filePath) && fileKind(filePath) === "code";
}

// Tests and specs, in the layouts the common languages actually use. This is an
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
