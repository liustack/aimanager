# Changelog

## 0.1.0 - 2026-08-18

First public release. TypeScript + Electron, rebuilt from scratch.

- **One-click DeepSeek Harness on macOS.** Click the whale: AIManager downloads a private Node.js runtime into its own directory, installs dsh, starts it on a dedicated port (34517), and opens the web UI inside the app window under a slim native-feeling title strip. The hosted instance shares the vendor's default state directory (`~/.dsh`), so hand-installed copies and every online tutorial keep working.
- **Desktop app install and launch.** Claude Desktop and the Codex (ChatGPT) app are detected if present and launch from the launchpad; missing ones install with an App Store-style progress ring (macOS, official vendor downloads).
- **The launchpad.** A single screen of brand icons on a monochrome backdrop. Installed apps launch on click; missing ones install, then launch.
- **Engine architecture.** All real work lives in a resident engine process talking to the GUI over pure JSON-RPC, organized by business domain (`runtime`, `dsh`, `apps`).
- **Installers.** Tag-triggered release builds produce macOS DMGs (Apple silicon + Intel) and a Windows installer. Unsigned for now: macOS first open is right-click → Open, Windows shows a SmartScreen prompt.
