#!/usr/bin/env bun
/**
 * delivery: claude-hook — turn-boundary inbound for Claude Code (agentbus).
 *
 * The Claude Code Stop/SessionStart hook. It does two separable things:
 *   1. registration — for a dispatched agent there's no env to set and no
 *      always-on send server doing it, so the hook is the registrar: it reads
 *      `session_id` (and agent_id) from stdin, resolves the id, and upserts the
 *      identity (stamping the runtime session id) + a name.
 *   2. delivery — drains this id's pending messages and injects them as
 *      `additionalContext`, then marks them delivered.
 *
 * Works with no channel flag, so it reaches sessions dispatched from the agents
 * panel. Registered in ~/.claude/settings.json by `agentbus enable claude-hook`.
 */
import { openBus } from '../../core/bus'
import { DB_PATH } from '../../core/paths'
import { resolveId, resolveToken, sanitizeName } from '../../core/identity'

const input = (await Bun.stdin.json().catch(() => ({}))) as {
  hook_event_name?: string
  session_id?: string
  agent_id?: string
  agent_type?: string
}
const event = input.hook_event_name ?? 'Stop'

const token = resolveToken(input.session_id)
const myId = token ? `claude:${token}` : null
if (!myId) process.exit(0) // no session id at all — nothing to do

const bus = openBus(DB_PATH)

// Background/dispatched sessions can't set AGENTBUS_NAME and don't get
// CLAUDE_SESSION_ID in Bash — the hook's stdin `session_id` is the ONLY way such
// a session can get an identity. So we register every session the hook fires for
// (the hook is itself an opt-in: you enabled this delivery), naming it from
// AGENTBUS_NAME, the dispatched --agent type, or a session-derived fallback.
const hasName = bus.displayName(myId) !== myId
const autoName =
  sanitizeName(process.env.AGENTBUS_NAME ?? '') ||
  sanitizeName(input.agent_type ?? '') ||
  `agent-${token.slice(0, 6)}`
bus.registerIdentity(myId, input.session_id ?? null, process.pid)
if (!hasName) bus.setName(autoName, myId)
const name = bus.displayName(myId)

// deliver: announce identity (SessionStart) + drain pending into additionalContext.
const parts: string[] = []
if (event === 'SessionStart') {
  parts.push(
    `agentbus: you are "${name}" on the local agent bus. ` +
    `To message a peer, use the send_message tool with from="${name}" ` +
    `(or run \`agentbus send <to> "..."\` in Bash).`,
  )
}
const pending = bus.pending(myId)
parts.push(
  ...pending.map(m => `<channel source="agentbus" from="${bus.displayName(m.sender)}" msg_id="${m.id}">\n${m.body}\n</channel>`),
)
if (parts.length) {
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: parts.join('\n') } }))
  for (const m of pending) bus.markDelivered(m.id)
}
bus.close()
process.exit(0)
