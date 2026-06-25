#!/usr/bin/env bun
/**
 * claude / hook mode — the *pull* delivery for Claude Code (agentbus).
 *
 * Where the channel mode is a long-running server that PUSHES messages mid-turn via
 * the channels API, this is the opposite shape: a short-lived script that Claude Code
 * invokes at a lifecycle boundary (SessionStart, Stop). On each invocation it
 * reads this session's pending messages and injects them as `additionalContext`,
 * then marks them delivered — a PULL at the turn boundary.
 *
 * Same two ports as every adapter, implemented differently:
 *   - Trigger  (PULL): the Claude Code hook lifecycle (no file-watch, no daemon).
 *   - Delivery (PUSH): the hook's `hookSpecificOutput.additionalContext` output.
 *
 * The win: it needs NO channel flag, so it reaches sessions that can't load
 * channels (e.g. ones dispatched from the agents panel). The cost: messages
 * arrive only at turn boundaries, not in real time.
 *
 * Registered in ~/.claude/settings.json by `agentbus enable claude hook`.
 */
import { openBus } from '../../core/bus'
import { DB_PATH } from '../../core/paths'

const sanitize = (s: string) => s.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32)

const input = (await Bun.stdin.json().catch(() => ({}))) as { hook_event_name?: string }
const event = input.hook_event_name ?? 'Stop'

// Opt-in by AGENTBUS_NAME. The hook is registered globally (it fires for every
// Claude session), so without an explicit name we do nothing — unrelated sessions
// never join the bus. A hook-only session can't rename itself (no MCP tools), so
// this name is fixed for its lifetime; set it at launch.
const name = sanitize(process.env.AGENTBUS_NAME ?? '')
if (!name) process.exit(0)

const bus = openBus(DB_PATH)
try {
  bus.heartbeat(name, process.pid) // presence: live while the session is active
  const pending = bus.pending(name)
  if (pending.length) {
    const ctx = pending
      .map(m => `<channel source="agentbus" from="${m.sender}" msg_id="${m.id}">\n${m.body}\n</channel>`)
      .join('\n')
    // Exit 0 with this output → Claude continues and sees the messages.
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: ctx } }))
    for (const m of pending) bus.markDelivered(m.id) // "gone" only after we emit it
  }
} finally {
  bus.close()
}
process.exit(0)
