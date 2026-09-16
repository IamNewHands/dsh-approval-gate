[简体中文](README.md) | **English**

# dsh-approval-gate

**Auto-approval gate for DeepSeek Harness — minimal human intervention: safe operations auto-approve, risky ones go to a human (fail-safe).**

A deterministic hard-deny layer and a Flash model pre-judge every sandbox escalation: credential exfiltration and destruction aimed at system paths are rejected outright, routine operations auto-approve, hard-risk operations (deletion / credentials / remote / system / bulk) always require human confirmation; learned rules only ever cover operations you confirmed, with an in-app human review UI.

> **Origin**: this project is a fork of [moon09300731/dsh-approval-gate](https://github.com/moon09300731/dsh-approval-gate),
> with several defects fixed and multi-machine rule sharing added. The original author's copyright
> and the MIT license are in [LICENSE](LICENSE). This repository
> ([IamNewHands/dsh-approval-gate](https://github.com/IamNewHands/dsh-approval-gate)) is the maintained version.
>
> **Upstream attribution**: the deterministic hard-deny layer, the classifier-input redaction,
> the structured JSON verdict protocol, the consecutive judge-failure counter, and the dynamic
> system-prompt guidance were ported from [NanmiCoder/dsh-auto-mode](https://github.com/NanmiCoder/dsh-auto-mode)
> (MIT License), adapted here to this plugin's confirmation-based learning pipeline.
> Credit for those five capabilities belongs to that project.

## ✨ Features

- 🚦 **Deterministic hard-deny layer** (evaluated *before* keywords): credential exfiltration and destruction targeting a filesystem root, an OS/credential-critical path, a Windows device namespace or a reserved device name are **rejected outright with no dialog** so the agent replans; `DSH_HOME` paths and the user home root escalate to a human instead, preserving manual approval. Ordinary workspace operations are unaffected
- ⚡ **Flash risk pre-judgment**: every sandbox escalation is judged by a Flash model, which must return a **strict JSON verdict** `{decision, reason, category}` with `decision` ∈ `allow` / `ask` / `deny` and `category` ∈ `deletion` / `credential` / `remote` / `system` / `bulk` / `neutral`; recoverable operations auto-approve
- 🔒 **Classifier-input redaction**: private key blocks, cloud/GitHub/Slack tokens, `Bearer` headers and `key=value` secrets become `[redacted-secret]`; text is truncated to 1000 characters; arguments are sanitized by field name (secret-named fields → `[redacted-secret-field]`, bulk-content fields → `[redacted-<key>:<length>-chars]`). Secrets never leave the machine
- ♻️ **Judge-failure counter**: judge failures are counted per session — the first 2 are silently rejected so the agent can replan, the 3rd (`judgeFailureLimit`) offers one manual human approval so a long outage cannot trap the task; a successful response resets the counter
- 🧭 **Dynamic system-prompt guidance**: while the `auto-approve` preset is active, an `<auto_approve_policy>` block is injected into the session's dynamic runtime context, telling the agent that routine workspace work runs directly, that deletion is the highest-risk routine operation and its authority must never be generalized to a variable/glob/parent/sibling/second target, that a reversible move or backup is preferred, and that hard-denied calls are rejected without a dialog so it should replan rather than resubmit
- 🛡️ **Hard risks are always human**: deletion, credentials, remote/production, system paths, and bulk irreversible operations go directly to human — no counting, no learning
- 🎯 **Confirmation-based learning**: after N human confirmations of the same operation, the N+1th occurrence auto-approves; persisted rules carry an **operation fingerprint**, so only operations you confirmed are auto-approved
- 🧠 **Semantic similarity verification**: operations with different wording but the same intent are judged by Flash against your confirmed samples — no keyword dependency
- 📄 **File diff & revert** (v0.5.0+): click a file in an approval record to view a **unified diff** — changed lines with ±5 context lines, multiple changes grouped into hunks separated by gray "N unmodified lines" bars, green additions / red deletions / gray context, dual line numbers; one-click **Revert** sends a command for the AI to restore the file from snapshot
- 🗂️ **Session-scoped snapshots** (v0.5.0+): snapshots belong to the event's session; the approval view shows only the current session's snapshot stats; clearing supports "this session only" vs "clear all" to avoid wiping other sessions' unviewed diffs
- 🔧 **Hot-reloadable config**: `allowlist.json` edits take effect immediately, no restart
- ✅ **Human review UI**: a green notice appears above the composer on auto-approval; the "Approval" view (right of Trajectory) shows the current session's full auto-approval timeline

## 📸 Interface Overview

### ① Approval View

![Approval View](docs/screenshots/approval-view.png)

The "Approval" tab (right of Trace) lists the current session's auto-allowed and manually-approved actions in reverse-chronological order: each record shows the tool (`bash` / `edit`), a verdict tag ("Auto-allowed · Flash safe", "Approved" etc.), timestamp and description. The top bar shows this session's **diff snapshot usage** (`2.9 KB · 3 items`) with two cleanup options: **"This session only"** (removes only the current session's snapshots, never touching other sessions' unviewed diffs) and **"Clear all"** (double-confirmed, clears every session).

### ② File Diff

![Diff Dialog](docs/screenshots/diff-panel.png)

Click a file in an approval record to open the diff dialog: a **unified diff** with green additions (`+`), red deletions (`-`) and gray context lines; dual **old/new line numbers** on the left; multiple changes grouped into **hunks** with gray "`6 unmodified lines`" separators folding unchanged regions. The header shows `+2 / -2 changed · 20 unchanged`. The **Revert** button at the bottom sends an undo command to the conversation so the AI restores the file from the pre-approval snapshot.

### ③ Settings · Auto-approval

![Settings Auto-approval](docs/screenshots/settings-auto-approve.png)

The "Auto-approval" section in Settings provides full configuration: **preset initialization** (one-click write of the `auto-approve` preset into `cordis.patch.yml`), **pipeline overview**, **deny-keyword blacklist** (built-in entries + custom add), and hot-reload notes (changes take effect immediately, no restart).

The judgment pipeline runs in this order:

```
hard-deny (credential / system-path) → hard-fact human escalation → dangerous keywords
→ allowlist → deny-rules → structured JSON judge (allow / ask / deny; hard categories → human;
neutral → confirmation-based learning; failure limit) → verdict learning
```

## 🚀 Quick Start

```sh
dsh plugin --profile web add "github:IamNewHands/dsh-approval-gate#main"
```

> The `dsh-approval-gate` package on npm is upstream 0.5.0 and lacks this repository's fixes — do not install it by package name.

1. **Add the permission preset**: append the `auto-approve` preset to `~/.dsh/profiles/web/cordis.patch.yml` ([see guide](docs/GUIDE.en.md#%E2%9A%A0%EF%B8%8F-manual-permission-preset-required-after-install))
2. **Restart** `dsh web`
3. **Select the preset**: choose "Auto Approval (Flash)" in the session's permission dropdown

## 📖 Docs

- [Full Guide (pipeline / configuration / security / review UI)](docs/GUIDE.en.md) · [中文指南](docs/GUIDE.md)

## 📄 License

MIT
