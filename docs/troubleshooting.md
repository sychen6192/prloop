# Troubleshooting

Most of this file is about one thing: **getting a Node process out through a corporate
network**. It is written down in detail because every layer of the problem completely hid the
next one, and each layer on its own looked like a different bug.

Start here — it names the fix for most problems:

```bash
npx tsx scripts/doctor.ts '<PR URL>' --smoke
```

---

**Run `npx tsx scripts/doctor.ts '<PR URL>' --smoke` first.** It names the fix for most problems.

**For certificate problems, run `tlsfix`** — it actually connects using every possible certificate
source and tells you which one works:

```bash
npx tsx scripts/tlsfix.ts '<PR URL>'
```

When you can't connect and doctor isn't clear, use **probe** to test directly:

```bash
npx tsx scripts/probe.ts '<PR URL>'
```

It unfolds what doctor hides: **where each setting actually came from** (`.env` / shell env var /
default), the full assembled URL, raw HTTP status and **the server's own error message**, and finally
tests each api-version to find which one this server accepts.

⚠️ **`.env` never overrides an existing environment variable** (so it can't clobber CI-injected values).
So if your shell has `export PRR_XXX=...`, the same key in `.env` is silently ignored. Section 1 of
probe flags this.

- **On-prem (Azure DevOps Server) won't connect.** Run `doctor <PR URL>` first — it prints the
  **API base** and the **actual request URL**. Those two lines usually show the problem. The API address
  is derived from the PR URL you gave;
  `https://tfs.corp.com/tfs/{collection}/{project}/_git/...` correctly resolves to
  `https://tfs.corp.com/tfs/{collection}` (virtual directory included). Still wrong? Override with
  `PRR_ADO_BASE_URL`.
- **On-prem reports an unsupported api-version.** Each version has a different ceiling: Server 2019 →
  `5.0`, 2020 → `6.0`, 2022 → `7.0`, cloud → `7.1`. Set `PRR_ADO_API_VERSION`.
- **`ECONNREFUSED` / connection refused.** Most often a **corporate proxy**.
  **Node's built-in `fetch` does not read `HTTP_PROXY` / `HTTPS_PROXY`** (curl, git, and pip all do,
  which is why those work and Node doesn't). prloop reads these variables itself and applies them, but
  only if they're set.

  ```bash
  export HTTPS_PROXY=http://proxy.corp:8080
  # Internal hosts (self-hosted model endpoints etc.) must bypass the proxy, or they get routed to the external egress
  export NO_PROXY=localhost,127.0.0.1,.corp.local
  ```

  **To put these in `.env`, use the `PRR_` versions**: `.env` doesn't override existing environment
  variables, so if the shell already has `HTTPS_PROXY`, the same key in `.env` neither takes effect nor
  errors. `PRR_HTTPS_PROXY` / `PRR_NO_PROXY` / `PRR_HTTP_PROXY` take priority over the conventional
  names and always work in `.env`. Section 1 of `probe` shows where each value actually came from.

  Section 1 of `probe` shows the current proxy settings; section 4 says whether the connection is direct
  or via proxy — with a proxy, TLS detection goes through a CONNECT tunnel, so a firewall rejection isn't
  misread as a certificate problem.
- **`proxy refused CONNECT: ... 403`, but git reaches the same host fine.**
  Usually **proxy filtering by User-Agent**: browsers and git allowed, unfamiliar clients blocked. It
  looks like "this host is blocked", but the host is fine — the client identity is what got rejected.

  Section 4b of `probe` tests five header combinations and tells you which one this proxy allows. prloop
  honestly sends `prloop/0.1` by default; if your proxy only allows specific strings, it's your call
  whether to play along:
  ```bash
  export PRR_USER_AGENT="git/2.34.1"
  ```
  This is a workaround for proxy policy — the proper fix is asking network admin to allowlist the tool's
  egress.

  The most useful clue is **how your git gets through**: if it can push and pull against Azure Repos, a
  working route exists. If `git config --global --get https.proxy` differs from `HTTPS_PROXY`, use that
  instead; if git has no proxy set and still works, that host should be direct — add it to `NO_PROXY`.
  A `407` means the proxy wants auth: use `http://user:password@host:port`.
- **TLS certificate errors (corporate TLS interception).** Browser opens it, tool can't connect — almost
  always this. **Node has its own built-in CA list and does not read the OS trust store** — so a
  certificate re-signed by your company's interception appliance (Zscaler, Blue Coat, etc.) is accepted
  by the browser and rejected by Node.

  The "TLS handshake" section of `npx tsx scripts/probe.ts '<PR URL>'` prints the certificate chain the
  server actually presented. If the last issuer isn't a public CA (Microsoft, DigiCert, and the like),
  it's interception, confirmed.

  **The fastest fix** is letting probe extract the certificate itself:

  ```bash
  npx tsx scripts/probe.ts '<PR URL>' --export-ca ./corporate-ca.pem
  # then put the path in .env as PRR_CA_CERTS
  ```

  On verification failure, probe writes the chain the server actually presented as PEM, saving a
  round-trip to IT for the file.
  ⚠️ This comes from the connection as it happened — don't adopt it if whoever intercepted you isn't
  someone you trust. For production use, prefer the corporate root CA from IT.

  **Simplest on Node 24+** — use the system trust store directly, no certificate file:

  ```bash
  export NODE_OPTIONS=--use-system-ca
  ```

  Version differences (all measured):

  | Node version | `--use-system-ca` | Works in `NODE_OPTIONS` |
  | --- | --- | --- |
  | 24+ | ✅ | ✅ Yes, easiest with `npx tsx` |
  | 22.15–23.x | ✅ | ❌ Not allowed, only `node --use-system-ca` directly |
  | 22.14 and below | ❌ No such flag | — |

  This flag only makes Node read the OS trust store; it **does not accept untrusted certificates**
  (measured: still rejects self-signed).

  **Full fix for a real case** (corporate TLS interception environment): the appliance presented only the
  re-signed site certificate — the intermediate was neither in the handshake nor in the system CA bundle.
  Export that intermediate from the browser: open the site → padlock in the address bar → Certificate →
  Certification Path → pick **the middle one** → export as Base64/PEM, then set
  `PRR_CA_CERTS=/path/to/exported.pem` in `.env`.
  `tlsfix` detects automatically whether this is your case.

  **If `az` / `curl` / `git` all work on the same machine and only this tool doesn't**, the cause is
  almost certainly a different trust source: Python and curl read the CA bundle at
  `REQUESTS_CA_BUNDLE` / `SSL_CERT_FILE`; Node only knows its own built-in list. Point Node at the same
  file:

  ```bash
  # .env
  PRR_CA_CERTS=/etc/ssl/certs/ca-certificates.crt   # whatever $REQUESTS_CA_BUNDLE points at
  ```

  `PRR_CA_CERTS` accepts a comma-separated list (a root and its intermediate often arrive as separate
  files) and is attached to the HTTP dispatcher at runtime, so it applies to every entry point —
  `bin/prloop`, `npm run doctor`, a direct `npx tsx`, all of them. `NODE_EXTRA_CA_CERTS` is still
  honoured if you prefer it, but it only works when something exported it before node started.

  Check whether your corporate CA is in that file:
  ```bash
  awk '/BEGIN/{c=""} {c=c $0 RS} /END/{print c | "openssl x509 -noout -subject"; close("openssl x509 -noout -subject")}' \
    /etc/ssl/certs/ca-certificates.crt | grep -i your-company-name
  ```

  To confirm the cause you can temporarily set `NODE_TLS_REJECT_UNAUTHORIZED=0`, but **don't leave it** —
  it disables all certificate verification, which means accepting any man-in-the-middle. Switch back to
  `PRR_CA_CERTS` as soon as you've confirmed.
- **203 / login page error.** PAT invalid or missing scope (needs Code Read & Write). On az CLI, usually
  an expired `az login` or the wrong tenant — rerun `az login`.
- **az errors.** `doctor` shows the current auth mode and az login identity. To force one auth method,
  set `PRR_AUTH_MODE=pat` or `azcli`. az tokens are cached in-process, not fetched per request.
- **Comment landed on the wrong line.** This is the exact problem the tool exists to fix. If it still
  happens, check that finding's `anchor` in `findings.json` and compare against `finder-*-raw.txt` in
  `runs/`: if the model's quote differs from the file content (rewritten indentation or content, say),
  anchoring fails rather than misplacing. If it's genuinely misplaced, report it with that run directory.
- **Lots of findings land in "unlocatable".** Usually the model isn't copying quotes verbatim as
  instructed. First confirm `PRR_LLM_STRUCTURED=1` and that the backend really supports guided decoding;
  weak models comply with formats much less reliably without schema enforcement.
- **Model output won't parse.** The backend doesn't support `response_format`. Switch to vLLM (xgrammar
  guided decoding) or a LiteLLM proxy; or set `PRR_LLM_STRUCTURED=0` to inspect the raw output and adjust.
- **`HTTP 504` (or 502/524) on model calls, usually the biggest diffs.** Not prloop's own deadline —
  that reads `timeout (900s)`. Some hop between prloop and the engine (nginx in front of vLLM, a LiteLLM
  proxy, a corporate gateway) gave up waiting: a buffered completion sends **zero bytes until the whole
  generation is done**, and on a long diff — thinking models especially — that silence outlives the hop's
  idle timeout (60–300s on common gateways). Retrying just waits out the same silence again.

  prloop streams by default (`PRR_LLM_STREAM=1`): bytes flow from the first token, so no hop ever sees an
  idle connection. Confirm streaming works end to end with a manual test —

  ```bash
  curl -N "$PRR_LLM_BASE_URL/chat/completions" -H "Content-Type: application/json" \
    -H "Authorization: Bearer $PRR_LLM_API_KEY" \
    -d '{"model":"<your-model>","stream":true,"messages":[{"role":"user","content":"count to 30 slowly"}]}'
  ```

  `data: {...}` lines arriving **incrementally** = streaming works, the 504 is gone. Everything arriving
  in one burst at the end = the gateway buffers SSE; fix it there (nginx: `proxy_buffering off;` for that
  location, and check `proxy_read_timeout` — time-to-first-token still counts against it when the engine's
  queue is long). If the backend rejects the streaming request outright (a 4xx naming `stream`), prloop
  logs it and falls back to buffered mode for the run — then the only real fix is raising every
  intermediary's response timeout above your slowest generation, or `PRR_LLM_STREAM=0` plus those raised
  timeouts.
- **A finder keeps failing with `truncated at the token limit`, reporting tens of thousands of chars of
  reasoning.** A thinking model is spending the whole `PRR_LLM_MAX_TOKENS` budget on chain of thought and
  never reaching the answer. Don't chase it with a bigger limit: reasoning length is random per call
  (measured on one PR: 11k chars one run, 132k the next, same prompt), and a runaway eats whatever it is
  given — each failure burns minutes and the full budget for zero findings. Fixes, best first:
  - Point `PRR_FINDER_MODELS` at a **non-thinking variant**. Finding + verbatim quoting doesn't need long
    reasoning — precision comes from the downstream gates. Keep the thinking model where reasoning pays:
    the skeptic.
  - Or switch thinking off at the engine for every call:
    `PRR_LLM_EXTRA_BODY={"chat_template_kwargs":{"enable_thinking":false}}` (vLLM / Qwen3 syntax; note it
    applies to the skeptic too).
  - To disable thinking for the finders while keeping it on the skeptic, do it per alias in the
    endpoint's own config (e.g. LiteLLM `extra_body` on the finder alias) instead.
- **Too many comments.** Lower `PRR_MAX_INLINE_COMMENTS`, or raise `PRR_MIN_INLINE_SEVERITY` to `high`.
- **Want to block merge.** Set `PRR_POST_STATUS=1` and add a status check with genre `prloop` / name
  `ai-review` to the branch policy. Don't have a bot cast a -10 vote — it fights the reviewer policy.
- **Big PR, some files not reviewed.** The summary lists what was left out. Raise `PRR_MAX_DIFF_CHARS`
  or the model's context limit.
