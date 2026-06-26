/**
 * The agentbus standard — core port contracts.
 *
 * The core (presence + message store + delivery tracking) is runtime-agnostic
 * and never imports an adapter. Each runtime plugs in by implementing two
 * driven ports:
 *
 *   - Delivery (PUSH): how a message enters a runtime's live session.
 *       claude `channel` mode → an MCP `notifications/claude/channel`.
 *   - Trigger  (PULL): how a recipient learns it has mail to drain.
 *       file-watch nudges via a wake file; poll ticks on an interval.
 *
 * See SPEC.md for the full standard.
 */

/**
 * A message on the bus. Loosely aligned with the A2A message shape (a sender, a
 * recipient, and a text part) so a future A2A bridge is a field mapping, not a
 * redesign. Local delivery stays MCP; A2A is an edge adapter.
 */
export interface Envelope {
  id: number
  from: string
  to: string // peer name; '*' broadcasts are fanned out to one row per peer
  body: string // the text part
  createdAt: number // epoch ms
}

/** Driven port — PUSH a message into a runtime's live session. */
export interface Delivery {
  deliver(env: Envelope): Promise<void>
}

/** Driven port — PULL: learn when there is mail to drain, and nudge peers. */
export interface Trigger {
  /** Start listening for nudges addressed to `self`; returns a disposer. */
  arm(self: string, onWake: () => void): () => void
  /** Nudge `recipient` to drain now (a no-op for pure pollers). */
  notify(recipient: string): void
}
