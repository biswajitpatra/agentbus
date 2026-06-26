/**
 * Database schema (Drizzle ORM). Edit this file, then run `bun run db:generate`
 * to produce a new versioned migration under drizzle/. The bus applies pending
 * migrations on open.
 *
 * The identity model: messages are keyed by a stable `id` ("claude:<token>"),
 * and `names` is a mutable label -> id map. Renaming edits `names` only — message
 * routing never moves, because it's always by id.
 */
import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core'

// One row per live session participant. `id` is stable for the session's
// lifetime ("<runtime>:<token>"); `sessionId` is the runtime's own live session
// thread (stamped by the delivery, e.g. the hook), giving the bidirectional
// id <-> session-thread link. Runtime-neutral: works for any runtime's sessions.
export const identities = sqliteTable('identities', {
  id: text('id').primaryKey(),
  sessionId: text('session_id'),
  pid: integer('pid').notNull(),
  startedAt: integer('started_at').notNull(),
  lastSeen: integer('last_seen').notNull(),
})

// Mutable human label -> identity id. `name` is the PK (unique), so registering
// an existing name overrides it (takes it over from the previous holder).
export const names = sqliteTable('names', {
  name: text('name').primaryKey(),
  id: text('id').notNull(),
  updatedAt: integer('updated_at').notNull(),
})

// One message. sender/recipient are identity ids. deliveredAt IS NULL = pending.
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

export type Identity = typeof identities.$inferSelect
export type NameRow = typeof names.$inferSelect
export type Message = typeof messages.$inferSelect
