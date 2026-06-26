# Contributing

Thanks for your interest in improving agentbus.

## Development

```bash
bun install                       # install deps
bun test                          # run the integration tests
bun x tsc --noEmit                # typecheck
bun adapters/send.ts              # run the send server standalone (reads AGENTBUS_NAME)
```

CI runs typecheck + tests on every push and PR; keep both green.

## Layout

- `core/` — the runtime-agnostic bus and the port contracts. Start here.
  - `core/ports.ts` — the standard: `Envelope`, `Trigger`, `Delivery`.
  - `core/bus.ts` — SQLite client, migrate-on-startup, all queries.
  - `core/schema.ts` — Drizzle tables (`identities`, `names`, `messages`).
  - `core/identity.ts` — id resolution (`<runtime>:<token>`) + name sanitizing.
- `triggers/` — Trigger (PULL) implementations: `file-watch`, `poll`.
- `adapters/send.ts` (+ `send.json`) — the always-on MCP send server.
- `adapters/deliveries/` — one `.ts` + `.json` per pluggable delivery
  (`claude-channel`, `claude-hook`).
- `cli.ts` — the manager (`install`/`list`/`enable`/`disable`/`send`/`peers`/
  `doctor`/`uninstall`).
- `drizzle/` — generated, versioned SQL migrations (committed).
- `test/` — spawns real send/delivery processes over stdio and asserts
  discovery, delivery, offline queueing, no-loss under concurrency, and the hook.

See [SPEC.md](SPEC.md) for the full standard and [README](README.md) for the
bus design.

## Adding a delivery

1. Create `adapters/deliveries/<id>.ts` that opens the core bus and wires a
   `Trigger` + a `Delivery` (see `claude-channel.ts` for a long-running server,
   `claude-hook.ts` for a runtime-invoked script).
2. Add `adapters/deliveries/<id>.json` (see [SPEC.md §7](SPEC.md)).
3. If it needs a new install mechanism, add a `register.kind` handler in `cli.ts`.
4. Keep the core untouched — deliveries depend on the core, never the reverse.

## Changing the schema

The schema is source-of-truth in `core/schema.ts`. After editing it:

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
