# OpenStrawberry launch kit

This kit is written for launch preparation. It describes only implemented capabilities at the time of writing. Do not claim that OpenStrawberry is a signed production browser, has automatic multi-agent execution, imports passwords/sessions, or is a full Chrome replacement.

## Core positioning

> **OpenStrawberry is a local-first Electron browser foundation for split-pane Chromium browsing and approval-gated AI companions.** It combines real embedded browser tabs, a secure per-agent credential boundary, review-first orchestration plans, and carefully constrained provider and coding-CLI execution.

## GitHub description

`Local-first Electron browser with split workspaces and approval-gated AI companions.`

## Show HN draft

**Title:** Show HN: OpenStrawberry – a local-first Electron browser with approval-gated AI companions

I’m building OpenStrawberry, an open-source Electron browser foundation for people who want browser workspaces and AI companions without sending browser state or credentials through a generic web app.

The current build has real Chromium BrowserView tabs, drag-to-split panes, session restore, workspace snapshots, reader mode, media controls, downloads, and a command palette. It supports separate encrypted credential bindings per agent, review-first orchestration plans, approval-gated OpenAI-compatible/Anthropic provider runs, and constrained Codex, Claude Code, and OpenCode execution in app-owned workspaces.

The security boundaries are intentionally part of the project: remote pages are sandboxed and Node-free; the renderer cannot access raw keys; every execution run requires native confirmation; browser context is minimized before it reaches an agent; and migration does not copy passwords, cookies, sessions, payment data, account tokens, or history.

It is still an early foundation. It does not yet ship signed installers, automatic multi-agent execution, password-file import, Qwen Code/Kimi Code execution, or a full tracker blocker. I would value feedback from Electron security practitioners, browser-tool builders, and developers who use local coding CLIs.

Repository: https://github.com/justapileofashes/openstrawberry

## Reddit draft

**Title:** I’m building OpenStrawberry, a local-first split-pane Electron browser with approval-gated AI companions

OpenStrawberry is an open-source desktop-browser foundation rather than a hosted AI browser. The current version focuses on real BrowserView tabs, split workspaces, local session restore, a command palette, reader mode, native-compatible media controls, and per-agent encrypted credential bindings.

For agent work, provider and local CLI execution are explicit user-approved actions. Remote webpages stay sandboxed and Node-free, raw API keys stay out of the renderer, and selected-tab context is reduced to origins before it goes to an agent. Browser migration imports only compatible bookmark/default-search data; it does not copy passwords, cookies, sessions, account tokens, payment data, or history.

The repo is early and I’m looking for technical feedback and contributors, especially around Electron hardening, cross-platform release engineering, workspace UX, and safe local CLI integrations. Signed installers and automated multi-agent execution are not available yet.

https://github.com/justapileofashes/openstrawberry

## Developer social post

Open-sourced **OpenStrawberry**: a local-first Electron browser foundation with real split-pane Chromium tabs, workspace snapshots, encrypted per-agent credentials, review-first orchestration, and approval-gated provider/Codex/Claude Code/OpenCode runs.

Early build, security-first boundaries, and no password/session copying. Looking for Electron security, browser UX, and release-engineering contributors.

https://github.com/justapileofashes/openstrawberry

## Outreach checklist

| Step | Guidance |
|---|---|
| GitHub | Set accurate description and topics, ensure issue templates are enabled, and link contributors to the security document. |
| Launch communities | Read each community’s current self-promotion rules before posting; tailor the draft rather than cross-posting identical text. |
| Feedback | Ask for technical critique and contributors, not stars. Respond to issues with the same accuracy as the README. |
| Release claims | State clearly that installers are not signed or publicly released until platform signing and provenance controls are complete. |

## Authorized-channel readiness review

| Channel | Status | Decision |
|---|---|---|
| Hacker News Show HN | The authenticated submission page was not available to automation, and the published HN guidelines prohibit generated or AI-edited text. | Do not submit this generated draft. The repository owner may provide a final human-authored post for manual submission. |
| Reddit r/electronjs | Account access was verified and the text-post interface is available. No community-specific restrictions were visibly displayed in the submission interface. | Eligible for a transparent technical introduction, subject to final per-post confirmation. |
| Reddit r/opensource | Account access was verified, but the visible rules prohibit spam, excessive self-promotion, and drive-by posting. | Do not submit a repository launch announcement. Engage only if a moderator-approved or substantive community discussion path is available. |
| Instagram | The configured connector is enabled but not connected to a business account. | Cannot create or publish a post until the user connects the intended Instagram account. |

### Submission result

On 15 August 2026, the authorized post was submitted to [`r/electronjs`](https://www.reddit.com/r/electronjs/comments/1voyne1/im_building_openstrawberry_a_localfirst_electron/). Reddit immediately marked it **removed by Reddit’s filters**. No duplicate repost was attempted. A future community submission should use a substantially revised, owner-authored message or follow a moderator-approved route rather than attempting to evade the platform’s filters.

## Final r/electronjs submission

**Title:** I’m building OpenStrawberry, a local-first Electron browser with split panes and approval-gated AI companions

**Body:**

I’ve open-sourced OpenStrawberry, an early Electron browser foundation focused on real BrowserView tabs, split-pane workspaces, local session restore, a command palette, reader mode, downloads, and compatible native media controls.

The part I’d especially value Electron feedback on is the local-first agent boundary. Each Companion has a separate encrypted credential binding, provider and local CLI runs require native approval, remote pages stay sandboxed and Node-free, and browser context is minimized before it is passed to an agent. The current execution adapters cover OpenAI-compatible and Anthropic Messages providers plus Codex, Claude Code, and OpenCode in app-owned workspaces.

This is not a signed production browser yet, and it does not copy passwords, cookies, sessions, payment data, account tokens, or browsing history during migration. It also does not yet provide automatic multi-agent execution, Qwen Code/Kimi Code runtime adapters, or tracker blocking.

I’m looking for technical feedback on Electron security boundaries, BrowserView workspace UX, and release engineering rather than generic promotion. The repository and threat-model details are here:

https://github.com/justapileofashes/openstrawberry
