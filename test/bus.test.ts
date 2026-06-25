/**
 * Integration tests: spawn real server processes over stdio and verify
 * discovery, cross-session delivery, rename, offline queueing, and that
 * concurrent senders never lose or duplicate a message.
 */
import { test, expect } from 'bun:test'
import { openBus } from '../db'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const text = (r: any) => JSON.stringify(r)

function session(name: string, home: string) {
  const transport = new StdioClientTransport({
    command: 'bun',
    args: ['server.ts'],
    env: { ...process.env, INTER_CLAUDE_NAME: name, INTER_CLAUDE_HOME: home },
  })
  return { client: new Client({ name: `test-${name}`, version: '0' }), transport }
}

test('discovery + delivery + rename', async () => {
  const home = mkdtempSync(join(tmpdir(), 'inter-claude-'))
  const received: unknown[] = []

  const alice = session('alice', home)
  const bob = session('bob', home)
  bob.client.fallbackNotificationHandler = async n => void received.push(n)

  await Promise.all([
    alice.client.connect(alice.transport),
    bob.client.connect(bob.transport),
  ])
  await Bun.sleep(400) // let both register their presence

  const peers = await alice.client.callTool({ name: 'list_peers', arguments: {} })
  expect(text(peers)).toContain('bob')

  await alice.client.callTool({ name: 'send_message', arguments: { to: 'bob', text: 'ping-123' } })
  await Bun.sleep(900) // wait past the poll interval
  expect(text(received)).toContain('notifications/claude/channel')
  expect(text(received)).toContain('ping-123')
  expect(text(received)).toContain('alice') // from attribute

  await alice.client.callTool({ name: 'set_name', arguments: { name: 'apiserver' } })
  await Bun.sleep(300)
  const peers2 = await bob.client.callTool({ name: 'list_peers', arguments: {} })
  expect(text(peers2)).toContain('apiserver')

  await alice.client.close()
  await bob.client.close()
}, 20_000)

test('offline queue drains on startup', async () => {
  const home = mkdtempSync(join(tmpdir(), 'inter-claude-'))
  const received: unknown[] = []

  // queue a message for carol before carol exists (reuses the real bus + migrations)
  const seed = openBus(join(home, 'bus.db'))
  seed.enqueue('dave', 'carol', 'queued-while-offline')
  seed.close()

  const carol = session('carol', home)
  carol.client.fallbackNotificationHandler = async n => void received.push(n)
  await carol.client.connect(carol.transport)
  await Bun.sleep(900)

  expect(text(received)).toContain('queued-while-offline')
  await carol.client.close()
}, 20_000)

test('concurrent senders never lose or duplicate', async () => {
  const home = mkdtempSync(join(tmpdir(), 'inter-claude-'))
  const got: string[] = []

  const rcv = session('rcv', home)
  rcv.client.fallbackNotificationHandler = async (n: any) => {
    if (n.method === 'notifications/claude/channel') got.push(n.params.content)
  }
  const a = session('a', home)
  const b = session('b', home)
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
