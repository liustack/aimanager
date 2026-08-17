# Contributing to AIManager

First, the policy: **AIManager does not accept pull requests.** It is a
deliberately small app with a single maintainer who reviews and owns every
line, and keeping that loop tight is what keeps it dependable.

Two contributions that genuinely help:

- **[Open an issue](https://github.com/liustack/aimanager/issues).** Bugs,
  ideas, a confusing error message, docs that read wrong. Issues get read and
  drive what gets built.
- **Fork it.** The MIT license means your copy is fully yours: rename it,
  rewire it, publish it. No permission needed.

Everything below is for people working on a fork.

## Scope

AIManager does one thing: install and launch AI harnesses for people who have
never opened a terminal. It never replaces what vendors already ship — official
installers, desktop apps, and state-directory conventions are used as-is, and
AIManager only fills the gaps vendors don't cover.

## Setup

```bash
pnpm install
pnpm dev         # development mode
pnpm typecheck   # tsc --noEmit, both process configs
pnpm test        # vitest unit tests, co-located *.test.ts
pnpm build       # electron-vite build
pnpm smoke       # engine RPC smoke test
pnpm smoke:dsh   # full pipeline: download Node, install dsh, launch, probe
```

The acceptance gate for any change is `pnpm typecheck && pnpm test && pnpm smoke`;
anything touching the runtime/dsh pipeline must also pass `pnpm smoke:dsh` (it
downloads a real Node.js runtime and installs the real dsh, so it needs network
and a few minutes).

Unit tests are co-located: a module's tests live in the adjacent `*.test.ts`
(vitest). Pure logic gets extracted into exported functions and pinned there;
process- and network-heavy paths are covered by the smoke tests instead.

Note: `scripts/run.mjs` exists because editors leak `ELECTRON_RUN_AS_NODE`
into child processes, which breaks Electron in confusing ways. Don't bypass it
to run Electron directly.

## How the code is organized

TypeScript + Electron, three processes with a hard boundary:

| Piece | Role |
| :-- | :-- |
| `src/main/` | Electron main process: window management, engine supervision, IPC relay. No business logic here. |
| `src/engine/` | Resident engine process (`utilityProcess`) where the real work happens, one file per business domain: `runtime.ts` (private Node.js supply, all platform differences), `dsh.ts` (install, launch, probe, supervise), `apps.ts` (desktop app detection and launch). |
| `src/preload/` | The `contextBridge` — wiring only. |
| `src/renderer/` | The React launchpad. |

The engine talks to the GUI over pure JSON-RPC messages
(`{id,method,params}` / `{id,result|error}`, events as `{event,payload}`), so
the engine can be swapped out wholesale without touching the app shell.

Code is organized by business domain, not by type: a new capability starts
with the question "which domain does this belong to?", never with a
`handlers/` or `utils/` directory.

## Conventions

- User-facing copy is Chinese; code, comments, and identifiers are English.
- Conventional commits, atomic commits.
- Real credentials never go into logs, error messages, or any output.
  `scripts/check-secrets.sh` greps for likely key patterns before a commit.
