---
applyTo: "**/*.ts", "**/*.mts", "**/*.cts"
---

# TypeScript review rules

prloop dedupes tool and model findings downstream — report what you see; pure
formatting/naming-convention output is the only thing left to linters. In particular, the
promise checks that matter most below (`no-floating-promises`, `no-misused-promises`) are
type-aware eslint rules that only run when `parserOptions.project` is configured — many
projects never enable them. Do not assume the linter has async correctness covered.

## Types do not exist at runtime

- **`as` assertions or `!` on external data** — `JSON.parse` results, request bodies,
  database rows, `process.env` values. The compiler is satisfied; the runtime value is
  whatever actually arrived. This is the most common source of false confidence in a
  TypeScript codebase. → parse and validate at the boundary (schema library or manual
  narrowing), then let inference carry the type inward.
- **`as unknown as T`** is the same problem stated louder: it silences every check the first
  `as` would still have performed.
- **`process.env.X!` read at module scope** turns a missing variable into a crash (or an
  `undefined` propagated as a string) at first use, far from the cause. → validate required
  env vars once at startup and export the result.

## Async correctness

- **A promise that is neither awaited, returned, nor `.catch`ed.** The work races the rest
  of the function and its rejection is unhandled — on current Node an unhandled rejection
  **terminates the process** by default.
- **An async callback passed to `Array.forEach`.** `forEach` ignores the returned promises:
  the loop "finishes" while every iteration is still running, and their rejections are
  unhandled. → `for...of` with `await`, or `Promise.all(items.map(...))`.
- **`Promise.all` where the other rejections must be observed.** It settles on the first
  rejection; the remaining ones become unhandled rejections. → `Promise.allSettled` when
  every outcome matters.
- **`return somePromise()` from inside a `try` block.** Without `await`, the rejection
  happens after the function has already left the `try` — the `catch` never fires, and the
  function is missing from the stack trace. → `return await`.
- **Sequential `await` of independent operations** creates a waterfall. → `Promise.all`.
- **Errors from an EventEmitter cannot be caught by `try`/`catch`** around the call site,
  and an `'error'` event with no listener crashes the process. → subscribe to `'error'`;
  async listeners need the emitter constructed with `{ captureRejections: true }`.

## Resources and lifecycle

- **Handles not released on the error path** — connections, watchers, file descriptors
  acquired before a `throw` and only released at the end of the happy path. → `try`/`finally`
  or explicit resource management (`using`).
- **`.pipe()` without error handling.** `pipe` does not forward errors downstream and does
  not destroy the other streams when one fails; the file descriptor stays open.
  → `stream.pipeline`, which propagates errors and destroys all streams.
- **`setInterval` with no corresponding `clearInterval`** on the shutdown or error path
  keeps the process alive and the closure's captures reachable.
