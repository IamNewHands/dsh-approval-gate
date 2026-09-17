# Changelog

This file records notable changes to dsh-approval-gate. Version numbers follow [Semantic Versioning](https://semver.org/).

> Chinese version: see [CHANGELOG.md](CHANGELOG.md).

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
