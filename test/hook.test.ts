/**
 * Tests for the claude-hook delivery: it registers the identity (from the
 * resolved id) and drains pending messages into hookSpecificOutput.additionalContext,
 * staying silent when the inbox is empty.
 */
import { test, expect } from 'bun:test'
import { openBus } from '../core/bus'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

function runHook(home: string, name: string) {
  const proc = Bun.spawn(['bun', 'adapters/deliveries/claude-hook.ts'], {
    env: { ...process.env, AGENTBUS_NAME: name, AGENTBUS_HOME: home },
    stdin: new TextEncoder().encode(JSON.stringify({ hook_event_name: 'Stop', session_id: 'sess123' })),
    stdout: 'pipe',
  })
  return new Response(proc.stdout).text().then(async out => { await proc.exited; return out })
}

test('hook registers + drains pending into additionalContext, marks delivered', async () => {
  const home = mkdtempSync(join(tmpdir(), 'agentbus-hook-'))
  const seed = openBus(join(home, 'bus.db'))
  seed.setName('frontend', 'claude:frontend') // so the from shows a name
  seed.enqueue('claude:frontend', 'claude:backend', 'hook-hello')
  seed.close()

  const out = await runHook(home, 'backend') // id resolves to claude:backend
  const parsed = JSON.parse(out)
  expect(parsed.hookSpecificOutput.hookEventName).toBe('Stop')
  expect(parsed.hookSpecificOutput.additionalContext).toContain('hook-hello')
  expect(parsed.hookSpecificOutput.additionalContext).toContain('from="frontend"')

  const check = openBus(join(home, 'bus.db'))
  expect(check.pending('claude:backend').length).toBe(0) // marked delivered
  expect(check.idForName('backend')).toBe('claude:backend') // hook registered the name
  check.close()
}, 20_000)

test('hook stays silent when the inbox is empty', async () => {
  const home = mkdtempSync(join(tmpdir(), 'agentbus-hook-'))
  const out = await runHook(home, 'lonely')
  expect(out.trim()).toBe('') // no output → normal stop, no forced continuation
}, 20_000)

test('hook announces identity for a dispatched agent on SessionStart', async () => {
  const home = mkdtempSync(join(tmpdir(), 'agentbus-hook-'))
  const proc = Bun.spawn(['bun', 'adapters/deliveries/claude-hook.ts'], {
    env: { ...process.env, AGENTBUS_NAME: '', CLAUDE_SESSION_ID: '', AGENTBUS_HOME: home },
    stdin: new TextEncoder().encode(JSON.stringify({
      hook_event_name: 'SessionStart', session_id: 'sess999', agent_id: 'a1', agent_type: 'researcher',
    })),
    stdout: 'pipe',
  })
  const out = await new Response(proc.stdout).text()
  await proc.exited
  const parsed = JSON.parse(out)
  expect(parsed.hookSpecificOutput.additionalContext).toContain('you are "researcher-') // <type>-<sid> auto-name

  const bus = openBus(join(home, 'bus.db'))
  expect(bus.displayName('claude:sess999')).toMatch(/^researcher-/) // registered from session_id, suffixed
  bus.close()
}, 20_000)
