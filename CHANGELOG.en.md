# Changelog

This file records notable changes to dsh-approval-gate. Version numbers follow [Semantic Versioning](https://semver.org/).

> Chinese version: see [CHANGELOG.md](CHANGELOG.md).

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

## [0.5.0] — 2026-09-15

### Added

- **File-change diff and revert**: files involved in an approval can be clicked to view a unified diff, with changed lines shown with 5 lines of surrounding context, multiple edits split into hunks and collapsed behind an "N unmodified lines" separator, and dual line numbers; a one-click "Revert this change" delivers an instruction telling the AI to restore the file from the snapshot
- **Session-level snapshot management**: snapshots belong to the session of their event, the approval view counts per current session, and cleanup offers two levels: "clear this session only" and "clear all"
- diff / revert / snapshot-management API

### Fixed

- **Broken diff snapshot data source**: `callId` traces back through the tool arguments to obtain the real path (layer B), with `justification` as a fallback (layer C); `manual-pending` now saves snapshots too
- **Read-only bash commands produced false snapshots**: write detection tightened, device/empty-content filtering, and file-level clickability in the UI
- Fixes for auto-learning defects, judge-model decoupling, and a batch of upstream issues

## [0.4.1] — 2026-09-14

### Added

- An "Auto-approve" section on the settings page: visual rule management (pipeline overview / dangerous-word blacklist / allowlist / permanent-manual / thresholds and timeouts / currently learning)
- One-click permission-preset initialization (text-level write to `cordis.patch.yml`, preserving comment formatting)
- Rule-management API: `GET/POST /api/auto-approve/rules`, `POST /api/auto-approve/setup`

### Fixed

- Prompt-banner history popup issue

## [0.4.0] — 2026-09-14

### Added

- **Manual review UI**: a green banner above the input box when something is auto-approved; an "Approvals" history view (to the right of the trajectory)
- Approval history view in reverse-chronological order (newest first)

### Fixed

- `client.js` now provides the standard export pattern (`default` / `apply` / `inject`), matching the DSH bundle specification

## [0.3.0] — 2026-09-13

### Added

- **flash third-party same-class verification**: semantically judges whether a new operation is the same class as the user's confirmed samples (`SAME` / `DIFFERENT`)
- **Neutral-category manual confirmation rule**: once the same "tool + mode + category" has been manually confirmed N times, it is auto-approved from the N+1th time on
- Distilled/rejection rules carry an **operation fingerprint** (`contains`), fixing a loophole where broad rules wrongly auto-approved
- Hot reload of `allowlist.json` configuration (re-read from disk before every approval, so configuration changes need no restart)

### Fixed

- White-box review fixed 3 P0 and 3 P1 issues (reachability / effectiveness)

## Earlier versions

Anything before 0.3.0 belongs to this fork's initial development stage and to the base implementation from upstream [moon09300731/dsh-approval-gate](https://github.com/moon09300731/dsh-approval-gate), and is not recorded entry by entry.
