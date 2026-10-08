// OpenSpec (openspec/changes/<id>/{proposal,design,tasks}.md and specs/<cap>/spec.md) is
// how a growing number of teams write down a change before they make it. Those files say
// what the author intends to build. Read as diff by the requirement axis, they were also
// read as proof that it was built: a ticked "- [x] 1.2 Lock the account after five failed
// codes" in tasks.md anchored as evidence and closed a criterion the code never met.
import { fileKind } from "./lang";

/**
 * A changed text file under a directory named openspec/ (monorepos nest it): a proposal,
 * design, task list or spec. It says what the author intends to build, never that it was
 * built. Lower-case only, as the OpenSpec CLI writes it; a code file under openspec/ stays code.
 */
export function isOpenSpecDoc(path: string): boolean {
  return /(?:^|\/)openspec\//.test(path) && fileKind(path) === "text";
}
