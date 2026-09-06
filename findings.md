# Findings & Reverse Engineering: idleDEX Game Bot

## 1. Context & Prior Hermes Work Analysis
- In the prior session, Hermes attempted to implement an idleDEX game bot (`bot.py`, `dashboard.html`, `economy.py`, PyInstaller spec).
- The user specifically requested:
  1. Standalone executable in `--onedir` format (`dist/idledex-bot/` directory).
  2. Intuitive and reliable token refresh flow when the session token becomes invalid.
  3. Thorough audit and correction of bugs/errors preventing bot operation.
  4. Significant usability and UI/UX improvements.
- Critical flaws identified in Hermes's delivery:
  1. **Fatal startup crash / shutdown**: If the hardcoded token expired (HTTP 401/403/4401), `main()` caught the error and shut down the HTTP dashboard server immediately. The user could never access the dashboard to enter a new token.
  2. **Ghost token banner**: `showTokenBanner()` was defined in `dashboard.html`, but NEVER invoked by any code. The banner was permanently hidden (`display:none`).
  3. **Broken JavaScript UI functions**:
     - `connect()` was called on button click, but undefined (Uncaught ReferenceError).
     - `disconnect()` was called on button click, but undefined (Uncaught ReferenceError).
     - `updateConfig()` was called by all sliders and dropdowns, but undefined (Uncaught ReferenceError).
     - `renderCollection()` was defined, but never called. Collection list was always empty.
     - `renderMap()` was a stub ("skip for now") with an empty grid.
  4. **Zero configuration persistence**: No `config.json` existed. Any token or setting submitted via the web dashboard was kept only in volatile memory and lost on restart.
  5. **Protocol desync & message format errors**:
     - IdleDex uses `{ t: "event", d: { ... } }`, not `{ type: "attack" }`.
     - Binary frame parser in `bot.py` unpacked string length as a 2-byte Uint16 (`<H`) instead of 1-byte Uint8 (`g`), corrupting binary state parsing.
     - IdleDex expects periodic `{ t: "ping" }` heartbeats every 5 seconds; lack of heartbeat results in silent server drop.
     - IdleDex supports native idle mode (`idle:start`, `idle:stop`, `idle:config`), which was unused.
     - Duplicate `Origin` header was passed in `websockets.connect` causing proxy rejection risks.
  6. **Packaging mismatch**: Hermes built a single-file executable (`--onefile`) inside `dist/idledex-bot.exe` despite the user explicitly answering *"quero no modelo pasta dist"*.

## 2. idleDEX Protocol Specifications (Directly verified from `index-C3hpUun1.js`)
- **Authentication**: `GET /api/ws-token` with session cookies (`__Secure-better-auth.session_token`). Returns `{ "token": "...", "shard": 0 }`.
- **WebSocket Endpoint**: `wss://idledex.com${shard > 0 ? '/ws/' + shard : '/ws'}?token=${token}&v=5`.
- **Heartbeat**: Ping every 5,000ms: `{ "t": "ping" }`.
- **Command Envelope**: Outgoing messages use `{ "t": "<event>", "d": { ... } }`.
- **Key Actions**:
  - `idle:start`, `idle:stop`, `idle:config`
  - `battle:move`, `battle:item`, `battle:flee`, `battle:switch`
  - `capture:throw` with `{ ballId: "..." }`
  - `daily:claim`, `pokedex:claim-all`, `gamepass:claim-all`
- **Key Incoming Events**:
  - `battle:turn`, `battle:timeline`, `battle:control`, `battle:end`
  - `inventory`, `team`, `team:patch`, `wallet`, `progress:state`
  - `daily:list`, `market:listings`, `market:priceStats`
  - Binary frames: magic byte `0x01`, tick (Uint32 LE), flags (Uint8), ack (optional Uint32 LE), entity count (Uint16 LE), entities with 1-byte length prefix UTF-8 name and optional coords/dir.

## 3. Root Cause of Game Disconnection ("Desloga Automaticamente")
- When the user runs an external Python script with the game's session token, the Python client opens a new WebSocket connection to `wss://idledex.com/ws?token=...`.
- The IdleDex backend enforces a strict **Single Active Connection** policy per account. When the new connection arrives, the server closes the older connection with close code `4001` or `4401`.
- In the browser client (`index-C3hpUun1.js`), the WebSocket close handler executes:
  ```javascript
  onAuthFail: a => {
      authClient.signOut();
      A.setState({ phase: "login" });
  }
  ```
- This triggers `authClient.signOut()`, which calls the backend Better-Auth `/api/auth/sign-out` endpoint. The server promptly destroys the session cookie in the database, logging the user completely out of the game!

## 4. The Electron Desktop Solution (`idledex-desktop`)
- By wrapping the application in an Electron desktop application:
  1. The game (`https://idledex.com/play`) runs in an embedded Chromium `<webview>` with persistent session partition (`persist:idledex`).
  2. The user logs in normally inside Chromium once; cookies remain persisted.
  3. No second WebSocket connection is ever created. The bot injects via `<webview>` preload (`preload-game.js`) directly into the official webpage's `window.WebSocket`.
  4. The bot reads game telemetry (binary map frames, battle states, inventory) and executes actions (combat, roaming, catching, auto-idle) through the **exact same WebSocket connection** that the game is already using.
  5. The host window (`index.html` + `app.js`) provides a retractable cyber dashboard (20x20 tactical radar, live combat HP bars, trainer telemetry, and strategy configuration) communicating with the guest game view via Chromium IPC (`sendToHost` / `ipc-message`).
  6. `backgroundThrottling: false` prevents Chromium from putting timers and WebSockets to sleep when the window is minimized or running in the System Tray.

## 5. Root Cause of Post-Login Bot Inactivity & State Synchronization
- **Issue**: After login in the desktop app, the bot appeared completely idle, with "Posição: Aguardando..." on the radar, "Aguardando telemetria de mapa...", empty trainer stats, and no actions executed.
- **Root Causes Discovered**:
  1. **Preload Attachment Timing & Race Conditions**: Setting `<webview>.preload` dynamically via client-side JavaScript in `app.js` can race with Chromium's initial navigation. Solution: Bound `will-attach-webview` in the Electron Main process (`main.js`) before window creation, enforcing `webPreferences.preload = gamePreload` directly at the Chromium engine level.
  2. **Reliance Exclusively on Binary Frames**: The bot previously parsed map entities and player position only through binary frames (`0x01`). However, IdleDex transmits the authoritative initial game state inside the JSON `welcome` packet (`e.d.snapshot`) and incremental entity deltas inside JSON `state`, `entity:enter`, and `entity:leave` events.
  3. **Missing Snapshot Extraction**: The `welcome` packet carries `e.d.snapshot.entities` (initial entity list with coordinates), `e.d.snapshot.player.team` (active Pokémon and stats), `e.d.snapshot.player.wallet` (coins and crystals), and `e.d.snapshot.player.inventory` (balls and potions). Without extracting these, the dashboard remained unpopulated until auxiliary events fired.
  4. **Premature Roam Loop**: Starting the roam loop on `ws.open` before the `welcome` packet was received caused movement commands to be sent with `playerPos.x === null`, desyncing the navigation before the player was spawned on the map. Moving `startRoamLoop()` to post-`welcome` ensures accurate position tracking and nearest-enemy calculations.

## 6. Reverse Engineering: Map Grass Collision & Battle Envelopes
- **Map Collision & Tall Grass**:
  - Map data is loaded by the official client from `/maps/${mapId}.collision.json`.
  - The grid is a flat array of dimensions `cols * rows` where:
    - `1 = Grass` (`l_.Grass` in bundle): tiles where wild Pokémon encounters occur.
    - `2 = Path` (`l_.Path` in bundle): standard walkable tiles without encounters.
    - Other values: blocked obstacles, walls, or water.
  - By loading this JSON matrix in `preload-game.js`, the bot accurately detects whether the player is in tall grass (`isGrass`), navigates straight to the nearest grass patch, and patrols exclusively within encounter tiles.
- **Battle Protocol & `bad_message` Error Root Cause**:
  - The IdleDex server requires explicit contextual identifiers in all battle action envelopes:
    - Attack: `{ t: "battle:move", d: { battleId: string, moveId: string } }`
    - Items (Balls & Potions): `{ t: "battle:item", d: { battleId: string, itemId: string } }`
    - Tactical Flee: `{ t: "battle:flee", d: { battleId: string } }`
  - Sending `{ t: "battle:move", d: { moveIndex: 0 } }` or commands without `battleId` causes the server to reject the packet with `[server] bad_message undefined`.
  - Captures in battle use `battle:item` with the active `battleId` rather than `capture:throw`.
  - Pausing the bot now flushes any pending turn timers and roam intervals, eliminating out-of-order residual commands.

## 7. Reverse Engineering: Dual-Dispatch Combat & BFS Grass Pathfinding
- **Battle Start Interaction Discovery**:
  - In wild battles, the IdleDex client renders the duel HUD (`hud-throw-bar`) immediately upon `battle:start` if `e.d.interactive === true`. It does NOT wait for `battle:turn`.
  - Player moves reside inside `e.d.leader.moves` (`[{ id: "scratch", name: "Scratch", power: 40, ... }, ...]`), not `e.d.leaderMoves`.
  - Waiting only for `battle:turn` left the bot frozen on turn 1 waiting for an event that only fires after the player's first action.
- **Dual-Dispatch DOM + WebSocket Execution**:
  - The duel HUD renders real `<button class="hud-duel-move" data-move-id="...">` elements for attacks and `<button class="hud-throw-ball" data-item-id="...">` for items/balls.
  - By performing a DOM `.click()` on the matching button, React's state transitions, animations play, and internal handlers execute.
  - Simultaneously sending the authoritative `{ t: "battle:move", d: { battleId, moveId } }` packet guarantees instantaneous server synchronization with zero desync.
  - The previous fallback `{ moveIndex: 0 }` was rejected by the server as `bad_message undefined` because the server strictly requires `moveId`.
- **BFS Grass Navigation vs Entity Chasing**:
  - Previously, the bot chased entities containing `:` in their ID, erroneously treating players, NPCs, and map signs as enemies, causing it to roam away from grass.
  - Wild encounters in IdleDex ONLY occur when walking inside tall grass (`grid[y * cols + x] === 1`).
  - Implemented a 4,000-node Breadth-First Search (BFS) on the collision grid (`route_001` has 540 grass tiles across 150x150). From any path tile, BFS computes the exact shortest sequence of walkable moves (`isWalkable: 1 || 2`) to the nearest grass tile in under 2ms, avoiding all fences and obstacles.
  - Inside grass (`isGrass === true`), the bot paces back and forth between adjacent grass tiles, maximizing wild battle encounters.
- **Elimination of Toast Spam ("Nenhum marco pronto para resgatar")**:
  - Traced to automatic `pokedex:claim-all` and `gamepass:claim-all` packets sent on `welcome` and `battle:end`. Stripping these automatic calls completely eliminated the unwanted notification toast.

## 8. Reverse Engineering: Complete Mechanics & Granular Variable Control Matrix (Phase 11)
- **Deep Item Catalog & Formulas in Production Bundle (`index-C3hpUun1.js`)**:
  - **Pokéballs & Multipliers (`soe` object)**:
    - `poke-ball`: 1x multiplier.
    - `great-ball` / `super-ball`: 2x multiplier.
    - `ultra-ball`: 4x multiplier.
    - `master-ball`: 100x multiplier (100% guaranteed catch).
  - **Potions & Healing**:
    - `potion`: Restores 20 HP.
    - `super-potion`: Restores 50 HP.
    - `hyper-potion`: Restores 200 HP.
    - `max-potion`: Restores 100% of max HP.
  - **Revives**:
    - `revive`: Restores fainted Pokémon with 50% HP (`ratioPct: 50`).
    - `max-revive`: Restores fainted Pokémon with 100% HP (`ratioPct: 100`).
- **Complete Action Packet Schemas**:
  - Combat items: `{ t: "battle:item", d: { battleId: string, itemId: string } }` (both balls, potions, and revives during combat if permitted by `canThrow`, `canHeal`, `canRevive`).
  - Combat switch: `{ t: "battle:switch", d: { battleId: string, creatureId: string } }`.
  - Out-of-combat item usage: `{ t: "item:use", d: { itemId: string, creatureId: string, quantity: number } }` (used to revive or heal party members between encounters).
  - Pokémon Center / Nurse Joy Full Heal: `{ t: "heal:full", d: { creatureIds: string[] } }` (heals team members by paying silver or free for novice ranks).
- **Elemental Move Advantage**:
  - Moves contain `id`, `name`, `type`, `power`, and `category`.
  - Integrated full Gen 1-9 type effectiveness chart (`TYPE_CHART`), enabling the bot to multiply move power by 2x for Super Effective advantages and 0.5x for resistances.
- **Granular Control Architecture**:
  - Exposed every critical operational variable directly in the UI dashboard and persisted via `config.py` / `config.json`:
    - Move selection modes (`smart`, `max_damage`, `first`).
    - Tactical flee threshold (`flee_hp_pct`).
    - Capture threshold (`catch_hp_pct`), priority modes (`balanced`, `economy`, `force_highest`), and species filters (`catch_only_shiny`, `catch_only_uncaught`).
    - Potion healing threshold (`potion_hp_pct`) and selection mode (`smart` deficit-based vs fixed tier).
    - In-battle and overworld Revive toggles (`use_revive_battle`, `use_revive_overworld`).
    - Pokémon Center auto-heal toggle (`auto_heal_center`).
    - Movement step delay (`roam_step_delay_ms`).

## 9. Reverse Engineering: Area Spawns Whitelist, Tactical XP/Flee Engine & IV/Nature Mechanics (Phase 12)
- **User-Calibrated Formulas**:
  - `super-ball` / `great-ball`: Set to **3x** multiplier (increased from base 2x).
  - `super-potion`: Restores **60 HP** (fixed).
  - `hyper-potion`: Restores **120 HP** (fixed).
  - Deficit-based smart healing updated:
    - Deficit < 35 HP $\rightarrow$ `potion` (20 HP).
    - 35 HP $\le$ Deficit < 90 HP $\rightarrow$ `super-potion` (60 HP).
    - 90 HP $\le$ Deficit < 250 HP $\rightarrow$ `hyper-potion` (120 HP).
    - Deficit $\ge$ 250 HP $\rightarrow$ `max-potion` (100%).
- **Current Map & Dynamic Spawn Discovery**:
  - Mapped all 150 official route names (`mte` dictionary in bundle) and friendly zone names (`fte` dictionary) into `ROUTE_NAMES` and `MAP_NAMES`.
  - The client automatically queries the server with `{ t: "map:preview", d: { mapId } }` upon entering any map or on `welcome`.
  - The server responds with `{ t: "map:preview", d: { mapId, creatures: [...] } }`, returning the list of available species for that route with `{ speciesId, name, minLevel, maxLevel, frequency, caught, seen }`.
  - The bot intercepts this payload and renders a live interactive species checklist on the Radar panel with route friendly names (e.g., "Rota 1 — Floresta Nascente").
- **Area Target Whitelist & Tactical Behavior Selector**:
  - Config parameters added: `target_species: string[]` and `unselected_action: "flee" | "battle"`.
  - If the wild Pokémon encountered is marked in the whitelist:
    - The bot executes normal capture logic (lowering HP and throwing balls).
  - If the wild Pokémon is NOT in the whitelist:
    - If `unselected_action === "flee"`: The bot immediately sends `{ t: "battle:flee", d: { battleId } }` and clicks the Flee button, preserving balls and time.
    - If `unselected_action === "battle"`: The bot battles normally with maximum damage attack to knock out the wild Pokémon and farm XP, ignoring capture thresholds.
- **Server-Side IV & Nature Concealment Architecture (Anti-Sniffer / Anti-Cheat)**:
  - Deep inspection of `index-C3hpUun1.js` (specifically classes `mr`, `Fr`, `mc`, `replays`, and socket handlers):
    - In `battle:start`, the foe creature object strictly delivers: `{ name, speciesId, level, hp, maxHp, isShiny, rarity, eventTier, creatureId, formSpeciesId, formSuffix, mega }`.
    - IVs (`ivs`), Nature (`nature`), EVs, and base offensive/defensive stats are **deliberately omitted** from incoming packets during battle. The server computes damage and RNG server-side.
    - **Conclusion**: It is technically impossible for any external bot or packet sniffer to know the wild Pokémon's IVs or Nature before throwing the ball, as this data does not exist in the client memory until captured.
- **Instant Post-Capture Evaluation Engine & Gen 1 to Gen 5 Competitive Database**:
  - Immediately upon capture (`battle:end` with `result === "capture"`), the server sends the full creature record in `e.d.caught` containing `{ nature, ivs: { hp, atk, def, spa, spd, spe } }`.
  - Created a comprehensive competitive database of 648 species across Gen 1 to Gen 5 (Kanto, Johto, Hoenn, Sinnoh, Unova) based on Smogon/VGC competitive tier lists, mapping each species to its optimal natures (e.g., Pikachu: Timid/Hasty; Gengar: Timid/Modest; Tyranitar: Adamant/Jolly; Garchomp: Jolly/Adamant).
  - Integrated `evaluateCapturedCreature()` in `preload-game.js`:
    - Sums all 6 IV stats (max 186).
    - Calculates IV percentage (`(total / 186) * 100`).
    - Cross-references nature with the competitive optimal list.
    - Assigns an empirical letter grade:
      - **S**: IV $\ge$ 85% + Optimal Nature.
      - **A**: IV $\ge$ 75% OR Optimal Nature.
      - **B**: IV $\ge$ 60%.
      - **C**: IV < 60%.
    - Emits live desktop telemetry and chat notification with detailed stats (e.g. `[CAPTURA] Gengar Nv.32 capturado! IVs: 165/186 (88.7%) | Nature: Timid (⭐ ÓTIMA) | Nota: S`).


