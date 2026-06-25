/**
 * The bus: all shared state (peers + messages) in one SQLite database, accessed
 * through Drizzle. Pending migrations are applied on open, so a freshly shipped
 * schema change upgrades the store automatically.
 */
import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import { and, asc, eq, gte, isNotNull, isNull, lt } from 'drizzle-orm'
import { mkdirSync } from 'fs'
import { dirname, join } from 'path'
import { messages, peers, type Message, type Peer } from './schema'

export type { Message, Peer }

export function openBus(dbPath: string) {
  mkdirSync(dirname(dbPath), { recursive: true })
  const sqlite = new Database(dbPath, { create: true })
  sqlite.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;')
  const db = drizzle({ client: sqlite })
  // migrations live next to this module, at <repo>/drizzle
  migrate(db, { migrationsFolder: join(import.meta.dir, '..', 'drizzle') })

  const now = () => Date.now()

  return {
    // --- presence / discovery ---
    registerPeer(name: string, pid: number) {
      const t = now()
      db.insert(peers).values({ name, pid, startedAt: t, lastSeen: t })
        .onConflictDoUpdate({ target: peers.name, set: { pid, startedAt: t, lastSeen: t } }).run()
    },
    heartbeat(name: string, pid: number) {
      const t = now()
      db.insert(peers).values({ name, pid, startedAt: t, lastSeen: t })
        .onConflictDoUpdate({ target: peers.name, set: { lastSeen: t } }).run()
    },
    unregisterPeer(name: string) {
      db.delete(peers).where(eq(peers.name, name)).run()
    },
    livePeers(staleMs: number): Peer[] {
      const cut = now() - staleMs
      db.delete(peers).where(lt(peers.lastSeen, cut)).run() // reap silent peers
      return db.select().from(peers).where(gte(peers.lastSeen, cut)).orderBy(asc(peers.name)).all()
    },
    isLive(name: string, staleMs: number): boolean {
      return db.select().from(peers)
        .where(and(eq(peers.name, name), gte(peers.lastSeen, now() - staleMs))).get() != null
    },

    // --- messages ---
    enqueue(sender: string, recipient: string, body: string): number {
      const [row] = db.insert(messages)
        .values({ sender, recipient, body, createdAt: now() })
        .returning({ id: messages.id }).all()
      return row.id
    },
    pending(recipient: string): Message[] {
      return db.select().from(messages)
        .where(and(eq(messages.recipient, recipient), isNull(messages.deliveredAt)))
        .orderBy(asc(messages.id)).all()
    },
    markDelivered(id: number) {
      db.update(messages).set({ deliveredAt: now() }).where(eq(messages.id, id)).run()
    },
    reassignPending(from: string, to: string) {
      db.update(messages).set({ recipient: to })
        .where(and(eq(messages.recipient, from), isNull(messages.deliveredAt))).run()
    },
    prune(ttlMs: number) {
      db.delete(messages)
        .where(and(isNotNull(messages.deliveredAt), lt(messages.deliveredAt, now() - ttlMs))).run()
    },

    close() {
      sqlite.close()
    },
  }
}

export type Bus = ReturnType<typeof openBus>
