# dsh-approval-gate — Full Guide

> Home: [English](../README.en.md) · [简体中文](../README.md) · Guide: [English](GUIDE.en.md) · [中文](GUIDE.md)

DeepSeek Harness auto-approval gate plugin v0.7.1: **minimal human intervention — only operations that must be confirmed go to a human (fail-safe)**.

When a session's permission preset is `auto-approve` (Auto Approval (Flash)), every approval request (sandbox escalation) is judged through this pipeline:

```
hard-deny (credential / system-path) → hard-fact human escalation → dangerous keywords
→ allowlist (deterministic rules) → denyRules (rejected upgrades)
→ structured JSON judge (hard categories → human, ahead of allow / deny; neutral confirmation; failure limit)
→ verdict learning
```

- **⓪ Hard-deny layer** (deterministic, evaluated *before* the keyword layer): facts read from the tool arguments and filesystem paths, not from keywords in a justification string. Two tiers:
  - **Direct reject (no dialog)**: credential exfiltration — an outbound call (`web_fetch`, `web_search`, `curl`, `wget`, or a deploy/publish/push/send/release-style tool name) whose arguments contain credential material, or whose URL carries a password or a `token`/`api_key`/`signature`/`auth` query parameter of 8+ characters; and destruction targeting a filesystem root (`/`, `C:\`), an OS or credential-critical path (`/etc`, `/bin`, `/sbin`, `/usr`, `/system`, `/library`, `/boot`, `C:\Windows`, `C:\Program Files`, `C:\ProgramData`, `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.azure`, `~/.kube`, `~/.config/gcloud`), a Windows device/NT namespace (`\\.\`, `\Device\`, `\\?\`, `\??\`), a Windows reserved device name (`CON`, `PRN`, `AUX`, `NUL`, `COM1-9`, `LPT1-9`), or an ambiguous drive-relative path
  - **Escalate to human** (preserves manual approval): `DSH_HOME` paths and the user home root itself
  - The judge model cannot overturn this layer. Ordinary workspace operations are unaffected and are never hard-denied
- **① DENY layer**: irreversible keywords (`rm -rf`, `drop table`, `force push`, formatting, …) → human (fail-safe)
- **② Allowlist layer**: a matching rule → auto-approve (deterministic, no LLM). Default rule `{mode:"workspace-write"}` — workspace writes (recoverable) auto-approve; `tool/mode/category/contains` combinations are supported (including learned rules)
- **③ denyRules layer**: `tool+mode+category` pairs the user has **explicitly rejected** → permanently human (never auto-approve what the user refused)
- **④ Judge** (escalations only): a strict JSON verdict — `decision` ∈ `allow` / `ask` / `deny`, `category` ∈ `deletion` / `credential` / `remote` / `system` / `bulk` / `neutral`
  - **Hard-risk categories are decided first** (`deletion` / `credential` / `remote` / `system` / `bulk`) → **directly human** (must confirm; no counting, no learning). This is a **symmetric safety gate**: whether the model answers `allow` or `deny`, a hard category always goes to a human — the model's verdict cannot bypass it
  - `deny` with category `neutral` → silently rejected, no dialog, so the agent can replan; the record stays on screen and can be **reconsidered** from the approval view (see below)
  - `allow` → auto-approve
  - `ask` → human
  - `neutral` (no hard-risk traits) → **confirmation mode**: the first N occurrences go to human, then the threshold state begins
  - Judge failure → counted per session (see [Judge-failure counter](#judge-failure-counter))
- **⑤ Learned persistence** (neutral, N=3: confirm 3 times, threshold state from the 4th)
  - Before threshold: every occurrence goes to human; **approve** → count +1 and record an **operation sample** (fingerprint + context); **reject** → upgrade to denyRules
  - In the threshold state (count ≥ N), three branches:
    1. **Fingerprint hit** (this operation is in the confirmed samples) → auto-approve + persist a `{tool, mode, category, contains}` rule
    2. **No fingerprint hit but samples exist** → hand the current operation's context plus the confirmed samples to flash for **third-party similarity verification**: `SAME` (same kind as a confirmed sample) → auto-approve (persist when a fingerprint exists); `DIFFERENT` / verification failure → human
    3. **No samples** → human
  - **Reject** → upgraded to denyRules (with fingerprint; without one, block the whole kind — rejection is always strict)
  - Cancel/unavailable → not counted (no verdict from the user; next time still goes to human)
  - Hard categories / DENY / verification failures are always human; similarity verification only applies to the neutral threshold state

### Structured JSON verdict protocol

The judge model no longer emits a single word. It must output a strict JSON object with exactly the keys `decision`, `reason` and `category`:

| Key | Values | Meaning |
|-----|--------|---------|
| `decision` | `allow` | Auto-approve |
| | `ask` | Escalate to a human prompt |
| | `deny` | Silently reject, no dialog, so the agent replans |
| `category` | `deletion` / `credential` / `remote` / `system` / `bulk` | Hard-risk categories → human |
| | `neutral` | No hard-risk trait → confirmation-based learning |
| `reason` | non-empty string, ≤1000 characters | Short justification |

Anything malformed — a missing key, an extra key, an invalid `decision`, an invalid `category`, an empty or overlong `reason`, or output that is not JSON — throws and is handled fail-safe (never auto-approve). A ```json code fence around the object is tolerated.

> The old text protocol (`SAFE` / `RISKY:<category>`) was replaced because a reasoning model's long chain-of-thought could contain those words and pollute the verdict, and because a binary safe/risky answer cannot express "reject silently so the agent changes plan".

### Classifier-input redaction

Before anything reaches the judge model, secrets and bulk content are stripped:

1. **Text level** — private key blocks, AWS keys (`AKIA`/`ASIA`), GitHub tokens (`ghp_`/`gho_`/`ghu_`/`ghs_`/`ghr_`/`github_pat_`), Slack tokens (`xoxb`/`xoxa`/`xoxp`/`xoxr`/`xoxs`), `Bearer <token>` headers and `key=value` secrets (`api_key=`, `token=`, `secret=`, `password=`) become `[redacted-secret]`; the text is then truncated to 1000 characters
2. **Argument level** — fields are sanitized by name: secret-named fields (`api_key`, `authorization`, `password`, `token`, `cookie`, `secret`, `credential`, `private…`) become `[redacted-secret-field]`; bulk-content fields (`body`, `content`, `data`, `diff`, `input`, `patch`, `payload`, `str`, `string`, `text`, and always `description`/`justification`) become `[redacted-<key>:<length>-chars]`
3. **Limits** — recursion depth 3, arrays capped at 25 entries, objects capped at 50 keys

If the workspace path itself contains a secret-shaped string, the exact target cannot be safely disclosed, so the call goes to human review instead.

### Judge-failure counter

Judge failures are counted **per session**:

- Failures 1 and 2 → the call is silently rejected (no dialog), so the agent can replan
- Failure 3 (configurable via `judgeFailureLimit`, default 3) → one manual human approval is offered, so a long outage cannot trap the task
- A successful judge response resets the counter to zero

### Dynamic system-prompt guidance

While the `auto-approve` preset is active, the plugin injects an `<auto_approve_policy>` block into the session's dynamic runtime context (via `systemPrompt.context`, ordered just after the host's own sandbox policy). It tells the agent that:

- routine workspace work should run directly
- deletion is the highest-risk routine operation, and deletion authority must never be generalized to a variable, glob, parent, sibling or second target
- a reversible move or backup is preferred when permanent deletion was not explicitly requested
- credentials, outbound transmission, deploys and system changes need explicit user authority for that exact effect and target
- hard-denied calls are rejected without a dialog, so the agent should replan rather than resubmit

Sessions on other presets get no injection.

### Where authorization comes from

Authorization now comes only from **direct-human session messages** (at most 4, sanitized, 4000-character budget). Repository content, tool output, assistant prose, skills, plugins and subagent text are **not** authorization.

## Install

```sh
# Install from this repository (recommended)
dsh plugin --profile web add "github:IamNewHands/dsh-approval-gate#main"
```

> Note: the `dsh-approval-gate` package on npm is still upstream 0.5.0 and does not contain this repository's fixes. Do not install it by package name.

## ⚠️ Manual permission preset (required after install)

The plugin cannot extend the frozen permission-preset table; add the preset manually to the profile's `cordis.patch.yml`:

Edit `~/.dsh/profiles/web/cordis.patch.yml` and append (or merge into the existing `permission` row — **the loader patch replaces the whole row's config, so restate every preset**):

```yaml
- id: permission
  name: '@deepseek-ai/dsh-permission-presets'
  config:
    presets:
      read-only:
        sandbox: read-only
        approval: ask
      workspace-write:
        sandbox: workspace-write
        approval: ask
      danger-full-access:
        sandbox: danger-full-access
        approval: never
      auto-approve:
        sandbox: workspace-write
        approval: ask
        name: Auto Approval (Flash)
        description: Multi-stage judgment: workspace writes auto-approve, risky operations go to human.
```

Restart `dsh web`; the permission dropdown then offers "Auto Approval (Flash)".

## Configuration (optional)

Data files live under `$DSH_HOME/auto-approve/` (default `~/.dsh/auto-approve/`):

| File | Purpose |
|------|---------|
| `allowlist.json` | Allow/deny lists, thresholds (auto-generated on first run, old versions auto-migrate, edits take effect immediately — hot reload) |
| `learning.json` | Learning state (auto-maintained, persists across sessions) |
| `audit.log` | Audit log (append-only) |
| `events.jsonl` | Auto-approval events (for the review UI, per-session isolation) |
| `snapshots/` | Pre-change snapshots of auto-approved files (named by event ID; used for diff and revert) |

`allowlist.json` structure (v4):

```json
{
  "version": 4,
  "denyKeywords": ["rm -rf", "drop table", "force push", "format"],
  "allowRules": [
    { "mode": "workspace-write", "description": "Workspace writes auto-approve" },
    { "tool": "bash", "mode": "workspace-write", "contains": "git add", "description": "Tool+mode+keyword rule" }
  ],
  "denyRules": [],
  "hardCategories": ["deletion", "credential", "remote", "system", "bulk"],
  "riskyThreshold": 3,
  "judgeTimeoutMs": 20000,
  "judgeFailureLimit": 3,
  "judgeModel": { "provider": "my-provider", "model": "my-flash-model" },
  "learning": { "enabled": true }
}
```

### Sharing rules across machines

The `allowlist.json` shipped inside the plugin package (repository root) is the
**aggregated ruleset**. On every load its rule arrays (`denyKeywords` /
`allowRules` / `denyRules` / `hardCategories`) are **merged incrementally** into
the local `$DSH_HOME/auto-approve/allowlist.json`, so several machines share one
ruleset:

- **Additive only**: machine-local rules are preserved, never overwritten or removed
- **Deduplicated by identity**: the same rule (`tool`/`mode`/`category`/`contains`) is never appended twice
- **Idempotent**: repeated loads produce no duplicate entries
- **Version follows the repo**: `version` tracks the aggregated file; a machine never downgrades it

The following are **machine-local** and are never synchronised (set them per machine):

- `riskyThreshold`, `judgeTimeoutMs`, `judgeFailureLimit`, `learning`
- `judgeModel`: the judge model. Custom provider names differ between machines
  (e.g. `my-provider`), so use this machine's actual value rather than copying another's

> The legacy `model` field (upstream 0.5.0) was renamed to `judgeModel`. On load it is
> migrated automatically: the machine-local value is carried over into `judgeModel` and
> the old `model` key is removed. An explicitly configured `judgeModel` always wins.

- `denyKeywords`: a hit sends the request to human (irreversible operations)
- `allowRules`: each rule matches on `tool` / `mode` / `category` / `contains` (omitted fields match anything). Learned rules are also written here
- `denyRules`: written automatically after a human rejection; a hit goes to human (no learning)
- `hardCategories`: flash `RISKY` in these categories → directly human (no counting, no learning)
- `riskyThreshold`: neutral confirmation threshold (default 3) — after N human confirmations of the same tool+mode+category, the N+1th occurrence auto-approves and persists a rule
- `judgeTimeoutMs`: single flash judgment timeout (default 20000ms; auto-retries once, then goes to human)
- `judgeFailureLimit`: consecutive judge failures per session before one manual human approval is offered (default 3, **machine-local**, never synchronised between machines)

## Usage

Select **"Auto Approval (Flash)"** in the session's permission dropdown (`/permission` dialog or settings). Other sessions are unaffected (gated per session preset).

## Settings Page (v0.4.1+)

A new "Auto Approval" section in the DSH settings panel (`settings.section`, styled like native DSH settings) provides visual rule management, cards ordered by pipeline stage:

- **Setup card**: detects whether the `auto-approve` permission preset exists in `cordis.patch.yml`; if missing, click "Configure" to write it automatically (text-level edit, comments preserved), effective after restart
- **Pipeline overview**: judgment pipeline + active hard-risk category badges
- **① DENY · deny list** (`denyKeywords`): view/add/remove dangerous keywords (removing a predefined keyword asks for confirmation)
- **② Allow list** (`allowRules`): view (tagged predefined / learned / user) / add (tool/mode/category/contains form) / remove — e.g. `tool=edit, mode=danger-full-access` auto-approves out-of-workspace edits
- **③ denyRules · always-human**: rejection-upgraded rules, view/remove
- **④ Flash · thresholds & timeout**: edit `riskyThreshold` (auto-approve starts at N+1th occurrence after N confirmations) / `judgeTimeoutMs` / `judgeFailureLimit` directly
- **⑤ Learning · in progress**: confirmation counts (n/N) + samples with a **"Stop" button** to intervene (removes count and samples, restarts learning)

All changes go through `POST /api/auto-approve/rules` into `allowlist.json` — **hot-reloaded immediately** (no restart); `POST /api/auto-approve/setup` handles one-click setup.

## Human Review UI (v0.4.0+)

Review entry points appear on auto-approval or human-approval (strict DSH design language, `--dsw-alias-*` tokens):

1. **Notice strip** (a dedicated row above the composer, `conversation.input.dock` order=30, does not scroll with the conversation):
   - Auto-approval → green ✅: tool + summary + verdict label (allowlist / flash-safe / learned / confirmed / flash-same), auto-dismisses after a few seconds
   - **Escalated to human → amber** (`--dsw-alias-state-warn-*`): "Waiting for human approval: <operation>", **stays until you decide**
   - **Silent / manual rejection → red** (v0.7.0+): "Rejected outright: <operation>" or "Rejected: <operation>", and it **never auto-dismisses** — it stays above the composer until you switch to the "Approval" tab or press an action button. A reconsidered rejection is no longer pending, so it is not restored as a red notice on reload and its wording flips to "Reconsideration approved" (v0.7.1). The strip offers:
     - **"View approval log"**: switches to the "Approval" tab (which also counts as reading it, so the strip collapses)
     - **"Re-approve"**: shown only when the rejection is **reconsiderable** (see below); pressing it writes an auto-approve rule and lets the AI retry the operation
   - Human approved → amber "Learning n/N, auto-approves after N" (dismisses after a few seconds)
   - Opening a session restores only **unread rejections**; auto-approved history is not replayed
   - The read position is persisted per session in browser `localStorage` (`dsh-approval-gate.seenRejects`): a reload neither loses pending rejections nor re-nags about ones already seen
2. **"Approval" history view**: the tab right of "Trajectory" (`conversation.view`, order=20). The title carries a **pending N** badge (rejections not yet reconsidered). Current session records (**newest first**): auto-approved (green ✅), human-approved (amber + learning count n/N), human-rejected (red), silent rejections (red + a "Re-approve" button)
3. **Reconsideration ("Re-approve", v0.7.0+)**: a rejected record can be reconsidered, which **writes an auto-approve rule carrying the operation fingerprint and delivers a retry instruction to the session** (so the AI re-runs the operation instead of you retyping it). Two fences:
   - **Only judge-layer silent rejections are reconsiderable**: `judge-deny` (a judge `deny` verdict, or a silent rejection after consecutive failures). The **deterministic hard-deny tier** (`hard-reject`: credential exfiltration, filesystem-root and system-path destruction) runs first and no allowlist rule can override it, so offering a button would be a false promise — it is not offered
   - **Hard-risk categories are not reconsiderable**: `deletion` / `credential` / `remote` / `system` / `bulk` mean "must be confirmed by a human every time", so reconsideration-based auto-approval is refused; loosen `hardCategories` or add an explicit allowlist rule instead
   - Reconsidering twice is idempotent (the rule is not written again); a reconsidered record is labelled "Reconsideration approved · <reason> (was rejected outright)" and drops out of the pending count (since v0.7.1 the wording and colour flip together, so it no longer looks like it is still rejected)
4. **File diff & revert** (v0.5.0+): when an auto-approval involves files, the host saves a **pre-change snapshot** at approval time (before the write). In the history view the corresponding event's **file chips become clickable** (blue outline) and open a diff panel:
   - **Changed lines only**: green `+` rows are additions, red `-` rows are deletions (classic diff semantics); the header shows +N / -M stats and unchanged-line count; a missing file is flagged
   - **Revert this change**: posts a revert instruction to the conversation (operation, files, event time, snapshot directory) so the AI restores the files to their pre-approval state
   - **Snapshot management**: the view header shows "diff snapshots <size> · <count>" with two cleanup actions — **"This session only"** (removes only the current session's snapshots, never touching other sessions' unviewed diffs) and **"Clear all"** (double-confirmed, clears every session). Both delete comparison data only — approval records stay — and after clearing, historical files can no longer be diffed
   - Limits: only text files (≤256KB each, ≤5 per event) get snapshots; binary/oversized files are not clickable

Data flow: the host appends a structured event to `~/.dsh/auto-approve/events.jsonl` per judgment (`kind`: auto / manual-pending / manual-approved / manual-rejected / hard-reject / judge-deny / reconsidered, plus sessionId/tool/mode/reason/justification/verdict/files/learningCount/threshold); the browser polls `GET /api/auto-approve/events?sessionId=&since=` (2s incremental / 5s full refresh in the view).

> `hard-reject` and `judge-deny` are **judge-layer silent rejections** (no dialog was shown): the hard-deny tier and a judge `deny` / consecutive failure respectively. The review view shows both in red as "Rejected outright" with the concrete reason.
>
> `reconsidered` is a **reconsideration record** (v0.7.0+): its `reconsiderOf` points back at the original event. The events API filters the reconsideration records out and adds `reconsidered: true` to the original event, which the frontend uses to label it "Reconsideration approved · … (was rejected outright)" and drop it from the pending count. Reconsideration does not rewrite the original event: the rejection did happen, so the reason stays visible in parentheses (v0.7.1 wording).

## Reconsideration API (v0.7.0+)

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/auto-approve/reconsider` | POST | `{sessionId, eventId, retry?}` → reconsiders one judge-layer silent rejection. Writes a fingerprint-scoped `allowRules` entry (its `description` is prefixed "User reconsidered:") and, when `retry !== false`, delivers a retry instruction. Returns `{ok, rule, duplicate, delivery}`; 400 with the reason (the `error` says whether it is the hard-deny tier or a hard-risk category) when not reconsiderable |

Fences (enforced server-side; the UI merely hides the button): `kind` must be `judge-deny`, and `category` must not hit `hardCategories`.

## File Diff & Revert API (v0.5.0+)

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/auto-approve/diff?eventId=&path=` | GET | Changed lines (`changedLines`, add/del) and stats for an event/file; reads only paths listed in that event's snapshot |
| `/api/auto-approve/revert` | POST | `{sessionId, eventId}` → assembles a revert instruction and delivers it to the session (typertGateway first, `agent.followup` fallback) |
| `/api/auto-approve/snapshots-stats?sessionId=` | GET | Snapshot usage `{count, bytes, ids, files}` (ids = events that still have snapshots; drives chip clickability; scoped to one session when sessionId is given) |
| `/api/auto-approve/snapshots-clear` | POST | Deletes snapshot files (only `.json` inside `snapshots/`); with `{sessionId}` it clears just that session, otherwise all sessions |

## Learning Semantics (v0.3.0+)

Neutral confirmation learning: each human approval of the same tool|mode|category increments the count; after **N confirmations (default 3), the N+1th occurrence auto-approves** and persists a fingerprinted rule. In the threshold state: fingerprint hit auto-approves; otherwise Flash semantically verifies against confirmed samples (SAME approves / DIFFERENT goes to human); rejections upgrade to denyRules (always human); in-progress learning can be stopped from the settings page.

## Security Design

1. **Hard-deny layer outranks everything**: credential exfiltration and destruction aimed at a filesystem root, an OS/credential-critical path or a Windows device namespace are rejected outright with no dialog; `DSH_HOME` and the home root escalate to a human. The judge model cannot overturn these facts
2. **DENY layer**: irreversible keywords go to human with zero model calls and zero false negatives
3. **Hard-risk categories are always human (symmetric gate, corrected in v0.7.0)**: `deletion`/`credential`/`remote`/`system`/`bulk` are never counted, learned, covered by persisted rules, or **reconsiderable**; whether the judge answers `allow` or `deny`, a hard category goes to a human. The `deny` branch used to precede the hard-category check, so a model `deny` on a hard category was rejected silently and made the configured categories inert — that is fixed
4. **Secrets never leave the machine**: judge inputs are redacted (tokens, key blocks, `Bearer` headers, `key=value` secrets) and truncated before the request is sent; secret-named and bulk-content argument fields are replaced by placeholders
5. **Learned rules carry category + operation fingerprint**: persisted rules are `{tool, mode, category, contains}` (contains = a fingerprint you confirmed); only the same fingerprint auto-approves. When the fingerprint misses, flash does **semantic similarity verification** against your confirmed samples — DIFFERENT or verification failure always goes to human; rejected operations upgrade to denyRules (with fingerprint; without one, the whole kind is blocked), never auto-approved
6. **Fail-safe**: judge failure, timeout (20s × 2 attempts), or malformed/unparseable output → neutral degradation or human; hard risks are never auto-approved. Consecutive failures are counted per session (first 2 silently rejected, the 3rd offers one manual approval) so an outage cannot trap the task
7. **Authorization is human-only**: only direct-human session messages count (at most 4, sanitized, 4000-character budget). Repository content, tool output, assistant prose, skills, plugins and subagent text are not authorization
8. **Recoverable first**: `workspace-write` (workspace writes) auto-approve by default; the judge runs only for escalations
9. **Per-session gating**: only sessions that explicitly selected the "Auto Approval (Flash)" preset are intercepted
10. **Judge only, never execute**: the plugin returns an allow/forward decision; it does not modify the rest of the approval flow

> Warning: auto-approval dramatically lowers human intervention. **Trusted environments only** — keep the `ask` preset for production data, remote systems, payments, and other high-risk scenarios.

## Technical Notes

- Mounted at the front of the `approval/request` waterfall (`prepend: true`, before the web answerer)
- Gate: `permissionPresets.current(session) === 'auto-approve'` (pass Session object: reads sessionProjections.stateOf(session,'permissions') internally)
- DSH approval fires on sandbox escalation; `reason` is always `escalate sandbox to <mode>: <justification>`, with `mode` in `workspace-write` / `danger-full-access`
- flash judgment: `reasoningEffort: 'off'` + `maxTokens: 256`, strict JSON verdict `{decision, reason, category}` (code fences tolerated; any deviation throws and is handled fail-safe)
- Timeout: `AbortController` signal into `llm.stream` (cancellable), `Promise.race` + `ctx.timeout(judgeTimeoutMs)`, abort + one retry
- Similarity verification: current operation context + confirmed samples to flash (`SAME`/`DIFFERENT`); failure counts as DIFFERENT
- Hard-deny facts: `src/paths.mjs` (path normalization, critical-path and destructive-target detection, credential-material and URL-credential detection) + `src/classifier.mjs` (strict JSON verdict parsing) + `src/sanitize.mjs` (judge-input redaction)
- Dynamic system prompt: `systemPrompt.context` with `name: 'approval-gate:policy'`, ordered right after the host's sandbox policy; the text callback returns `''` for any session not on the `auto-approve` preset
- Learning loop: captures human verdicts through the waterfall `next()` return (`allowed-once` persists / `rejected` upgrades)
- Review UI: host writes `events.jsonl` + `GET /api/auto-approve/events` (sessionId filter + since cursor); client polls and renders
- Snapshots & diff: approval happens before the write, so the auto-approval event saves `snapshots/<eventId>.json` at record time (text only, ≤256KB per file, ≤5 per event); diff uses approximate line matching and returns changed lines only (up to 500)
- Revert delivery: `sendToSession` prefers `typertGateway.invoke({namespace:'session', method:'prompt'})` (queue mode), falling back to `agent.followup`

## Tests

`npm test` syntax-checks every source file and runs the six suites:

| File | Covers |
|------|--------|
| `test/absorbed.test.mjs` | Regression tests for the five ported capabilities against the **real exports** in `src/`: the structured JSON verdict protocol, judge-input redaction, the per-session judge-failure counter, the deterministic hard-deny tiers, and the dynamic system-prompt context (injected only while the preset is active). Uses a temporary `DSH_HOME` so the real `~/.dsh/auto-approve` is never touched |
| `test/pipeline.test.mjs` | End-to-end pipeline test driven through a **mock host** that actually executes the registered `approval/request` handler: hard-deny reject (no dialog) → hard-fact human → dangerous keywords → allowlist → redaction → structured judge → hard categories (ahead of allow / deny) → `deny` / `allow` / `ask` → failure counting → confirmation-based learning. Asserts the returned verdict, whether `next()` was called (i.e. whether a dialog appeared), and the exact message sent to the judge model. Includes the `deny + neutral` silent-reject case and its `deny + hard category` human-escalation counterpart |
| `test/reconsider.test.mjs` | Contracts of the reconsideration endpoint (`POST /api/auto-approve/reconsider`): the hard-deny tier and hard-risk categories both return 400 without writing a rule, a neutral silent rejection is reconsiderable (fingerprint rule + delivered retry + `reconsiderOf` recorded), the events API annotates `reconsidered` and filters the reconsideration records out, reconsidering twice is idempotent, and an unknown event is a 404 |
| `test/client-render-smoke.test.mjs` | **Real rendering** smoke tests of the client bundle (minimal React hooks shim + DOM/fetch stubs): rejection notices persist and carry "Re-approve" / "View approval log", hard rejects get no re-approve button, only reconsiderable rows in the approval view offer the button, opening the tab marks rejections seen, and a seen rejection does not re-surface after a reload |

`test/unit.test.mjs` and `test/seed-sync.test.mjs` cover the pre-existing rule matching, config migration and cross-machine rule sharing.

## License

MIT

This project is a fork of [moon09300731/dsh-approval-gate](https://github.com/moon09300731/dsh-approval-gate);
the original author's copyright notice is retained in [LICENSE](../LICENSE).

The deterministic hard-deny layer, classifier-input redaction, structured JSON verdict protocol,
consecutive judge-failure counter and dynamic system-prompt guidance were ported from
[NanmiCoder/dsh-auto-mode](https://github.com/NanmiCoder/dsh-auto-mode) (MIT License), adapted to
this plugin's confirmation-based learning pipeline. Credit for those capabilities belongs to that project.
