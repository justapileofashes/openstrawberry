# Transparent Tracker-Blocking Policy

OpenStrawberry’s app-owned browser partition will use Electron’s main-process `Session.webRequest.onBeforeRequest` hook to cancel only requests that match a compact, maintained tracker-host policy. Electron documents `onBeforeRequest` as a session-level interception point whose callback can cancel a request, and reports the request URL, referrer, and resource type to the handler.[1]

| Policy element | Intended behavior |
|---|---|
| Scope | The persistent OpenStrawberry browser partition only; the renderer and guest pages do not receive blocking control or rule lists. |
| Default | Block known analytics, pixel, and tag-manager hosts only for non-document subresources. Main-frame and sub-frame navigation are never blocked by this baseline. |
| Per-site control | A local allow-list may disable blocking when the initiating page’s host matches the user-selected site entry. This setting is transparent and reversible. |
| Transparency | The browser UI receives only a bounded blocked-request count for the active page, not full third-party URL logs or page content. |
| Exclusions | No content rewriting, cookie copying, credential access, or inspection of request bodies is part of the baseline. |

> **Compatibility note:** This is a conservative starter policy, not a claim of comprehensive ad blocking. Sites can depend on third-party resources, so OpenStrawberry preserves navigation and gives users an explicit per-site off switch.

Electron notes that a `WebRequest` event uses the last listener attached for that event, so OpenStrawberry keeps the interception handler in the browser manager rather than allowing plugins or renderer code to attach competing request listeners.[1] The persistent session is intentionally created from the `persist:` partition used by app-owned BrowserViews.[2]

## References

[1]: https://electronjs.org/docs/latest/api/web-request "Electron — WebRequest API"
[2]: https://electronjs.org/docs/latest/api/session "Electron — Session API"
