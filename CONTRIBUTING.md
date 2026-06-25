# Contributing

Thanks for your interest in improving inter-claude-channels.

## Development

```bash
bun install        # install deps
bun test           # run the integration tests
bun x tsc --noEmit # typecheck
bun server.ts      # run the channel standalone (reads INTER_CLAUDE_NAME)
```

CI runs typecheck + tests on every push and PR; keep both green.

## Layout

- `server.ts` — the channel: MCP tools + the poll-and-push delivery loop. Start here.
- `db/schema.ts` — Drizzle table definitions (`peers`, `messages`).
- `db/index.ts` — the bus: SQLite client, migrate-on-startup, and all queries.
- `drizzle/` — generated, versioned SQL migrations (committed).
- `test/bus.test.ts` — spawns real server processes over stdio and asserts
  discovery, delivery, rename, offline queueing, and no-loss under concurrency.
- `scripts/` — install / uninstall / doctor / demo helpers.

See the **How it works** and **Data & migrations** sections of the
[README](README.md) for the bus design.

## Changing the schema

The schema is source-of-truth in `db/schema.ts`. After editing it:

```bash
bun run db:generate   # writes a new drizzle/NNNN_*.sql migration — commit it
```

Migrations apply automatically on the next session start. Never hand-edit a
generated migration; change the schema and regenerate.

## Code style

Match the existing file: TypeScript, 2-space indent, single quotes, no
semicolons, small focused functions. No formatter config is enforced — read the
surrounding code and stay consistent.

## Pull requests

1. Fork and branch from `main`.
2. Add or update a test for any behavior change (`test/bus.test.ts`).
3. Keep the diff focused; one concern per PR.
4. Describe the change and how you verified it.

## Reporting bugs / ideas

Open an issue using the templates. For anything security-sensitive, see
[SECURITY.md](SECURITY.md) instead of filing a public issue.
