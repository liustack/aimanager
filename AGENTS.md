# Project Overview (for AI Agent)

## Goal

AIManager is the installer and launcher for AI harnesses — a desktop app that installs and starts an AI agent in one click, for people who never open a terminal. Free and open source forever (MIT).

Two shapes of harness, two treatments:

- **Harnesses with their own desktop GUI** (Codex app, Claude Desktop): install only, never wrap — download and install the official app plus whatever it needs, then launch it from the panel.
- **Harnesses with no desktop form** (DeepSeek Harness): AIManager supplies an invisible runtime, hosts the process on a dedicated port, and embeds the web UI inside its own window.

## Technical Approach

- **Three processes, one hard boundary.** All real work lives in a resident engine process (`utilityProcess`); the Electron main process only manages windows, supervises the engine, and relays IPC. Engine ↔ GUI is pure JSON-RPC (`{id,method,params}` / `{id,result|error}`, events as `{event,payload}`), so the engine can be swapped out wholesale without touching the app shell.
- **Vendor passthrough, never replacement.** Whatever a vendor already ships — official installers, desktop apps, state-directory conventions (dsh's `~/.dsh`) — is used as-is. AIManager only fills the gaps vendors don't cover.
- **Hosted instances are process-isolated but state-shared.** The hosted dsh runs on its own port (34517) but reuses the vendor's default state directory, so hand-installed copies coexist and every online tutorial still applies.
- **Private runtime supply.** Node.js is downloaded into AIManager's own directory and never touches the user's system; all platform differences converge in `runtime.ts`.
- **Organized by business domain, not by type.** A new capability starts with "which domain does this belong to?" — never a `handlers/` or `utils/` directory.

## Code Organization

```
src/
├── main/       # Electron main process: window management, engine supervision, IPC relay — no business logic
├── engine/     # resident engine process, one file per business domain
│   ├── runtime.ts   # private Node.js supply, all platform differences
│   ├── dsh.ts       # dsh: install, launch, probe, supervise
│   └── apps.ts      # desktop apps: detect and launch
├── preload/    # contextBridge — wiring only
└── renderer/   # the React launchpad
```

## Commands

```bash
pnpm dev         # development mode
pnpm typecheck   # tsc --noEmit, both process configs
pnpm test        # vitest unit tests, co-located *.test.ts
pnpm build       # electron-vite build
pnpm smoke       # engine RPC smoke test
pnpm smoke:dsh   # full real pipeline: download Node, install dsh, launch, probe
```

## Verification

- The acceptance gate for any change is `pnpm typecheck && pnpm test && pnpm smoke`; anything touching the runtime/dsh pipeline must also pass `pnpm smoke:dsh` (real network, a few minutes).
- Unit tests are co-located (`*.test.ts` next to the module, vitest). Pure logic gets extracted and pinned in unit tests; process- and network-heavy paths belong to the smoke tests.
- `scripts/run.mjs` works around editors leaking `ELECTRON_RUN_AS_NODE` into child processes. Don't bypass it to run Electron directly.
- `scripts/check-secrets.sh` greps for likely credential patterns before a commit. Real credentials never go into logs, error messages, or any output.

## Conventions

- User-facing copy is Chinese; code, comments, and identifiers are English. `README.md` in English, `README.zh-CN.md` in Chinese.
- TypeScript + Electron only.
- Branch before touching main (`feat/` `fix/` `refactor/` `docs/` `chore/` prefixes). Conventional commits, atomic commits.
