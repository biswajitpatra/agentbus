/**
 * Tests for the claude `hook` (pull) delivery mode: the drain script should read
 * a session's pending messages, emit them as hookSpecificOutput.additionalContext,
 * mark them delivered, and stay silent when the inbox is empty (so it never forces
 * the turn to continue for nothing).
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

test('hook mode drains pending into additionalContext and marks delivered', async () => {
  const home = mkdtempSync(join(tmpdir(), 'agentbus-hook-'))
  const seed = openBus(join(home, 'bus.db'))
  seed.enqueue('frontend', 'backend', 'hook-hello')
  seed.close()

  const out = await runHook(home, 'backend')
  const parsed = JSON.parse(out)
  expect(parsed.hookSpecificOutput.hookEventName).toBe('Stop')
  expect(parsed.hookSpecificOutput.additionalContext).toContain('hook-hello')
  expect(parsed.hookSpecificOutput.additionalContext).toContain('from="frontend"')

  const check = openBus(join(home, 'bus.db'))
  expect(check.pending('backend').length).toBe(0) // marked delivered after emit
  check.close()
}, 20_000)

test('hook mode stays silent when the inbox is empty', async () => {
  const home = mkdtempSync(join(tmpdir(), 'agentbus-hook-'))
  const out = await runHook(home, 'lonely')
  expect(out.trim()).toBe('') // no output → normal stop, no forced continuation
}, 20_000)
