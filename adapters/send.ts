#!/usr/bin/env bun
/**
 * send — the always-on SEND layer for agentbus (core + push, over MCP).
 *
 * One MCP server, registered in every session, exposing the send/query tools
 * (send_message / broadcast / list_peers / whoami) and keeping presence fresh.
 * It NEVER drains the inbox — receiving is the separate, pluggable *delivery*
 * layer (adapters/deliveries/*). MCP is universal, so this send path works on
 * any MCP-capable CLI; delivery is what varies per runtime.
 *
 * Registered as the MCP server `agentbus` (plain tools, no channel).
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { openBus } from '../core/bus'
import { DB_PATH, WAKE_DIR } from '../core/paths'
import type { Trigger } from '../core/ports'
import { fileWatchTrigger } from '../triggers/file-watch'
import { pollTrigger } from '../triggers/poll'

const HEARTBEAT_MS = 15_000
const STALE_MS = 45_000
const POLL_MS = 3_000

const sanitize = (s: string) => s.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32)

// Opt-in by AGENTBUS_NAME. Without it we still serve the tools (so any session
// can send), but we register no presence — unrelated sessions don't appear as
// peers. With it, this session is a first-class, addressable peer.
const explicit = sanitize(process.env.AGENTBUS_NAME ?? '')
const name = explicit || `agent-${Math.random().toString(36).slice(2, 6)}`
const participate = explicit !== ''

const bus = openBus(DB_PATH)
const trigger: Trigger =
  process.env.AGENTBUS_TRIGGER === 'poll' ? pollTrigger(POLL_MS) : fileWatchTrigger(WAKE_DIR)

const listPeers = () => bus.livePeers(STALE_MS)

// Mailbox semantics: queue for any peer (idle hook-sessions and not-yet-started
// peers included). Only sending to yourself is rejected.
function send(to: string, text: string): number {
  const target = sanitize(to)
  if (!target) throw new Error('recipient name must contain a-z, 0-9, _ or -')
  if (target === name) throw new Error('cannot send to self')
  const id = bus.enqueue(name, target, text)
  trigger.notify(target) // nudge a live recipient to drain now (no-op for pollers)
  return id
}

const mcp = new McpServer(
  { name: 'agentbus', version: '0.3.0' },
  {
    capabilities: { tools: {} },
    instructions:
      'agentbus send/query tools for talking to other agent sessions on this machine. ' +
      'Messages you receive arrive as <channel source="agentbus" from="<peer>" ...> events (via an enabled delivery: channel or hook). ' +
      'To reply, call send_message with `to` set to that `from` value.',
  },
)

const ok = (text: string) => ({ content: [{ type: 'text' as const, text }] })

mcp.registerTool('send_message',
  { description: 'Send a message to one peer session by name.', inputSchema: { to: z.string(), text: z.string() } },
  async ({ to, text }) => ok(`sent to ${to} (#${send(to, text)})`),
)

mcp.registerTool('broadcast',
  { description: 'Send a message to every other online peer.', inputSchema: { text: z.string() } },
  async ({ text }) => {
    const targets = listPeers().filter(p => p.name !== name)
    for (const p of targets) send(p.name, text)
    return ok(`broadcast to ${targets.length} peer(s): ${targets.map(p => p.name).join(', ') || '(none)'}`)
  },
)

mcp.registerTool('list_peers',
  { description: 'List agent sessions currently online on this machine.', inputSchema: {} },
  async () => {
    const peers = listPeers()
    const lines = peers.map(p => `${p.name === name ? '*' : ' '} ${p.name}${p.name === name ? ' (you)' : ''}`)
    return ok(peers.length ? `online peers:\n${lines.join('\n')}` : 'no peers online')
  },
)

mcp.registerTool('whoami',
  { description: "Show this session's peer name.", inputSchema: {} },
  async () => ok(participate ? name : `${name} (not registered — set AGENTBUS_NAME to be addressable)`),
)

await mcp.connect(new StdioServerTransport())

// --- presence (only when this session opted in with AGENTBUS_NAME) -----------

let closed = false
let beat: ReturnType<typeof setInterval> | undefined
if (participate) {
  bus.registerPeer(name, process.pid)
  beat = setInterval(() => { if (!closed) bus.heartbeat(name, process.pid) }, HEARTBEAT_MS)
}

function shutdown(): void {
  if (closed) return
  closed = true
  if (beat) clearInterval(beat)
  if (participate) { try { bus.unregisterPeer(name) } catch {} }
  try { bus.close() } catch {}
  process.exit(0)
}
mcp.server.onclose = shutdown
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
process.on('exit', () => { if (!closed && participate) { try { bus.unregisterPeer(name) } catch {} } })
