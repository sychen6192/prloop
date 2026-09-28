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
checkout of the repositories you review. prloop creates every directory under it readable by
its owner only (0700), so another account on a shared build agent cannot list or read it;
directories that already exist keep their mode. Two JSONL files sit above the pruned run
directories and outlive them: `dismissals.jsonl`, the findings a reviewer rejected, and
`outcomes.jsonl`, the ones they fixed. Both hold a fingerprint, a file path and a category —
no source, no quote — and neither is ever read into a model prompt.

## What is defended

- **Secrets are redacted where text leaves the process** (`libs/redact.ts`): log lines,
  `runs/` artifacts, error messages, `prloop --config`, and every comment posted on the PR —
  the summary and each inline finding, whose claim, evidence and suggested fix are the model's
  own words. The motivating leak: gateways that echo the presented credential back inside a
  401 body, which was then relayed into the log, into `runs/` and onto the pull request.
  Redaction is applied at the egress, not per producer, so a new call site cannot forget it.
- **Static analysis runs with a scrubbed environment** (`libs/shell.ts`, `scrubbedEnv`).
  `PRR_WORKDIR` is a checkout of the PR's *source branch*, and linters execute that branch's
  code — an eslint config, a Maven plugin or a lint hook is a program the PR author wrote. Every
  variable whose name looks like a credential is dropped before the tool starts; the `opencode`
  runner's child process gets the same treatment, and so does `PRR_WORKTREE_SETUP_CMD`, which
  runs the reviewed branch's own install line. That command goes through a **non-login** shell
  for the same reason: `sh -lc` re-sources `/etc/profile` and `~/.profile` before running, and a
  profile that exports `OPENAI_API_KEY` or `GITHUB_TOKEN` puts back every name the scrub just
  removed. `HOME` itself is passed through by design, so files under it (`~/.npmrc`,
  `~/.git-credentials`, the `~/.azure` token cache) remain readable by the setup command and by
  the linters.
- **prloop's own state on the PR is bound to the identity that wrote it.** prloop keeps its
  cross-run state in hidden HTML comments inside its own comments (`publish/markers.ts`): the
  `--since auto` resume point, a finding's fingerprint, its category. Those markers are text
  anyone who can comment on the PR can type, so the two readers whose forging is not
  recoverable also check `author.id` against the identity prloop authenticates as
  (`_apis/connectionData`, `ado/identity.ts`): the resume point, where a forged
  `<!-- prloop:iteration=9999 -->` would make a run review an empty diff and report a clean PR,
  the dismissal store, where a forged `wontFix` thread would suppress a finding on every
  future PR in the repository, and the run lease, where a forged
  `<!-- prloop:run=... -->` refreshed often enough would make prloop stand down from that PR
  for good. The dedupe readers deliberately stay on markers alone — forging
  those costs one missing comment, while requiring identity there would double-post whenever
  prloop's credential differs between a laptop and a pipeline. Identity, fingerprint and
  category are read only from the markers at the start of a comment body, and the resume point
  and the lease only from those at its end, after prloop's own closing line. Everything in
  between may quote text prloop did not write — acceptance criteria, model claims and notes —
  and passing the identity check does not make that text prloop's: a criterion typed as
  `&lt;!-- prloop:iteration=5 --&gt;` reached the summary as a live marker once the work item
  was flattened to text. So every HTML comment opener in the quoted text is also defused on
  its way to the PR (`defuseHtmlComments`), which keeps it readable and keeps it from hiding
  the rest of the comment. Where `connectionData` is unavailable (some on-prem Server
  versions) prloop falls back to trusting the markers alone and says so, once, in the run log.
- **Text prloop did not write is fenced before it reaches a model.** The PR description, the
  reviewed repository's own convention documents, the linked work items (title, description
  and every acceptance criterion) and the static-analysis reports each go into their prompt
  inside a named tag, preceded by one sentence saying they are reference material and that
  instructions addressed to a reviewer inside them are to be ignored (`prompts/untrusted.ts`).
  A closing tag carried by the text is neutralised, so it cannot end its own fence early, and
  prloop's own reading instructions stay outside the fence rather than being disclaimed along
  with the ticket. Single-line fields — the PR title, branch names, the author's display name,
  a work item's type — are collapsed to one line and capped, because a newline in one of them
  forges a section of the prompt. None of this is a guarantee against a determined injection;
  it makes the boundary explicit, which is what a model can act on.
- **A static-analysis message is source text quoted back.** It becomes the claim of a comment
  prloop signs and the body of a triage prompt, so it is collapsed to one paragraph, stripped
  of HTML comments and leading markdown structure, and capped. Finding fingerprints hash the
  tool, the rule, the file and the line's own text — never the message — so this changes what
  is displayed and never what is suppressed.
- **The `opencode` runner cannot hand the model a tool.** A review prompt carries text an
  attacker can write — the diff, the description, the work items — so the agent that reads it
  must be able to do nothing but answer. prloop does not trust an installed agent file for
  that: `opencode run --agent` falls back to opencode's default agent, which has every tool,
  when the named agent is a subagent or cannot be found, and prloop's own agent file used to
  declare itself a subagent. Every run now gets prloop's definition — a primary agent with
  every permission denied by name and by wildcard — through `OPENCODE_CONFIG_CONTENT`, which
  opencode merges over user and project configs, and again as the `opencode.json` of the
  empty temporary directory the run is launched from, well away from prloop's `.env`. A
  run that still prints opencode's fallback warning is killed on that line, and its answer is
  refused.
- **Nothing runs at install time.** `.npmrc` sets `ignore-scripts`: none of prloop's
  dependencies needs an install script, and a compromised release of one would otherwise run
  with the environment of whoever installs. The CI workflows pin every action to a commit, not
  a tag that can be moved.
- **prloop never writes its own configuration** and never votes on a PR. It posts comments and,
  optionally, a status.

Known limit worth stating: a `runs/` directory created before prloop made them owner-only
keeps its old mode. On an existing install, run `chmod -R go-rwx runs/` once.

## Reporting a vulnerability

Report privately through **GitHub Security Advisories** on this repository
(Security → Report a vulnerability). Do not open a public issue for anything that leaks a
credential, exfiltrates reviewed source, or lets a reviewed repository execute code outside
the static-analysis sandboxing described above.

Expect an acknowledgement within a week. There is no bounty.

## Supported versions

Pre-1.0: **`main` only.** Fixes land on `main`; older tags are not patched.
