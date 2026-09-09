---
applyTo: "**/*.py", "**/*.pyi"
---

# Python review rules

prloop dedupes tool and model findings downstream — report what you see; pure
formatting/naming-convention output is the only thing left to linters.

What follows needs reasoning that spans functions, requests, or time — the kind no
pattern-matching tool can see.

## The GIL is not a transaction

A single bytecode step is atomic; a sequence of them is not, and the interpreter can switch
threads between any two.

- **Check-then-act on shared state** — `if key not in cache: cache[key] = compute()`,
  `if not self.started: self.start()`, read-modify-write on a counter or dict. Two threads
  both see the "before" state and both act. → hold a lock over the whole sequence, or use a
  single atomic primitive (`dict.setdefault`, `itertools.count`, `queue.Queue`).
- **Assuming operations on built-ins are atomic.** Google's style guide is explicit that they
  are not always: a `dict` whose keys implement `__hash__` or `__eq__` in Python runs
  interpreted code mid-operation, and the switch can land there.
- **Module-level mutable state that holds per-request or per-user data** — a cached current
  user, tenant, request, or session at module scope is shared by every worker thread and every
  concurrent request in the process. It leaks one user's data into another's, and only under
  load. → `contextvars`, or state carried on the request object. A deliberately shared
  connection pool or client singleton is infrastructure, not request state — do not report it.

## async correctness the `ASYNC` rules do not cover

- **`asyncio.create_task()` with the result discarded.** The loop keeps only a weak reference,
  so the task can be garbage-collected mid-flight and the work silently never completes.
  (`RUF006` catches this but is **not** in the default rule set.) → keep the reference in a
  set and discard it from an `add_done_callback`.
- **`await` inside `except` or `finally` during cancellation.** The pending `CancelledError`
  is discarded while the new await runs, so the task refuses to die and shutdown hangs.
  → keep cleanup paths synchronous, or shield them deliberately.
- **`asyncio.gather(...)` without `return_exceptions=True` when every outcome matters.** It
  raises the first exception and the siblings' exceptions are never retrieved — they surface
  later as "exception was never retrieved" warnings, detached from the code that caused them.
- **A coroutine that is never awaited.** The call returns a coroutine object, nothing runs,
  and the only symptom is a RuntimeWarning nobody reads. Most common when an `async def` is
  passed to an API that expects a plain callable.

## Exceptions that change control flow silently

- **`return`, `break`, or `continue` inside `finally`.** The in-flight exception is discarded
  outright — the function returns normally and the error is gone with no trace at all. There
  is no legitimate use of this in production code.
- **`raise NewError(...)` inside `except` without `from`.** The original traceback is lost, so
  the report names the handler instead of the cause. (`B904` is **not** in the default rule
  set.) → `raise NewError(...) from exc`, or `from None` when the chaining is deliberate.
- **`logging.error(...)` in an exception handler.** Records the message without the traceback.
  → `logging.exception(...)`, or `logging.error(..., exc_info=True)`.
- **`assert` used to validate input or enforce a precondition.** Assertions are stripped under
  `python -O`, so the check simply disappears in the deployment that most needs it.
  → raise a real exception.
- **A `try` body far larger than the operation being guarded.** The `except` then also
  swallows failures from lines nobody meant to cover. → narrow the block to the call that can
  actually raise.

## Resource lifetime across error paths

- **A resource acquired before a statement that can raise, released only on the happy path.**
  Connections, cursors, locks, file descriptors, temporary directories. → `with`, or
  `try`/`finally`.
- **A generator that owns an expensive resource.** Cleanup runs only when the generator is
  exhausted or collected; a consumer that breaks early leaves it open indefinitely.
  → wrap the resource in a `with` inside the generator, or use `contextlib.closing` at the
  call site.
- **`__del__` used for cleanup with observable effects.** Timing is not guaranteed, order at
  interpreter shutdown is not guaranteed, and a reference cycle can mean it never runs at all.

## Data model contracts

- **`__eq__` defined without `__hash__`.** Python sets `__hash__` to `None`, so the object
  becomes unhashable and every use as a dict key or set member raises `TypeError`.
  (`PLW1641` is **not** in the default rule set.) → define both, over the same fields, or
  `@dataclass(frozen=True)`.
- **`__eq__` inconsistent with the fields used for ordering or hashing** puts objects into
  containers they can never be found in again.

## Query shape and transaction boundaries

- **A query issued inside a loop over rows** (Django/SQLAlchemy N+1). It passes every test with
  a handful of fixtures and collapses on production volume. → `select_related` /
  `prefetch_related`, `joinedload`, or one batched query.
- **A network call, queue publish, or email send inside a database transaction.** The
  transaction stays open for the whole round trip, and if the commit later fails the external
  effect has already happened and cannot be rolled back. → commit first, then dispatch via an
  outbox.

## Numeric correctness

- **`float` for money or any exact quantity.** → `Decimal`, or integer minor units.
- **`==` between floats.** → `math.isclose`.

## Widely-agreed additions

Community consensus, not tool-enforced — word findings with room for doubt and cap severity
at medium.

- **pandas chained assignment** (`df[df.a > 1]['b'] = 3`). Under Copy-on-Write, the only mode
  from pandas 3.0, this raises `ChainedAssignmentError`. → `.loc`.
- **`inplace=True` on a chained operation** mutates the temporary, leaving the original
  DataFrame untouched. (`PD002` is not in ruff's default set.)
- **A comprehension with several `for` clauses or filters.** Google's style guide draws the
  line at one of each; past that a loop reads better.
- **Mutable global state in general.** If it must exist, module level or class attribute, name
  prefixed with `_`.
