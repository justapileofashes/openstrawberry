# Security posture

OpenStrawberry is a **local-first Electron browser foundation**. It treats webpages, imported browser-profile files, renderer IPC payloads, provider responses, and local CLI output as untrusted input. The application does not claim to provide the same security services as Chrome or another fully resourced browser vendor; Electron itself cautions that rendering untrusted content has inherent limitations and requires downstream applications to update Electron promptly.[1]

## Enforced controls

| Boundary | Implemented control |
|---|---|
| Remote webpages | Every `BrowserView` disables Node integration, enables context isolation and sandboxing, retains web security, denies all permissions, blocks non-HTTP(S) navigation, and denies unsafe popup targets. |
| Privileged UI | The local renderer is sandboxed, locked to its own development or packaged-file origin, has a restrictive CSP, disables `webview` tags, and cannot open arbitrary new windows. |
| IPC | The preload exposes one narrow method per channel. Main-process handlers reject senders other than the local app renderer and validate every renderer-reachable payload before acting on it. |
| Credentials | Per-agent credentials are encrypted with Electron `safeStorage` only when operating-system encryption is available. The renderer receives only credential status, never raw keys. Agent registry and vault files are written atomically with private file permissions where the platform supports POSIX modes. |
| Provider execution | Every run requires a native user confirmation. Only HTTPS provider endpoints are accepted; custom endpoint URLs cannot contain embedded credentials, query strings, or fragments. Browser context is reduced to web origins before it is handed to an agent. Provider responses are time- and size-bounded. |
| Local CLI execution | Only Codex, Claude Code, and OpenCode have fixed, shell-free invocation templates. Each run requires native confirmation, uses a private app-owned workspace, resolves an allowlisted CLI to an absolute executable path, restricts inherited environment variables, bounds output, and times out. |
| Migration | Imported Chromium JSON is read only after approval, from regular non-symlink files with size limits. Bookmark parsing is depth- and count-bounded, keeps only valid HTTP(S) URLs, and does not read passwords, cookies, sessions, payment data, account tokens, or history. |
| Packaging | Electron Builder packages the application in an ASAR archive. Linux package metadata and the OpenStrawberry icon are configured; unsigned distribution is explicitly prohibited in the release checklist. |

Electron recommends context isolation, sandboxing, explicit permission handlers, navigation limits, popup limits, restrictive IPC APIs, and use of current framework versions when rendering remote content.[1] [2] The implementation applies those controls to both the privileged local renderer and every remote BrowserView.

## Security-review evidence

The hardening pass added tests for unsafe URL schemes and malformed navigation values, IPC payload bounds and enum validation, credential-bearing context URL minimization, HTTPS provider URL rules, and bounded migration parsing. The project currently passes all unit tests, both TypeScript configurations, and a production build. A production-dependency audit returned no known high-severity advisories at the time of this review.

## Important residual risks

| Risk | Current position |
|---|---|
| Remote-site compromise | A malicious website can still attack its own renderer process or exploit an upstream Chromium/Electron vulnerability. Keep Electron updated and do not treat the app as equivalent to Chrome’s Safe Browsing or Certificate Transparency services. |
| Agent capability | An approved provider or local CLI receives the user’s task and sanitized selected-tab origins. A local coding CLI can modify files inside its OpenStrawberry-owned workspace; review its output and workspace changes before reuse. |
| Local-account compromise | OS-level malware or an attacker with the user’s account privileges can potentially access app data. `safeStorage` depends on OS credential protection and cannot replace full-disk encryption or account security. |
| Unsigned artifacts | The Linux DEB smoke build is unsigned and must not be treated as a public trusted release. macOS notarization, Windows Authenticode, signed checksums, and release provenance remain required. |
| Feature scope | Password-file import, automatic multi-agent execution, external video capture, tracker/ad blocking, and Qwen Code/Kimi Code execution are not implemented in this hardening scope. |

## Reporting a vulnerability

Please avoid opening a public issue for a suspected vulnerability. Use GitHub’s private security-advisory reporting mechanism for the repository, include a minimal reproduction and impact description, and allow maintainers time to investigate before disclosure.

## References

[1] [Electron Security](https://www.electronjs.org/docs/latest/tutorial/security)

[2] [Electron Context Isolation](https://www.electronjs.org/docs/latest/tutorial/context-isolation)

[3] [Electron Process Sandboxing](https://www.electronjs.org/docs/latest/tutorial/sandbox)
