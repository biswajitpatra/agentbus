/**
 * Integration tests over real stdio processes, exercising the layers:
 *   - send       (adapters/send.ts)                       — tools + registration
 *   - delivery   (adapters/deliveries/claude-channel.ts)  — channel receive
 * A session = the send server (which registers its identity + name) plus, for a
 * receiver, the channel delivery. We verify discovery, name→id routing,
 * cross-session delivery, offline queueing, and no loss under concurrency.
 */
import { test, expect } from 'bun:test'
import { openBus } from '../core/bus'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const text = (r: any) => JSON.stringify(r)

function proc(entry: string, name: string, home: string) {
  const transport = new StdioClientTransport({
    command: 'bun',
    args: [entry],
    env: { ...process.env, AGENTBUS_NAME: name, AGENTBUS_HOME: home },
  })
  return { client: new Client({ name: `t-${name}`, version: '0' }), transport }
}
const send = (name: string, home: string) => proc('adapters/send.ts', name, home)
const channel = (name: string, home: string) => proc('adapters/deliveries/claude-channel.ts', name, home)

test('discovery + name routing + channel delivery', async () => {
  const home = mkdtempSync(join(tmpdir(), 'agentbus-'))
  const received: unknown[] = []

  const alice = send('alice', home)
  const bobSend = send('bob', home) // registers identity + name "bob"
  const bobChan = channel('bob', home) // receives for bob's id
  bobChan.client.fallbackNotificationHandler = async n => void received.push(n)

  await Promise.all([alice.client.connect(alice.transport), bobSend.client.connect(bobSend.transport), bobChan.client.connect(bobChan.transport)])
  await Bun.sleep(600) // registration

  const peers = await alice.client.callTool({ name: 'list_peers', arguments: {} })
  expect(text(peers)).toContain('bob')

  await alice.client.callTool({ name: 'send_message', arguments: { to: 'bob', text: 'ping-123' } })
  await Bun.sleep(900)
  expect(text(received)).toContain('notifications/claude/channel')
  expect(text(received)).toContain('ping-123')
  expect(text(received)).toContain('alice') // from = displayName(sender id)

  await Promise.all([alice.client.close(), bobSend.client.close(), bobChan.client.close()])
}, 25_000)

test('offline queue drains on channel startup', async () => {
  const home = mkdtempSync(join(tmpdir(), 'agentbus-'))
  const received: unknown[] = []

  // queue for carol's id before carol exists (messages are keyed by id)
  const seed = openBus(join(home, 'bus.db'))
  seed.enqueue('claude:dave', 'claude:carol', 'queued-while-offline')
  seed.close()

  const carol = channel('carol', home) // resolves its own id (claude:carol) and drains
  carol.client.fallbackNotificationHandler = async n => void received.push(n)
  await carol.client.connect(carol.transport)
  await Bun.sleep(900)

  expect(text(received)).toContain('queued-while-offline')
  await carol.client.close()
}, 25_000)

test('concurrent senders never lose or duplicate', async () => {
  const home = mkdtempSync(join(tmpdir(), 'agentbus-'))
  const got: string[] = []

  const rcvSend = send('rcv', home) // registers name "rcv"
  const rcvChan = channel('rcv', home) // receives
  rcvChan.client.fallbackNotificationHandler = async (n: any) => {
    if (n.method === 'notifications/claude/channel') got.push(n.params.content)
  }
  const a = send('a', home)
  const b = send('b', home)
  await Promise.all([
    rcvSend.client.connect(rcvSend.transport),
    rcvChan.client.connect(rcvChan.transport),
    a.client.connect(a.transport),
    b.client.connect(b.transport),
  ])
  await Bun.sleep(600)

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
  expect(got.length).toBe(2 * N)

  await Promise.all([rcvSend.client.close(), rcvChan.client.close(), a.client.close(), b.client.close()])
}, 30_000)

test('send_message with explicit from attributes the sender by name', async () => {
  const home = mkdtempSync(join(tmpdir(), 'agentbus-'))
  const received: unknown[] = []

  const seed = openBus(join(home, 'bus.db'))
  seed.setName('bob', 'claude:bob') // a registered identity to send "as"
  seed.close()

  const alice = send('alice', home) // has its own id, but we override `from`
  const rcvSend = send('rcv', home) // registers name "rcv"
  const rcvChan = channel('rcv', home)
  rcvChan.client.fallbackNotificationHandler = async n => void received.push(n)
  await Promise.all([alice.client.connect(alice.transport), rcvSend.client.connect(rcvSend.transport), rcvChan.client.connect(rcvChan.transport)])
  await Bun.sleep(600)

  await alice.client.callTool({ name: 'send_message', arguments: { to: 'rcv', text: 'from-bob', from: 'bob' } })
  await Bun.sleep(900)
  expect(text(received)).toContain('from-bob')
  expect(text(received)).toContain('"from":"bob"') // attributed to bob, not alice
  expect(text(received)).not.toContain('"from":"alice"')

  await Promise.all([alice.client.close(), rcvSend.client.close(), rcvChan.client.close()])
}, 25_000)
