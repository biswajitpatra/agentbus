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

// Participate when named (interactive + hook) OR when this is a dispatched agent
// (it has an agent_id). A plain, unnamed interactive session does nothing — no
// auto-join noise.
const isAgent = Boolean(input.agent_id)
if (!myId || !(process.env.AGENTBUS_NAME || isAgent)) process.exit(0)

const bus = openBus(DB_PATH)
try {
  // 1. register: identity + the runtime's live session id + a discoverable name.
  bus.registerIdentity(myId, input.session_id ?? null, process.pid)
  const name =
    sanitizeName(process.env.AGENTBUS_NAME ?? '') ||
    sanitizeName(input.agent_type ?? '') ||
    `agent-${token.slice(0, 6)}`
  bus.setName(name, myId)

  // 2. deliver: announce identity (agents, on SessionStart) + drain pending.
  const parts: string[] = []
  if (event === 'SessionStart' && isAgent) {
    parts.push(
      `agentbus: you are "${name}" on the local agent bus. ` +
      `To message another session, use the send_message tool with from="${name}" ` +
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
} finally {
  bus.close()
}
process.exit(0)
