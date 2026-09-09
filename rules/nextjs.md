---
applyTo: "**/*.tsx", "**/*.jsx", "**/app/**/*.ts", "**/app/**/*.js", "**/pages/**/*.ts", "**/pages/**/*.js"
---

# React / Next.js review rules

prloop dedupes tool and model findings downstream — report what you see; pure
formatting/naming-convention output is the only thing left to linters. Below is what needs
judgment in context.

## Server Action security (highest priority)

- **A Server Action must re-verify authorization itself.** This is the most common and most
  severe mistake: once a Server Action is created and exported, **it can be POSTed to
  directly**, bypassing your UI entirely. Checks at the page or layout level **do not** carry
  into the action.
  → Every action must re-confirm identity (authentication) **and resource ownership
  (authorization)** inside itself.
- **Checking identity but not ownership.** Confirming "who you are" is not confirming "this
  record is yours". Any action that takes an id parameter must check that the resource
  belongs to the current user.
- **Unvalidated action arguments.** Input from the client must always be schema validated.
- **Returning whole database records.** Return only the fields the UI needs; do not dump the
  entire row.
- **Authenticating only in middleware / a proxy.** CVE-2025-29927 allows middleware to be
  bypassed entirely by forging the `x-middleware-subrequest` header, so verification cannot
  live there alone.

## Server / Client boundary

- **`'use client'` in a layout or barrel file.** **Every import in that file and every
  component it renders directly get pulled into the client bundle** — one misplaced directive
  turns an entire subtree into client components.
  → Put `'use client'` as deep in the leaves as possible; pass Server Components in via
  children/props.
- **Passing non-serializable values to a Client Component**: functions, class instances,
  complex objects beyond Date.
- **Accessing server-side secrets in a Client Component.** Only `NEXT_PUBLIC_`-prefixed env
  vars reach the client — and conversely, anything carrying that prefix will leak.
- **Using client hooks in a Server Component** (useState, useEffect, useContext).

## Hydration

When a hydration mismatch appears, the cause is almost always one of these:

- `Date.now()`, `Math.random()`, `new Date()`, or user-locale date formatting during render
- reading `typeof window !== 'undefined'` or browser-only APIs during render
- invalid HTML nesting (`<div>` inside `<p>`, `<a>` inside `<a>`, `<button>` inside
  `<button>`)
- external mutable data not sent as a snapshot alongside the HTML

`suppressHydrationWarning` is an escape hatch that applies to one level only. Do not use it to
paper over a real problem.

## useEffect

Most useEffects are unnecessary. When you see an effect, first ask whether it is one of
these:

- **Computing a derived value from props/state** → compute it during render, not effect +
  state
- **Resetting all state when a prop changes** → pass a different `key`, do not reset in an
  effect
- **Sharing logic between event handlers** → extract a function, do not use an effect
- **Sending a POST triggered by a user action** → put it in the event handler
- **Subscribing to an external store** → `useSyncExternalStore`

Data fetching that genuinely needs an effect **must handle the race condition**: an earlier
request can come back later.
→ Set an `ignore` flag in cleanup.

## Other

- **Using the index as a list key**, or `Math.random()` as a key (the latter rebuilds the
  whole DOM and wipes user input).
- **Unsanitized `dangerouslySetInnerHTML` content.** Unless the source is fully trusted, it
  is XSS.
- **`useSearchParams()` without a Suspense boundary** degrades **the entire page** to client
  rendering.
- **`export const dynamic = 'force-static'` makes `cookies()`, `headers()`, and
  `useSearchParams()` silently return empty values** — a very hard bug to track down.
- **Awaiting several independent requests in sequence in one component** creates a waterfall.
  → `Promise.all`.
- **A layout reading runtime data** (`cookies()`, uncached fetch) **does not** fall back to
  the sibling `loading.js`; it blocks navigation outright.
