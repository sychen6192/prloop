// Renders the PR comments against synthetic data — no Azure DevOps, no model calls.
// Use it to see what a review actually looks like before pointing the tool at a real PR,
// and to eyeball comment wording after changing publish/format.ts.
import { buildHunks, diffLines } from "../libs/diff";
import { renderFindingComment, renderSummary } from "../publish/format";
import type { AnchoredFinding, FileDiff, RequirementResult } from "../libs/types";
import type { ReviewContext } from "../ado/intake";

function mkFile(path: string, rightLines: string[], changed: number[], language: string): FileDiff {
  const leftLines = rightLines.filter((_, i) => !changed.includes(i + 1));
  const { hunks, changedRightLines, changedLeftLines } = buildHunks(
    leftLines,
    rightLines,
    diffLines(leftLines, rightLines),
  );
  return {
    path,
    changeType: "edit",
    hunks,
    rightLines,
    leftLines,
    changedRightLines,
    changedLeftLines,
    binary: false,
    truncated: false,
    language,
  };
}

const files = [
  mkFile(
    "/src/payment/refund_service.py",
    [
      "def process_refund(order_id, amount):",
      "    order = db.get_order(order_id)",
      "    db.begin()",
      "    order.refunded += amount",
      "    gateway.refund(order.payment_id, amount)",
      "    db.commit()",
    ],
    [3, 4, 5, 6],
    "python",
  ),
  mkFile(
    "/app/checkout/page.tsx",
    [
      "export default async function CheckoutPage() {",
      "  const cart = await getCart()",
      "  console.log('cart', cart)",
      "  return <Summary cart={cart} />",
      "}",
    ],
    [3],
    "tsx",
  ),
];

const ctx = {
  ref: { baseUrl: "https://dev.azure.com/contoso", org: "contoso", project: "Shop", repoId: "shop-api", prId: 4821 },
  pr: {
    title: "Support partial refunds in the refund flow",
    description: "Implements partial refunds for PBI #12043.",
    sourceBranch: "feature/partial-refund",
    targetBranch: "main",
    createdBy: "Alice Wu",
    status: "active",
  },
  iterations: [],
  iteration: { id: 3, sourceRefCommit: "", targetRefCommit: "", commonRefCommit: "", createdDate: "" },
  compareTo: 0,
  files,
  skipped: [{ path: "/package-lock.json", reason: "generated/lock/vendor" }],
  changeTrackingIds: new Map(),
} as unknown as ReviewContext;

const req: RequirementResult = {
  workItems: [
    {
      id: 12043,
      title: "Support partial refunds",
      type: "Product Backlog Item",
      state: "Active",
      description: "",
      acceptanceCriteria: "",
      specSource: "acceptance-criteria",
      url: "",
    },
  ],
  criteria: [
    {
      workItemId: 12043,
      criterion: "A user can refund an amount smaller than the order total",
      verdict: "satisfied",
      note: "process_refund takes an amount and adds it to order.refunded.",
      file: "/src/payment/refund_service.py",
      quote: "    order.refunded += amount",
    },
    {
      workItemId: 12043,
      criterion: "Cumulative refunds must not exceed the order total",
      verdict: "missing",
      note: "No code in the diff checks order.refunded against the order total.",
    },
    {
      workItemId: 12043,
      criterion: "Every refund writes an audit log entry with actor and timestamp",
      verdict: "misunderstood",
      note: "Only a console log was added. Not an audit log, and no actor recorded.",
      file: "/app/checkout/page.tsx",
      quote: "  console.log('cart', cart)",
    },
    {
      workItemId: 12043,
      criterion: "Notify the user when a refund fails",
      verdict: "not-verifiable",
      note: "Notification may live in the frontend or a message queue. Not decidable from this change alone.",
    },
  ],
  extras: [
    { claim: "Adds cart debug output on the checkout page, unrelated to the refund requirement.", file: "/app/checkout/page.tsx" },
  ],
};

const findings: AnchoredFinding[] = [
  {
    category: "data-integrity",
    severity: "critical",
    confidence: 0.9,
    file: "/src/payment/refund_service.py",
    quote: "    gateway.refund(order.payment_id, amount)",
    claim: "External payment call sits inside the DB transaction, holding a connection until the RPC returns.",
    evidence:
      "If gateway.refund times out or throws, db.commit() never runs, but the gateway may have already " +
      "refunded, leaving books and DB inconsistent. The connection is also held for the whole RPC, " +
      "exhausting the pool under load.",
    suggested_fix:
      "    db.commit()\n" +
      "    outbox.enqueue(RefundRequested(order.payment_id, amount))",
    sources: ["qwen3-coder"],
    fingerprint: "a1b2c3d4e5f6",
    anchor: { side: "right", startLine: 5, endLine: 5, startOffset: 1, endOffset: 46 },
  },
  {
    category: "leftover-code",
    severity: "medium",
    confidence: 0.95,
    file: "/app/checkout/page.tsx",
    quote: "  console.log('cart', cart)",
    claim: "Debug output left on the checkout page, dumping the full cart.",
    evidence: "Shows up in the browser console in production; cart contents may include personal data.",
    sources: ["qwen3-coder", "devstral-small"],
    fingerprint: "f6e5d4c3b2a1",
    anchor: { side: "right", startLine: 3, endLine: 3, startOffset: 1, endOffset: 28 },
  },
];

const degraded: AnchoredFinding[] = [
  {
    category: "concurrency",
    severity: "high",
    confidence: 0.6,
    file: "/src/payment/refund_service.py",
    quote: "    order.refunded = order.refunded + amount",
    claim: "Refund total is incremented without a lock; concurrent refunds overwrite each other.",
    sources: ["qwen3-coder"],
    fingerprint: "0f0f0f0f0f0f",
    anchorFailure: "quote-not-found",
  },
];

console.log("═".repeat(78));
console.log("  Sticky summary comment (top of the PR, updated in place each run)");
console.log("═".repeat(78));
console.log(
  renderSummary({
    ctx,
    agg: {
      inline: findings,
      belowBar: [],
      degraded,
      stats: { raw: 4, afterDedupe: 3, anchored: 3, survived: 2, refuted: 1, inline: 2, byFailure: { "quote-not-found": 1 }, excluded: 0, dismissed: 0 },
    },
    req,
    finderErrors: [],
    omittedFiles: [],
    appliedRules: ["_base.md"],
    durationSec: 74,
    runDir: "",
  }),
);

for (const f of findings) {
  console.log(`\n${"═".repeat(78)}`);
  console.log(`  Inline comment → ${f.file}:${f.anchor?.startLine}`);
  console.log("═".repeat(78));
  console.log(renderFindingComment(f));
}
