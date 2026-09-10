# ⚡ IdleDex Desktop Suite — Autonomous Automation & Intelligence Platform

[![Electron](https://img.shields.io/badge/Electron-33.4.11-47848F?logo=electron&logoColor=white)](https://www.electronjs.org/)
[![Node.js](https://img.shields.io/badge/Node.js->=18.0-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![JavaScript](https://img.shields.io/badge/JavaScript-ES2022-F7DF1E?logo=javascript&logoColor=black)](https://developer.mozilla.org/)
[![Playwright](https://img.shields.io/badge/Playwright-Tested-2EAD33?logo=playwright&logoColor=white)](https://playwright.dev/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Build](https://img.shields.io/badge/Build-Portable%20Standalone%20x64-blue?logo=windows&logoColor=white)](https://github.com/lucasantannaeng)

> **Enterprise-grade automation client and real-time game telemetry dashboard for [IdleDex](https://idledex.com/play), featuring zero-injection native WebSocket stream interception, autonomous roaming, battle engine, Pokédex completion analysis, and complete local session isolation.**

---

## 🌟 Overview

**IdleDex Desktop Suite** is a dedicated, zero-external-dependency automation client and operational dashboard engineered for the browser MMORPG *IdleDex*. Built upon Electron 33 with native multi-partition sandbox isolation, it provides seamless, human-like automation while intercepting live WebSocket frames directly in-memory — eliminating any need for browser extensions, external Python runtimes, memory injection, or manual cookie extraction.

Designed from the ground up to respect true game mechanics, IdleDex Desktop combines intelligent heuristic pathfinding, IV calculation, dynamic ball economy management, and autonomous NPC delivery routines into an elegant, high-density dark interface.

---

## 🚀 Key Features

* 🎮 **Zero-Injection WebSocket Interception**: Intercepts official game protocol messages (`welcome`, `spawn`, `battle`, `party`, `inventory`, `area_pokedex`) via in-memory preload hooks without modifying game bytecode or client source files.
* 🧭 **Intelligent Roaming & Grass Navigation**: Autonomous movement loop using real client movement sequences, collision-aware boundary checks, and intelligent wild grass detection.
* ⚔️ **Smart Combat & Capture Engine**:
  * Prioritizes captures based on missing Pokédex entries, shiny/golden rarity, high IV thresholds, or custom player watchlists.
  * Ball tier hierarchy management (Pokéball ➔ Great Ball ➔ Ultra Ball ➔ Master Ball) based on target rarity and current server allowances.
  * Damage optimization selecting super-effective moves while holding back lethal hits on high-value catch targets.
* 🏥 **Autonomous Recovery & Center Healing**: Continuous HP/PP telemetry with automatic potion application and smart Pokémon Center travel before team faints.
* 🔬 **Laboratory Auto-Travel & NPC Deliveries**: Evaluates Box excess, travels autonomously to Professor Oak's lab when batches are ready, completes research deliveries, and returns to hunting routes without human intervention.
* 📊 **Live Radar & Telemetry Dashboard**: Real-time HUD showing wild spawns, team vitals, capture rates, gold/dust hourly yields, and active route Pokédex completion percentages.
* 🔒 **Anti-Leak & Complete Session Isolation**: Credentials, OAuth tokens, and cookies are stored exclusively in the user's local operating system profile (`%APPDATA%`). The compiled `.exe` contains zero personal data and can be safely shared.
* 🎨 **Master Ball Identity & Dark Aesthetic**: Custom high-resolution Master Ball visual branding across application icons, multi-tier `.ico` assets, system tray, and Vercel/Linear-inspired dark UI.

---

## 🏗️ Architecture & Security Model

```text
idledex-bot/
├── app/                        # High-density Desktop UI
│   ├── index.html              # Main dashboard HUD & config panels
│   ├── app.js                  # UI state management, radar canvas & IPC bridge
│   ├── styles.css              # Linear/Vercel dark premium design system
│   └── icon.png                # Master Ball raster asset (512x512)
├── electron/                   # Electron Runtime & Sandboxing
│   ├── main.js                 # Window lifecycle, secure partition & atomic config
│   ├── preload-game.js         # In-memory WebSocket tap & bot decision engine
│   └── tray-icon.png           # System tray icon (32x32)
├── build/                      # Build Resources & Packaging Artifacts
│   ├── icon.ico                # Multi-resolution Windows icon (16px - 256px)
│   └── icon.png                # Source branding icon (512x512)
├── tests/                      # Automated Regression & Verification Suites
│   ├── regression-suite.js     # Protocol & combat engine regression tests
│   └── smoke-electron.js       # Playwright-driven Electron launch verification
├── research/                   # Reverse Engineering & Protocol Specifications
│   ├── 2026-09-08-audit.md     # WebSocket protocol schemas and contracts
│   └── 2026-09-09-usability.md # UX heuristics and delivery cycle audits
├── dist-release/               # Compiled Portable Binaries (Git-Ignored)
│   └── IdleDex_Desktop_Portable_2.5.0.exe
├── package.json                # Project manifest & electron-builder configuration
└── README.md                   # Technical documentation
```

### Security & Privacy Architecture
* **Strict Credential Partitioning**: The application uses Electron's isolated partition (`persist:idledex`). Google OAuth and session tokens are held by Chromium in local DPAPI-encrypted storage (`%APPDATA%/idledex-bot`).
* **Zero Credential Bundling**: When compiling or sharing the portable `.exe`, **no session data or credentials are included**. A recipient launching the executable begins with a pristine, unauthenticated session.
* **Atomic Configuration**: Player settings are stored locally in `bot-config.json` via write-to-temp and atomic rename, eliminating corruption risk during unexpected power loss.

---

## ⚙️ Game Mechanics & Engine Multipliers

The combat and decision engine strictly adheres to verified official server-side rules:

| Domain | Rule / Multiplier | Engine Behavior |
| :--- | :--- | :--- |
| **Capture Logic** | Exact HP % Thresholds | Arremessos aguardam confirmação do servidor (`catch_result`); nunca dispara comandos em spam. |
| **Ball Hierarchy** | Pokéball ➔ Great ➔ Ultra ➔ Master | Alterna automaticamente para esferas superiores se o alvo for Shiny ou lendário. |
| **IV Filtering** | 6 IVs Totais (0-186 scale) | Avaliação rigorosa: criaturas com IVs inferiores ao piso configurado são marcadas para liberação/NPC. |
| **Proteção de Caixa** | Equipe + Locks + Shinies + Eventos | Protegidos contra liberação acidental; descarte desativado se o limite for zero. |
| **Auto-Viagem Lab** | Lotes válidos de excedentes | Só viaja se houver lotes completos e cargas disponíveis com o Professor. |

---

## ⚡ Getting Started

### Option A: Portable Standalone Executable (Recommended for End Users)
1. Baixe o executável compilado `IdleDex_Desktop_Portable_2.5.0.exe` (com o ícone da **Master Ball**).
2. Execute o arquivo diretamente em qualquer computador com Windows 10/11 x64 (não requer instalação de Node.js, Python ou extensões).
3. Faça login normalmente na sua conta IdleDex pela janela embutida.
4. Ajuste suas preferências no painel lateral, clique em **Salvar Configurações** e ative o botão **Ligar Bot**.

### Option B: Running from Source (Developers)

#### Prerequisites
* Node.js `>= 18.0.0`
* npm `>= 9.0.0`

#### Installation & Development
```bash
# Clone the repository
git clone https://github.com/lucasantannaeng/idledex-bot.git
cd idledex-bot

# Install dependencies
npm ci

# Run test suites
npm test

# Launch in development mode
npm start

# Launch with Chrome DevTools Protocol diagnostics enabled (port 9222)
npm start -- --inspect-bot
```

#### Compiling the Portable Executable
```bash
# Build standalone single-file portable .exe
npm run dist:portable
```
O executável gerado estará disponível em `dist-release/IdleDex_Desktop_Portable_2.5.0.exe`.

---

## 🧪 Testing & Verification

O projeto conta com suítes automatizadas de testes cobrindo integridade de empacotamento, regressão de protocolo e ciclo de vida Electron:

```bash
# Run all automated tests
npm test

# Run regression test suite directly
node tests/regression-suite.js

# Run Playwright Electron smoke test
node tests/smoke-electron.js
```

---

## 📄 License & Credits

This project is licensed under the **MIT License** — see the [LICENSE](LICENSE) file for details.

*Disclaimer: IdleDex is a trademark of its respective creators. This software is an independent educational automation tool.*
