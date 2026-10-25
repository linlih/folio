# Folio

**English** · [简体中文](README.zh-CN.md)

A local-first, card-based note app. Your notes live on your own device in SQLite; Loro CRDTs keep several devices in sync without conflicts. Built with Tauri 2, React and Rust.

- **Cards and a daily journal**: one editor for both, with outlines, tasks, code blocks, math and links between cards.
- **Card library and topics**: browse, search and group cards.
- **Whiteboards**: lay cards out, connect them, frame them in sections and build mind maps from text or cards.
- **Sync** (in development): end-to-end encrypted, through a server you host yourself.
- **Desktop and phone layouts**: macOS, Windows, Linux and Android, with iOS planned.

## Download

Get the latest version from [Releases](https://github.com/linlih/folio/releases/latest):

| Platform | File |
|---|---|
| macOS (Apple Silicon and Intel) | `Folio_x.y.z_universal.dmg` |
| Windows | `Folio_x.y.z_x64-setup.exe` or `.msi` |
| Linux | `.AppImage`, `.deb` or `.rpm` |
| Android (arm64) | `folio-android-arm64.apk` |

Desktop apps check for updates once a day and ask before installing (the AppImage on Linux; `.deb` / `.rpm` update through your package manager). The Android app tells you when a new APK is out.

The builds are not yet signed by Apple or Microsoft. On macOS, allow the app the first time in **System Settings → Privacy & Security**; on Windows, choose **More info → Run anyway**.

## Self-hosting the sync server

On a Linux server with systemd, point a domain at it, then run:

```bash
curl -fsSL https://raw.githubusercontent.com/linlih/folio/main/scripts/install-server.sh | sudo bash -s -- --domain sync.example.com
```

The script installs everything under `/opt/folio-sync` (program, settings and token, data, logs rotated daily) as the systemd service `folio-sync`, sets up HTTPS with Caddy (when the machine has none, Caddy's official release is installed into `/opt/folio-sync`, checksum-verified and run as the service `folio-sync-caddy`, with no package manager needed; when it has one, the script asks before adding a site to your Caddyfile; `--https-port` picks another port than 443), and prints the server address and token to enter in **Settings → Sync** in the app. The server only ever sees encrypted data.

Run on a terminal without options, it asks step by step for the domain, the public HTTPS port (443 by default; another port avoids most scanning) and the local port, then shows the plan and changes nothing until you agree. For unattended installs pass `--domain`, `--https-port`, `--port` and `--yes`.

Manage it with the `folio-sync` command:

```
folio-sync status | start | stop | restart | logs -f | info | upgrade | uninstall [--purge]
```

## Repository layout

```
crates/
  folio-core/     Domain model: document ids, card document structure (Loro), extraction; no IO
  folio-store/    SQLite: the only writer, change log, derived indexes, device settings
  folio-sync/     Sync client
  folio-io/       Import and export
  folio-mcp/      MCP server (AI access to notes)
  folio-server/   Sync relay server
src-tauri/      Tauri 2 shell: IPC commands, windows, logging and diagnostics
web/            React frontend: design system, i18n, app shell, platform layer
scripts/        Fonts, tests, releases
design/         Architecture and decisions (in Chinese)
spike/          Early technical experiments, kept for reference
```

Planned: `packages/` (plugin SDK) and `plugins/` (built-in plugins).

Design and decisions: [`design/ARCHITECTURE.md`](design/ARCHITECTURE.md), ADRs in [`design/adr/`](design/adr/), research in [`design/research/`](design/research/).

## Development

Requirements: Rust (stable), Node.js 22+, and on macOS the Xcode Command Line Tools.

```bash
./scripts/fetch-fonts.sh
```

```bash
npm install
```

Frontend only, in the browser with an in-memory backend:

```bash
npm run dev
```

The desktop app (Tauri):

```bash
npm run tauri dev
```

Every test (Rust, then frontend type check and unit tests):

```bash
npm test
```

## Builds and releases (GitHub Actions)

- **CI** runs every test on each push to `main`.
- **Releasing**: run `./scripts/release.sh 0.2.0 -m "What changed" --push`. It sets the version everywhere, commits, and pushes a tag whose message becomes the release notes. The tag builds and publishes the release: installers, signed update packages, `latest.json` (which installed apps check) and the Android APK. Details in `design/ARCHITECTURE.md` §7.3.
- **Build apps** can also be run by hand from the Actions tab. It only builds, without publishing; the files stay in that run's artifacts for 14 days.
- **iOS** builds are only compile-checked for now. Installing on an iPhone needs an Apple developer account and signing (§7.2).

Signing keys live in the repository secrets: `TAURI_SIGNING_PRIVATE_KEY` and its password for updates, `ANDROID_KEYSTORE_B64` and `ANDROID_KEYSTORE_PASSWORD` for the APK.
