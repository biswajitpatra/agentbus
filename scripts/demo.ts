#!/usr/bin/env bun
/**
 * Self-driving demo of the inter-claude bus, used to record the README cast.
 *
 * It spawns two REAL server processes over stdio and drives them with the MCP
 * client — the same discovery, delivery, and rename the tools do in a live
 * session. Nothing here is faked; only the narration and pacing are scripted.
 *
 *   bun scripts/demo.ts
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
}
const sleep = (ms: number) => Bun.sleep(ms)
const say = async (s = '') => { console.log(s); await sleep(700) }
const text = (r: any) => r.content?.[0]?.text ?? JSON.stringify(r)

function session(name: string, home: string) {
  const transport = new StdioClientTransport({
    command: 'bun',
    args: ['server.ts'],
    env: { ...process.env, INTER_CLAUDE_NAME: name, INTER_CLAUDE_HOME: home },
  })
  return { client: new Client({ name: `demo-${name}`, version: '0' }), transport }
}

const home = mkdtempSync(join(tmpdir(), 'inter-claude-demo-'))

await say(c.bold('inter-claude-channels') + c.dim(' — two Claude Code sessions talking'))
await say()

await say(c.dim('$ ') + 'INTER_CLAUDE_NAME=frontend claude --channels server:inter-claude')
await say(c.dim('$ ') + 'INTER_CLAUDE_NAME=backend  claude --channels server:inter-claude')
const frontend = session('frontend', home)
const backend = session('backend', home)
const inbox: string[] = []
backend.client.fallbackNotificationHandler = async (n: any) => {
  if (n.method === 'notifications/claude/channel') {
    const p = n.params
    inbox.push(`<channel source="inter-claude" from="${p.meta.from}" msg_id="${p.meta.msg_id}">\n  ${p.content}\n</channel>`)
  }
}
await Promise.all([
  frontend.client.connect(frontend.transport),
  backend.client.connect(backend.transport),
])
await sleep(600)
await say(c.green('  ✓ both sessions online'))
await say()

await say(c.cyan('frontend ▸ ') + 'list_peers')
await say(c.dim(text(await frontend.client.callTool({ name: 'list_peers', arguments: {} })).split('\n').map(l => '  ' + l).join('\n')))
await say()

await say(c.cyan('frontend ▸ ') + 'send_message  to=backend  text=' + c.yellow('"what\'s the shape of GET /users?"'))
await frontend.client.callTool({ name: 'send_message', arguments: { to: 'backend', text: "what's the shape of GET /users?" } })
await sleep(800)
await say(c.green('  ✓ pushed into backend\'s running session:'))
await say(c.dim(inbox[0]?.split('\n').map(l => '  ' + l).join('\n')))
await say()

await say(c.cyan('backend ▸ ') + 'send_message  to=frontend  text=' + c.yellow('"{ id, name, email }"'))
await backend.client.callTool({ name: 'send_message', arguments: { to: 'frontend', text: '{ id, name, email }' } })
await sleep(600)
await say(c.green('  ✓ reply delivered'))
await say()

await say(c.cyan('backend ▸ ') + 'set_name  name=api')
await say(c.dim('  ' + text(await backend.client.callTool({ name: 'set_name', arguments: { name: 'api' } }))))
await sleep(400)
await say(c.cyan('frontend ▸ ') + 'list_peers')
await say(c.dim(text(await frontend.client.callTool({ name: 'list_peers', arguments: {} })).split('\n').map(l => '  ' + l).join('\n')))
await say()

await say(c.green('  ✓ renamed live — no restart. ') + c.dim('github.com/biswajitpatra/inter-claude-channels'))

await frontend.client.close()
await backend.client.close()
process.exit(0)
