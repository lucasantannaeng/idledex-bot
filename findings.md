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
