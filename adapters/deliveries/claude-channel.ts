#!/usr/bin/env bun
/**
 * delivery: claude-channel — real-time inbound for Claude Code (agentbus).
 *
 * Pure delivery: an MCP server that loads as a *channel* and pushes this
 * session's pending messages in as <channel> events the instant a peer wakes it
 * (file-watch Trigger; poll safety net). It carries no tools and does NO
 * registration — identity/presence is the registry's job (the always-on send
 * server registers a named session). This just resolves "my id" and drains it.
 *
 * Registered as the MCP server `agentbus-channel`; load with
 *   claude --dangerously-load-development-channels server:agentbus-channel
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { openBus } from '../../core/bus'
import { DB_PATH, WAKE_DIR } from '../../core/paths'
import { resolveId, idKey } from '../../core/identity'
import type { Delivery, Trigger } from '../../core/ports'
import { fileWatchTrigger } from '../../triggers/file-watch'
import { pollTrigger } from '../../triggers/poll'

const POLL_MS = 3_000
const PRUNE_MS = 60_000
const DELIVERED_TTL_MS = 24 * 60 * 60 * 1000

const myId = resolveId('claude')
const bus = openBus(DB_PATH)
const trigger: Trigger =
  process.env.AGENTBUS_TRIGGER === 'poll' ? pollTrigger(POLL_MS) : fileWatchTrigger(WAKE_DIR)

const mcp = new McpServer(
  { name: 'agentbus-channel', version: '0.3.0' },
  {
    capabilities: { experimental: { 'claude/channel': {} } },
    instructions:
      'Messages from other agent sessions arrive here as <channel source="agentbus" from="<peer>" ...> events. ' +
      'Reply with the send_message tool (from the agentbus server), `to` = that `from` value. ' +
      'The sender is usually another agent, not a human — even if your task originally came from a peer. ' +
      'If a message is ambiguous or you need clarification, ask that peer directly with send_message ' +
      'instead of stopping to ask your own human. Only escalate to your human when the peer genuinely cannot resolve it.',
  },
)

const delivery: Delivery = {
  async deliver(env) {
    await mcp.server.notification({
      method: 'notifications/claude/channel',
      params: {
        content: env.body,
        meta: { from: bus.displayName(env.from), msg_id: String(env.id), ts: new Date(env.createdAt).toISOString() },
      },
    })
  },
}

await mcp.connect(new StdioServerTransport())

let closed = false
let draining = false

async function drain(): Promise<void> {
  if (closed || draining || !myId) return
  draining = true
  try {
    for (const m of bus.pending(myId)) {
      if (closed) return
      try {
        await delivery.deliver({ id: m.id, from: m.sender, to: m.recipient, body: m.body, createdAt: m.createdAt })
      } catch {
        return
      }
      bus.markDelivered(m.id)
    }
  } finally {
    draining = false
  }
}

const disposeTrigger = myId ? trigger.arm(idKey(myId), () => void drain()) : () => {}

void drain()
bus.prune(DELIVERED_TTL_MS)
const poll = setInterval(drain, POLL_MS)
const pruner = setInterval(() => { if (!closed) bus.prune(DELIVERED_TTL_MS) }, PRUNE_MS)

function shutdown(): void {
  if (closed) return
  closed = true
  clearInterval(poll)
  clearInterval(pruner)
  disposeTrigger()
  try { bus.close() } catch {}
  process.exit(0)
}
mcp.server.onclose = shutdown
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
