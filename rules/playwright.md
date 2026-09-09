---
applyTo: "**/*.spec.ts", "**/*.e2e.ts", "**/playwright.config.*"
---

# Playwright review rules

**These rules apply only to Playwright browser end-to-end tests.** Judge each file
separately: for a file that is a vitest or jest unit test, none of these rules apply to that
file and none may be cited against it.

## Missing `await` — the silent pass

- **A web-first assertion without `await`**:
  `expect(page.getByText('welcome')).toBeVisible()`. The assertion returns a promise; the
  test ends before it settles, and **passes without having asserted anything**. A false
  green is worse than a red — nobody investigates a passing test. The same applies to
  unawaited actions (`page.click(...)` without `await`), which race the next step.
  This is the highest-severity finding in this pack. (`eslint-plugin-playwright`'s
  `missing-playwright-await` exists for this; most projects don't install it.)

## Assertions that discard auto-retry

- **`expect(await locator.isVisible()).toBe(true)`** evaluates once, immediately, and cannot
  retry — it fails or flakes on anything that renders asynchronously. Playwright's own
  documentation lists this form as the anti-example.
  → `await expect(locator).toBeVisible()`, which retries until the timeout.

## Locators bound to implementation

- **CSS or XPath selectors** (`.btn-primary > div:nth-child(2)`) break on DOM changes and
  bypass the actionability checks (visible, enabled, stable) that the recommended locators
  perform before acting. → `getByRole`, `getByLabel`, `getByTestId`.

## Tests that are not independent

- **State carried from one test to the next** — a test that assumes a previous test logged
  in or created data. Playwright runs tests in parallel workers by default, so ordering is
  not guaranteed and failures are non-deterministic. → each test sets up its own state in
  `beforeEach`; share expensive setup via fixtures or storage state, not via test order.

## Unmocked third-party calls

- **Tests that hit real external services** inherit their downtime, rate limits, cookie
  banners, and overlays as test failures. → mock the responses with the Network API
  (`page.route`).

## Widely-agreed additions

Community consensus, not in the official docs — word findings accordingly and cap severity
at medium.

- **`page.waitForTimeout(...)` as synchronization.** A fixed sleep is flakiness with a delay
  attached: too short it flakes, too long it slows the suite. → a web-first assertion or an
  explicit wait for the actual condition.
- **`test.only` left in** silently reduces the suite to one test in CI.
- **Branching on page state** (`if (await x.isVisible()) { ... }`) makes the test assert
  different things on different runs.
