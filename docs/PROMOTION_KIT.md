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
