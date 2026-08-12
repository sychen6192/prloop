---
applyTo: "**/*"
---

# Structural code smell baseline

Taken from *Refactoring*, chapter 3. Applies to all languages, as the baseline when a repo
has no conventions of its own.

**Two constraints, both mandatory:**

1. **The repo's own conventions always override this baseline.** If project docs
   (CONTRIBUTING, CODING_STANDARDS, CLAUDE.md, etc.) endorse a construct, do not report it,
   even if it is listed as a smell here.
2. **Every smell is a judgment call, not a hard violation.** Word reports with room for
   doubt ("there may be Feature Envy here"), never exceed medium severity, and use the
   maintainability category. Code smells are heuristics by nature; enforcing them as rules
   only produces noise.

Also: anything the linter already covers (formatting, naming conventions, unused variables)
must never be reported from here.

## The 12 smells (what it is → how to fix it)

- **Mysterious Name** — a function, variable, or type name does not reveal what it does or
  what it holds.
  → Rename it; if you cannot think of an honest name, the design itself is muddled.
- **Duplicated Code** — logic of the same shape appears in several hunks or files in this
  change.
  → Extract the shared part and call it from both sides.
- **Feature Envy** — a method accesses another object's data more than its own.
  → Move the method to the data it envies.
- **Data Clumps** — the same few fields or parameters keep appearing together (a type trying
  to be born).
  → Wrap them in a type and pass that type.
- **Primitive Obsession** — a primitive or string represents a domain concept that deserves
  its own type.
  → Give the concept a small type.
- **Repeated Switches** — a switch or if-chain over the same type recurs across the change.
  → Use polymorphism, or have both sites share one lookup table.
- **Shotgun Surgery** — one logical change forces you to edit many scattered files in the
  diff.
  → Pull the things that change together into one module.
- **Divergent Change** — one file or module is modified for several unrelated reasons.
  → Split it, so each module changes for one reason only.
- **Speculative Generality** — abstraction, parameters, or hooks added for requirements that
  are not in the spec.
  → Delete it; inline it back and wait for the real requirement.
- **Message Chains** — long `a.b().c().d()` navigation makes the caller depend on structure
  it should not know about.
  → Hide the traversal behind a method on the first object.
- **Middle Man** — a class or function whose work is mostly forwarding to someone else.
  → Remove it and call the real target directly.
- **Refused Bequest** — a subclass or implementer ignores or overrides most of what it
  inherits.
  → Drop the inheritance; use composition.

## Do not report these from this baseline

- File length of pre-existing code. Look only at **what this change contributes** — a new
  file born oversized, or one that makes an existing file grow significantly, is worth
  raising.
- Suggestions with no concrete gap, like "could add more tests" or "could use more comments".

## Two-axis review (summarized from Matt Pocock's `code-review` skill)

The smell list above is that skill's Standards floor; this section carries the rest of its
method. A review answers two independent questions, and neither may mask the other — code
can follow every convention while implementing the wrong thing, and do exactly what was
asked while breaking the conventions. Check both, always:

- **Standards — is it built right?** The repo's documented standards first (they always
  override), then the smell baseline above. A documented-standard breach may be reported
  as a hard violation; a baseline smell never is.
- **Spec — is it the right thing?** Judge the diff against whatever states the intent —
  the linked issue, spec file, or PR description. Three checks:
  1. Requirements asked for but missing or only partially implemented.
  2. Behavior nobody asked for (scope creep).
  3. Requirements that look implemented, but implemented wrongly.

  Missing or wrong behavior is a `correctness` finding, severity by actual impact; scope
  creep is a judgment call like the smells, `medium` at most.

**Every finding carries a checkable citation** — the standards file and rule, the named
smell plus the offending hunk, or the spec/description line it violates. A finding that
cannot cite one of these is a hypothesis, not a finding: drop it. And when no spec or
description exists, say so — never infer the requirements from the code and then review
the code against them.
