/**
 * Identity resolution — shared by every component so they all agree on "who am I".
 *
 * id = `<runtime>:<token>` (e.g. `claude:…`, `gemini:…`, `codex:…`), where token
 * is the first available of:
 *   1. AGENTBUS_NAME      — set at launch for an interactive session you name
 *   2. CLAUDE_SESSION_ID  — present in Bash-tool subprocesses (so the CLI works)
 *   3. a caller-supplied session id — the hook passes the `session_id` it gets
 *      on stdin (dispatched agents, where no env can be set)
 *
 * Returns null when none are available — the caller is anonymous and cannot
 * register an identity (it can still send, attributed as `anon`).
 */
const clean = (s?: string | null) => (s ? s.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 48) : '')

/** A filesystem-safe form of an id, for wake-file names. */
export const idKey = (id: string) => id.replace(/[^a-z0-9_-]/g, '_')

/** Sanitize a human name (the label peers address). */
export const sanitizeName = (s: string) => s.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32)

export function resolveToken(fallbackSessionId?: string): string {
  return clean(process.env.AGENTBUS_NAME) || clean(process.env.CLAUDE_SESSION_ID) || clean(fallbackSessionId)
}

export function resolveId(runtime: string, fallbackSessionId?: string): string | null {
  const token = resolveToken(fallbackSessionId)
  return token ? `${runtime}:${token}` : null
}
