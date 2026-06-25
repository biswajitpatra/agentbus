#!/usr/bin/env bun
/**
 * inter-claude — a peer-to-peer channel that lets Claude Code sessions talk.
 *
 * Every session launches this file as a channel (an MCP server that pushes
 * events into the session). All shared state — who is online and every message
 * with its delivery status — lives in one SQLite database (see db/). A session
 * inserts a row to send; the recipient's server polls for its undelivered rows,
 * pushes them into its session as <channel> events, and stamps them delivered.
 * No daemon and no network: the DB file is the bus.
 *
 * Prior art: clauder (https://github.com/MaorBril/clauder) pioneered
 * cross-session messaging for Claude Code, also backed by a shared SQLite
 * store. inter-claude keeps that idea but delivers through the native channels
 * API instead of terminal injection, and supports live rename.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { homedir } from 'os'
import { join } from 'path'
import { openBus } from './db'

// --- Config -----------------------------------------------------------------

const ROOT =
  process.env.INTER_CLAUDE_HOME ??
  join(homedir(), '.claude', 'channels', 'inter-claude')
const DB_PATH = join(ROOT, 'bus.db')

const HEARTBEAT_MS = 15_000 // how often we refresh our presence
const STALE_MS = 45_000 // a peer silent this long is treated as offline
const POLL_MS = 3_000 // safety-net poll; the primary trigger is the wake-file watch
const PRUNE_MS = 60_000 // how often to drop old delivered messages
const DELIVERED_TTL_MS = 24 * 60 * 60 * 1000 // keep delivered rows this long

const sanitize = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32)

let name =
  sanitize(process.env.INTER_CLAUDE_NAME ?? '') ||
  `claude-${Math.random().toString(36).slice(2, 6)}`

const bus = openBus(DB_PATH)

// --- Registry / send (thin wrappers over the bus) ---------------------------

const register = () => bus.registerPeer(name, process.pid)
const heartbeat = () => bus.heartbeat(name, process.pid)
const listPeers = () => bus.livePeers(STALE_MS)
const isLive = (peer: string) => bus.isLive(peer, STALE_MS)

function send(to: string, text: string): number {
  if (to === name) throw new Error('cannot send to self')
  if (!isLive(to)) throw new Error(`no live peer named "${to}" (try list_peers)`)
  const id = bus.enqueue(name, to, text)
  bus.wake(to) // push: nudge the recipient to drain now
  return id
}

// --- MCP server + tools ------------------------------------------------------

const mcp = new Server(
  { name: 'inter-claude', version: '0.1.0' },
  {
    capabilities: { tools: {}, experimental: { 'claude/channel': {} } },
    instructions:
      'You are connected to other Claude Code sessions over the "inter-claude" channel. ' +
      'Their messages arrive as <channel source="inter-claude" from="<peer>" msg_id="...">text</channel>. ' +
      'To answer one, call send_message with `to` set to that `from` value. ' +
      'Other tools: list_peers (who is online), whoami (your own name), broadcast (message everyone), set_name (rename yourself).',
  },
)

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'send_message',
      description: 'Send a message to one peer session by name.',
      inputSchema: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Target peer name (see list_peers)' },
          text: { type: 'string', description: 'Message body' },
        },
        required: ['to', 'text'],
      },
    },
    {
      name: 'broadcast',
      description: 'Send a message to every other online peer.',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
    },
    {
      name: 'list_peers',
      description: 'List Claude Code sessions currently online on this machine.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'whoami',
      description: "Show this session's peer name.",
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'set_name',
      description: 'Rename this session so peers can address it differently.',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      },
    },
  ],
}))

const ok = (text: string) => ({ content: [{ type: 'text', text }] })

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  const args = (req.params.arguments ?? {}) as Record<string, unknown>
  try {
    switch (req.params.name) {
      case 'send_message': {
        const id = send(String(args.to), String(args.text))
        return ok(`sent to ${args.to} (#${id})`)
      }
      case 'broadcast': {
        const text = String(args.text)
        const targets = listPeers().filter(p => p.name !== name)
        for (const p of targets) send(p.name, text)
        return ok(`broadcast to ${targets.length} peer(s): ${targets.map(p => p.name).join(', ') || '(none)'}`)
      }
      case 'list_peers': {
        const peers = listPeers()
        const lines = peers.map(p => `${p.name === name ? '*' : ' '} ${p.name}${p.name === name ? ' (you)' : ''}`)
        return ok(peers.length ? `online peers:\n${lines.join('\n')}` : 'no peers online')
      }
      case 'whoami':
        return ok(name)
      case 'set_name': {
        const next = sanitize(String(args.name))
        if (!next) throw new Error('name must contain a-z, 0-9, _ or -')
        if (next === name) return ok(`already named ${name}`)
        if (isLive(next)) throw new Error(`name "${next}" is taken`)
        rename(next)
        return ok(`renamed to ${name}`)
      }
      default:
        return { content: [{ type: 'text', text: `unknown tool: ${req.params.name}` }], isError: true }
    }
  } catch (err) {
    return {
      content: [{ type: 'text', text: `${req.params.name}: ${err instanceof Error ? err.message : String(err)}` }],
      isError: true,
    }
  }
})

await mcp.connect(new StdioServerTransport())

// --- Inbound delivery: poll our rows, push, stamp delivered ------------------

let closed = false
let draining = false

async function drain(): Promise<void> {
  if (closed || draining) return
  draining = true
  try {
    for (const m of bus.pending(name)) {
      if (closed) return
      try {
        await mcp.notification({
          method: 'notifications/claude/channel',
          params: {
            content: m.body,
            meta: { from: m.sender, msg_id: String(m.id), ts: new Date(m.createdAt).toISOString() },
          },
        })
      } catch {
        return // transport gone — leave the row pending, deliver it next time
      }
      bus.markDelivered(m.id) // mark "gone" only after a successful push
    }
  } finally {
    draining = false
  }
}

// the wake-file watch is the primary trigger; rebind it whenever our name changes
let wakeWatcher: ReturnType<typeof bus.watchInbox> | undefined
function watchInbox(): void {
  wakeWatcher?.close()
  wakeWatcher = bus.watchInbox(name, () => void drain())
}

function rename(next: string): void {
  bus.reassignPending(name, next) // move pending rows to the new name
  bus.unregisterPeer(name)
  name = next
  register()
  watchInbox() // re-point the wake watch at the new name
  void drain()
}

// --- Lifecycle ---------------------------------------------------------------

register()
watchInbox() // push: drain the instant a peer touches our wake file
void drain() // deliver anything queued while we were offline (mailbox semantics)
bus.prune(DELIVERED_TTL_MS)

const beat = setInterval(heartbeat, HEARTBEAT_MS)
const poll = setInterval(drain, POLL_MS) // safety net for any missed wake event
const pruner = setInterval(() => { if (!closed) bus.prune(DELIVERED_TTL_MS) }, PRUNE_MS)

function shutdown(): void {
  if (closed) return
  closed = true
  clearInterval(beat)
  clearInterval(poll)
  clearInterval(pruner)
  wakeWatcher?.close()
  try { bus.unregisterPeer(name) } catch {}
  try { bus.close() } catch {}
  process.exit(0)
}
mcp.onclose = shutdown // parent disconnected (stdin EOF) — stop cleanly
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
process.on('exit', () => { if (!closed) { try { bus.unregisterPeer(name) } catch {} } })
