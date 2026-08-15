# Contributing to OpenStrawberry

Thank you for considering a contribution to OpenStrawberry. The project is building a local-first Electron browser foundation with deliberately constrained agent execution. We value clear threat boundaries, reproducible behavior, and honest scope statements over feature count.

## Before you start

For bug reports and feature discussions, please search existing issues first. For a significant change to Electron process boundaries, provider execution, credential storage, browser migration, permissions, or packaging, open an issue describing the design before writing a large pull request.

> **Security concerns must not be reported publicly.** Follow the private reporting path in [`docs/SECURITY.md`](docs/SECURITY.md).

## Local setup

```bash
pnpm install
pnpm test
pnpm check
pnpm dev
```

The application uses Electron, Vite, React, TypeScript, and pnpm. Keep main-process and preload changes minimal; guest webpages are untrusted and must never receive Node.js or raw credential access.

## Contribution expectations

Every behavior change should include focused Vitest coverage and should keep the following checks green:

```bash
pnpm test
pnpm check
pnpm build
```

Use small, descriptive commits. Explain user-visible behavior, security implications, limitations, and testing in the pull request. Do not add mock reviews, testimonials, fake benchmark data, trackers, hard-coded credentials, or unreviewed provider/CLI execution paths.

## Architecture guardrails

| Area | Required contribution boundary |
|---|---|
| Remote content | Keep BrowserView pages sandboxed, context-isolated, Node-free, permission-denied, and restricted to HTTP(S) navigation. |
| IPC | Add one narrow preload wrapper per purpose, validate every payload in the main process, and preserve trusted-sender checks. |
| Credentials | Keep raw keys in the main process only; use the encrypted vault and never log, serialize, or return keys to the renderer. |
| Agents | Preserve explicit native approval before provider or local CLI execution. Treat webpage context as untrusted and minimize it before transfer. |
| Migration | Do not copy browser password stores, cookies, sessions, payment data, or account tokens. |
| Releases | Do not present unsigned smoke-build artifacts as trusted public releases. |

## Conduct

Participation is governed by the project [Code of Conduct](CODE_OF_CONDUCT.md).
