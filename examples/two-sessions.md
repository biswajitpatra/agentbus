# Two sessions talking

A full walkthrough of one session messaging another.

## 1. Install once

```bash
bash scripts/install.sh                  # deps + register the always-on send server
bun run agentbus enable claude-channel   # turn on real-time delivery
```

## 2. Start two sessions

Each session loads the always-on `agentbus` send tools automatically; the
`--dangerously-load-development-channels` flag adds the `claude-channel` delivery.

Terminal A:

```bash
AGENTBUS_NAME=frontend claude --dangerously-load-development-channels server:agentbus-channel
```

Terminal B:

```bash
AGENTBUS_NAME=backend claude --dangerously-load-development-channels server:agentbus-channel
```

The first time, Claude Code asks to trust the MCP server(s) — choose **Use this
MCP server**.

## 3. Send a message

In **frontend**, prompt:

> Use list_peers to see who's online, then send_message to `backend`:
> "What's the shape of the GET /users response?"

## 4. It arrives in backend, mid-session

**backend** receives, without you touching its terminal:

```
<channel source="agentbus" from="frontend" msg_id="1" ts="2026-06-25T...">
What's the shape of the GET /users response?
</channel>
```

It can answer by calling `send_message` with `to: "frontend"`.

## Prefer turn-boundary delivery? Use the hook instead

```bash
bun run agentbus disable claude-channel
bun run agentbus enable  claude-hook
```

Then launch plainly — no flag — and messages drain at each turn boundary:

```bash
AGENTBUS_NAME=backend claude
```

This is the way to reach sessions you can't pass the channel flag to (e.g. ones
dispatched from the agents panel).

## Send from a shell (no MCP)

```bash
AGENTBUS_NAME=frontend bun run agentbus send backend "What's the API contract?"
bun run agentbus peers
```

## Inspect / debug

```bash
bun run agentbus doctor   # runtime, what's enabled, live peers, pending/delivered

# the bus is just SQLite:
DB=~/.agentbus/bus.db
sqlite3 "$DB" "SELECT name, pid, last_seen FROM peers;"
sqlite3 "$DB" "SELECT sender, recipient, body, delivered_at FROM messages ORDER BY id DESC LIMIT 10;"
```

## Offline delivery

Stop **backend**, have **frontend** send it a message, then start **backend**
again — the queued message drains into the new session on launch.
