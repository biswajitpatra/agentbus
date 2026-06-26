#!/usr/bin/env bun
/**
 * agentbus — the manager.
 *
 * Three layers (see SPEC.md):
 *   - core      : the SQLite bus (presence + mailbox + delivery tracking).
 *   - send (MCP): the always-on `agentbus` MCP server — send_message/list_peers/…
 *                 Universal: every CLI speaks MCP. This CLI keeps it registered.
 *   - delivery  : how messages land IN a session. Pluggable, multi-select —
 *                 claude-channel (file-watch + channel), claude-hook (Stop/
 *                 SessionStart), gemini-a2a (future). Enable any combination.
 *
 *   agentbus install                 register send + show deliveries
 *   agentbus list                    send + deliveries, and which are on
 *   agentbus enable <delivery>       turn on one delivery (also ensures send)
 *   agentbus disable <delivery>      turn off a delivery
 *   agentbus launch <delivery> [name]  print the command to start a session
 *   agentbus doctor                  diagnose runtime, registration, peers, mailboxes
 *   agentbus uninstall               remove send + every delivery + the bus
 */
import { Database } from 'bun:sqlite'
import { readdirSync, readFileSync, writeFileSync, existsSync, copyFileSync, rmSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { styleText } from 'node:util'
import { DB_PATH, WAKE_DIR, HOME } from './core/paths'
import { openBus } from './core/bus'
import { resolveId, idKey, sanitizeName } from './core/identity'
import { fileWatchTrigger } from './triggers/file-watch'

const REPO = import.meta.dir
const DELIVERIES_DIR = join(REPO, 'adapters', 'deliveries')
const SEND_MANIFEST = join(REPO, 'adapters', 'send.json')
const CLAUDE_JSON = join(homedir(), '.claude.json')
const SETTINGS_JSON = join(homedir(), '.claude', 'settings.json')

type Register = { kind: string; name?: string; events?: string[] }
type Unit = { id: string; title: string; runtime: string; entry: string; register: Register; launch?: string; always?: boolean }

const C = {
  dim: (s: string) => styleText('dim', s),
  bold: (s: string) => styleText('bold', s),
  green: (s: string) => styleText('green', s),
  red: (s: string) => styleText('red', s),
  cyan: (s: string) => styleText('cyan', s),
}

const send = (): Unit => JSON.parse(readFileSync(SEND_MANIFEST, 'utf8'))

function deliveries(): Unit[] {
  if (!existsSync(DELIVERIES_DIR)) return []
  return readdirSync(DELIVERIES_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => JSON.parse(readFileSync(join(DELIVERIES_DIR, f), 'utf8')) as Unit)
    .sort((a, b) => a.id.localeCompare(b.id))
}

function getDelivery(id: string): Unit {
  const d = deliveries().find(x => x.id === id)
  if (!d) { console.error(C.red(`unknown delivery "${id}"`)); console.error('run: agentbus list'); process.exit(1) }
  return d
}

// --- JSON config helpers -----------------------------------------------------

function readJson(path: string): any {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {}
}
function writeJson(path: string, d: any): void {
  if (existsSync(path)) copyFileSync(path, `${path}.bak-agentbus`)
  writeFileSync(path, JSON.stringify(d, null, 2))
}
const hookCommand = (u: Unit) => `bun ${join(REPO, u.entry)}`

// --- registration (dispatch by register.kind) --------------------------------

function isEnabled(u: Unit): boolean {
  if (u.register.kind === 'claude-mcp-server') {
    return Boolean(readJson(CLAUDE_JSON).mcpServers?.[u.register.name!])
  }
  if (u.register.kind === 'claude-hook') {
    const cmd = hookCommand(u)
    const hooks = readJson(SETTINGS_JSON).hooks ?? {}
    return Object.values(hooks).some((arr: any) =>
      (arr as any[]).some(g => (g.hooks ?? []).some((h: any) => h.command === cmd)))
  }
  return false
}

function registerUnit(u: Unit): void {
  if (u.register.kind === 'claude-mcp-server') {
    const d = readJson(CLAUDE_JSON)
    ;(d.mcpServers ??= {})[u.register.name!] = { command: 'bun', args: [join(REPO, u.entry)] }
    writeJson(CLAUDE_JSON, d)
  } else if (u.register.kind === 'claude-hook') {
    const d = readJson(SETTINGS_JSON)
    const cmd = hookCommand(u)
    d.hooks ??= {}
    for (const ev of u.register.events ?? []) {
      d.hooks[ev] ??= []
      const present = (d.hooks[ev] as any[]).some(g => (g.hooks ?? []).some((h: any) => h.command === cmd))
      if (!present) d.hooks[ev].push({ hooks: [{ type: 'command', command: cmd }] })
    }
    writeJson(SETTINGS_JSON, d)
  } else {
    console.error(C.red(`don't know how to register kind "${u.register.kind}" yet`)); process.exit(1)
  }
}

function unregisterUnit(u: Unit): boolean {
  if (u.register.kind === 'claude-mcp-server') {
    const d = readJson(CLAUDE_JSON)
    const had = Boolean(d.mcpServers && u.register.name! in d.mcpServers)
    if (had) { delete d.mcpServers[u.register.name!]; writeJson(CLAUDE_JSON, d) }
    return had
  }
  if (u.register.kind === 'claude-hook') {
    const d = readJson(SETTINGS_JSON)
    const cmd = hookCommand(u)
    let had = false
    for (const ev of Object.keys(d.hooks ?? {})) {
      const before = (d.hooks[ev] as any[]).length
      d.hooks[ev] = (d.hooks[ev] as any[]).filter(g => !(g.hooks ?? []).some((h: any) => h.command === cmd))
      if (d.hooks[ev].length !== before) had = true
      if (!d.hooks[ev].length) delete d.hooks[ev]
    }
    if (had) writeJson(SETTINGS_JSON, d)
    return had
  }
  return false
}

const whereOf = (u: Unit) =>
  u.register.kind === 'claude-hook'
    ? `${(u.register.events ?? []).join('/')} hooks in ~/.claude/settings.json`
    : `MCP server "${u.register.name}" in ~/.claude.json`

function ensureSend(): void {
  const s = send()
  if (!isEnabled(s)) { registerUnit(s); console.log(C.green(`✓ send on`) + C.dim(` (${whereOf(s)})`)) }
}

// --- commands ----------------------------------------------------------------

function cmdInstall(): void {
  ensureSend()
  console.log(C.dim('\nenable a delivery (you can enable more than one):'))
  for (const d of deliveries()) console.log(`  agentbus enable ${C.bold(d.id)}${C.dim(`   ${d.title}`)}`)
}

function enable(id: string): void {
  if (id === 'send') { ensureSend(); return }
  // Deliberately no "all": each delivery is enabled individually.
  const d = getDelivery(id)
  ensureSend() // a delivery is useless without the send layer
  registerUnit(d)
  console.log(C.green(`✓ ${d.id} on`) + C.dim(` (${whereOf(d)})`))
  if (d.launch) console.log(C.dim('  launch: ') + C.cyan(d.launch))
}

function disable(id: string): void {
  const u = id === 'send' ? send() : getDelivery(id)
  const had = unregisterUnit(u)
  console.log(had ? C.green(`✓ ${id} off`) : C.dim(`- ${id} was not on`))
  if (id === 'send') console.log(C.dim('  (send is the base layer — you usually want `agentbus uninstall` instead)'))
}

function cmdList(): void {
  const s = send()
  console.log(C.bold('agentbus\n'))
  console.log(`  ${isEnabled(s) ? C.green('●') : C.dim('○')} ${C.bold('send')}${C.dim(`  — ${s.title}  [always-on]`)}`)
  console.log(C.dim('  deliveries:'))
  for (const d of deliveries()) {
    const on = isEnabled(d)
    console.log(`  ${on ? C.green('●') : C.dim('○')} ${C.bold(d.id)}${C.dim(`  — ${d.title}`)}${on ? C.green('  ← on') : ''}`)
  }
  console.log(C.dim('\n  enable each you want, individually: agentbus enable <delivery>'))
}

function cmdLaunch(id: string, name?: string): void {
  const d = getDelivery(id)
  if (!d.launch) { console.error(C.red(`${id} has no launch command`)); process.exit(1) }
  console.log(name ? d.launch.replace('<name>', name) : d.launch)
}

function cmdDoctor(): void {
  const line = (okState: boolean, s: string) => console.log(`  ${okState ? C.green('✔') : C.red('✗')} ${s}`)
  console.log(C.bold('agentbus doctor') + C.dim(`  (home: ${HOME})`) + '\n')

  line(Boolean(Bun.which('bun')), `bun ${Bun.version}`)
  line(Boolean(Bun.which('claude')), 'claude CLI on PATH  (channels need >= 2.1.80)')

  console.log('\n' + C.bold('layers'))
  line(isEnabled(send()), `send ${isEnabled(send()) ? 'on' : C.dim('off — run: agentbus install')}`)
  for (const d of deliveries()) line(isEnabled(d), `${d.id} ${isEnabled(d) ? 'on' : C.dim('off')}`)

  console.log('\n' + C.bold('bus') + C.dim(`  ${DB_PATH}`))
  if (!existsSync(DB_PATH)) { console.log(C.dim('  (no bus yet — start a session first)')); return }
  const db = new Database(DB_PATH, { readonly: true })
  try {
    const now = Date.now()
    const rows = db.query(
      `SELECT i.id, i.session_id, i.last_seen, (SELECT group_concat(n.name, ', ') FROM names n WHERE n.id = i.id) AS names
       FROM identities i ORDER BY i.id`,
    ).all() as any[]
    console.log('  identities:')
    if (!rows.length) console.log(C.dim('    (none)'))
    for (const r of rows) {
      const state = r.last_seen >= now - 45_000 ? C.green('online') : C.dim('stale')
      const sess = r.session_id ? C.dim(` session=${r.session_id}`) : ''
      console.log(`    - ${r.names ?? C.dim('(no name)')}  ${C.dim(r.id)}  ${state}${sess}`)
    }
    const box = db.query(
      'SELECT recipient, sum(delivered_at IS NULL) pending, sum(delivered_at IS NOT NULL) delivered FROM messages GROUP BY recipient ORDER BY recipient',
    ).all() as any[]
    console.log('  mailboxes (pending / delivered):')
    if (!box.length) console.log(C.dim('    (no messages yet)'))
    for (const b of box) console.log(`    - ${b.recipient}  ${b.pending} pending / ${b.delivered} delivered`)
  } finally { db.close() }
}

// Send / name / list straight over the bus — no MCP server needed. Handy for
// scripts and for dispatched agents, which shell out to this (Bash subprocesses
// get CLAUDE_SESSION_ID, so the id resolves the same as the hook's).
function cmdSend(to: string, message: string): void {
  if (!to || !message) { console.error('usage: agentbus send <to> "message"'); process.exit(1) }
  const bus = openBus(DB_PATH)
  const toId = bus.idForName(sanitizeName(to)) ?? (to.includes(':') ? to : null)
  if (!toId) { bus.close(); console.error(C.red(`no peer named "${to}"`)); process.exit(1) }
  const from = resolveId('claude') ?? 'anon'
  const id = bus.enqueue(from, toId, message)
  bus.close()
  fileWatchTrigger(WAKE_DIR).notify(idKey(toId)) // wake a live delivery now
  console.log(C.green('✓ sent') + C.dim(` ${from} → ${to} (#${id})`))
}

function cmdName(name: string): void {
  const myId = resolveId('claude')
  if (!myId) { console.error(C.red('no id — set AGENTBUS_NAME, or run inside a session (CLAUDE_SESSION_ID)')); process.exit(1) }
  const clean = sanitizeName(name)
  if (!clean) { console.error(C.red('name must contain a-z, 0-9, _ or -')); process.exit(1) }
  const bus = openBus(DB_PATH)
  bus.registerIdentity(myId, process.env.CLAUDE_SESSION_ID ?? null, process.pid)
  bus.setName(clean, myId)
  bus.close()
  console.log(C.green(`✓ registered as ${clean}`) + C.dim(` (${myId})`))
}

function cmdPeers(): void {
  if (!existsSync(DB_PATH)) { console.log('no peers online'); return }
  const bus = openBus(DB_PATH)
  const peers = bus.livePeers(45_000)
  bus.close()
  console.log(peers.length ? peers.map(p => `  ${p.name}`).join('\n') : 'no peers online')
}

function cmdUninstall(): void {
  for (const u of [send(), ...deliveries()]) {
    const had = unregisterUnit(u)
    if (had) console.log(C.green(`✓ ${u.id} off`))
  }
  for (const f of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`, `${DB_PATH}.init.lock`]) {
    try { rmSync(f) } catch {}
  }
  try { rmSync(WAKE_DIR, { recursive: true, force: true }) } catch {}
  try { rmSync(HOME, { recursive: false }) } catch {} // only if now empty
  console.log(C.green('\n✓ uninstalled') + C.dim(' — restart any running session to drop the loaded server/hook.'))
}

function usage(): void {
  console.log(`agentbus — local message bus for AI agent sessions

usage:
  agentbus install                 register the always-on send server + list deliveries
  agentbus list                    send + deliveries, and which are on
  agentbus enable <delivery>       turn on one delivery (also ensures send)
  agentbus disable <delivery>      turn off a delivery
  agentbus launch <delivery> [name]  print the command to start a session
  agentbus send <to> "message"     enqueue a message over the bus (no MCP needed)
  agentbus name <name>             claim a name for this session (over the bus)
  agentbus peers                   list peers currently online
  agentbus doctor                  diagnose runtime, registration, peers, mailboxes
  agentbus uninstall               remove send + every delivery + the bus`)
}

const [cmd, a1, a2] = process.argv.slice(2)
switch (cmd) {
  case 'install': cmdInstall(); break
  case 'list': cmdList(); break
  case 'enable': if (!a1) { usage(); process.exit(1) } enable(a1); break
  case 'disable': if (!a1) { usage(); process.exit(1) } disable(a1); break
  case 'launch': if (!a1) { usage(); process.exit(1) } cmdLaunch(a1, a2); break
  case 'send': if (!a1) { usage(); process.exit(1) } cmdSend(a1, process.argv.slice(4).join(' ')); break
  case 'name': if (!a1) { usage(); process.exit(1) } cmdName(a1); break
  case 'peers': cmdPeers(); break
  case 'doctor': cmdDoctor(); break
  case 'uninstall': cmdUninstall(); break
  default: usage(); if (cmd) process.exit(1)
}
