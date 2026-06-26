#!/usr/bin/env bun
/**
 * send — the always-on SEND layer for agentbus (core + push, over MCP).
 *
 * One MCP server (`agentbus`) with the send/query tools. For a *named*
 * interactive session (AGENTBUS_NAME set) it also calls the core registry to
 * register its identity + presence — that's the registration concern, kept
 * separate from delivery. It NEVER drains the inbox; receiving is the delivery
 * layer's job. MCP is universal, so this works on any MCP-capable CLI.
 *
 * Registered as the MCP server `agentbus`.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { openBus } from '../core/bus'
import { DB_PATH, WAKE_DIR } from '../core/paths'
import { resolveId, resolveToken, sanitizeName, idKey } from '../core/identity'
import type { Trigger } from '../core/ports'
import { fileWatchTrigger } from '../triggers/file-watch'
import { pollTrigger } from '../triggers/poll'

const RUNTIME = 'claude'
const HEARTBEAT_MS = 15_000
const STALE_MS = 45_000
const POLL_MS = 3_000

const myId = resolveId(RUNTIME) // null if anonymous (no name / session id)
const myToken = resolveToken()

const bus = openBus(DB_PATH)
const trigger: Trigger =
  process.env.AGENTBUS_TRIGGER === 'poll' ? pollTrigger(POLL_MS) : fileWatchTrigger(WAKE_DIR)

// Resolve a target argument to an id: a known name, or an explicit "<rt>:<tok>" id.
function targetId(to: string): string {
  const byName = bus.idForName(sanitizeName(to))
  if (byName) return byName
  if (to.includes(':')) return to
  throw new Error(`no peer named "${to}" (try list_peers)`)
}

// Resolve the sender id. Defaults to this server's own id, but a session that
// can't self-identify (a dispatched agent, whose MCP server isn't told the
// session id) may pass `from` = its registered name; we resolve it to an id.
function resolveFrom(from?: string): string {
  if (!from) return myId ?? 'anon'
  const n = sanitizeName(from)
  return bus.idForName(n) ?? (from.includes(':') ? from : `anon:${n}`)
}

function sendToId(fromId: string, toId: string, text: string): number {
  if (toId === fromId) throw new Error('cannot send to self')
  const id = bus.enqueue(fromId, toId, text)
  trigger.notify(idKey(toId)) // wake a live delivery now (no-op for pollers)
  return id
}

const mcp = new McpServer(
  { name: 'agentbus', version: '0.3.0' },
  {
    capabilities: { tools: {} },
    instructions:
      'agentbus send/query tools for talking to other agent sessions on this machine. ' +
      'Messages you receive arrive as <channel source="agentbus" from="<peer>" ...> events (via an enabled delivery). ' +
      'Reply with send_message, `to` = that `from` value. set_name lets you (re)claim a name.',
  },
)

const ok = (text: string) => ({ content: [{ type: 'text' as const, text }] })

mcp.registerTool('send_message',
  {
    description: 'Send a message to one peer by name (or id). Pass `from` (your registered name) if this session has no id of its own — e.g. a dispatched agent.',
    inputSchema: { to: z.string(), text: z.string(), from: z.string().optional() },
  },
  async ({ to, text, from }) => ok(`sent to ${to} (#${sendToId(resolveFrom(from), targetId(to), text)})`),
)

mcp.registerTool('broadcast',
  { description: 'Send a message to every other online peer.', inputSchema: { text: z.string(), from: z.string().optional() } },
  async ({ text, from }) => {
    const fromId = resolveFrom(from)
    const targets = bus.livePeers(STALE_MS).filter(p => p.id !== fromId)
    for (const p of targets) sendToId(fromId, p.id, text)
    return ok(`broadcast to ${targets.length} peer(s): ${targets.map(p => p.name).join(', ') || '(none)'}`)
  },
)

mcp.registerTool('list_peers',
  { description: 'List agent sessions currently online on this machine.', inputSchema: {} },
  async () => {
    const peers = bus.livePeers(STALE_MS)
    const lines = peers.map(p => `${p.id === myId ? '*' : ' '} ${p.name}${p.id === myId ? ' (you)' : ''}`)
    return ok(peers.length ? `online peers:\n${lines.join('\n')}` : 'no peers online')
  },
)

mcp.registerTool('whoami',
  { description: "Show this session's name and id.", inputSchema: {} },
  async () => ok(
    myId
      ? `${bus.displayName(myId)}  (${myId})`
      : 'anonymous here — this session has no id. Launch with AGENTBUS_NAME=<name> (or call set_name) to become an addressable peer.',
  ),
)

mcp.registerTool('set_name',
  { description: 'Claim a name so peers can address this session by it.', inputSchema: { name: z.string() } },
  async ({ name: raw }) => {
    if (!myId) throw new Error('this session has no id — set AGENTBUS_NAME at launch')
    const name = sanitizeName(raw)
    if (!name) throw new Error('name must contain a-z, 0-9, _ or -')
    const prev = bus.setName(name, myId)
    if (prev) sendToId(myId, prev, `(agentbus) the name "${name}" was reassigned away from you`)
    return ok(`registered as ${name}`)
  },
)

await mcp.connect(new StdioServerTransport())

// --- registration (interactive, named sessions only) -------------------------

let closed = false
let beat: ReturnType<typeof setInterval> | undefined
if (myId) {
  bus.registerIdentity(myId, null, process.pid) // session_id is stamped by the delivery (hook)
  if (myToken) bus.setName(myToken, myId) // default name = the launch token
  beat = setInterval(() => { if (!closed) bus.heartbeat(myId, null, process.pid) }, HEARTBEAT_MS)
}

function shutdown(): void {
  if (closed) return
  closed = true
  if (beat) clearInterval(beat)
  if (myId) { try { bus.unregisterIdentity(myId) } catch {} }
  try { bus.close() } catch {}
  process.exit(0)
}
mcp.server.onclose = shutdown
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
process.on('exit', () => { if (!closed && myId) { try { bus.unregisterIdentity(myId) } catch {} } })
