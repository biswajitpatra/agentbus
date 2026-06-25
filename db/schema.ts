/**
 * Database schema (Drizzle ORM). Edit this file, then run `bun run db:generate`
 * to produce a new versioned migration under drizzle/. The server applies any
 * pending migrations automatically on startup, so updating the app later is
 * just: change the schema -> generate -> ship.
 */
import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core'

// One row per online session — presence + heartbeat for discovery.
export const peers = sqliteTable('peers', {
  name: text('name').primaryKey(),
  pid: integer('pid').notNull(),
  startedAt: integer('started_at').notNull(),
  lastSeen: integer('last_seen').notNull(),
})

// One row per message. deliveredAt IS NULL means pending ("not yet gone");
// a timestamp means it was pushed into the recipient's session ("gone").
export const messages = sqliteTable(
  'messages',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sender: text('sender').notNull(),
    recipient: text('recipient').notNull(),
    body: text('body').notNull(),
    createdAt: integer('created_at').notNull(),
    deliveredAt: integer('delivered_at'),
  },
  t => ({ inbox: index('idx_inbox').on(t.recipient, t.deliveredAt) }),
)

export type Peer = typeof peers.$inferSelect
export type Message = typeof messages.$inferSelect
