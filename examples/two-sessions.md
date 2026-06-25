# Two sessions talking

A full walkthrough of one session messaging another.

## 1. Install once

```bash
bash scripts/install.sh
```

## 2. Start two sessions

Terminal A:

```bash
INTER_CLAUDE_NAME=frontend claude --dangerously-load-development-channels server:inter-claude
```

Terminal B:

```bash
INTER_CLAUDE_NAME=backend claude --dangerously-load-development-channels server:inter-claude
```

Each prints a dim notice confirming the channel is registered. The first time,
Claude Code asks to trust the MCP server — choose **Use this MCP server**.

## 3. Send a message

In **frontend**, prompt:

> Use list_peers to see who's online, then send_message to `backend`:
> "What's the shape of the GET /users response?"

## 4. It arrives in backend, mid-session

**backend** receives, without you touching its terminal:

```
<channel source="inter-claude" from="frontend" msg_id="1719300000000-1" ts="2026-06-25T...">
What's the shape of the GET /users response?
</channel>
```

It can answer by calling `send_message` with `to: "frontend"`.

## 5. Rename on the fly

In either session:

> set_name to `api`

Peers now address it as `api`. (This is the thing launch-time naming can't do.)

## Inspect / debug

```bash
bash scripts/doctor.sh   # runtime, registration, live peers, pending/delivered counts

# the bus is just SQLite:
DB=~/.claude/channels/inter-claude/bus.db
sqlite3 "$DB" "SELECT name, pid, last_seen FROM peers;"
sqlite3 "$DB" "SELECT sender, recipient, body, delivered_at FROM messages ORDER BY id DESC LIMIT 10;"
```

## Offline delivery

Stop **backend**, have **frontend** send it a message, then start **backend**
again — the queued message drains into the new session on launch.
