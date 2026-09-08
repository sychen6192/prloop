# TypeScript, Node server, and Playwright review rules

Date: 2026-07-30
Status: **implemented** 2026-07-30 in `38ec0f1` (rules/typescript.md, rules/node-server.md,
rules/playwright.md). Kept as the design record for why those packs are shaped this way;
the rule files themselves are the current text.

## Problem

prloop is assumed to be Java-only. It is not: `profiles/index.ts` already ships three
profiles, and the `nextjs` one claims `.ts .tsx .js .jsx .mjs .cjs` and runs tsc + eslint.
`libs/lang.ts` already treats typescript/tsx/javascript/jsx as reviewable.

The real gap is the rule pack. `rules/nextjs.md` declares:

```
applyTo: "**/*.tsx", "**/*.jsx", "**/app/**", "**/pages/**"
```

A pull request that touches only backend `.ts` files therefore loads **no TypeScript rule at
all** — only `_base.md`, the cross-language code-smell baseline. The content of `nextjs.md`
is Server Actions, hydration, and `useEffect`, which is worth nothing to a Node service.

The target repository is a monorepo containing a Next.js app, Node backend packages, and
Playwright end-to-end tests that share directories with unit tests.

Test files are not filtered anywhere — the `NOISE` list in `libs/lang.ts:26` excludes
`__snapshots__` and `.snap` but nothing else — so specs are reviewed like any other source
file and will pick up whichever rule packs their extension matches.

## Scope

**In scope**

1. `rules/typescript.md` — new, applies to all TypeScript
2. `rules/node-server.md` — new, server-side request handling only
3. `rules/playwright.md` — new, Playwright end-to-end tests only
4. `libs/lang.ts` — add `.mts` / `.cts` to `EXT_LANG`
5. `scripts/selftest.ts` — assertions for rule selection across the monorepo cases

`rules/nextjs.md` is unchanged.

**Out of scope** (deliberately deferred; see Known defects)

- Fixing static-analysis working directory resolution
- Per-package tool invocation in a monorepo
- Renaming the `nextjs` profile to `typescript`
- Additional Node tooling (knip, npm audit, per-package eslint config discovery)

## Design

### Selection strategy

Rules are selected by extension and are additive. No path glob such as `apps/api/**` appears
anywhere: directory conventions differ between repositories, and hard-coding this
repository's layout into the tool's shipped rules would break every other consumer.

Where a glob cannot separate two audiences that share a file extension, the pack opens with a
self-guard telling the model to discard the whole pack when it does not apply — the same
technique `_base.md` uses when it defers to the repository's own conventions. This applies to
`node-server.md` (a `.ts` file may be a service, a library, or a CLI) and to `playwright.md`
(a `.spec.ts` file may be an end-to-end test or a unit test).

| Changed file | Rules loaded |
|---|---|
| `apps/api/src/user.ts` | `_base` + `typescript` + `node-server` |
| `apps/api/src/user.test.ts` | `_base` + `typescript` + `node-server` |
| `apps/web/src/login.spec.ts` | `_base` + `typescript` + `node-server` + `playwright` |
| `apps/web/app/route.ts` | `_base` + `typescript` + `node-server` + `nextjs` |
| `apps/web/app/page.tsx` | `_base` + `nextjs` |
| `packages/cli/src/main.ts` | `_base` + `typescript` + `node-server` |

`node-server.md` is loaded in more places than it applies to. That is the cost of a glob that
cannot see project structure, and the self-guard is what absorbs it.

### `.mts` / `.cts` must be reachable

`ado/intake.ts:78` and `git/intake.ts:72` both drop files that fail `isReviewable`, which
resolves through `EXT_LANG` in `libs/lang.ts`. `.mts` and `.cts` are absent, so they resolve
to `other` and the file is discarded at intake. The `applyTo` globs below would never match
them. Add both, mapped to `typescript`.

### Format

All three packs follow `rules/java.md`: sections ordered by severity, one bullet per pattern,
each stating the mechanism that makes it a bug, with a `→` fix where one exists. No style
guidance.

## `rules/typescript.md`

Applies to every TypeScript file regardless of what the project is. No self-guard needed.

```
applyTo: "**/*.ts", "**/*.mts", "**/*.cts"
```

`**/*.js`, `**/*.mjs`, and `**/*.cjs` are excluded. In this monorepo `.js` appears on both
the frontend and the backend with no way to tell them apart by name, and `.mjs`/`.cjs` are
mostly configuration files. These can be added later if backend JavaScript turns up in real
review traffic.

### Content

1. **Types do not exist at runtime.** `as` assertions and `!` applied to external data —
   `JSON.parse` results, `req.body`, database rows, `process.env`. The type checker passes
   and the runtime still breaks. The most common source of false confidence in a TypeScript
   codebase, and it applies equally to a service, a library, and a CLI. → parse, don't assert.
2. **Async correctness.** Unawaited promises (`forEach` with an async callback,
   fire-and-forget calls); `Promise.all` where one rejection leaves the other rejections
   unhandled → `allSettled`; sequential `await` of independent work creating a waterfall;
   errors from EventEmitters not being catchable by `try`/`catch`.
3. **Resources and lifecycle.** Handles, connections, and subscriptions not released on error
   paths; streams not destroyed; `setInterval` never cleared.

Target length is roughly 45 lines.

### Preamble

The existing packs open with "anything the linter already covers must not be reported again".
For this pack that claim needs qualifying: the promise-related checks
(`no-floating-promises`, `no-misused-promises`) are type-aware rules that only run when
eslint is configured with `parserOptions.project`, which many repositories never enable. The
preamble must say that tsc and eslint findings are not to be repeated, *and* that the
type-aware promise rules are frequently absent and still need human judgement.

## `rules/node-server.md`

Same glob as `typescript.md`, because a server file has no distinguishing extension.

```
applyTo: "**/*.ts", "**/*.mts", "**/*.cts"
```

Self-guard, first line of the pack. It must be phrased per-file: rules are selected once per
pull request and the finder prompt contains every changed file's diff concatenated, so "this
file" has no referent there — the guard has to instruct the model to decide applicability for
each file it is looking at:

> These rules apply only to server-side code that handles external requests. Judge each file
> separately: for a file that is a library, a CLI, a build script, or a client-side
> component, none of these rules apply to that file and none may be cited against it.

### Content

1. **Request-scoped data in module scope.** Module-level bindings are shared by every
   concurrent request in a single Node process. Caching the current user, tenant, or the
   request object at module scope leaks data across users. Highest severity, unreachable by
   static tooling, Node-specific. → `AsyncLocalStorage`, or hang it off the request object.
2. **Error handling on async request paths.** In Express 4 a rejection inside an async
   handler is *not* routed to error middleware — Express 5 calls `next(err)` automatically,
   Express 4 does not. Writing to the response after `res.headersSent`. Catch blocks that
   swallow and continue with invalid state.
3. **The trust boundary.** `req.body` reaching business logic without schema validation;
   mass assignment (`...req.body` spread into an ORM write); returning whole database rows
   (password hashes, internal flags); raw queries built with template literals; user input
   reaching `fs` paths or `child_process` (`execFile` over `exec`); token comparison that is
   not timing-safe → `crypto.timingSafeEqual`.
4. **Event loop and unbounded work.** Synchronous `fs`, heavy crypto, or large `JSON.parse`
   on the request path; `Promise.all` over an array whose length the caller controls;
   `Map`-based caches with no eviction; regex that backtracks on user input (ReDoS).
5. **Shutdown.** No graceful shutdown, so deploys drop in-flight requests.

Target length is roughly 60 lines.

### Two mandatory carve-outs

**Section 1 must exempt the deliberate `globalThis` client singleton.** This is the
recommended pattern for Prisma under Next.js:

```ts
const globalForPrisma = globalThis as unknown as { prisma: PrismaClient };
const prisma = globalForPrisma.prisma || new PrismaClient();
if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;
```

Without it, every dev-mode hot reload constructs a new `PrismaClient` with a fresh connection
pool and the database runs out of connections (vercel/next.js#45483, prisma#17566). A
connection pool or client instance intentionally placed on `globalThis` is not the defect
section 1 describes, and reporting it is a false positive landed on textbook code. That is
the most expensive kind of false positive a review tool can produce: once it flags an
officially recommended pattern, nobody reads its real findings either.

**Section 3 must not restate `nextjs.md`.** `nextjs.md:21` already covers unvalidated Server
Action arguments and `nextjs.md:22` covers returning whole database records. On an
`app/actions.ts` file both packs load and are concatenated into one prompt, so the same
defect would be described twice and reported twice. Section 3 must scope those two bullets to
non-Server-Action entry points and say so explicitly.

## `rules/playwright.md`

### Why a separate pack

Playwright specs are `.ts`, so they already match `typescript.md` and `node-server.md`. What
they do not get is the failure mode that matters most here. A web-first assertion without
`await`:

```ts
expect(page.getByText('welcome')).toBeVisible();
```

does not finish before the test ends, and **the test passes silently**. A false green is
worse than a red, because nobody investigates it. `eslint-plugin-playwright` exists largely
for this (`missing-playwright-await`) and most projects do not install it.

### Selection

```
applyTo: "**/*.spec.ts", "**/*.e2e.ts", "**/playwright.config.*"
```

Playwright's default `testMatch` is `**/*.@(spec|test).?(c|m)[jt]s?(x)`, which collides with
vitest and jest conventions. In the target repository end-to-end specs and unit tests share
directories, so no path glob can separate them and the filename cannot either.

Self-guard, first line of the pack, phrased per-file for the same reason as
`node-server.md`'s:

> These rules apply only to Playwright browser end-to-end tests. Judge each file separately:
> for a file that is a vitest or jest unit test, none of these rules apply to that file and
> none may be cited against it.

`**/*.test.ts` is deliberately **not** claimed. It is the more common unit-test suffix, and
claiming it would load this pack on the majority of unit-test pull requests, where the
self-guard is the only thing preventing misapplied findings. `.spec.ts` and `.e2e.ts` skew
far more towards end-to-end use.

### Content

1. **Assertions and actions without `await`.** The silent-pass mechanism above. Highest
   severity in the pack.
2. **Assertions that discard auto-retry.**
   `expect(await locator.isVisible()).toBe(true)` resolves once and cannot retry;
   `await expect(locator).toBeVisible()` retries until the timeout. Playwright's own
   documentation lists the first form as the anti-example.
3. **Locators bound to implementation.** CSS and XPath selectors break on DOM changes and
   skip the actionability checks that `getByRole()` and friends perform (visible, enabled,
   stable) before acting.
4. **Tests that are not independent.** Playwright requires each test to run with its own
   storage, session, cookies, and data. State carried between tests fails
   non-deterministically under parallel workers. → `beforeEach`, not test chaining.
5. **Hard waits.** `page.waitForTimeout()` in place of a web-first assertion or an explicit
   wait condition is flakiness with a delay attached.
6. **Unmocked third-party calls.** External services bring cookie banners, overlays, and
   downtime into the test result. → the Network API.

Target length is roughly 60 lines.

Item 1 must be written as the Playwright-specific silent-pass case and must not restate
`typescript.md`'s general floating-promise bullet. Both packs load together on a `.spec.ts`
file; two rules describing the same defect produce two findings for it.

### Source tiers

Items 1 to 4 and 6 come from Playwright's official best-practices documentation or from
`eslint-plugin-playwright`'s own rule set. Item 5, and the commonly cited `test.only`-left-in
and `if (await x.isVisible())` conditional-branching patterns, are **community consensus and
are not in the official documentation**. The implementation must not present the second group
with the same confidence as the first — the review prompt already leans on rules as
authoritative, so an overstated rule becomes an overstated comment.

## Sources

Content is drawn from these rather than invented. Every claim must be traceable to one of
them or to behaviour verifiable from a primary specification. Unsourced assertions are what
produce confidently wrong review comments.

- [goldbergyoni/nodebestpractices](https://github.com/goldbergyoni/nodebestpractices) —
  105k stars, the highest-rated Node.js practice list. Sections 2.10, 2.13, 3.13, 6.16,
  6.17, 6.19, 7.1.
- [OWASP Node.js Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Nodejs_Security_Cheat_Sheet.html)
  — input validation, filesystem handling, request size limits, event-loop DoS.
- [Express error handling guide](https://expressjs.com/en/guide/error-handling.html) — the
  Express 4 vs 5 async-rejection difference and `res.headersSent`, both stated in the
  official documentation.
- [typescript-eslint](https://typescript-eslint.io/rules/no-floating-promises/) — which
  promise checks exist and that they require type-aware configuration.
- [Playwright best practices](https://playwright.dev/docs/best-practices) — locators,
  web-first assertions, test isolation, mocking third parties.
- [eslint-plugin-playwright `missing-playwright-await`](https://github.com/playwright-community/eslint-plugin-playwright/blob/main/docs/rules/missing-playwright-await.md)
  — the unawaited-assertion class and why it is not caught by default.
- [vercel/next.js#45483](https://github.com/vercel/next.js/issues/45483),
  [prisma/prisma#17566](https://github.com/prisma/prisma/issues/17566) — hot-reload
  connection exhaustion, and why the `globalThis` singleton is the recommended answer.

## Testing

`scripts/selftest.ts` gains assertions over `selectRules` covering every row of the selection
table, plus:

- `.mts` resolves to `typescript` through `detectLanguage`
- a `.test.ts` file does **not** select `playwright.md`
- `apps/api/src/user.ts` does **not** select `nextjs.md` (the `**/app/**` glob must not match
  the `apps/` directory prefix)

## Known defects found during design, not fixed here

These were identified while scoping this work and are recorded so they are not lost. All
predate this change and none is introduced by it.

> **Update:** defects 1, 2 and 4 are fixed. `run()` now takes a `cwd`; `projectDirsFor()`
> resolves each tool's marker to the nearest ancestor of the changed files and runs the tool
> once per project it finds; output paths are parsed against that cwd and lifted back into
> workdir coordinates. Defect 4 fell out of the same change — `target/classes` resolves per
> module exactly like `tsconfig.json` resolves per package. Defect 3 stands.

1. **Static analysis tools run in the wrong working directory.** `libs/shell.ts` `run()`
   never passes `cwd` to `execFile`, so tools execute in prloop's own process working
   directory rather than `PRR_WORKDIR` — while `gates/static.ts:96` checks `requires`
   against `PRR_WORKDIR`. Java survives only when prloop happens to be launched from
   `PRR_WORKDIR` itself — the file paths handed to PMD are workdir-relative and resolve
   against the process cwd. `npx tsc --noEmit` is worse: it takes no file arguments and is
   driven entirely by cwd, so it
   currently type-checks prloop itself, and every finding is then discarded by
   `filterToChangedLines` because the paths do not match. The result is a silent zero, with
   no error surfaced. Roughly a five-line fix.

2. **Tool output paths are not resolved against the tool's working directory.**
   `profiles/parsers.ts:7` `rel()` strips a `workdir` prefix from absolute paths and strips
   a leading `./`, but never resolves a relative path against the directory the tool ran in.
   Once tools run per package, tsc reporting `src/user.ts` from `apps/api/` must become
   `apps/api/src/user.ts`. Fixing this means giving `rel()` both a cwd and a workdir base.

3. **The `nextjs` profile is misnamed.** It claims every `.ts` file, including pure backend
   code, and runs generic TypeScript tooling. `typescript` is the accurate name.

4. **`spotbugs` `requires: "target/classes"` assumes a single-module Maven build.** In a
   multi-module repository the path only exists for one module, so SpotBugs is skipped for
   the rest. Same class of problem as defect 1, on the Java side.

Defects 1 and 2 mean that for the target monorepo the static-analysis gate produces nothing.
These rule packs are therefore the only thing standing between a backend PR and an unreviewed
merge, which is the assumption their content is written under.
