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

