# CLAUDE.md

1. Read [AGENTS.md](AGENTS.md) first — goal, architecture, commands, and conventions live there.
2. The acceptance gate for any change is `pnpm typecheck && pnpm test && pnpm smoke`; anything touching the runtime/dsh pipeline must also pass `pnpm smoke:dsh`.
3. All real work lives in the engine process behind the JSON-RPC boundary; the Electron main process carries no business logic.
4. Vendor passthrough, never replacement: official installers, desktop apps, and state-directory conventions are used as-is.
5. Branch before touching main (`feat/` `fix/` `refactor/` `docs/` `chore/` prefixes). Conventional commits, atomic commits.

@.claude/CLAUDE.md
