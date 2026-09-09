# Security

## What prloop handles

- **An Azure DevOps credential** — `PRR_ADO_PAT` (Code Read & Write + Work Items Read), or an
  `az login` token when no PAT is set. It can comment on and read every repository the PAT can.
- **A model endpoint key** — `PRR_LLM_API_KEY`, sent to `PRR_LLM_BASE_URL`.
- **The source code of every PR it reviews.** Diffs, raw blob bytes, work item text and
  acceptance criteria are put into model prompts and sent to whatever endpoint you configure.
  prloop makes no judgement about where that endpoint is; pointing it at a third-party API
  means the reviewed code goes there.

## What lands on disk

Every run writes `runs/<org>/<project>/<repo>/pr-<id>/iter-<N>-<ts>/`: the exact prompts, the
diff inside them, each model's raw output, the skeptic verdicts, and `config.json` — the
settings the run used and where each value came from. **These files contain the reviewed
code.** `runs/` is gitignored, never uploaded anywhere by prloop, and pruned by
`PRR_RUNS_KEEP` / `PRR_RUNS_MAX_AGE_DAYS`; treat the directory with the same care as a
checkout of the repositories you review.

## What is defended

- **Secrets are redacted where text leaves the process** (`libs/redact.ts`): log lines,
  `runs/` artifacts, error messages and the summary comment posted on the PR. The motivating
  leak: gateways that echo the presented credential back inside a 401 body, which was then
  relayed into the log, into `runs/` and onto the pull request. Redaction is applied at the
  egress, not per producer, so a new call site cannot forget it.
- **Static analysis runs with a scrubbed environment** (`libs/shell.ts`, `scrubbedEnv`).
  `PRR_WORKDIR` is a checkout of the PR's *source branch*, and linters execute that branch's
  code — an eslint config, a Maven plugin or a lint hook is a program the PR author wrote. Every
  variable whose name looks like a credential is dropped before the tool starts; the `opencode`
  runner's child process gets the same treatment.
- **prloop never writes its own configuration** and never votes on a PR. It posts comments and,
  optionally, a status.

Known limit worth stating: `prloop --config` redacts the registered secrets, but a password
embedded in a proxy or base URL is printed as part of the URL. Scrub that line before sharing
the output.

## Reporting a vulnerability

Report privately through **GitHub Security Advisories** on this repository
(Security → Report a vulnerability). Do not open a public issue for anything that leaks a
credential, exfiltrates reviewed source, or lets a reviewed repository execute code outside
the static-analysis sandboxing described above.

Expect an acknowledgement within a week. There is no bounty.

## Supported versions

Pre-1.0: **`main` only.** Fixes land on `main`; older tags are not patched.
