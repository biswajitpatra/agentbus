#!/usr/bin/env bun
/**
 * Self-driving demo of agentbus, used to record the README cast.
 *
 * Each "session" is the two real layers wired together over stdio: the always-on
 * `agentbus` send server (tools) and the `claude-channel` delivery (receive). We
 * drive them with the MCP client exactly as a live session would. Nothing is
 * faked; only the narration and pacing are scripted.
 *
 *   bun scripts/demo.ts
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { styleText } from 'node:util'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const dim = (s: string) => styleText('dim', s)
const cyan = (s: string) => styleText('cyan', s)
const green = (s: string) => styleText('green', s)
const yellow = (s: string) => styleText('yellow', s)
const bold = (s: string) => styleText('bold', s)

const sleep = (ms: number) => Bun.sleep(ms)
const say = async (s = '') => { console.log(s); await sleep(700) }
const text = (r: any) => r.content?.[0]?.text ?? JSON.stringify(r)

function session(name: string, home: string) {
  const env = { ...process.env, AGENTBUS_NAME: name, AGENTBUS_HOME: home }
  const sendT = new StdioClientTransport({ command: 'bun', args: ['adapters/send.ts'], env })
  const chanT = new StdioClientTransport({ command: 'bun', args: ['adapters/deliveries/claude-channel.ts'], env })
  const send = new Client({ name: `demo-send-${name}`, version: '0' })
  const chan = new Client({ name: `demo-chan-${name}`, version: '0' })
  const inbox: string[] = []
  chan.fallbackNotificationHandler = async (n: any) => {
    if (n.method === 'notifications/claude/channel') {
      const p = n.params
      inbox.push(`<channel source="agentbus" from="${p.meta.from}" msg_id="${p.meta.msg_id}">\n  ${p.content}\n</channel>`)
    }
  }
  return { send, inbox, connect: () => Promise.all([send.connect(sendT), chan.connect(chanT)]), close: () => Promise.all([send.close(), chan.close()]) }
}

const home = mkdtempSync(join(tmpdir(), 'agentbus-demo-'))

await say(bold('agentbus') + dim(' — two agent sessions talking'))
await say()

await say(dim('$ ') + 'AGENTBUS_NAME=frontend claude --dangerously-load-development-channels server:agentbus-channel')
await say(dim('$ ') + 'AGENTBUS_NAME=backend  claude --dangerously-load-development-channels server:agentbus-channel')
const frontend = session('frontend', home)
const backend = session('backend', home)
await Promise.all([frontend.connect(), backend.connect()])
await sleep(600)
await say(green('  ✓ both online — send (MCP) + claude-channel delivery'))
await say()

await say(cyan('frontend ▸ ') + 'list_peers')
await say(dim(text(await frontend.send.callTool({ name: 'list_peers', arguments: {} })).split('\n').map((l: string) => '  ' + l).join('\n')))
await say()

await say(cyan('frontend ▸ ') + 'send_message  to=backend  text=' + yellow('"what\'s the shape of GET /users?"'))
await frontend.send.callTool({ name: 'send_message', arguments: { to: 'backend', text: "what's the shape of GET /users?" } })
await sleep(800)
await say(green('  ✓ delivered into backend\'s running session:'))
await say(dim(backend.inbox[0]?.split('\n').map((l: string) => '  ' + l).join('\n')))
await say()

await say(cyan('backend ▸ ') + 'send_message  to=frontend  text=' + yellow('"{ id, name, email }"'))
await backend.send.callTool({ name: 'send_message', arguments: { to: 'frontend', text: '{ id, name, email }' } })
await sleep(800)
await say(green('  ✓ reply delivered to frontend:'))
await say(dim(frontend.inbox[0]?.split('\n').map((l: string) => '  ' + l).join('\n')))
await say()

await say(green('  ✓ send (always-on MCP) + pluggable delivery. ') + dim('github.com/biswajitpatra/agentbus'))

await Promise.all([frontend.close(), backend.close()])
process.exit(0)
