/**
 * The bus: all shared state in one SQLite database, accessed through Drizzle.
 * Pending migrations are applied on open.
 *
 * Two concerns live here, both runtime-agnostic:
 *   - the registry: identities (stable id <-> live Claude session) + names
 *     (mutable label -> id) + presence.
 *   - the mailbox: messages keyed by recipient *id*, with delivery tracking.
 * It knows nothing about MCP, channels, hooks, or how a recipient is woken.
 */
import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import { and, asc, eq, gte, isNotNull, isNull, lt } from 'drizzle-orm'
import { mkdirSync, openSync, closeSync, rmSync } from 'fs'
import { dirname, join } from 'path'
import { identities, names, messages, type Identity, type Message, type NameRow } from './schema'

export type { Identity, Message, NameRow }
export type LivePeer = { name: string; id: string }

function withInitLock(dbPath: string, fn: () => void): void {
  const lock = `${dbPath}.init.lock`
  const start = Date.now()
  for (;;) {
    let fd: number
    try { fd = openSync(lock, 'wx') }
    catch {
      if (Date.now() - start > 20_000) { try { rmSync(lock) } catch {} }
      Bun.sleepSync(25)
      continue
    }
    try { fn() } finally {
      try { closeSync(fd) } catch {}
      try { rmSync(lock) } catch {}
    }
    return
  }
}

export function openBus(dbPath: string) {
  mkdirSync(dirname(dbPath), { recursive: true })
  const sqlite = new Database(dbPath, { create: true })
  sqlite.exec('PRAGMA busy_timeout = 10000;')
  const db = drizzle({ client: sqlite })
  withInitLock(dbPath, () => {
    sqlite.exec('PRAGMA journal_mode = WAL;')
    migrate(db, { migrationsFolder: join(import.meta.dir, '..', 'drizzle') })
  })

  const now = () => Date.now()

  return {
    // --- registry: identities (presence) ---
    registerIdentity(id: string, sessionId: string | null, pid: number) {
      const t = now()
      db.insert(identities).values({ id, sessionId, pid, startedAt: t, lastSeen: t })
        .onConflictDoUpdate({ target: identities.id, set: { sessionId, pid, lastSeen: t } }).run()
    },
    heartbeat(id: string, sessionId: string | null, pid: number) {
      const t = now()
      db.insert(identities).values({ id, sessionId, pid, startedAt: t, lastSeen: t })
        .onConflictDoUpdate({ target: identities.id, set: { lastSeen: t, ...(sessionId ? { sessionId } : {}) } }).run()
    },
    unregisterIdentity(id: string) {
      db.delete(identities).where(eq(identities.id, id)).run()
    },
    isLiveId(id: string, staleMs: number): boolean {
      return db.select().from(identities)
        .where(and(eq(identities.id, id), gte(identities.lastSeen, now() - staleMs))).get() != null
    },
    sessionThread(id: string): string | null {
      return db.select().from(identities).where(eq(identities.id, id)).get()?.sessionId ?? null
    },

    // --- registry: names (mutable label -> id) ---
    // Override semantics: returns the previous holder's id (or null) so the
    // caller can notify it. Drops the caller's other names (rename = one label).
    setName(name: string, id: string): string | null {
      const prev = db.select().from(names).where(eq(names.name, name)).get()?.id ?? null
      db.delete(names).where(eq(names.id, id)).run()
      db.insert(names).values({ name, id, updatedAt: now() })
        .onConflictDoUpdate({ target: names.name, set: { id, updatedAt: now() } }).run()
      return prev && prev !== id ? prev : null
    },
    idForName(name: string): string | null {
      return db.select().from(names).where(eq(names.name, name)).get()?.id ?? null
    },
    displayName(id: string): string {
      return db.select().from(names).where(eq(names.id, id)).orderBy(asc(names.name)).get()?.name ?? id
    },
    // live peers = names whose identity is still live (for list_peers)
    livePeers(staleMs: number): LivePeer[] {
      const cut = now() - staleMs
      db.delete(identities).where(lt(identities.lastSeen, cut)).run() // reap stale
      const live = db.select().from(identities).where(gte(identities.lastSeen, cut)).all()
      const liveIds = new Set(live.map(i => i.id))
      return db.select().from(names).orderBy(asc(names.name)).all()
        .filter(n => liveIds.has(n.id))
        .map(n => ({ name: n.name, id: n.id }))
    },

    // --- mailbox: messages keyed by recipient id ---
    enqueue(senderId: string, recipientId: string, body: string): number {
      const [row] = db.insert(messages)
        .values({ sender: senderId, recipient: recipientId, body, createdAt: now() })
        .returning({ id: messages.id }).all()
      return row.id
    },
    pending(recipientId: string): Message[] {
      return db.select().from(messages)
        .where(and(eq(messages.recipient, recipientId), isNull(messages.deliveredAt)))
        .orderBy(asc(messages.id)).all()
    },
    markDelivered(id: number) {
      db.update(messages).set({ deliveredAt: now() }).where(eq(messages.id, id)).run()
    },
    prune(ttlMs: number) {
      db.delete(messages)
        .where(and(isNotNull(messages.deliveredAt), lt(messages.deliveredAt, now() - ttlMs))).run()
    },

    close() { sqlite.close() },
  }
}

export type Bus = ReturnType<typeof openBus>
