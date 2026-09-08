// Offline self-test for ADO intake's edges — the four places where the API answers with
// something other than the happy path and prloop has historically believed it.
//
//   - a paginated changes response. Page one is a complete answer as far as the shape goes;
//     stopping there silently reviews part of a big PR and says nothing.
//   - a Task with no acceptance criteria. PRs are linked to Tasks; the criteria live on the
//     parent PBI, so the requirement axis has nothing to check unless the walk-up happens.
//   - an HTML sign-in page served with HTTP 200. Injecting that as "the repo's conventions"
//     feeds a login form to the reviewer prompt as if it were the coding standard.
//   - a 401 on a conventions path. Swallowing everything made an auth failure and an
//     ADO outage look exactly like a repo that documents nothing (Phase 2F's isFileMissing).
//
// Shares the fake ADO with selftest-publish.ts and keeps its own file: that one is about
// what prloop WRITES, this one about what it believes when it READS.
import { fakeAdo, type FakeAdoState } from "./fakes/ado";

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    passed++;
    console.log(`  [OK]   ${name}`);
  } else {
    failed++;
    console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function eq<T>(name: string, actual: T, expected: T) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  check(name, a === e, `expected ${e}, got ${a}`);
}

function section(t: string) {
  console.log(`\n${t}`);
}

async function capture<T>(fn: () => Promise<T>): Promise<{ value: T; lines: string[] }> {
  const lines: string[] = [];
  const real = console.log;
  console.log = (...a: unknown[]) => {
    lines.push(a.map(String).join(" "));
  };
  try {
    return { value: await fn(), lines };
  } finally {
    console.log = real;
  }
}

const ado = await fakeAdo();
try {
  process.env["PRR_ADO_BASE_URL"] = ado.origin;
  process.env["PRR_ADO_PAT"] = "test-pat";
  process.env["PRR_NO_PROXY"] = "127.0.0.1";
  process.env["PRR_QUIET"] = "1";

  const { parsePrUrl } = await import("../ado/client");
  const { getIterationChanges, getPrInfo, listIterations } = await import("../ado/iterations");
  const { getLinkedRequirements } = await import("../ado/workitems");
  const { fetchRepoConventions, CONVENTION_PATHS } = await import("../ado/conventions");

  const ref = parsePrUrl("https://dev.azure.com/contoso/Shop/_git/shop-api/pullrequest/4821");
  const setState = (partial: Partial<FakeAdoState>) => {
    Object.assign(ado.state, partial);
    ado.reset();
  };

  section("PR metadata: the shapes ADO returns, not the ones the pipeline wants");
  {
    setState({
      pr: {
        title: "Support partial refunds",
        description: "d",
        sourceRefName: "refs/heads/feature/partial-refund",
        targetRefName: "refs/heads/main",
        createdBy: { displayName: "Alice Wu" },
        status: "active",
      },
      iterations: [
        { id: 1, sourceRefCommit: { commitId: "aaa" }, targetRefCommit: { commitId: "bbb" }, createdDate: "2026-01-01T00:00:00Z" },
        { id: 2, sourceRefCommit: { commitId: "ccc" }, targetRefCommit: { commitId: "ddd" }, commonRefCommit: { commitId: "eee" }, createdDate: "2026-01-02T00:00:00Z" },
      ],
    });
    const pr = await getPrInfo(ref);
    eq("refs/heads/ is stripped from the source branch", pr.sourceBranch, "feature/partial-refund");
    eq("...and the target", pr.targetBranch, "main");
    eq("the author is flattened out of its object", pr.createdBy, "Alice Wu");

    const iterations = await listIterations(ref);
    eq("every iteration is returned, newest last", iterations.map((i) => i.id), [1, 2]);
    eq("commit ids are flattened", iterations[1]?.sourceRefCommit, "ccc");
    // A missing commonRefCommit must be "" rather than undefined: intake passes it straight
    // into a URL, where undefined becomes the string "undefined" and fetches a nonexistent ref.
    eq("a missing commit is an empty string, never undefined", iterations[0]?.commonRefCommit, "");
  }

  section("paged iteration changes: page one is not the answer");
  {
    // ADO caps a page at $top=2000 and hands back the $skip for the next one. A PR that
    // touches more files than that is rare but real (a lockfile-wide refactor, a generated
    // client regenerated) — and getting only page one means reviewing part of a change while
    // reporting on all of it.
    const TOP = 2000;
    const page1 = Array.from({ length: TOP }, (_, i) => ({
      changeTrackingId: i + 1,
      changeType: "edit",
      item: { path: `/src/gen/f${String(i).padStart(4, "0")}.ts`, objectId: "o1", originalObjectId: "o0" },
    }));
    const page2 = [
      { changeTrackingId: 9001, changeType: "add", item: { path: "/src/last.ts", objectId: "o2" } },
      // Folders arrive in the same list and must not become review targets.
      { changeTrackingId: 9002, changeType: "add", item: { path: "/src/newdir", isFolder: true } },
      { changeTrackingId: 9003, changeType: "add", item: { path: "/src/otherdir", gitObjectType: "tree" } },
      // An entry with no path at all: nothing can be fetched or anchored for it.
      { changeTrackingId: 9004, changeType: "edit", item: {} },
    ];
    setState({ changePages: [{ changeEntries: page1, nextSkip: TOP }, { changeEntries: page2 }] });

    const entries = await getIterationChanges(ref, 2, 1);
    eq("both pages are collected", entries.length, TOP + 1);
    eq("...page one's first entry is there", entries[0]?.path, "/src/gen/f0000.ts");
    check("...and page two's real entry is too", entries.some((e) => e.path === "/src/last.ts"));
    check("folders are dropped (isFolder)", !entries.some((e) => e.path === "/src/newdir"));
    check("...and folders that only say gitObjectType=tree", !entries.some((e) => e.path === "/src/otherdir"));

    const asked = ado.matching("GET", /\/changes$/);
    eq("exactly two requests, not one and not a loop", asked.length, 2);
    eq("the first page starts at 0", asked[0]?.query["$skip"], "0");
    eq("...and the second uses the skip the API handed back", asked[1]?.query["$skip"], String(TOP));
    eq("the incremental comparison point is forwarded", asked[0]?.query["$compareTo"], "1");
    eq("...and so is the page size", asked[0]?.query["$top"], String(TOP));

    // A single short page is one request: continuing on a page that was not full would loop
    // forever against a server that always echoes nextSkip.
    setState({ changePages: [{ changeEntries: page2, nextSkip: 4 }] });
    const short = await getIterationChanges(ref, 2);
    eq("a short page ends the walk even when nextSkip is set", ado.matching("GET", /\/changes$/).length, 1);
    eq("...and yields what it held", short.length, 1);
  }

  section("Task → parent PBI: where acceptance criteria actually live");
  {
    // A PR is linked to the Task; the criteria are on its parent PBI. Without the walk-up the
    // requirement axis reports "no acceptance criteria" on a work item that has them, which
    // reads as "nothing to check" rather than "I looked in the wrong place".
    setState({
      workItemRefs: [501],
      workItems: {
        501: {
          id: 501,
          fields: { "System.Title": "Wire up the refund endpoint", "System.WorkItemType": "Task", "System.State": "Active" },
          relations: [{ rel: "System.LinkTypes.Hierarchy-Reverse", url: "https://dev.azure.com/contoso/_apis/wit/workItems/900" }],
          _links: { html: { href: "https://dev.azure.com/contoso/_workitems/edit/501" } },
        },
        900: {
          id: 900,
          fields: {
            "System.Title": "Support partial refunds",
            "System.WorkItemType": "Product Backlog Item",
            "System.State": "Active",
            "Microsoft.VSTS.Common.AcceptanceCriteria": "<div>A user can refund less than the total</div>",
          },
        },
      },
    });
    const { value: linked } = await capture(() => getLinkedRequirements(ref));
    eq("the linked Task and its parent both come back", linked.items.map((w) => w.id), [501, 900]);
    eq("...and the parent is named as the source of the criteria", linked.inheritedFrom, [900]);
    eq("the criteria are flattened out of their HTML", linked.items[1]?.acceptanceCriteria, "A user can refund less than the total");
    eq("...and labelled as real acceptance criteria", linked.items[1]?.specSource, "acceptance-criteria");
    eq("the Task keeps its own (empty) criteria", linked.items[0]?.acceptanceCriteria, "");
    eq("the parent is fetched, so exactly two work-item reads", ado.matching("GET", /\/wit\/workitems$/).length, 2);

    // The walk-up is conditional. A Task that carries its own criteria must not drag its
    // parent's in: a PBI's criteria span several PRs, and judging this diff against all of
    // them is the false-accusation generator the axis already had to retire once.
    setState({
      workItemRefs: [502],
      workItems: {
        502: {
          id: 502,
          fields: {
            "System.Title": "Refund cap",
            "System.WorkItemType": "Task",
            "Microsoft.VSTS.Common.AcceptanceCriteria": "<p>Refunds stop at the order total</p>",
          },
          relations: [{ rel: "System.LinkTypes.Hierarchy-Reverse", url: "https://dev.azure.com/contoso/_apis/wit/workItems/900" }],
        },
        900: { id: 900, fields: { "System.Title": "parent", "Microsoft.VSTS.Common.AcceptanceCriteria": "<p>everything else</p>" } },
      },
    });
    const { value: own } = await capture(() => getLinkedRequirements(ref));
    eq("a Task with its own criteria stands alone", own.items.map((w) => w.id), [502]);
    eq("...nothing is inherited", own.inheritedFrom, []);
    eq("...and the parent is never fetched", ado.matching("GET", /\/wit\/workitems$/).length, 1);

    // A Bug states what it wants in ReproSteps. The text is used, and WHERE it came from is
    // carried with it: repro steps describe the defect, so asking "is this step implemented?"
    // of a fix answers "missing" every time (the prompt asks a different question instead).
    setState({
      workItemRefs: [503],
      workItems: {
        503: {
          id: 503,
          fields: {
            "System.Title": "Refund double-charges",
            "System.WorkItemType": "Bug",
            "Microsoft.VSTS.TCM.ReproSteps": "<ol><li>Refund twice</li></ol>",
          },
        },
      },
    });
    const { value: bug } = await capture(() => getLinkedRequirements(ref));
    eq("a Bug's repro steps stand in for criteria", bug.items[0]?.acceptanceCriteria, "1. Refund twice");
    eq("...and are labelled as repro steps, not criteria", bug.items[0]?.specSource, "repro-steps");

    // No linked work item is the ordinary case, and costs nothing.
    setState({ workItemRefs: [], workItems: {} });
    const { value: none } = await capture(() => getLinkedRequirements(ref));
    eq("a PR with no linked work item reads nothing more", none.items.length, 0);
    eq("...and does not call the work item API at all", ado.matching("GET", /\/wit\/workitems$/).length, 0);
  }

  section("repo conventions: a sign-in page is not a coding standard");
  {
    // An auth redirect serves an HTML login form with HTTP 200. Injected into the review
    // prompt as "the repository's conventions", it is worse than fetching nothing: the model
    // is handed a page of markup and told the repo's standards override the baseline.
    setState({
      items: {
        "/CONTRIBUTING.md": { status: 200, body: '<!DOCTYPE html>\n<html><body><form>Sign in to Azure DevOps</form></body></html>', contentType: "text/html" },
        "/CLAUDE.md": { body: "# House rules\n\nNo empty catch blocks.\n" },
      },
    });
    const { value: docs, lines } = await capture(() => fetchRepoConventions(ref, "tgt3"));
    eq("only the real document is kept", docs.map((d) => d.path), ["/CLAUDE.md"]);
    check("...with its text intact", (docs[0]?.text ?? "").includes("No empty catch blocks"));
    check("the HTML page is not reported as a failure either — it answered 200", !lines.some((l) => l.includes("[WARN]")), lines.join(" | "));
    eq("every known convention path is tried", ado.matching("GET", /\/items$/).length, CONVENTION_PATHS.length);

    // A blank file is the same non-answer as no file: nothing to inject, nothing to warn about.
    setState({ items: { "/AGENTS.md": { body: "   \n\n" } } });
    const { value: blank } = await capture(() => fetchRepoConventions(ref, "tgt3"));
    eq("an empty document adds nothing", blank.length, 0);
  }

  section("repo conventions: a 404 is silence, a 401 is a failure that must be said");
  {
    // Swallowing every error made a scope-less PAT, an ADO outage and six exhausted timeouts
    // look exactly like a repo that documents nothing — so the repo's own standards vanished
    // from every review prompt and nothing said a word.
    setState({ items: {} });
    const { value: missing, lines: quiet } = await capture(() => fetchRepoConventions(ref, "tgt3"));
    eq("a repo that documents nothing yields nothing", missing.length, 0);
    check("...silently: a 404 is the normal case", !quiet.some((l) => l.includes("[WARN]")), quiet.join(" | "));

    setState({ items: { "/CLAUDE.md": { status: 401, body: "" } } });
    const { value: denied, lines: warned } = await capture(() => fetchRepoConventions(ref, "tgt3"));
    eq("a 401 still yields no document", denied.length, 0);
    const warning = warned.find((l) => l.includes("[WARN]")) ?? "";
    check("...but it is reported", warning.includes("repo conventions"), warned.join(" | "));
    check("...counted against the paths tried", warning.includes(`1 of ${CONVENTION_PATHS.length}`), warning);
    check("...naming the path and the status", warning.includes("/CLAUDE.md") && warning.includes("401"), warning);
    check("...and saying what the review lost", warning.includes("missing from this review"), warning);

    // Reported ONCE, not once per path: six failing paths are one problem.
    setState({ items: Object.fromEntries(CONVENTION_PATHS.map((p) => [p, { status: 401, body: "" }])) });
    const { lines: allDenied } = await capture(() => fetchRepoConventions(ref, "tgt3"));
    eq("six failures are one warning, not six", allDenied.filter((l) => l.includes("[WARN]")).length, 1);
  }
} finally {
  await ado.close();
}

console.log(`\nResult: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
