/**
 * Integration tests over real stdio processes, exercising the split layers:
 *   - send       (adapters/send.ts)                       — the always-on MCP tools
 *   - delivery   (adapters/deliveries/claude-channel.ts)  — channel receive
 * A "sender" runs send.ts; a "receiver" runs the channel delivery. We verify
 * discovery, cross-session delivery, offline queueing, and that concurrent
 * senders never lose or duplicate a message.
 */
import { test, expect } from 'bun:test'
import { openBus } from '../core/bus'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const text = (r: any) => JSON.stringify(r)

function client(entry: string, name: string, home: string) {
  const transport = new StdioClientTransport({
    command: 'bun',
    args: [entry],
    env: { ...process.env, AGENTBUS_NAME: name, AGENTBUS_HOME: home },
  })
  return { client: new Client({ name: `test-${name}`, version: '0' }), transport }
}
const sender = (name: string, home: string) => client('adapters/send.ts', name, home)
const channel = (name: string, home: string) => client('adapters/deliveries/claude-channel.ts', name, home)

test('discovery + send + channel delivery', async () => {
  const home = mkdtempSync(join(tmpdir(), 'agentbus-'))
  const received: unknown[] = []

  const alice = sender('alice', home)
  const bob = channel('bob', home)
  bob.client.fallbackNotificationHandler = async n => void received.push(n)

  await Promise.all([alice.client.connect(alice.transport), bob.client.connect(bob.transport)])
  await Bun.sleep(500) // let presence register

  const peers = await alice.client.callTool({ name: 'list_peers', arguments: {} })
  expect(text(peers)).toContain('bob')

  await alice.client.callTool({ name: 'send_message', arguments: { to: 'bob', text: 'ping-123' } })
  await Bun.sleep(900)
  expect(text(received)).toContain('notifications/claude/channel')
  expect(text(received)).toContain('ping-123')
  expect(text(received)).toContain('alice') // from attribute

  await alice.client.close()
  await bob.client.close()
}, 20_000)

test('offline queue drains on channel startup', async () => {
  const home = mkdtempSync(join(tmpdir(), 'agentbus-'))
  const received: unknown[] = []

  // queue a message for carol before carol exists (reuses the real bus + migrations)
  const seed = openBus(join(home, 'bus.db'))
  seed.enqueue('dave', 'carol', 'queued-while-offline')
  seed.close()

  const carol = channel('carol', home)
  carol.client.fallbackNotificationHandler = async n => void received.push(n)
  await carol.client.connect(carol.transport)
  await Bun.sleep(900)

  expect(text(received)).toContain('queued-while-offline')
  await carol.client.close()
}, 20_000)

test('concurrent senders never lose or duplicate', async () => {
  const home = mkdtempSync(join(tmpdir(), 'agentbus-'))
  const got: string[] = []

  const rcv = channel('rcv', home)
  rcv.client.fallbackNotificationHandler = async (n: any) => {
    if (n.method === 'notifications/claude/channel') got.push(n.params.content)
  }
  const a = sender('a', home)
  const b = sender('b', home)
  await Promise.all([
    rcv.client.connect(rcv.transport),
    a.client.connect(a.transport),
    b.client.connect(b.transport),
  ])
  await Bun.sleep(500)

  const N = 8
  const sends: Promise<unknown>[] = []
  for (let i = 0; i < N; i++) {
    sends.push(a.client.callTool({ name: 'send_message', arguments: { to: 'rcv', text: `a-${i}` } }))
    sends.push(b.client.callTool({ name: 'send_message', arguments: { to: 'rcv', text: `b-${i}` } }))
  }
  await Promise.all(sends)
  await Bun.sleep(1500)

  for (let i = 0; i < N; i++) {
    expect(got).toContain(`a-${i}`)
    expect(got).toContain(`b-${i}`)
  }
  expect(got.length).toBe(2 * N) // exactly once each: no loss, no duplicates

  await Promise.all([rcv.client.close(), a.client.close(), b.client.close()])
}, 30_000)
