# Changelog

## 0.2.0 - 2026-08-24

- **AIManager is now Summono.** New name, new mascot: a little white ghost you summon agents with. The GitHub repo moved to `liustack/summono` (old links redirect), the app identity and window title changed accordingly, and the private state directory migrates automatically from `~/.aimanager` to `~/.summono` on first launch — existing runtime, source memory, and plugin seeds are kept.
- **New app icon.** The Summono ghost on a black rounded tile, shipped as full icns/ico sets.

## 0.1.2 - 2026-08-20

- **Mac builds are now Developer ID signed and notarized by Apple.** No more Gatekeeper prompts or `xattr` workarounds — download, open, done. (Release builds run with hardened runtime enabled.)
- **A real titlebar above the hosted DeepSeek Harness.** The 30px strip now shows a centered title and a hairline bottom border, and its colors come from sampling the actual rendered pixels of the dsh page — it follows dsh's light/dark appearance automatically, settling on the final color without flashing intermediate tones.
- **Back to launchpad is one click.** The ⋯ popup menu became a direct launchpad button (native popup menus can't be edge-aligned in Electron and kept spilling out of the window).

## 0.1.1 - 2026-08-18

- **Fixed the macOS "damaged and can't be opened" error.** v0.1.0 shipped with no code signature at all, which Apple silicon Gatekeeper rejects with an unbypassable "damaged" dialog. Builds are now ad-hoc signed: the first open shows a "cannot verify" prompt instead, bypassable via System Settings → Privacy & Security → Open Anyway. If you already have a v0.1.0 copy, run `xattr -cr /Applications/AIManager.app` or just install this version over it.
- **New app icon.** A clean letter-A tile, programmatically drawn (crisp squircle, transparent corners).

## 0.1.0 - 2026-08-18

First public release. TypeScript + Electron, rebuilt from scratch.

- **One-click DeepSeek Harness on macOS.** Click the whale: AIManager downloads a private Node.js runtime into its own directory, installs dsh, starts it on a dedicated port (34517), and opens the web UI inside the app window under a slim native-feeling title strip. The hosted instance shares the vendor's default state directory (`~/.dsh`), so hand-installed copies and every online tutorial keep working.
- **Desktop app install and launch.** Claude Desktop and the Codex (ChatGPT) app are detected if present and launch from the launchpad; missing ones install with an App Store-style progress ring (macOS, official vendor downloads).
- **The launchpad.** A single screen of brand icons on a monochrome backdrop. Installed apps launch on click; missing ones install, then launch.
- **Engine architecture.** All real work lives in a resident engine process talking to the GUI over pure JSON-RPC, organized by business domain (`runtime`, `dsh`, `apps`).
- **Installers.** Tag-triggered release builds produce macOS DMGs (Apple silicon + Intel) and a Windows installer. Unsigned for now: macOS first open is right-click → Open, Windows shows a SmartScreen prompt.
