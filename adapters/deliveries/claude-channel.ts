#!/usr/bin/env bun
/**
 * delivery: claude-channel — real-time inbound for Claude Code (agentbus).
 *
 * An MCP server that loads as a *channel* and pushes this session's pending
 * messages straight in as <channel> events the instant a peer wakes it
 * (file-watch Trigger; poll as a safety net). It carries NO tools — sending
 * lives in the always-on `agentbus` send server — so send and receive stay
 * cleanly separate, and enabling this never swallows messages meant for another
 * delivery.
 *
 * Registered as the MCP server `agentbus-channel`; load it with
 *   claude --dangerously-load-development-channels server:agentbus-channel
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { openBus } from '../../core/bus'
import { DB_PATH, WAKE_DIR } from '../../core/paths'
import type { Delivery, Trigger } from '../../core/ports'
import { fileWatchTrigger } from '../../triggers/file-watch'
import { pollTrigger } from '../../triggers/poll'

const HEARTBEAT_MS = 15_000
const POLL_MS = 3_000
const PRUNE_MS = 60_000
const DELIVERED_TTL_MS = 24 * 60 * 60 * 1000

const sanitize = (s: string) => s.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32)

const explicit = sanitize(process.env.AGENTBUS_NAME ?? '')
const name = explicit || `agent-${Math.random().toString(36).slice(2, 6)}`
const participate = explicit !== ''

const bus = openBus(DB_PATH)
const trigger: Trigger =
  process.env.AGENTBUS_TRIGGER === 'poll' ? pollTrigger(POLL_MS) : fileWatchTrigger(WAKE_DIR)

const mcp = new McpServer(
  { name: 'agentbus-channel', version: '0.3.0' },
  {
    capabilities: { experimental: { 'claude/channel': {} } },
    instructions:
      'Messages from other agent sessions arrive here as <channel source="agentbus" from="<peer>" ...> events. ' +
      'Reply with the send_message tool (from the agentbus server), `to` = that `from` value.',
  },
)

const delivery: Delivery = {
  async deliver(env) {
    await mcp.server.notification({
      method: 'notifications/claude/channel',
      params: {
        content: env.body,
        meta: { from: env.from, msg_id: String(env.id), ts: new Date(env.createdAt).toISOString() },
      },
    })
  },
}

await mcp.connect(new StdioServerTransport())

// --- drain: pending rows -> channel push -> mark delivered -------------------

let closed = false
let draining = false

async function drain(): Promise<void> {
  if (closed || draining) return
  draining = true
  try {
    for (const m of bus.pending(name)) {
      if (closed) return
      try {
        await delivery.deliver({ id: m.id, from: m.sender, to: m.recipient, body: m.body, createdAt: m.createdAt })
      } catch {
        return // transport gone — leave it pending for next time
      }
      bus.markDelivered(m.id) // "gone" only after a successful push
    }
  } finally {
    draining = false
  }
}

const disposeTrigger = trigger.arm(name, () => void drain())

// --- lifecycle ---------------------------------------------------------------

if (participate) bus.registerPeer(name, process.pid)
void drain() // deliver anything queued while we were offline
bus.prune(DELIVERED_TTL_MS)

const beat = participate ? setInterval(() => { if (!closed) bus.heartbeat(name, process.pid) }, HEARTBEAT_MS) : undefined
const poll = setInterval(drain, POLL_MS) // safety net for any missed wake
const pruner = setInterval(() => { if (!closed) bus.prune(DELIVERED_TTL_MS) }, PRUNE_MS)

function shutdown(): void {
  if (closed) return
  closed = true
  if (beat) clearInterval(beat)
  clearInterval(poll)
  clearInterval(pruner)
  disposeTrigger()
  if (participate) { try { bus.unregisterPeer(name) } catch {} }
  try { bus.close() } catch {}
  process.exit(0)
}
mcp.server.onclose = shutdown
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
process.on('exit', () => { if (!closed && participate) { try { bus.unregisterPeer(name) } catch {} } })
