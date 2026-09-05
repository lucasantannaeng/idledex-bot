# Task Plan: idleDEX Bot Fixes & Enhancements

## Phase 1: Architecture & Persistence
- [x] Extract full conversation context and reverse engineer upstream JavaScript protocol.
- [x] Create `config.json` persistence engine (`config.py`: auto-load, auto-save, token, cookie, port, thresholds, strategy).
- [x] Implement robust token parsing (handles raw tokens, cookie headers, decoded values, JSON inputs via `clean_session_token`).

## Phase 2: Core Bot Engine Fixes (`bot.py`)
- [x] Keep HTTP dashboard server running ALIVE independently even if token is missing/expired/invalid.
- [x] Fix token refresh event loop & prevent hang/shutdown on auth errors.
- [x] Implement IdleDex protocol-accurate messaging (`{ t: "...", d: ... }`).
- [x] Fix binary protocol parser (1-byte length prefix for entity name/id aligned with upstream `xye`).
- [x] Implement 5-second ping heartbeat loop (`{ t: "ping" }`).
- [x] Implement native idle mode integration (`idle:start`, `idle:stop`, `idle:config`).
- [x] Pass proper headers and cookies in WebSocket connection (removing duplicate Origin).
- [x] Expose rich status via `/state`: `connected`, `needs_token`, `auth_error`, `entities`, `collection`, `wallet`, `progress`, `battle`, `inventory`, `config`.
- [x] Add `/api/config` endpoint (GET/POST) to save strategy and threshold configurations dynamically.
- [x] Add `/api/connect` and `/api/disconnect` endpoints for user manual control from the dashboard.

## Phase 3: Dashboard Redesign & Usability (`dashboard.html`)
- [x] High-density corporate dark UI (Slate/Cyan palette, modern font stack, crisp badges, smooth animations).
- [x] Prominent, auto-opening Token Renewal Modal / Banner whenever `needs_token` is true.
- [x] Fix all missing JavaScript handlers (`connect`, `disconnect`, `updateConfig`, `renderCollection`).
- [x] Interactive Real-Time Map visualization of entities parsed from binary frames or state (20x20 canvas radar).
- [x] Rich Battle Panel: HP percentages, enemy species, active battle log, battle control status.
- [x] Live Collection view with IVs, Shinies highlight, natures, level, types.
- [x] Live Inventory & Wallet (coins, crystals, balls, potions).
- [x] Integrated Settings tab with live persistence to `config.json`.

## Phase 4: PyInstaller Executable (`--onedir` Dist Distribution)
- [x] Update `idledex-bot.spec` to build `--onedir` distribution in `dist/idledex-bot/`.
- [x] Include all required assets (`dashboard.html`, `visualizer.html`, default `config.json`).
- [x] Verify standalone runtime of `dist/idledex-bot/idledex-bot.exe`.

## Phase 5: Verification & Logbook
- [x] Run syntax checks and unit tests.
- [x] Verify HTTP API responses (`/state`, `/logs`, `/api/token`, `/api/config`).
- [x] Test PyInstaller build and run the executable to confirm clean boot and dashboard serving.
- [x] Record entry in Obsidian Vault `04_Logbook`.

## Phase 6: Electron Desktop App Migration (`idledex-desktop`)
- [x] Architectural alignment via `/grill-me` (pure Electron desktop app, embedded Chromium `<webview>`, split-screen cyber UI, zero duplicate sockets).
- [x] Configure `package.json` with `electron` and `electron-builder`.
- [x] Develop Main Process (`electron/main.js`) with native window, System Tray, persistent partition (`persist:idledex`), and background execution (`backgroundThrottling: false`).
- [x] Develop Webview Guest Preload (`electron/preload-game.js`) hooking `window.WebSocket`, decoding binary frames, auto-combating, roaming, and streaming telemetry to host via `sendToHost`.
- [x] Develop Dashboard Host Preload (`electron/preload-dashboard.js`) exposing secure `contextBridge` APIs.
- [x] Develop Cyber Split-Screen UI (`app/index.html`, `app/styles.css`, `app/app.js`):
  - Left column: official game loaded natively with full cookie session persistence.
  - Right column: collapsible cyber sidebar with 20x20 tactical canvas radar, live HP combat bars, KPIs, inventory, and strategy settings.
- [x] Build Portable Desktop Distribution in `dist-desktop/win-unpacked/` via `electron-builder`.
- [x] Comprehensive documentation in `README.md` and logging in Obsidian Vault `04_Logbook\Logbook.md`.

## Phase 7: Post-Login Synchronization & Preload Interception Fixes
- [x] Trace live Chromium runtime & diagnose "Posição: Aguardando..." / bot inactivity.
- [x] Implement main-process `will-attach-webview` hook in `electron/main.js` to guarantee preload injection before webview navigation begins.
- [x] Reverse-engineer full JSON protocol in game bundle: map `welcome` snapshot (`snapshot.player.team`, `inventory`, `wallet`, initial `entities` & `playerPos`).
- [x] Add authoritative JSON `state`, `entity:enter`, `entity:leave`, and `map:change` handlers to `preload-game.js`.
- [x] Reorder roam loop initialization to trigger post-`welcome` to prevent navigation desync with null player coordinates.
- [x] Recompile full distribution in `dist-desktop/win-unpacked/IdleDex Desktop.exe` with exit code 0.


