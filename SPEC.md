# The agentbus standard

A small, local standard for **last-mile messaging between AI agent sessions on
one machine** — the layer that pushes a message *into a running session* and
tracks whether it got there.

agentbus deliberately does **not** reinvent agent-to-agent networking. Protocols
like [A2A](https://a2a-protocol.org/latest/) and ACP already standardize how
remote agent *services* (HTTP servers) discover and call each other. They cannot
inject an unsolicited message into a long-running interactive session (a `claude`
stdio REPL is not an HTTP server, and A2A push notifications flow back to the
*caller*, not into a peer's live context). agentbus fills exactly that gap, and
keeps its envelope A2A-shaped so a remote A2A leg can be added as an adapter.

## 1. Architecture

```
        ┌───────────────────────────────────────────┐
        │  CORE  (runtime-agnostic, the central place)│
        │  presence registry · durable mailbox ·      │
        │  delivery tracking            (one SQLite db)│
        └───────────────┬───────────────┬─────────────┘
              SEND (always-on)    DELIVERY (pluggable, many)
              MCP tools, notify   Trigger + Delivery ports
        ┌───────────────┴───────────────┴─────────────┐
        │  send.json (one, always)  ·  deliveries/*.json │
        └───────────────────────────────────────────────┘
```

Three layers:

- **core** — owns all shared state and is the single source of truth. Knows
  nothing about MCP, channels, HTTP, or how a recipient is woken.
- **send** — one **always-on** MCP server exposing the send/query tools
  (`send_message`, `broadcast`, `list_peers`, `whoami`) and `notify` (waking a
  recipient). MCP is universal, so the same send layer works on any MCP-capable
  CLI. It **never drains** the inbox.
- **delivery** — how an envelope lands *in* a session, implemented with the two
  driven ports below (`Trigger` + `Delivery`). Deliveries are **pluggable and
  independent**: enable any combination, each individually (there is no
  "enable all"). They cooperate through the bus — whichever drains a pending row
  first delivers it (its `deliveredAt` write); the others find it gone — so
  running several together is safe. Different runtimes' deliveries (Claude,
  Gemini, …) coexist on the one shared bus and can message each other.

The Claude Code deliveries are `claude-channel` (file-watch + MCP channel —
real-time) and `claude-hook` (hook lifecycle + `additionalContext` —
turn-boundary, and works for sessions that can't load channels, e.g. ones
dispatched from the agents panel).

## 2. Envelope

The unit of exchange. Field names mirror A2A's message shape (a sender, a
recipient, a text part) so bridging is a mapping, not a redesign.

| Field | Type | Meaning |
|-------|------|---------|
| `id` | integer | Monotonic, assigned by the core on enqueue. |
| `from` | string | Sender peer name. |
| `to` | string | Recipient peer name. `*` is fanned out to one envelope per live peer at enqueue time. |
| `body` | string | The text part. |
| `createdAt` | integer | Epoch milliseconds, assigned by the core. |

Peer names are `[a-z0-9_-]{1,32}`.

## 3. Port: Trigger (PULL)

How a recipient learns it has mail, and how a sender nudges a recipient.

```ts
interface Trigger {
  arm(self: string, onWake: () => void): () => void  // listen; returns a disposer
  notify(recipient: string): void                    // nudge a recipient (may be a no-op)
}
```

- `arm` starts listening for nudges addressed to `self` and calls `onWake` when
  one arrives (or speculatively). It returns a disposer that stops listening.
- `notify` asks the transport to wake `recipient` now. Pure pollers implement it
  as a no-op and rely on their own tick.
- A Trigger MAY fire `onWake` spuriously; it MUST NOT promise to fire for every
  message. The core mailbox is authoritative, so a missed wake only delays
  delivery until the next `onWake`. **Implementations SHOULD pair a primary
  Trigger with a slow safety poll.**

Reference implementations: `file-watch` (per-peer wake file + `fs.watch`),
`poll` (fixed interval), and the host runtime's **hook lifecycle** (the claude
`hook` mode arms on `SessionStart`/`Stop` — the runtime triggers the drain
instead of a file watch, so there is no long-running process).

## 4. Port: Delivery (PUSH)

How an envelope enters a runtime's live session.

```ts
interface Delivery {
  deliver(env: Envelope): Promise<void>  // resolve = handed to the transport
}
```

- `deliver` MUST reject if the message was not handed to the transport.
- The promise resolving means **handed off to the transport**, not **processed
  by the agent**. Channels (and most push transports) provide no application
  ack, so "delivered" is a transport fact, not a read receipt.

Reference implementations: `mcp-channel` (an MCP `notifications/claude/channel`
— push, mid-turn) and `hook-additionalContext` (a Claude Code hook prints
`hookSpecificOutput.additionalContext` — pull, at the turn boundary).

## 5. Delivery semantics

The core records `deliveredAt` **only after `deliver()` resolves**. Therefore:

- **At-least-once.** A crash between a successful push and the `deliveredAt`
  write redelivers on restart. Receivers SHOULD tolerate duplicates (the
  envelope `id` is stable for dedup).
- **Ordered per recipient.** Pending rows drain in ascending `id`.
- **Durable / offline.** An envelope to an offline peer stays pending until that
  peer arms and drains — a mailbox, not a fire-and-forget bus.
- **Never lost on transport failure.** A rejected `deliver()` leaves the row
  pending for the next attempt.

## 6. Presence

A participating session (one with a name set via `AGENTBUS_NAME`) upserts a
`peers` row and refreshes `lastSeen` on a heartbeat (reference: 15 s). A peer
silent past a stale window (reference: 45 s) is treated as offline and reaped
lazily on the next presence query. The name is fixed for the session's lifetime
(set at launch). Sending uses mailbox semantics: an envelope may be queued for
any name, so idle or not-yet-started peers are still reachable.

## 7. Manifests

The always-on send layer is described by `adapters/send.json`:

```json
{
  "id": "send",
  "title": "MCP send tools (core + push)",
  "runtime": "any-mcp",
  "always": true,
  "entry": "adapters/send.ts",
  "register": { "kind": "claude-mcp-server", "name": "agentbus" }
}
```

Each pluggable delivery is one file under `adapters/deliveries/`:

```json
{
  "id": "claude-channel",
  "title": "Claude — channel (real-time, file-watch + MCP channel)",
  "runtime": "claude-code",
  "entry": "adapters/deliveries/claude-channel.ts",
  "register": { "kind": "claude-mcp-server", "name": "agentbus-channel" },
  "launch": "AGENTBUS_NAME=<name> claude --dangerously-load-development-channels server:agentbus-channel"
}
```

`agentbus enable <delivery>` turns on exactly one delivery (and ensures `send` is
registered); there is deliberately **no "enable all"**. `register.kind` tells the
manager how to install it: `claude-mcp-server` writes an MCP server to
`~/.claude.json`; `claude-hook` writes `SessionStart`/`Stop` hooks to
`~/.claude/settings.json`. New kinds are added as new runtimes/transports are
supported (e.g. an A2A delivery POSTing to a webhook).

## 8. Conformance

A conformant delivery:

1. Reads/writes only through the core API (no direct schema coupling).
2. Implements `Trigger` and `Delivery` per §3–4.
3. Marks an envelope delivered only after a successful push (§5).
4. Ships a manifest under `adapters/deliveries/` (§7).

## 9. Relationship to other protocols

| Layer | Standard | agentbus role |
|-------|----------|---------------|
| Agent ↔ tool | MCP | our PUSH transport (`mcp-channel` Delivery) |
| Agent ↔ remote agent (service) | A2A / ACP | future edge **adapter**; envelope is kept A2A-shaped |
| Agent ↔ local live session | *(gap)* | **this spec** |
