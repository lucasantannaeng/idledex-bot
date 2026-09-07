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

## Phase 8: Grass Navigation, Battle Envelopes & Pause Hygiene
- [x] Reverse-engineer collision map format (`.collision.json` with `Grass: 1` and `Path: 2`).
- [x] Ingest map collision data in `preload-game.js` via `loadMapCollision()`.
- [x] Implement smart navigation: hunt visible enemies, navigate to nearest grass patch, and patrol strictly within grass.
- [x] Reverse-engineer battle envelopes in game bundle: map `battleId`, `battle:move`, `battle:item`, `battle:flee`.
- [x] Implement smart move selection with capture protection (avoid killing capture targets).
- [x] Implement hierarchical ball throwing (`ultra-ball`, `great-ball`, `poke-ball`) via `battle:item`.
- [x] Clean pause: cancel roam and battle timers on pause, flush state, and eliminate `bad_message undefined`.
- [x] Recompile full distribution in `dist-desktop/win-unpacked/IdleDex Desktop.exe` with exit code 0.

## Phase 9: Battle Dual-Dispatch, BFS Grass Pathfinding & Anti-Spam
- [x] Remove automatic `pokedex:claim-all` and `gamepass:claim-all` to eliminate "Nenhum marco pronto para resgatar" toast spam.
- [x] Implement dual-dispatch combat engine: extract moves from `d.leader.moves` on `battle:start`, perform DOM button click (`button[data-move-id]`, `.hud-duel-move`) + authoritative WebSocket packet (`battle:move` with valid `moveId`).
- [x] Eliminate `moveIndex: 0` fallback that triggered server `bad_message undefined`.
- [x] Add combat watchdog interval (600ms) to ensure actions trigger immediately when duel UI opens.
- [x] Implement BFS pathfinding algorithm on 150x150 map collision grid to navigate directly to nearest grass patch from any location without getting stuck on fences or obstacles.
- [x] Enforce alternating grass patrol within tall grass tiles to maximize wild encounters.
- [x] Fix unpause state transition to never send movement packets while in battle.
- [x] Recompile portable executable in `dist-desktop/win-unpacked/IdleDex Desktop.exe` with exit code 0.

## Phase 10: Multiplayer Isolation, Keyboard Input Integration & Unfreezing
- [x] Diagnose multiplayer battle broadcast crosstalk in IdleDex server architecture (`index-C3hpUun1.js` line 79 `ha(r)`).
- [x] Implement strict battle ownership filter `isMyBattle(d)` in `preload-game.js` (`d.ownerId === playerId || d.foeOwnerId === playerId`).
- [x] Filter all combat events (`battle:turn`, `battle:control`, `battle:end`) strictly by active `currentBattleId` to ignore foreign battles, defeats, and captures.
- [x] Integrate native KeyboardEvent simulation (`window.dispatchEvent`) matching the game's `w1e` keyboard controller (`ArrowUp`/`ArrowDown`/`ArrowLeft`/`ArrowRight`), executing local client prediction, camera follow, and sprite movement.
- [x] Restrict entity enemy detection to `wild:` or `foe:` prefixes, preventing the bot from targeting other human players (`user:`).
- [x] Validate isolation and BFS engine with unit test suites (`scratch/test_engine.js` and `scratch/test_isolation.js`).
- [x] Recompile full portable desktop distribution in `dist-desktop/win-unpacked/IdleDex Desktop.exe` with exit code 0.

## Phase 11: Deep Reverse Engineering & Full Variable Control Matrix
- [x] Download and reverse engineer the complete production bundle (`index-C3hpUun1.js`), extracting all item definitions, multipliers, formulas, and schemas.
- [x] Reverse engineer ball capture multipliers (`soe` table: Poke 1x, Great 2x, Ultra 4x, Master 100x).
- [x] Reverse engineer potion healing values (`potion` 20, `super-potion` 50, `hyper-potion` 200, `max-potion` 100%) and smart deficit escalation algorithm.
- [x] Reverse engineer revives (`revive` 50% HP, `max-revive` 100% HP) for in-battle duel items and overworld `item:use`.
- [x] Reverse engineer Pokémon Center / Nurse Joy auto-heal protocol (`heal:full` with `{ creatureIds }`).
- [x] Implement elemental type effectiveness chart (`TYPE_CHART`) for smart move selection with weakness exploitation (2x) and resistance avoidance.
- [x] Expand `config.py` with granular parameters (`potion_mode`, `use_revive_battle`, `use_revive_overworld`, `auto_heal_center`, `catch_only_shiny`, `catch_only_uncaught`, `ball_priority`, `move_selection_mode`, `roam_step_delay_ms`).
- [x] Update `preload-game.js` with comprehensive decision tree and full inventory cataloging (balls, potions, revives).
- [x] Redesign UI settings panel (`app/index.html`, `app/styles.css`, `app/app.js`) into 4 dedicated sections (Combate, Captura, Poções & Revive, Mapa & Economia) with expanded inventory KPI grid.
- [x] Develop automated test suite (`scratch/test_decision_suite.js`) verifying all 4 decision domains with exit code 0.
- [x] Recompile portable desktop application in `dist-desktop/win-unpacked/IdleDex Desktop.exe` with exit code 0.

## Phase 12: Area Spawns Whitelist, Tactical XP/Flee Engine, IV/Nature Evaluation & Formula Calibration (v2.2)
- [x] Apply user-requested formula corrections:
  - Super Ball / Great Ball multiplier updated to 3x.
  - Super Potion healing calibrated to fixed 60 HP.
  - Hyper Potion healing calibrated to fixed 120 HP.
  - Recalibrate smart deficit escalation thresholds in `preload-game.js`.
- [x] Reverse engineer map routes & friendly names:
  - Extract all 150 official route names (`mte`) and special zone maps (`fte`) into `scratch/routes.json`.
  - Implement `ROUTE_NAMES`, `MAP_NAMES`, and `getMapFriendlyName(mapId)` in `preload-game.js`.
- [x] Implement dynamic area spawn discovery:
  - Automatically query `{ t: "map:preview", d: { mapId } }` on map transition and `welcome`.
  - Intercept server response and stream available wild species array to desktop dashboard.
- [x] Implement Area Target Whitelist & Tactical Behavior Engine:
  - Add `target_species: string[]`, `unselected_action: "flee" | "battle"`, and `min_iv_alert` to `config.py` and `electron/main.js`.
  - Whitelist mode: if wild Pokémon is in target list, execute capture logic.
  - If unselected and `unselected_action === "flee"`: immediately execute `{ t: "battle:flee" }` and click Flee button.
  - If unselected and `unselected_action === "battle"`: fight with maximum damage attack to knock out foe and farm XP.
- [x] Reverse engineer wild IV/Nature mechanics:
  - Prove server-side omission of IVs and Nature during wild encounters (`battle:start`) to prevent sniffer cheats.
  - Identify post-capture payload in `battle:end` (`e.d.caught` with full `nature` and `ivs: { hp, atk, def, spa, spd, spe }`).
- [x] Implement Competitive Nature Database & Post-Capture IV/Nature Evaluation Engine:
  - Compile 648 species across Gen 1 to Gen 5 (Kanto, Johto, Hoenn, Sinnoh, Unova) with optimal competitive natures (`scratch/best_natures.json`).
  - Calculate total IV sum (/186), IV percentage, check optimal nature, and assign letter grade (S, A, B, C).
  - Stream evaluation immediately to Desktop UI and chat log upon capture.
- [x] Redesign Desktop UI (`app/index.html`, `app/app.js`):
  - Add "📍 Spawns da Área" card in Radar panel with route badge, unselected action selector, and interactive species checklist with "Marcar Todos" / "Desmarcar" buttons.
  - Add "🎯 Avaliação da Última Captura" card in Combat panel displaying IV sum, percentage, nature badge, and letter grade.
  - Update Potion descriptions to +60 HP and +120 HP, and Super Ball to 3x in Config panel.
- [x] Verify implementation:
  - Run comprehensive automated test suite (`scratch/test_v22_suite.js`) passing 100% with exit code 0.
- [x] Package portable standalone distribution:
  - Recompile `dist-desktop/win-unpacked/IdleDex Desktop.exe` via `npm run pack`.

## Phase 13: Systematic Debugging — Single Dispatch Engine, Takeover Immunity & Throw Bar Synchronization (v2.2.1)
- [x] Diagnose root cause of `[Jogo] [server] bad_message undefined`:
  - Identified dual-dispatch race condition: DOM `.click()` triggered internal React `F.emit` $\rightarrow$ WebSocket, followed immediately by secondary `sendEvent`.
  - Identified watchdog polling desync: actions re-dispatched during animation phase without in-flight lock.
  - Identified premature execution at `battle:start` before the throw window opened.
- [x] Diagnose root cause of "miss click opening game options":
  - Traced to un-scoped `.hud-duel-move` selector matching `<button class="hud-duel-move hud-throw-takeover">`.
  - Clicking this button opened the Premium Gamepass modal when in auto or takeover state.
- [x] Diagnose capture and item failure:
  - Traced to state flags not resetting on battle start, items rendered with `.hud-throw-ball` class for both balls and potions, and secondary packet sends when buttons were disabled on server.
- [x] Implement single dispatch engine (`executeBattleAction`):
  - Ensures exactly ONE action per turn (DOM click IF enabled, OR single WebSocket packet IF element is absent/headless). Never both.
- [x] Implement in-flight turn lock (`actionInFlight` and `lastTurnNumber`):
  - Prevents watchdog or timer from firing duplicate actions while animations or turns are in progress.
- [x] Implement throw bar state guard (`isThrowBarOpen`):
  - Verifies `data-open` attribute and confirms `.hud-duel-waiting` is absent before allowing any action dispatch.
- [x] Implement strict move selector and takeover immunity:
  - Scoped strictly inside `.hud-duel-moves` and excludes `.hud-throw-takeover`.
- [x] Filter console log messages in `app/app.js`:
  - Suppressed harmless internal codes (`bad_message`, `in_battle_move`, `chat_empty`) matching official client logic.
- [x] Create regression test suite (`scratch/test_battle_engine_fix.js`):
  - Validated takeover immunity, in-flight locking, and turn reset passing with exit code 0.
- [x] Recompile portable standalone distribution:
  - Recompiled `dist-desktop/win-unpacked/IdleDex Desktop.exe` via `npm run pack`.

## Phase 14: Economic Alignment, Official creature:release Protocol & Zero-Ball Strategy (v2.3)
- [x] Complete forensic audit of bot codebase vs official bundle (`index-C3hpUun1.js`):
  - Discovered and eliminated ghost command `inventory:list` in `battle:end`.
  - Discovered and eliminated ghost command `market:sell` in monetize strategy.
  - Reverse-engineered official discard protocol: `{ t: "creature:release", d: { creatureIds: string[] } }`.
- [x] Align wallet currency structure:
  - Updated snapshot parsing and `wallet` event to ingest `silver` (Prata) and `gold` (Ouro) accurately.
  - Updated UI dashboard cards to "Prata" and "Ouro" with faithful locale formatting.
- [x] Implement safe low-IV discard engine via `creature:release`:
  - Added strict safety gates: never release Shinies (`isShiny`), rare event tiers (`eventTier > 0`), or favorited/locked monsters (`isLocked`).
  - Added configurable threshold slider `discard_iv_pct` (default 50%).
  - Added duplicate release protection via `releasedCreatureIds` Set.
- [x] Implement tactical zero-ball inventory management:
  - In combat: if out of balls and foe was target, either switch to XP battle (with max damage attacks) if `unselected_action === "battle"`, or flee if `unselected_action === "flee"`.
  - In roaming: if out of balls and `unselected_action === "flee"`, auto-pause roam loop and bot (`pause_on_no_balls: true`).
- [x] Configuration persistence & UI:
  - Added `discard_iv_pct: 50` and `pause_on_no_balls: true` to `config.py`, `electron/main.js`, `app/index.html`, and `app/app.js`.
- [x] Verification & Automated Tests:
  - Created and executed `scratch/test_economy_v23_suite.js` (static audit, wallet ingestion, safety filters, zero-ball behavior) passing with exit code 0.
  - Ran full regression suites `scratch/test_battle_engine_fix.js` and `scratch/test_v22_suite.js` with exit code 0.
- [x] Standalone distribution packaging:
  - Recompiled standalone executable `dist-desktop/win-unpacked/IdleDex Desktop.exe` via `npm run pack`.
