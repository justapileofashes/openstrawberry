# Local coding-agent adapter references

OpenStrawberry will invoke local coding CLIs only through their documented noninteractive interfaces, with an explicit user approval boundary before a task begins. The adapter implementation must keep API keys scoped to one spawned process, avoid loading untrusted workspace configuration where a tool provides a bare mode, and capture structured output rather than parsing terminal presentation text.

| Adapter | Verified invocation pattern | Planned OpenStrawberry policy |
|---|---|---|
| Codex CLI | `codex exec` runs a noninteractive task. The official documentation describes `--sandbox workspace-write` for editing, JSON Lines via `--json`, and an inline `CODEX_API_KEY` for one automation invocation. | Default to read-only planning/review. Allow a user-approved isolated workspace-write run only after the task plan, target directory, and model binding are visible. Use structured events where available. |
| Claude Code | `claude -p` runs noninteractively. The official documentation recommends `--bare` for scripted calls, explicit `--allowedTools`, and structured JSON or stream-JSON output. | Use bare mode by default, explicit least-privilege allowed tools, a process-scoped `ANTHROPIC_API_KEY`, and bounded workspace paths. |
| OpenCode | `opencode run` is the documented noninteractive command. It supports model/agent choice, JSON event output, working-directory selection, and explicit auto-approval. | Use a dedicated OpenStrawberry working directory and JSON output. Do not enable automatic approval unless a user-approved task policy explicitly permits it. |

## Source references

[1] OpenAI, [Codex CLI non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode).

[2] Anthropic, [Run Claude Code programmatically](https://code.claude.com/docs/en/headless).

[3] OpenCode, [CLI reference](https://opencode.ai/docs/cli/).

## Provider protocol notes

| Provider family | Verified protocol boundary | Adapter policy |
|---|---|---|
| OpenAI-compatible providers and OpenRouter | OpenRouter documents a standard `POST /api/v1/chat/completions` endpoint using a bearer key, model identifier, and message list. It also documents compatibility with the OpenAI SDK when pointed at its base URL. | A single OpenAI-compatible adapter will accept an explicit base URL and model. It will supply the key only in the main-process HTTP request and will redact it from all emitted run events. |
| OpenAI | The official Chat Completions reference describes a response generated from a list of messages; OpenAI recommends the newer Responses API for new projects. | The first adapter layer will use an explicit configured protocol mode. It will not silently transform an OpenAI-compatible gateway into a native Responses request. |
| Anthropic | The official Messages API uses `POST /v1/messages`, top-level `system` content, an alternating user/assistant message list, and a required `max_tokens` bound. | A native Anthropic adapter will be separate from the OpenAI-compatible adapter and will enforce an explicit output-token ceiling. |

[4] OpenRouter, [Quickstart](https://openrouter.ai/docs/quickstart).

[5] OpenAI, [Chat Completions overview](https://developers.openai.com/api/reference/chat-completions/overview/).

[6] Anthropic, [Messages API](https://platform.claude.com/docs/en/api/messages).
