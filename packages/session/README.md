# @0bridge/session

`0b.session/1`: one shape for a session from any AI tool, a coding agent's transcript or a chat
app's conversation, so it can move between tools and be kept anywhere. The package also has pure
converters from each tool's own logs, secret masking, and a lossy export to DTI's "AI Conversation
History".

It reads nothing and sends nothing: no `fs`, no network, no `node:*` imports (a test enforces it).
The 0bridge CLI finds the logs and calls the converters; the 0bridge gateway (a Cloudflare Worker)
uses the same code for transcripts that reach it another way.

> Status: version 1, used by 0bridge. It is not a standard. It will be called one only once two
> tools outside 0bridge read or write it.

```ts
import { converters, toConversation, validate } from "@0bridge/session";
import { redact } from "@0bridge/session/redact";
import { toDti } from "@0bridge/session/dti";

const first = converters["claude-code"](linesReadSoFar);
const later = converters["claude-code"](linesAppendedSince, first.state); // continues exactly
const messages = toConversation([...first.events, ...later.events]).map((m) => ({ ...m, text: redact(m.text) }));
```

## The schema

A session document is a `Session`, optionally with its `events`. The JSON Schema is
[`schema/session-1.json`](schema/session-1.json); `validate(x)` checks the same rules and names
what's wrong.

### Session

| Field | Type | Meaning |
|---|---|---|
| `schema` | `"0b.session/1"` | The version. |
| `id` | string | Canonical `<tool>:<native id>`, e.g. `claude-code:0f2c4a7e-…`. Starts with `source.tool`. |
| `source.vendor` | `anthropic` `openai` `google` `xai` `cursor` `meta` `nous` `openclaw` `other` | Who makes the tool. |
| `source.product` | string | Its name for people: Claude Code, Codex, Gemini CLI. |
| `source.tool` | string | Its label: `claude-code`, `claude-app`, `codex`, `codex-app`, `grok`, `cursor`, `cursor-agent`, `gemini`, `openclaw`, `hermes`. |
| `source.nativeId` | string | The tool's own session id. |
| `source.host` | string? | The machine it ran on. |
| `source.account` | string? | Which of the person's accounts of that tool, when not the default (a second Claude config folder, `CODEX_HOME`). |
| `title` | string? | The tool's title, or the first thing the person asked. |
| `cwd` | string? | The folder it ran in. |
| `repo` | `{remote?, branch?, commit?}`? | The git repo, branch and commit. |
| `createdAt`, `updatedAt` | number | Epoch milliseconds. |
| `model` | string? | The model it last used. |
| `resume` | `{kind: "native-cli" \| "acp" \| "none", command?, nativeId?}`? | How to continue it in the tool that made it, e.g. `claude --resume <uuid>`. |
| `parentId` | string? | The session this one forked from or continued (canonical id). |
| `usage` | `{inputTokens?, outputTokens?}`? | Token totals, when the log has them. |
| `x` | object? | Vendor passthrough: anything else worth keeping, unvalidated. |

### Event

| Field | Type | Meaning |
|---|---|---|
| `id` | string | The tool's id for it when there is one (a message uuid), else `#<seq>`. |
| `seq` | integer | Position in the session from 0, without gaps. |
| `ts` | number | Epoch milliseconds; 0 when the log has no time. |
| `role` | `user` `assistant` `system` `tool` | Who it's from. A tool's output is `tool`; the person's answer to an agent's question is `user`. |
| `parts` | Part[] | The content. |
| `model` | string? | The model that produced it. |
| `injected` | boolean? | Context the tool added on its own (environment, reminders, AGENTS.md, skills), not something the person typed. |
| `ask` | `question` \| `answer`? | The agent asking the person something (a question tool), and the answer. |
| `raw.line` | integer? | Line (or record) in the source log, from 0. |

### Part

| Type | Fields | Notes |
|---|---|---|
| `text` | `text`, `redacted?` | As written. |
| `thinking` | `text`, `redacted?` | Reasoning. **Stored redacted**: the converters keep that it happened (`text: ""`, `redacted: true`), not what it said. |
| `tool_call` | `callId`, `name`, `input` | `input` is the parsed arguments when they are JSON. |
| `tool_result` | `callId`, `output`, `isError?` | `output` is text, clipped at 16 KB. For an answered question it is the answer. |
| `file` | `mime`, `uri?`, `sha256?` | An attachment by reference; the bytes are never inlined. |

### The conversation (`toConversation`)

What 0bridge uploads and searches is the conversation, not the whole transcript (decision D34):
the person's and the assistant's text, plus the questions an agent asked with their answers.
Injected context, system text, tool calls, tool output, reasoning and files are left out, empty
text is dropped, and a message over 16 KB is clipped with `… [n more characters]`.

## Converters

`converters[id](lines, prev?)` takes the lines read since the last call and the state that call
returned, and gives `{events, state, meta}`. Reading a log in two pieces gives exactly the events
of reading it whole (a test checks every split of every fixture): the state carries the next
`seq`, the line count, metadata, and questions still waiting for their answer.

| Converter | Reads | Where the logs are |
|---|---|---|
| `claude-code` | Claude Code and the Claude app's Code tab | `~/.claude/projects/<project>/<session>.jsonl`, and each other Claude config folder (`~/.claude-*`, `CLAUDE_CONFIG_DIR`) |
| `codex` | Codex CLI and the Codex app | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`, and `$CODEX_HOME/sessions` |
| `openclaw` | OpenClaw's coding agents (Codex inside) | `~/.openclaw/agents/<agent>/agent/codex-home/sessions/**/rollout-*.jsonl` |
| `grok` | Grok CLI | `~/.grok/sessions/<folder>/<session>/chat_history.jsonl` |
| `gemini-cli` | Gemini CLI | `~/.gemini/tmp/<project>/chats/session-*.json` |
| `cursor-agent` | Cursor CLI | `~/.cursor/chats/<hash>/<id>/store.db`, `~/.cursor/acp-sessions/<id>/store.db` (SQLite; core reads it) |

Two more mappers take rows that 0bridge's CLI reads from SQLite: `fromCursorBubbles(rows)` for the
Cursor app (`state.vscdb`) and `fromHermesMessages(rows)` for Hermes Agent (`~/.hermes/state.db`).

### Claude Code

| Log | 0b.session/1 |
|---|---|
| file name (uuid) | `source.nativeId`; `id` = `claude-code:<uuid>` (`claude-app:` when the Claude app owns it) |
| `cwd`, `gitBranch` | `cwd`, `repo.branch` |
| `message.model` (not `<synthetic>`) | `model`, `Event.model` |
| `ai-title` line; else the first `summary` | `title` |
| `user` / `assistant` line, each content block | one event; `uuid` (`uuid:<n>` for later blocks) is its id |
| `text` block | `text` part; `injected` when it is a reminder, command wrapper or continuation summary |
| `thinking` / `redacted_thinking` | `thinking`, redacted |
| `tool_use` / `tool_result` | `tool_call` / `tool_result` (role `tool`) |
| `AskUserQuestion` and its result (`toolUseResult.answers`) | `ask: "question"` / `ask: "answer"` |
| `image` / `document` block | `file` with the media type |
| `isMeta` line | events marked `injected` |
| `isSidechain` line (a subagent's own turn) | left out |

### Codex and OpenClaw

| Log | 0b.session/1 |
|---|---|
| file name (uuid) | `source.nativeId` |
| `session_meta.originator` | `source.tool`: `codex`, `codex-app` (Desktop), `openclaw` |
| `session_meta.cwd`, `turn_context.cwd` | `cwd` (the latest wins) |
| `session_meta.git.branch` | `repo.branch` |
| `turn_context.model` | `model` |
| `response_item` `message` user / assistant | `text` (content texts joined with a newline); `injected` for environment, instructions, AGENTS.md, skills |
| `response_item` `message` developer / system | `system`, `injected` |
| `reasoning` | `thinking`, redacted |
| `function_call`, `custom_tool_call`, `local_shell_call` and their outputs | `tool_call` / `tool_result` |
| `request_user_input` and its output | `ask` |
| `event_msg`, `compacted`, `world_state`, token counts | left out |

### Grok CLI

| Log | 0b.session/1 |
|---|---|
| folder names | `source.nativeId` (the session folder), `cwd` (the URL-encoded parent) |
| `user` text inside `<user_query>` | `text` |
| other `user` text | `text`, `injected` |
| `assistant` `content` | `text` |
| `assistant` `tool_calls[]`, `tool_result` | `tool_call` / `tool_result`; `ask_user_question` is an `ask` |
| `system` | `system`, `injected` |

### Gemini CLI

The chat file is one JSON document rewritten as the chat grows (`{sessionId, startTime,
lastUpdated, messages, summary?}`), so it is passed whole each time and the state remembers how
many records were converted (the cursor is a message count). A JSONL variant (a header line, then
one record per line) is read the same way.

| Log | 0b.session/1 |
|---|---|
| `sessionId` | `source.nativeId` |
| `<project>/.project_root` (newer versions) | `cwd`; older versions only keep a hash, so there is none |
| `startTime`, `summary` | `createdAt`, `title` |
| `user` record | `text` |
| `gemini` record `content` | `text`; `model` from the record |
| `thoughts[]` | one `thinking`, redacted |
| `toolCalls[]` with `result` (`functionResponse.response.output`) | `tool_call` + `tool_result` |
| `info`, `error`, `warning` | `system`, `injected` |

Unverified: Gemini CLI wasn't installed where this was written; the shape follows its
`ChatRecordingService`.

### Cursor CLI

Each chat is a SQLite store of content-addressed blobs. `meta` key `0` holds hex-encoded JSON
(`{agentId, latestRootBlobId, name, createdAt, …}`); the root blob is a protobuf whose field 1
repeats the SHA-256 of each message blob in order (`cursorAgentMessageIds`). Message blobs are AI
SDK messages, passed one per line. Checked against a real store from Cursor CLI 2026.09.23.

| Log | 0b.session/1 |
|---|---|
| folder name | `source.nativeId` |
| `meta.json` `cwd`, `title`; meta `name`, `createdAt` | `cwd`, `title`, `createdAt` |
| `user` text inside `<user_query>` | `text`; the `<timestamp>` next to it gives `ts` |
| other `user` text (`<user_info>`, `<git_status>`, skills) | `text`, `injected` |
| `system` | `system`, `injected` |
| `assistant` parts `text` / `reasoning` / `tool-call` | `text` / `thinking` (redacted) / `tool_call` |
| `tool` parts `tool-result` (`output.value`) | `tool_result` |

Messages carry no time of their own: each takes the last `<timestamp>` seen, and 0bridge falls
back to the store's modification time before the first.

### Cursor app

`fromCursorBubbles` maps the app's `bubbleId:<composer>:<bubble>` rows in the order of the
composer's `fullConversationHeadersOnly`: type 1 is the person, type 2 the assistant, other types
(tool runs, status) are left out. The composer's `name`, `createdAt` and workspace folder give
`title`, `createdAt` and `cwd`.

### Hermes Agent

`fromHermesMessages` maps OpenAI-style rows (`role`, `content`, `tool_calls` JSON, `tool_call_id`,
`timestamp` in seconds or milliseconds). Unverified: no Hermes install was available, so 0bridge
reads `state.db` only when its `messages` table has `id`, `session_id`, `role` and `content`.

### Not yet

- **Muse Code:** TODO. Its session format couldn't be checked, so there is no converter.
- **Chat apps** (Claude, ChatGPT, Gemini): their conversations reach 0bridge when the app saves
  one through MCP (`bridge__session_save`), not from logs.

## Export to DTI

`toDti(session, events)` gives DTI's "AI Conversation History"
([schemas.pub/schemas/24](https://schemas.pub/schemas/24)):

```json
{
  "details": { "createdBy": "Claude Code", "createdAt": "…", "startTime": "…", "endTime": "…", "modality": "text" },
  "identifiers": [{ "name": "me@example.com", "identifier": "me@example.com", "type": "email" }],
  "messages": [{ "sentAt": "…", "sender": "me@example.com", "text": "…" }, { "sentAt": "…", "sender": "AI", "text": "…" }]
}
```

| 0b.session/1 | DTI |
|---|---|
| `source.product` | `details.createdBy` |
| `createdAt`, `updatedAt` | `details.startTime`, `details.endTime`; `details.createdAt` is `updatedAt`, so the export is reproducible |
| `source.account` (else `user`) | the one identifier (`type: "email"` when it is one) |
| `toConversation(events)` | `messages`: the person's by their identifier, the rest by `AI` |

Lost: tool calls and their output, reasoning, files, injected context, system text, `cwd`, `repo`,
`model`, `usage`, `resume`, event ids and roles beyond person/AI. DTI requires at least one
message; a session without conversation exports an empty list.

## Mapping to ACP and OpenTelemetry

Not exporters, just the correspondence, so a tool speaking either can read or write this schema.

| 0b.session/1 | ACP (Agent Client Protocol) | OpenTelemetry GenAI |
|---|---|---|
| `source.nativeId` / `id` | `sessionId` (`session/new`, `session/load`) | `gen_ai.conversation.id` (`session.id`) |
| `cwd` | `session/new` `cwd` | |
| `source.vendor` | | `gen_ai.provider.name` |
| `source.product` | agent `name` | `gen_ai.agent.name` |
| `model` | | `gen_ai.request.model`, `gen_ai.response.model` |
| `usage` | | `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens` |
| `resume.kind: "acp"` | `session/load` | |
| user `text` | `session/update` `user_message_chunk` | `gen_ai.input.messages` part `text` |
| assistant `text` | `agent_message_chunk` | `gen_ai.output.messages` part `text` |
| `thinking` | `agent_thought_chunk` | part `reasoning` |
| `tool_call` | `tool_call` (`toolCallId`, `title`, `rawInput`) | part `tool_call` (`id`, `name`, `arguments`); `gen_ai.tool.call.id`, `gen_ai.tool.name` |
| `tool_result` | `tool_call_update` (`status`, `rawOutput`) | part `tool_call_response` (`id`, `response`) |
| `file` | content block `resource_link` (`uri`, `mimeType`) | part `uri` / `blob` |

## Redaction

`redact(text, values?)` masks, as `[secret]`, the given values (6 characters or more, longest
first) and anything shaped like a credential: OpenAI, Anthropic, Stripe and OpenRouter keys, AWS
access key ids, GitHub and Slack tokens, Google API keys and OAuth tokens, JWTs, PEM private keys,
0bridge recovery keys, passwords in URLs, and values after names like `SECRET`, `TOKEN`,
`PASSWORD` or `API_KEY`.

The converters don't redact: they keep the log as it is, minus reasoning. Whoever moves a session
off the machine masks it first. 0bridge's CLI redacts every uploaded message and title with the
person's vault values, and the gateway redacts again what reaches it another way.

## Versioning

The version is in every document (`schema: "0b.session/1"`). Adding an optional field, a part
type, a role or a vendor keeps `/1`; readers ignore what they don't know. Removing or renaming a
field, or changing what one means, is `0b.session/2`, published next to `/1`.

## Non-goals

- Not a standard yet, and not a storage format: 0bridge's upload stays its own wire format (with
  optional fields from this schema).
- No fs, network or SQLite in this package: finding and reading the logs is the caller's job.
- No lossless round trip back to a vendor's format.

## License

Apache-2.0. See [LICENSE](LICENSE).
