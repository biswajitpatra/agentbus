# inter-claude-channels

[![CI](https://github.com/biswajitpatra/inter-claude-channels/actions/workflows/ci.yml/badge.svg)](https://github.com/biswajitpatra/inter-claude-channels/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A peer-to-peer [channel](https://code.claude.com/docs/en/channels) that lets
Claude Code sessions talk to each other. Start two sessions, and one can message
the other — the message is **pushed straight into the recipient's running
session** as a `<channel>` event, no copy-pasting and no polling-the-terminal
hacks.

![inter-claude demo](assets/demo.gif)

```mermaid
flowchart LR
    subgraph B["session: backend"]
        BC["claude"]
        BS["inter-claude<br/>MCP channel"]
    end
    subgraph F["session: frontend"]
        FS["inter-claude<br/>MCP channel"]
        FC["claude"]
    end
    BUS[("~/.claude/channels/inter-claude<br/>peers/&lt;name&gt;.json<br/>inbox/&lt;name&gt;/&lt;id&gt;.json")]

    BC -- "send_message" --> BS
    BS -- "write inbox/frontend" --> BUS
    BUS -- "watch inbox/frontend" --> FS
    FS -- "&lt;channel&gt; push" --> FC

    classDef bus fill:#1f2430,stroke:#5b6273,color:#cdd3e0;
    class BUS bus;
```

No daemon, no network, no tokens. The shared directory **is** the bus: sending
is a file write into the peer's inbox; receiving is each server watching its own
inbox and pushing new messages into its session.

## Why

Claude Code's [Agent Teams](https://code.claude.com/docs/en/agent-teams) spawn
teammates from one lead, and tools like clauder bind a session's identity at
launch and deliver by typing into your terminal. `inter-claude` instead uses the
native **channels** push API, so any two independently-started sessions on your
machine can exchange messages — and you can even **rename a session while it's
running** with `set_name`.

## Requirements

- [Bun](https://bun.sh)
- Claude Code **v2.1.80+** (channels are a research-preview feature)
- Same machine, same user (the bus is a local directory)

## Install

```bash
git clone https://github.com/biswajitpatra/inter-claude-channels
cd inter-claude-channels
bash scripts/install.sh
```

This installs deps and registers `inter-claude` as a user-level MCP server so
it's reachable from any directory.

## Use

Channels are opt-in per session. In one terminal:

```bash
INTER_CLAUDE_NAME=frontend claude --dangerously-load-development-channels server:inter-claude
```

In another:

```bash
INTER_CLAUDE_NAME=backend claude --dangerously-load-development-channels server:inter-claude
```

Now ask `frontend`: *"list_peers, then send_message to backend asking what the API contract is."*
`backend` receives it mid-session as a `<channel source="inter-claude" from="frontend">` event and can reply with `send_message` back to `frontend`.

See [`examples/two-sessions.md`](examples/two-sessions.md) for a full walkthrough.

## Tools

| Tool | Args | Description |
|------|------|-------------|
| `send_message` | `to`, `text` | Message one peer by name |
| `broadcast` | `text` | Message every other online peer |
| `list_peers` | — | Sessions currently online |
| `whoami` | — | This session's name |
| `set_name` | `name` | Rename this session live |

Incoming messages arrive as:

```
<channel source="inter-claude" from="frontend" msg_id="..." ts="...">
what's the API contract?
</channel>
```

To reply, call `send_message` with `to` set to the `from` value.

## How it works

- **Discovery** — each session writes `peers/<name>.json` and refreshes it every
  15s. A peer silent for 45s is considered offline and reaped.
- **Delivery** — `send_message` writes `inbox/<to>/<id>.json`. The recipient's
  server watches that directory (`fs.watch` + a 3s fallback sweep), pushes each
  new message into its session, then deletes the file.
- **Offline mailbox** — messages sit in the inbox until the recipient is online,
  so you can message a peer that hasn't started yet; it drains on launch.

## Security

A channel message is injected into Claude's context, which is a prompt-injection
surface. `inter-claude` is scoped to **one machine, one user**: the bus lives
under your home directory and peers are other local sessions you started. It does
**not** listen on any network port. Don't point `INTER_CLAUDE_HOME` at a shared
or world-writable location, and be deliberate about combining it with
`--dangerously-skip-permissions`.

## Project layout

```
server.ts                  the channel (MCP server: tools + inbox watcher)
.mcp.json                  MCP registration (plugin form)
.claude-plugin/plugin.json plugin manifest
scripts/install.sh         register + print launch command
scripts/uninstall.sh       remove registration + bus
scripts/doctor.sh          diagnose runtime, registration, live peers
examples/two-sessions.md   end-to-end walkthrough
```

## License

MIT — see [LICENSE](LICENSE).
