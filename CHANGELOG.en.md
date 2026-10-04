# Changelog

This file records notable changes to dsh-approval-gate. Version numbers follow [Semantic Versioning](https://semver.org/).

> Chinese version: see [CHANGELOG.md](CHANGELOG.md).

## [0.9.6] — 2026-10-04

**Approval records can finally answer "did this touch inside or outside the workspace?"**: deterministic absolute-path extraction and target localisation land, so command-flavoured tools (`pwsh` / `bash`) no longer lose their absolute paths, and relative fragments in the model's prose no longer masquerade as targets.

This is the **prerequisite step** of the "fewer human approvals" line, not an approval rule itself: only once "all targets are inside the workspace" can be answered reliably is the next step (auto-approve in-workspace operations) safe to build. **The deterministic decision logic is untouched** — hard deny, dangerous keywords, the allowlist, learning and every allow/escalate branch are unchanged. The one behavioural surface that does move is the **judge's input, which now carries real path evidence** (see below); the judge's verdicts may therefore shift. That cannot be verified offline and must be observed on live traffic after a restart.

### Background (real-log forensics)

A command like `cd D:\GitHub_Clone\x; git push origin main` clearly contains an absolute path, yet write-target extraction required a "write-shaped" command and therefore returned nothing; the recorded event fell back to regex-scraping the **model's prose**:

- Of 628 real events carrying a command, **458 (73%) recorded no absolute path at all**
- The recorded "targets" were relative fragments — `IamNewHands/dsh-approval-gate`, `origin/main`, `.git/objects` — which cannot be localised, so "did the model read outside the workspace?" was unanswerable
- Read-only targets (`Get-Content`) were lost the same way, leaving the judge's `filesystemEffects` empty and forcing it to guess from wording

### Changes

- **`src/paths.mjs` gains three pure functions** (no IO, unit-testable):
  - `extractAbsolutePaths(text)` → `{ raw, path, kind }[]`: recognises only four absolute shapes (drive / UNC / POSIX root / `~`), with `kind` ∈ `data` / `program` / `device`
  - `classifyPathScope(paths, roots)` → `{ scope, inside, outside }` where `scope` ∈ `inside` / `outside` / `mixed` / `unknown`
  - `hasPathTraversal(text)`: detects `..\` / `../` traversal
- **Only absolute paths are extracted**: `origin/main`, `refs/heads/x`, `src/a.ts`, `IamNewHands/repo` and URL path segments produce no target — they cannot be localised on their own and would only create a false "looks in-workspace" impression
- **Quoted spans win**: `'C:\Program Files\Git\bin\bash.exe'` is no longer truncated to `C:\Program`, and the Git-Bash form `/d/GitHub_Clone/x` is folded onto `D:` before comparison
- **System program locations and device pseudo-files are not data targets**: `/usr/bin/env`, `C:\Windows\System32\…`, `C:\Program Files\…`, `/dev/null` do not take part in localisation — otherwise `bash.exe` would make a purely in-workspace operation look like "outside the workspace"
- **`src/index.mjs` gains `resolveToolCallTargets()` and `targetScopeOf()`**: command tools yield targets even when read-only; events gain `targets` (absolute, max 12), `targetScope` and `targetTraversal`
- **`files` semantics deliberately unchanged**: it still holds write targets only (for pre-change snapshots). Read-only targets go to `targets` alone — otherwise `Get-Content ~/.ssh/id_rsa` would copy private-key content into the gate's own snapshot directory, creating a new leak surface
- **The judge's input gains real paths**: `filesystemEffects` is now "absolute paths found in the command ∪ write targets", so `cd D:\ws\x; git push` is no longer sent as "touches no files"
- **New "target location" row in the field table** (`src/zh.mjs` + `client.js`): `工作区内` / `工作区外` / `跨工作区内外` / `无法定域（没有绝对路径）`, colour-coded as a warning when not `inside`; the host card's plain text gains a `目标：…` line. This is a different axis from "blast radius" (sandbox mode), hence a separate row

### Fail-closed boundaries (deliberately conservative)

| Case | Result | Why |
|---|---|---|
| No `data` target at all | `unknown` (**not** `inside`) | Relative fragments and paths built from variables (`-D $dir`) are unknown; `unknown` must be treated exactly like `outside` |
| A `..` traversal with all literal paths in-workspace | Degraded to `unknown` | `cd D:\ws\x; Get-Content ..\..\Users\me\.ssh\id_rsa` yields only in-workspace paths; reporting `inside` would be a dangerous false negative |
| URL path segments, `owner/repo` prose | No target produced | Not filesystem targets |

### Replay verification (real logs, not projection)

- **30 days (1184 events, 628 with a command)**: scope `inside` 475 / `mixed` 29 / `outside` 131 / `unknown` 549. Of the 276 events that previously had relative fragments only, **138 (50%) are now localisable**
- **Last 7 days (488 events, 430 with a command)**: `inside` 309 / `mixed` 20 / `outside` 82 / `unknown` 77. Of the 145 fragment-only events, **99 (68%) are now localisable**
- Auto-approved events (869 over 30 days) by the new scope: `inside` 423 / `outside` 61 / `mixed` 25 / `unknown` 364 — the first time this distribution can be produced at all

### Known limits and residual risk (stated up front)

- **Embedded text can produce phantom targets**: when a command embeds script or config bodies (YAML inside a Python heredoc), POSIX-root-shaped false paths such as `/build-app.yml` may appear. This only makes localisation **more conservative** (`outside`), never a false `inside`
- **The recorded `command` is truncated at 400 characters**: targets of very long commands may be missed — this affects the audit record only; live decisions use the full command
- **The deterministic verdict logic is unchanged**: `unknown` and `outside` currently do not affect allow/escalate at all; they only feed the audit. **The judge's input did change, though** (`filesystemEffects` grew from "write targets" to "absolute paths in the command ∪ write targets"), so the judge layer may rule differently on command-flavoured calls — the direction should be more accurate (no more guessing from wording), but it cannot be measured offline and needs live traffic to confirm

### Next (not yet implemented)

Allow-by-scope (all targets inside ⇒ auto-approve; one outside ⇒ human), anchoring git by command, always-human for anything outside the workspace, and always-human for sensitive path shapes. The replay shows **11 of the last 7 days' 13 distinct human approvals had all targets inside the workspace** — that is the near-term ceiling of that lever.

## [0.9.5] — 2026-10-04

**DSH's own configuration changes no longer prompt a human**: profile / plugin / dependency edits under `$DSH_HOME` auto-approve (two exceptions still escalate). This **reverses** the 2026-09-18 "writes under `DSH_HOME` always require a human" decision, based on the user's 2026-10-04 policy and real-log measurements.

### Background and policy

The user's goal is **fewer human approvals**. The tiering they asked for:

| Area | Treatment |
|---|---|
| Operations inside the workspace | no approval needed (low risk) |
| git operations | no approval needed (low risk) |
| **DSH's own configuration changes** | **no approval needed (low risk)** ← delivered here |
| Anything else, anywhere else | keep the human, above all to stop the model reading extra sensitive files and leaking them |

Measurements (`$DSH_HOME/auto-approve/{audit.log,events.jsonl}`, 30 days 2026-09-05 → 10-04):

- Totals: 1178 events, 869 auto-approvals (73.8%), 145 human prompts (**100% approved, 0 rejected**), 11 silent rejections
- **The last 7 days had only 36 human prompts, 20 of them (56%) DSH config edits** — `cordis.patch.yml`, profile `package.json`, `pnpm-workspace.yaml`, the profile directory
- Of the auto-approvals, only 21 touched a real out-of-workspace path, all of them work the user explicitly asked for (Clash AppData 16 / DSH 4 / OpenViking 1); **zero** sensitive-file reads were auto-approved

### Changes

- **`src/index.mjs`: new `dsh-config` tier in the hard-fact layer** (`hardDenyFacts` returns `'dsh-config'`): a target under `$DSH_HOME` auto-approves. **The tier runs after the DENY layer**, so an irreversible keyword still escalates first (dangerous keywords always outrank it)
- **Two exceptions still escalate** (`DSH_CONFIG_EXCLUDE_RE`):
  1. **The gate's own data directory** `$DSH_HOME/auto-approve/` — rules / audit / learning / snapshots. Rewriting it means allowing itself; a safety component must not be rewritable by what it guards
  2. **Credential-named files**: `api-key` / `apikey` / `token` / `secret` / `credential` / `password` / `keyring` / `.env` / `.npmrc` / `.netrc` / `.git-credentials` / `id_rsa` / `id_ed25519` / `*.pem` / `*.key` / `*.pfx` / `*.p12` / `login data` / `cookies` — this one answers the user's "stop the model reading sensitive files" concern
- Auto-approvals are recorded as `verdict: 'dsh-config'` (audit `ALLOW … (dsh-config: DSH_HOME path …)`), shown in the UI as "DSH 配置（自动放行）"
- **Agent guidance** gained one line: DSH's own configuration can be edited directly without asking first (credential files and the gate's own data excepted), so the model stops pre-asking pointlessly
- The client's `VERDICT_NEUTRAL` set includes `dsh-config` (routine auto-approval colouring)

### Replay verification (real log, not estimation)

- The last 7 days' 20 DSH-config prompts → **all 20 now auto-approve**, with 0 exception hits
- 12 distinct `$DSH_HOME` paths appear in the 30-day log: 10 auto-approve (`cordis.patch.yml` 52×, `package.json` 31×, profile dir 30×, `skills/` 9×, `pnpm-workspace.yaml` 8×, `pnpm-lock.yaml` 8×, `node_modules/dsh-approval-gate` 7×, the `.dsh` root 4×, `node_modules/dsh-win-notify` 2×) and 2 still escalate (`auto-approve/allowlist.json` 5×, `auto-approve` 1×)
- **No** path covered by the new exceptions appears in the real log — both exceptions are a pure safety net, not part of today's benefit

### Residual risk (deliberate, stated plainly)

- `$DSH_HOME/skills/**` is auto-approved too. Skills are **instructions for future turns**, i.e. a self-modification surface; the user maintains skills themselves, so it rides along with "DSH config is low risk". To narrow it, add a segment to `DSH_CONFIG_EXCLUDE_RE`
- `profiles/*/node_modules/**` holds plugin code (including this plugin). Writing it only takes effect **after a restart**, the user's workflow reinstalls from git, and `auto-approve/` stays human — so "rewrite the rules to allow myself" is not opened

### Regression tests

- `test/absorbed.test.mjs` case 4: tier assertions became "reject credentials/system paths → `dsh-config` profile config / package.json / skills → `human` the gate's own dir / `api-key.json` / `.env`"
- `test/pipeline.test.mjs` case 3: its target is now the **gate's own data directory** (still human); case 3b was rewritten as **the three boundaries of the DSH-config tier**: ① a profile edit auto-approves with zero judge calls, recorded as `dsh-config` and never counted; ② the gate's own data directory still escalates; ③ with a dangerous keyword the DENY layer outranks the dsh-config tier (event `path === 'deny'`)
- docs/GUIDE (zh/en): pipeline diagram, the three hard-fact tiers, security-design item 1 and the test table all updated

### Compatibility

- **Reverses the 2026-09-18 decision**: `$DSH_HOME` targets are no longer "always human". The home root, other out-of-workspace paths, dangerous keywords and credential exfiltration behave **exactly as before**
- No config migration, no `allowlist.json` edit needed; `version` stays 4
- No interaction with the 0.9.4 scope model: `dsh-config` is a deterministic allowance at pipeline step 1b — it writes no rule and counts nothing

## [0.9.4] — 2026-10-04

**Scope becomes a choice**: a new approval can be specified as "this once / this session / global" (session by default), and **the legacy learned rules that 0.9.3 retired go back to being global** (user decision, 2026-10-04).

### Background

To close the cross-session poisoning path, 0.9.3 did two rather strict things: (1) owner-less sedimented / re-approval rules were **retired** outright, and (2) every approval-produced rule applied only inside its session. That blocked the poisoning, but it also threw away the whitelist the user had already built up. This release follows the user's decision: migrate the existing rules back to global, and make scope a per-approval choice going forward.

### Changes

**Scope model (src/index.mjs)**

- New `ruleScope(rule)` is the **single owner** of scope interpretation: `'global'` / `'session'` / `'none'`
  - explicit `scope:'global'` → global (a new approval chose "global", or the rule was promoted from a session rule)
  - explicit `scope:'session'` → requires a `sessionId`; **without an owner it returns `'none'` (never matches)** — fail-safe: an unprovable owner must never be upgraded into a global allowance
  - no `scope`: with a `sessionId` → session scope (rules created during 0.9.3); without one → **global** (legacy sediment / re-approval / judge-unavailable rules, rules you wrote, repository-seed rules, built-in defaults)
- `ruleUsableInSession()` now reads `ruleScope()`; the previous description-prefix retirement heuristic (`LEARNED_RULE_DESC_RE`) is deleted

**A new approval's scope (three options)**

- The reconsider endpoint accepts `scope: 'once' | 'session' | 'global'` (defaulting to the settings-page sediment scope)
  - `once`: **writes no rule**, grants a one-shot allowance that only covers the AI's retry; the grant is consumed on use (in-memory only — after a restart the retry itself is gone, so no stale state can linger)
  - `session`: writes a session-scoped rule with its owner (previous behaviour)
  - `global`: writes a global rule — explicitly chosen by the user, so no session owner is required
- The settings page's ② allow-list card gained "new approval sediment scope": **this session (default) / global**, deciding where automatic sediments (learning threshold reached, judge-unavailable approval) are written
- Allow-list rows show a scope tag (全局 / 本会话) and session rules offer a one-click **"提升为全局"** (new API `op=promote`, idempotent — an already-global rule returns `already`)

**UI**

- The re-approval action became three buttons: **仅本次 / 本会话 / 全局** (in both the notice strip and the history row, each with a tooltip); the notice action area now wraps
- History rows annotate the scope used when reconsidering: `已追认放行 · …（仅本次）` / `（已写入本会话规则）` / `（已写入全局规则）`; the events API now ships `reconsiderScope`
- Auto-approval events gained two verdict labels: `once` (追认 · 仅本次放行) and `learned-judge-unavailable` (已确认操作，判定器不可用)

### Regression tests

- `test/session-scope.test.mjs` rewritten into 9 sections: scope semantics table (including "session scope without an owner never matches"), session rules allowing only their owner, **legacy learned rules applying in every session**, denyRules still global, "this once" writing no rule and expiring after one use, re-approval session/global each behaving as chosen, one-click promotion, and the sediment-scope setting deciding the layer
- `test/reconsider.test.mjs` case 5b: now asserts the `scope` / `sessionScoped` / `sedimentScope` annotations and that an owner-less legacy learned rule reports `scope === 'global'`
- `test/client-render-smoke.test.mjs`: case 6c now covers the scope tags, the promote button and the sediment-scope setting; case 3c additionally asserts the "（仅本次）" annotation; the re-approval button assertions follow the three scopes

### Compatibility

- **The 0.9.3 retirement is reverted**: owner-less sedimented / re-approval rules already in `allowlist.json` apply globally again, with no migration needed
- Rules created **during 0.9.3** that carry a `sessionId` stay session-scoped (no `scope` field means session), so this change does not widen them into globals
- Rules you wrote (description `用户自定义`), repository-seed rules and built-in defaults were always global and stay that way
- No schema migration; `allowlist.json` stays at `version: 4`

## [0.9.3] — 2026-10-03

> ⚠️ This release's "owner-less learned rules are **retired**" and "approval rules always apply only inside their session" were **superseded by 0.9.4**: existing rules are global again and a new approval picks its own scope (session by default). See the entry above.

**Approvals only apply to the session that earned them**: learning counters and the allow rules they sediment are no longer shared across sessions; the API origin fence also gained scheme and port comparison. Addresses upstream issue #4 P0-2 and P0-3.

### Problem

- **Learning state is global, so it can be farmed into a global rule** (issue #4 P0-2): the `learning.json` counter key was just `tool|mode|category` with no session, so any session could repeat one operation, get it confirmed a few times by a human, and sediment an **allow rule written into `allowlist.json` that then applied to every session**. An out-of-control or malicious session could poison the global allowlist that way — which is exactly how the "dangerous operations go to a human" chain gets bypassed. Rules written by re-approval ("approve again") were global too
- **The origin check compared hostnames only** (issue #4 P0-3): the old code was `u.hostname === host.split(':')[0]` — it never compared the scheme or the port, so "same name" was enough: `https://` pages, pages on any port, and `javascript:` / `data:` origins all passed. On the fallback path (no `connection` service loaded) that left the destructive endpoints (rules / setup / revert / snapshots-clear) exposed to cross-origin pages

### Changes

**Scope (src/index.mjs)**

- The learning counter key became `sessionId|tool|mode|category`: confirmations accumulate only inside the session that produced them
- Allow rules gained an optional `sessionId`; new `ruleUsableInSession()` / `rulesForSession()`: a rule with a `sessionId` applies only in its owning session
- **Legacy owner-less learned rules are retired**: rules whose description starts with `自动沉淀：`, `判定器不可用，人工批准后沉淀：` or `用户追认：` cannot prove which session they belong to, so they no longer participate in matching in any session (they are exactly the existing cross-session allowances). User-authored rules (description `用户自定义`), repository-seed rules and built-in defaults stay global — those are *configuration*, not *approval*
- **denyRules stays global on purpose** (deliberate asymmetry): on the rejection side, crossing sessions only ever adds one more human prompt and never auto-approves anything, so global is the safer side
- Rules written by the reconsider endpoint now carry a `sessionId` (from the event, falling back to the request body); when neither has one the endpoint returns 400 so the user can hand-write a whitelist rule instead of persisting a rule with no definable scope
- Rule de-duplication and deletion now go through `sameAllowRule()` (session dimension included): otherwise session B's sediment would be judged "already present" and silently reuse session A's rule, showing up as "I approved it but it still asks a human"
- Because session prefixes make learning keys grow with the number of sessions, there is now a 400-key cap (oldest evicted by insertion order); every write goes through `saveLearning()`

**Origin fence (src/index.mjs)**

- An origin must be **literally same-origin with the request's own `Host` (scheme + host + port)**; the only exception is "the request's Host is loopback *and* the origin is a loopback alias", which covers 127.0.0.1 / localhost / [::1] across ports
- Non-`http(s)` origins (`javascript:` / `data:` / `null`) are rejected outright
- The scheme comes from `req.socket.encrypted`, then `x-forwarded-proto`; **when neither is available the scheme is not compared** (forcing http on a reverse proxy that does not set the header would 403 the user's own https settings page)
- The residual risk is written down: a DNS-rebinding page is *literally* same-origin with the local service (both Origin and Host are the attacker's domain), so no Origin comparison can spot it; the real defence is `connection.requestRejection`'s credential fence (a rebinding page cannot obtain the session cookie scoped to 127.0.0.1)

**Settings page (client.js)**

- Allowlist card: tags are now "本会话沉淀" / "旧沉淀 · 已停用" / "用户", each learned row shows its owning session (truncated to 12 chars), and the card explains that approval-produced rules apply only to the session that produced them
- Deleting a rule now sends its `sessionId` (two sediment rules with the same signature but different owners are two distinct rules)
- Learning card: the key prefix is formatted by the host (new `describeLearnKey()`: `sessionId|tool|mode|category` → `tool|mode|category · 会话 xxx`), and the card states that counting is per session
- The rules snapshot gained `sessionScoped` / `legacyInactive` annotations so the UI can tell "in effect" from "retired"

### Regression tests

- `test/session-scope.test.mjs` (new): scope semantics table (own session / another session / legacy learned / user-authored / shipped), an end-to-end "a sediment rule only allowlists its owning session", legacy learned rules being dead everywhere, user-authored global rules unaffected, denyRules still global, and the learning key being persisted with its session prefix
- `test/origin-fence.test.mjs` (new): 8 allowed origins (same-origin / loopback cross-port / loopback alias / LAN / reverse proxy) and 7 rejected ones (cross-origin / port mismatch / scheme mismatch / `javascript:` / `data:` / `null` / cross-origin Referer), plus an explicit assertion of the rebinding residual and its credential-fence counterpart
- `test/pipeline.test.mjs` case 10c: the learning fixture is now keyed per session, with a new "another session does not inherit it" assertion (removing the session prefix turns it red immediately)
- `test/reconsider.test.mjs`: new case 5b (snapshot annotations) and case 8 (no session owner → 400 without writing a rule); case 4 now also asserts the rule carries a `sessionId`
- `test/client-render-smoke.test.mjs`: new case 6c (the three scope tags plus the scope explanation)

### Compatibility

- **Existing data behaves differently on purpose**: the legacy auto-sedimented / judge-unavailable / re-approval rules already in `allowlist.json` **stop applying**, and the settings page labels them "旧沉淀 · 已停用"; legacy global learning keys in `learning.json` (without a session prefix) are no longer read. For an allowance that should apply everywhere, write a "用户自定义" allowlist rule instead (user-authored rules stay global)
- No schema migration and no config edit needed; `allowlist.json` stays at `version: 4`
- Reverse proxies and LAN access are unaffected: same-origin and loopback aliases still pass; only previously mis-allowed origins such as "same name, different port" now get a 403

## [0.9.2] — 2026-10-03

The settings page now has a "judge model" entry: the judging model can be picked from the UI instead of hand-editing `allowlist.json` (the settings UI is ported from upstream PR #11, `@sunligh91`).

### Problem

- **Configurable but not reachable**: `judgeModel` (decoupling the judge from the main model) has been supported on the backend all along — `applyRuleOp` writes it, `judgeModelCandidates` uses it to order the candidate chain, `migrateJudgeModel` migrates the legacy field — yet the settings page had **no** such field at all (`client.js` contained zero occurrences of `judgeModel`), and the host exposed no model-catalog endpoint. The only ways to change the judge were hand-editing `allowlist.json` or curl. And the judge model is exactly the setting users need most: if the default model is a multi-step tool loop (e.g. `agy`), a single judgement cannot finish within `judgeTimeoutMs`, which shows up as "every approval goes to a human" with no actionable control in the UI
- **Upstream PR #11 leaves a gap**: it ships both the dropdown and `/api/auto-approve/models`, but the dropdown only shows anything when the catalog loads — on failure it displays "loading available models…" forever, so the user can neither pick nor type a value

### Changes

- **`src/index.mjs`: new `GET /api/auto-approve/models`**. Same source as the model selector in the bottom-right of the conversation: the routes from `llm.listProviders()` plus `llm.listModels(id)` per route. Only routes with a registered adapter are listed (an unregistered/dormant route would fail at judgement time). A single provider's catalog failure is isolated into `failures` while other routes stay selectable (matching the host's `dsh-api-session-controller` catalog policy). An unavailable catalog always returns 200 + an empty list + `reason`, **never a 5xx**; the endpoint sits behind the same credential fence as the rest (issue #12)
- **`client.js`: new "Judge model · decoupled from the main model" card** in the ④ Flash judgement area. With a catalog it renders two dropdowns (route + model, "follow the agent default model" first); **without** one it degrades to plain provider/model inputs rather than stalling on a loading state — a wrong judge model is precisely when the user must be able to change it, so the entry point must not disappear along with the catalog. The card footer shows the currently effective value; a pinned route/model that has left the catalog (provider switched, adapter removed) still appears as an option marked "current config, unregistered / not in catalog" — otherwise it would render as empty and one click on "save" would silently clear the pin
- **`test/models-endpoint.test.mjs` (new)**: six assertions pin the endpoint contract — catalog forwarding and current-value echo, single-provider failure isolation, 200 on an unavailable catalog, 405, and no route/model metadata leaking past a 401 credential fence
- **`test/client-render-smoke.test.mjs`: new case 6b** asserting the dropdown path (listing the selected route's models and no other route's) and the manual-entry fallback, which still shows the effective value
- **docs/GUIDE (zh/en)**: the `judgeModel` bullet now documents the settings entry and its fallback behaviour

### Compatibility

- **No configuration change, no migration**: the storage format and parsing of `judgeModel` are untouched; the new endpoint is read-only
- With an unavailable catalog (older DSH / missing llm service) behaviour is identical to 0.9.1; the settings page merely gains an extra card that can be filled in by hand

## [0.9.1] — 2026-10-02

Dangerous keywords now match on **boundaries** (fixing one real false positive), and the existing "writes under `$DSH_HOME` always require a human" semantics is written down.

### Problem

- **Keyword false positive**: `looksDeny` used plain substring containment for multi-word keywords, so `git push --force-with-lease` (the **safe**, lease-guarded force push) contains `push --force` and was treated as a force push. The 2026-10-01 approval log shows 4 such escalations (events 816 / 830 / 842 / 847), each costing a manual click for no reason. The same class hit `docker rmi` against the `docker rm` keyword
- **Semantics mistaken for a bug**: the user reported "approval self-learning is not working". The scene: the same target `C:\Users\shiro\.dsh\profiles\desktop\cordis.patch.yml` was approved 13 times, yet every record showed a plain "human approved" with **no `learning N/3` progress**. The cause is that `hardDenyFacts()` classifies `$DSH_HOME` targets as the human tier and returns at **gate 0**; the allowlist (gate 2) and the learning counter (gate 6) both sit after it — so those operations are never counted, never learned, cannot be whitelisted, and have no reconsider button. This is **pre-existing and deliberate** safety semantics (the README / GUIDE said only "escalates to a human", never "and never learns"), and the documentation gap made the investigation expensive

### Changes

- **`src/index.mjs`: `looksDeny` now matches on boundaries** (new internal helper `matchDenyKeyword`). When a keyword starts or ends with a word character, the adjacent character must not be in `[a-z0-9_-]`. One rule blocks both false-positive classes: prefix damage (`format` matching `Format-Table` / `--format`) and **flag extension** (`push --force` matching `push --force-with-lease`, `docker rm` matching `docker rmi`). Keywords ending in `=` / `:` (`dd of=`, `cipher /w:`) keep no boundary on that side, as before. On a boundary miss the scan continues to the next occurrence, so a real dangerous keyword later in the same text is still caught (`git push --force-with-lease … && git push --force …` still matches)
- **`test/unit.test.mjs`: the `looksDeny` assertions now hit the production implementation.** The file used to carry a copy of the same function, so breaking production would not turn the test red (verified: with the source reverted, the new cases fail immediately). Eight boundary cases added (`--force-with-lease` / `--force-if-includes` / `docker rmi` must not match; `--force` at a flag boundary, after a semicolon, and `docker rm -f` must still match; a real dangerous keyword after a boundary miss must still match)
- **`test/pipeline.test.mjs`: new case 3b** locking "the hard-fact gate runs before the allowlist and before learning" so it cannot later be "fixed" as a bug. Four assertions: ① a matching `allowRules` entry pointing exactly at that `$DSH_HOME` file still escalates to a human (and the test first asserts the rule *does* match, so it cannot pass vacuously); ② zero judge-model calls; ③ no learning counter appears in `learning.json` for that target; ④ the event has `path === 'hard-deny'` and no `learningCount` (i.e. the UI shows no `learning N/3`). RED check: deleting the human-tier branch from the source makes case 3b fail immediately with `a DSH_HOME target must still go to a human even with a matching allowlist rule`
- **README (zh/en)**: two new feature bullets — the full semantics of "writes under `DSH_HOME` always require a human" (never counted / never learned / cannot be whitelisted / no reconsider button / no learning progress shown) and "dangerous keywords match on boundaries"
- **docs/GUIDE (zh/en)**: the ⓪ hard-deny layer's "human tier" now carries a warning that it runs before the allowlist and before learning, what that implies, and the typical scene

### Compatibility

- Keyword behaviour **only narrows false positives; it does not open up real dangers**: every existing true-positive case for the built-in keywords still passes
- The `$DSH_HOME` / home-root approval behaviour is **unchanged** (still the human tier); this release only adds documentation and regression tests
- No config change and no migration; `allowlist.json` needs no edit

## [0.9.0] — 2026-09-24

Approval explanations turn from one prose blob into a **structured field table**: operation type / target path / blast radius / command / model note.

### Problem

- The explanation was a single paragraph (`沙箱提权到 danger-full-access：…。做什么：命令：…；目标路径：…`), so the approver had to read the whole thing to learn whether this was a deletion or a write, which path it touched, and how far it reached — in the user's words: verbose, not concise, hard to scan
- More fundamentally, an event carried only the `zh` string; the client had no structured fields to render as a table even if it wanted to

### Changed

- **`src/zh.mjs` gains `describeFacts()`**: tool name + real command + real target paths + sandbox mode become display-ready fields. The operation type is decided at command level: `rm` / `Remove-Item` / `format` / `git reset --hard` / `drop table` → **删除 (deletion)**; `git … push` (including `git -c key=value push`) / `gh release` / `npm publish` / `scp` / `curl` → **推送/发布 (remote push/publish)**; `write` → **新增/写入**; `edit` → **修改**; `read` → **读取**; otherwise execution/search/call by tool semantics. A deletion outranks a remote write in the same command (irreversible first)
- **The same function states the blast radius**: `danger-full-access` → the whole machine (any path outside the workspace is writable, including system locations; changes cannot be auto-reverted), `workspace-write` → the workspace (writes outside it are still refused), `read-only` → read-only, no escalation → sandbox mode unchanged
- **`buildChineseReason()` now emits one field per line**: `操作：…` / `路径：…` / `影响：…` / `命令：…` / `原因：…`. The `沙箱提权到 X：…` prefix is gone (the mode is stated in the impact line) along with the `做什么：…` run-on sentence; a backfilled command still reads `命令（回溯最近同名调用）：…`, and a command tool with no command still prints `命令：host未提供`
- **`src/index.mjs` records a `facts` field on events** (`compactFacts()`: whitelisted keys, per-field clipping, at most eight paths) for both auto-allowed and manual-approval events, so the client can render the table
- **`client.js` renders a real field `<table>` inside each approval record** (72px label column; deletion red, write green, edit blue, remote amber; paths and commands in the code font and wrapping), and the top notice strip shows a one-line summary (`删除 · a.txt 等 3 处 · 整机`) with facts summary → `zh` → original text as fallbacks
- **`client.js` shows the session's record count on the top "审批" tab** (`审批 (12)`). The host renders the `conversation.view` `label` through `resolveSlotLabel()` as a **string** and only recomputes the tab list on slot mutations or locale publishes (a `label` thunk is by design resolved "following the active locale"), so the count rides a thunk reading a module-level counter plus one locale publish whenever the count actually changes (a throwaway namespace, disposed right after). The count equals the rows the view actually lists (`manual-pending` lives only in the notice strip and is excluded), so the tab can never say 5 while the list shows 4. Without a locale service the label falls back to a plain "审批" and the count stays in the view
- **The events API backfills `facts` for older events**: an event with no `facts` on disk (recorded before v0.9.0) gets them derived in the response from what was recorded (tool / mode / files / command / justification), so the whole history renders as a field table. **Nothing is written back** — the event log keeps exactly what was recorded

### Deliberately not done

- **No HTML table in the host approval card**: the host package `dsh-client-ui-approval` renders `reason` as **plain text** inside a `<div>` (no Markdown, no HTML, and no `white-space:pre-wrap`), so a plugin can only change that string. Injecting CSS to restyle the host DOM would produce a pseudo-table, but it depends on host internal class names and attributes and breaks on any DSH upgrade — so the host card stays plain text (now field-per-line) and the table lives in this plugin's own review view

### Compatibility

- Events without `facts` keep rendering from `zh` / `justification` text, never blank
- `zh` is retained (the host card and notice strip still need plain text); `facts` is additive, and older clients simply ignore it

### Tests

- `test/zh.test.mjs` rewritten to 16 assertions: six-way operation typing (including `git -c … push` and deletion precedence), five blast-radius tiers, backfilled-command labelling, `compactFacts` whitelist/path cap/unknown-key dropping, the host card's five-line field order, and a real incident sample (whole machine + no path + long command → `操作：推送/发布`)
- `test/client-render-smoke.test.mjs`: `inspect()` can now expand function components; a new "structured facts → field table" case asserts the five field names, the real path, the machine-wide scope, the verbatim command and the `ag-facts-v-del` colouring, plus text fallback for old events without `facts`, and a "tab count" case (the label is a thunk, mounting the notice strip alone publishes the count, `manual-pending` is excluded)
- `test/pipeline.test.mjs`: case 17d now asserts the event carries `command`, `zh` and `facts.action`/`facts.scopeShort`
- `test/reconsider.test.mjs`: the events API test asserts an older event (no `facts` on disk) receives derived `facts` (operation type / blast radius / paths) in the response and that **nothing is written back to the file**
- Full `npm test` suite passes (zh / unit / seed-sync / absorbed / pipeline / reconsider / reconsider-match / client-render-smoke)

## [0.8.5] — 2026-09-24

Escalation explanations lose the noise: `write` / `edit` and other tools with no command field no longer print a "command: host未提供" line.

### Problem

- v0.8.3 emitted the command line unconditionally, so file-tool approval cards carried a line that could only ever read `host未提供` — the post-0.8.4 restart check (writing `C:\Users\shiro\Documents\dsh-approval-gate-probe.txt`) showed `做什么：命令：host未提供；目标路径：<real path>`, where the command half was pure noise

### Fixed

- **`src/zh.mjs`: only command-flavoured tools emit a command line.** `COMMAND_TOOLS` covers `pwsh` / `powershell` / `cmd` / `bash` / `sh` / `zsh` / `exec` / `run` / `shell` / `terminal` / `python` / `node` / `deno` / `bun` / `curl` / `wget` / `ssh` / `scp`, and recognises prefixed/suffixed variants such as `terminal-bash`; `write` / `edit` / `write_file` never show a command line, even when none was supplied
- **The target-path line is unchanged**: real paths are listed (up to five), otherwise it reads `host未提供`, and `danger-full-access` still adds "does not restrict paths — this grant covers the whole machine"

### Tests

- `test/zh.test.mjs` gains three assertions: a `write` escalation contains no "命令" text at all and only the target-path line, an `edit` escalation missing its path still shows the target-path line with the machine-wide note, and `terminal-bash` counts as a command tool while `write_file` does not
- Full `npm test` suite passes (zh / unit / seed-sync / absorbed / pipeline / reconsider / reconsider-match / client-render-smoke)

## [0.8.4] — 2026-09-24

Root-cause fix: the plugin always read `session.events`, a field DSH's `Session` does not have — so structured arguments, the deterministic hard-deny layer, and the user-authorization source were all long dead.

### Problem

- **Wrong API**: `req.agent.session` is DSH's `Session` instance, whose public event accessors are `snapshotEvents()` / `ownEvents()`. `Session.prototype` carries only `id` / `seq` / `header` / `eventAt` / `snapshotEvents` / `ownEvents` / `append` — **no `events`** (confirmed empirically with `Object.getOwnPropertyDescriptors`). Hence `Array.isArray(undefined) === false`
- **Three casualties**:
  1. B-layer structured argument resolution (the `tool/call` `file_path` / `command`) never matched — across 485 production approval events, the `command` field was populated 0 times; v0.8.3's "backfill the newest same-name call" was patching this error
  2. `hardDenyFacts` always received `{}` — the deterministic hard-deny layer's "target of a write/delete lands in a protected location" branch never fired in production (nor did the credential-material branch for outbound arguments)
  3. `trustedUserMessages(session, 4)` was always empty — the "sole user-authorization source" handed to the judge was blank
- **Why the tests missed it**: the fixture built a session as `{ events: [...] }`, feeding the plugin exactly the field it believed in and production does not have

### Fixed

- **`src/index.mjs` gains `sessionEvents(session)`**: tries `snapshotEvents()` → `ownEvents()` → an `events` field (kept for other hosts and existing tests); a throwing accessor degrades instead of breaking the approval
- **The approval handler now uses it**: `toolFiles` / `toolCmd` / hard-deny `callArgs` all read real events, and `trustedUserMessages` was switched internally as well
- **The test fixture now mirrors production**: `makeReq` defaults to `{ id, header, snapshotEvents() }` (**without** an `events` field), so an "events-field-only" regression turns the whole suite red; a `legacyEventsField` option covers the compatibility branch

### Behaviour changes (visible after a restart)

- Writes into `C:\Windows\...`, `~/.ssh`, a filesystem root and similar protected locations are now **hard-rejected with no dialog** (previously they reached the judge or a human)
- The dangerous-keyword layer can now see the real command (`looksDeny` is fed `toolCmd`), so keyword hits escalate to a human more often
- Approval records and escalation prompts start showing real commands and target paths instead of fragments scraped from the model's prose

### Tests

- `test/pipeline.test.mjs` gains case 17 (a–e): under the production session shape a system-path write is hard-rejected (`kind: 'hard-reject'`, zero prompts); with no event source the same call is **not** hard-rejected (negative control proving the gap was real); the legacy `events` field still works; the real command lands in the event and the Chinese explanation; `sessionEvents` priority and error degradation
- Full `npm test` suite passes (zh / unit / seed-sync / absorbed / pipeline / reconsider / reconsider-match / client-render-smoke)

## [0.8.3] — 2026-09-24

Escalation prompts now always state the command and target path — and say so explicitly when the host did not provide them. This also fixes the root cause that kept both lines empty.

### Problem

- **The escalation prompt carried no command and no target path**: the approver saw only the sandbox-mode consequences plus the model's raw justification, with no way to tell what the escalation would run or touch. User's words: "这会话中的提权为什么没写具体路径 是全电脑的路径吗"
- **Root cause: the structured arguments never resolved**: the displayed command came from a strict `callId` match against the session's `tool/call` event, yet in production `$DSH_HOME/auto-approve/events.jsonl` **all 485 approval events had an empty `command` field** — that lookup has never matched on the real call path (session logs show `tool/call` and `approval/asked` adjacent with identical callIds, so the event view the approval handler sees disagrees with the persisted order)
- **The Chinese-justification branch was worse**: when `justification` was already Chinese, the explanation only localized the `沙箱提权到 <mode>：` prefix and dropped command and target path entirely

### Fixed

- **`src/zh.mjs`: escalation explanations now always emit a "what it does" line**, writing `host未提供` when the command or target path is missing; `danger-full-access` adds "does not restrict paths — this grant covers the whole machine, not one path" so it is not misread as a scoped grant; `workspace-write` makes no machine-wide claim
- **The Chinese branch carries the same line** instead of only localizing the prefix
- **`src/index.mjs`: new `resolveDisplayCommand`** — when the strict match misses, it falls back to the most recent same-name `tool/call` in the session for the real command and labels it "命令（回溯最近同名调用）", never pretending it is this call's exact argument
- **The fallback affects display only**: hard denies, hard facts, the allowlist, rule fingerprints and diff snapshots still use strictly matched arguments, so a misattributed argument cannot sway a safety decision

### Tests

- `test/zh.test.mjs` gains four assertions: both lines must be present when facts are missing (plus the machine-wide note), `workspace-write` must not claim machine-wide access, a backfilled command must be labelled, and the Chinese branch must list command and target path
- `test/pipeline.test.mjs` gains case 16: `callId` hit wins, a miss backfills from the newest same-name call (ignoring other tools), `edit` never invents a command, a missing `callId` still backfills, and empty event lists or malformed JSON never throw
- Full `npm test` suite passes (zh / unit / seed-sync / absorbed / pipeline / reconsider / reconsider-match / client-render-smoke)

## [0.8.2] — 2026-09-22

Fixes "auto-learning has no effect": the confirmation counter was long past the threshold, yet every escalation still prompted a human.

### Problem

- **The judge-unavailable branch ran before the confirmation-count check**: whenever the judge timed out or errored, the code went straight to a human and never reached the "confirmed N times" path. Evidence (session `session-c7c21920`, 2026-09-22 20:15–21:10): `learning.json` had `pwsh|danger-full-access|neutral` at **8/3**, while the approval records kept reading "manually approved · learning 6/3 (auto-approves after 3)" — the counter climbed, the prompts did not stop
- **The failure was upstream flakiness, not the operation**: the judge reported `Stream ended without finish_reason`, upstream `code=4001`, and 20s timeouts — the judging layer had lost its capability. Escalating to a human neither fixes the judge nor honours the learning that already happened
- Counting and releasing were therefore decoupled: `learning.stats` said 8/3 while behaviour was identical to 0/3, and re-approving manually never changed the next outcome

### Fixed

- **An unavailable judge now honours completed learning first** (`src/index.mjs`): the failure branch checks the confirmation count for that `tool|mode|neutral` key, and when `learning.enabled` and the count is ≥ `riskyThreshold` it auto-approves and records the event (`path: learned-judge-unavailable`) instead of escalating; the session's judge-failure counter is cleared at the same time
- **Hard-risk gates are unaffected**: hard denies (credential exfiltration / system-path destruction), hard facts (`DSH_HOME` / home root), dangerous keywords, the allowlist and `denyRules` all run before the judge, and hard categories still require a human every time. This fallback applies only to `neutral` keys that already met the threshold
- **Trade-off (recorded deliberately)**: with the judge unavailable there is no semantic similarity check, so this releases on the **confirmation count alone** — looser than the healthy path, which still asks the judge to verify sameness when the fingerprint misses. That is intentional: a broken judge must not park already-confirmed same-class operations in human approval indefinitely

### Tests

- `test/pipeline.test.mjs` gains case 10c: with `pwsh|danger-full-access|neutral = 6` seeded and the judge throwing every time, it asserts `allowed-once` and `nextCalls = 0` (**zero human prompts**) while confirming the judge really was called (proving the failure fallback ran, not an allowlist hit)
- Cases 10 / 10b / 10d now clear `learning.json` first: they verify "below threshold → human", and were previously polluted by learning counts accumulated earlier in the same process

## [0.8.1] — 2026-09-21

Chinese approval explanations: the model's `justification` is often English (subagents and other providers especially), and the host template adds an English prefix `escalate sandbox to <mode>:` — so the approver had to read English before deciding.

### Added

- **Every approver-facing explanation is Chinese** (`src/zh.mjs`): the explanation is built from **structured facts** — target sandbox mode, the real command, the real target paths — and states the consequence (writable scope / reversibility / whether anything outside the workspace is touched). Commands, paths and arguments are kept verbatim, never translated or rewritten; when the original is already Chinese only the English host prefix is localized
- Events carry a new `zh` field: both the approval card body and the approval-view rows render it first, while `justification` / `reason` keep the original text so the audit record stays truthful. Older events have no `zh` and fall back to the original

### Fixed

- **The host's English prefix no longer reaches the approver**: an escalation body now reads "沙箱提权到 danger-full-access：…" instead of `escalate sandbox to danger-full-access: …`
- **All four human-handoff exits are covered**: `forwardToHuman`, both "first N manual confirmations" branches, and the judge-error fallback. Auto-approved events only gain the display-only `zh` field and never see `reason` rewritten (so downstream matching on the original text is unaffected)

### Tests

- `test/zh.test.mjs` (new): CJK detection, English → Chinese explanation, Chinese original with prefix localization only, the no-escalation-prefix fallback, unknown modes never claiming a false consequence, and truncation
- `test/client-render-smoke.test.mjs`: new assertions that the notice renders `zh` first and that rows use `zh` when present but fall back to the original justification

## [0.8.0] — 2026-09-18

Fixes the chain of false rejections caused by treating "judge unavailable" as "this operation is harmful": right after approving one operation, the next similar call was silently rejected again, forcing the user to re-approve repeatedly.

Evidence (session `session-c44df57e`, 2026-09-18 20:27–20:48): **4 of 8** approval requests were caused by an unavailable judge; `audit.log` holds 49 `FAILED` lines, 8 of them on 09-17/09-18.

### Fixed

- **The judge no longer treats reasoning as its answer**: `callFlash` used to `return reasoning` when the answer text was empty, handing chain-of-thought to a JSON parser — a guaranteed parse failure that masked the real cause (no answer text at all). It now throws explicitly with the reasoning length
- **Judge output cap 256 → 1024 (`judgeMaxTokens`, configurable)**: relays (ai-gateway) force `thinking=enabled` for DeepSeek models and fill in `effort=high`; reasoning and the answer share `max_tokens`, so 256 tokens were eaten by reasoning and the answer came back empty. This is the most common real cause of a "judge failure"
- **Judge unavailable → straight to a human on the first failure** (`judgeFailureLimit` default 3 → 1): an unavailable judge means the judging layer lost its capability, not that the operation is harmful. Silent rejection just makes the agent bang its head against the same wall while the user finds out later. The setting remains: values >1 restore the old rhythm
- **`flash-failed` escalations now seed an allow rule when the human approves**: the branch previously only recorded a learning sample, so the next call to the same target hit the same broken judge and was silently rejected again (the direct cause of "approved at 20:43:23, rejected again at 20:43:35")
- **Failure reasons reach `audit.log` and the event record**: previously only `{ failed: true }` came back, so timeout / upstream error / empty answer / invalid JSON were indistinguishable and diagnosis was blind
- **Reconsideration without a fingerprint no longer writes a broad rule**: the old behaviour wrote a tool+mode+category rule, i.e. it released everything that tool did in the escalated mode (at 20:43:39 a fingerprint-less `write` rule was written, covering every later `write` escalation). Now it returns 400 and points at the settings-page allowlist instead
- **Command-line tools (pwsh) take their fingerprint from the real command**: events now carry a `command` field. Previously a pwsh reconsideration could only pick an incidental word out of the justification (incident: `contains:"job"` matched only the call that happened to contain "job"; the next call phrased it as "in the background" and missed)
- **Judge model candidate chain**: configured judge → session default model → built-in fallback. A single flaky channel (the 09-17 workbuddy `502 upstream_runaway`) no longer means the judge is entirely unavailable

### Added

- Two new settings: **judge failures before a human prompt** and **judge output cap (tokens)**
- Approval records show the **real failure reason** (timeout / upstream error / empty answer), and "judge unavailable" is now clearly distinguished from "judged harmful"
- Three built-in allow rules: Rime user directory (`%APPDATA%\Rime`) write/edit, and the Weasel `WeaselDeployer.exe` deployment. That directory was human-approved two days running and is a known-safe target
- The seed `allowlist.json` now carries `judgeFailureLimit` / `judgeMaxTokens` defaults

### Tests

- `test/pipeline.test.mjs`: case 10 now asserts "first failure prompts a human"; new cases 10b (`judgeFailureLimit>1` keeps the old rhythm), 10c (approval seeds a fingerprint rule and the next same-target call makes **zero judge calls**), 10d (failure reason lands on the event), 14 (candidate chain: dead primary → fallback judges successfully), 15 (candidate-chain helper dedupes/drops empties/keeps order); case 11 now uses `judgeFailureLimit=2` to verify the success reset
- `test/reconsider-match.test.mjs`: new cases for "fingerprint-less reconsideration → 400, no broad rule" and "command-line fingerprints come from `event.command` and survive rewording"
- `test/client-render-smoke.test.mjs`: new assertions separating judge-unavailable from harmful wording and showing the failure reason; settings page asserts both new controls; the `/api/auto-approve/rules` stub is completed
- `test/absorbed.test.mjs`: updated default assertions (`judgeFailureLimit=1`, `judgeMaxTokens=1024`) and the source contract for failure reasons reaching the audit log

## [0.7.1] — 2026-09-17

Fixes a display defect that made a reconsidered record **still look rejected**.

### Fixed

- **A reconsidered record now reads as released**: reconsideration does not rewrite the original event (it really was a rejection, and that audit fact is kept) — it only adds a `reconsidered` flag. The old wording glued the two together as "Reconsidered · Rejected outright · judge unavailable (consecutive failures)" and kept the red ✕ and error background, so right after pressing "Re-approve" the user saw what looked like a failed reconsideration. A reconsidered silent rejection now renders as **"Reconsideration approved · <reason> (was rejected outright)"**, with a ✓ glyph, a done/amber tag and no pending rail; the original reason stays in parentheses so nothing is hidden
- **A reconsidered record no longer counts as pending and no longer re-surfaces as a pinned notice**: on reload, reconsidered rejections are no longer restored as a red notice (they used to show up again in the "pending N" badge and the notice strip even though the rule was already written and the AI had already retried)
- The "Re-approve" button now honours the `reconsidered` fence (matching the pending test), so an already-reconsidered row no longer offers the button again

### Tests

- `test/client-render-smoke.test.mjs` gains two cases: a reconsidered row renders as "Reconsideration approved · judge unavailable (was rejected outright)" with a done tag while only the **un-reconsidered** row counts toward "pending 1"; and a reconsidered rejection no longer re-surfaces as a notice after a reload

## [0.7.0] — 2026-09-16

Fixes an ordering defect in the judgment pipeline and adds user visibility plus a remedy path for silent rejections.

### Fixed

- **Hard-risk categories now take precedence over the judge model's `deny`**: the `deny` branch used to sit before the hard-category check, so when the model returned `deny` for a hard category (`deletion`/`credential`/`remote`/`system`/`bulk`) the request was **rejected silently** and the configured `hardCategories` was effectively inert — a legitimate out-of-workspace write (an application config under `%APPDATA%`, say) never even got the chance of a manual approval. Hard categories are now a **symmetric safety gate**:
  - `allow` + hard category → escalate to human (previous behavior)
  - `deny` + hard category → escalate to human (this fix)
  - `deny` + `neutral` → still rejected silently (no dialog, so the agent replans)
- The deterministic hard-deny layer (credential exfiltration, filesystem-root and system-path destruction) is **unchanged**: it still runs first, and neither an allowlist rule nor a re-approval can override it

### Added

- **"Re-approve" (reconsideration)**: a silent rejection in the approval history can be reconsidered, which writes an auto-approve rule carrying the operation fingerprint and delivers a retry instruction so the AI re-runs the operation. Two fences:
  - Only **judge-layer silent rejections** (`judge-deny`) are reconsiderable; the deterministic hard-deny tier (`hard-reject`) runs first and no allowlist rule can override it, so offering a button would be a false promise → 400
  - A **hard-risk category** means "must be confirmed by a human every time", so reconsideration-based auto-approval is refused → 400
  - New endpoint `POST /api/auto-approve/reconsider`; the reconsideration is recorded as `kind: "reconsidered"` with `reconsiderOf` pointing back at the original event
- **Rejection notices persist**: notices for silent and manual rejections no longer disappear after 4 seconds — they stay above the composer until you switch to the "Approval" tab or press an action button. Auto-approved notices still collapse after a few seconds as before. The read position is persisted per session in browser `localStorage`, so a page reload neither loses pending rejections nor re-nags about ones already seen
- **Pending badge on the "Approval" tab**: the view title shows how many rejections are still unreconsidered, and the notice offers both "View approval log" (switch to the tab) and "Re-approve"

### Tests

- `test/pipeline.test.mjs`: case 7 now covers `deny + neutral` staying silent; new case 7b locks in `deny + hard category → human`, with a `neutral` variant of the same tool and justification as a control so the relaxation cannot silently become a blanket opening
- Added `test/reconsider.test.mjs`: 7 contracts of the reconsideration endpoint (hard rejects not reconsiderable, hard categories not reconsiderable, a neutral rejection writing a fingerprint rule + delivering a retry + recording `reconsiderOf`, event-API annotation and filtering, idempotent re-reconsideration, 404 for unknown events)
- Added `test/client-render-smoke.test.mjs`: renders the client bundle for real with a minimal React hooks shim plus DOM/fetch stubs, covering persistent rejection notices and their buttons, no re-approval button on hard rejects, only reconsiderable rows offering the button, marking rejects as seen when the tab opens, and no re-surfacing after a reload

## [0.6.0] — 2026-09-16

Ports 5 capabilities from [NanmiCoder/dsh-auto-mode](https://github.com/NanmiCoder/dsh-auto-mode) (MIT License), adapted to this repository's confirm-to-learn pipeline.

### Added

- **Deterministic hard-deny layer** (`src/paths.mjs` + `hardDenyFacts()`): decisions are based on the **real path and credential facts** of the tool arguments rather than on `justification` keywords, and the judge model has no authority to overturn them. Two tiers:
  - **Direct reject** (returns `rejected`, no dialog, so the agent replans): an outbound call carrying credential material; a destructive target landing on a filesystem root, an OS or credential-critical path, a Windows device/NT namespace, or a Windows reserved device name
  - **Escalate to human** (manual approval stays available): the target is `$DSH_HOME` or the user home root itself
- **Judge-input sanitization** (`src/sanitize.mjs`): secrets and large bodies are stripped or truncated before they reach the judge model. Private key blocks, `AKIA`/`ASIA`, GitHub/Slack tokens, `Bearer` headers and `key=value` secrets become `[redacted-secret]`; secret-like field names become `[redacted-secret-field]`; large body fields become `[redacted-<key>:<length>-chars]`; text is truncated to 1000 characters, with depth 3, arrays 25 and objects 50. Workspace paths with sensitive shapes escalate to a human instead of being sent out
- **Structured JSON verdict protocol** (`src/classifier.mjs`): a strict `{decision, reason, category}` replaces the former textual `SAFE` / `RISKY:<category>`; `decision` ∈ `allow`/`ask`/`deny`, `category` ∈ `deletion`/`credential`/`remote`/`system`/`bulk`/`neutral`, `reason` is non-empty and ≤1000 characters; any format deviation throws and is handled fail-safe
- **Consecutive judge-failure counter**: counted per session. The first 2 failures reject silently so the agent replans, and the 3rd escalates to a human once, so that a long-unavailable judge does not wedge the task; one successful judgment resets the count to zero. The threshold is configured by `judgeFailureLimit` (default 3)
- **Dynamic system-prompt guidance**: while a preset is active, `<auto_approve_policy>` is injected into the session's dynamic context (immediately after the host sandbox policy), reducing out-of-bounds requests that need judging at the source
- **Authorization-source restriction**: the judge model accepts only **direct human messages** as authorization (at most 4 messages, sanitized one by one, 4000-character total budget); repository content, tool output, assistant text, and skill / plugin / subagent text never constitute authorization

### Changed

- **Judge-model output protocol change**: `SAFE` / `RISKY:<category>` are no longer accepted. If you configured a judge prompt or downstream tooling specifically for this plugin, update it accordingly
- **Safety gate**: when the judge model returns `decision: "allow"` but `category` hits `hardCategories`, the request is **forced to a human**; the hard-category gate cannot be bypassed
- **Failure fallback semantics changed**: the former "a judge failure escalates to a human" is now a "consecutive failure counter": the first 2 failures reject silently, and only the 3rd escalates to a human
- New event `kind` values: `hard-reject` (hard-deny tier) and `judge-deny` (a `deny` verdict / silent rejection after consecutive failures); the manual review view shows both in red as "rejected outright" and labels the reason
- Mount log now reflects the new pipeline order

### New configuration

- `judgeFailureLimit`: how many consecutive judge failures trigger a single human escalation (default 3, **machine-local** configuration, not part of multi-machine sync)

### Tests

- Added `test/absorbed.test.mjs`: regression tests for the 5 ported capabilities, asserting against the **real exported implementations** under `src/` (without duplicating logic inside the tests), covering sanitization boundaries, fail-safe handling of invalid JSON-protocol input, hard-deny tiers, the prompt-layer contract, failure counting and authorization sources
- Added `test/pipeline.test.mjs`: **simulates the host** actually executing the registered `approval/request` handler, covering no-dialog hard rejects, hard facts escalating to a human, zero model calls for allowlisted requests, `allow`/`deny`/`ask` routing, the `allow` + hard-category safety gate, consecutive-failure counting and reset, **secrets not leaving the machine**, and preset gating
- `npm test` now includes syntax checks for the 3 new modules and the two test files above

### Docs

- README (Chinese/English) and docs/GUIDE (Chinese/English) now cover the new pipeline order, the JSON verdict protocol, sanitization behavior and boundaries, failure counting, the two hard-deny tiers, prompt-layer guidance and `judgeFailureLimit`
- Added **upstream attribution**: the 5 capabilities above are ported from NanmiCoder/dsh-auto-mode (MIT License), and the original design and implementation are copyright that project

## [0.5.5] — 2026-09-16

### Added

- **Multi-machine rule sharing**: `allowlist.json` inside the plugin package (repository root) serves as the aggregated rule set and is merged incrementally into the local configuration at load time (additions only, no removals, deduplicated by fingerprint, idempotent, version taken from the repository)
- `allowlist.json` is packaged at the repository root as the shared rule seed

### Fixed

- Migration of the judge-model configuration field `model` → `judgeModel`: the existing local value is preserved and the old key is removed; an explicitly configured `judgeModel` wins (previously the `model` key in the old configuration was no longer read, which silently disabled the judge model)
- The `/api/auto-approve/*` routes now include the DSH core credential fence (upstream issue #12): `connection.requestRejection` takes precedence, degrading to origin validation when it is absent; exception protection added inside `requestAuthRejection`
- Removed machine-local identifiers and stale documentation

### Changed

- Repository metadata now points to this fork, and installation is done from this repository

## [0.5.0] — 2026-08-18

### Added

- **File-change diff and revert**: files involved in an approval can be clicked to view a unified diff, with changed lines shown with 5 lines of surrounding context, multiple edits split into hunks and collapsed behind an "N unmodified lines" separator, and dual line numbers; a one-click "Revert this change" delivers an instruction telling the AI to restore the file from the snapshot
- **Session-level snapshot management**: snapshots belong to the session of their event, the approval view counts per current session, and cleanup offers two levels: "clear this session only" and "clear all"
- diff / revert / snapshot-management API

### Fixed

- **Broken diff snapshot data source**: `callId` traces back through the tool arguments to obtain the real path (layer B), with `justification` as a fallback (layer C); `manual-pending` now saves snapshots too
- **Read-only bash commands produced false snapshots**: write detection tightened, device/empty-content filtering, and file-level clickability in the UI
- Fixes for auto-learning defects, judge-model decoupling, and a batch of upstream issues

## [0.4.1] — 2026-08-17

### Added

- An "Auto-approve" section on the settings page: visual rule management (pipeline overview / dangerous-word blacklist / allowlist / permanent-manual / thresholds and timeouts / currently learning)
- One-click permission-preset initialization (text-level write to `cordis.patch.yml`, preserving comment formatting)
- Rule-management API: `GET/POST /api/auto-approve/rules`, `POST /api/auto-approve/setup`

### Fixed

- Prompt-banner history popup issue

## [0.4.0] — 2026-08-16

### Added

- **Manual review UI**: a green banner above the input box when something is auto-approved; an "Approvals" history view (to the right of the trajectory)
- Approval history view in reverse-chronological order (newest first)

### Fixed

- `client.js` now provides the standard export pattern (`default` / `apply` / `inject`), matching the DSH bundle specification

## [0.3.0] — 2026-08-16

### Added

- **flash third-party same-class verification**: semantically judges whether a new operation is the same class as the user's confirmed samples (`SAME` / `DIFFERENT`)
- **Neutral-category manual confirmation rule**: once the same "tool + mode + category" has been manually confirmed N times, it is auto-approved from the N+1th time on
- Distilled/rejection rules carry an **operation fingerprint** (`contains`), fixing a loophole where broad rules wrongly auto-approved
- Hot reload of `allowlist.json` configuration (re-read from disk before every approval, so configuration changes need no restart)

### Fixed

- White-box review fixed 3 P0 and 3 P1 issues (reachability / effectiveness)

## Earlier versions

Anything before 0.3.0 belongs to this fork's initial development stage and to the base implementation from upstream [moon09300731/dsh-approval-gate](https://github.com/moon09300731/dsh-approval-gate), and is not recorded entry by entry.
