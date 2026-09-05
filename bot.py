"""
idleDEX Game Bot & Management Dashboard
Autonomous background runner with real-time web telemetry and control.
"""

import asyncio
import json
import logging
import os
import struct
import sys
import threading
import time
from datetime import datetime
from typing import Any, Dict, List, Optional
from http.server import HTTPServer, BaseHTTPRequestHandler

import aiohttp
import websockets
import websockets.exceptions

from config import BotConfig, clean_session_token, get_app_dir
from economy import EconomyMonitor

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("idledex_bot")

# Global pointers for HTTP Dashboard
current_bot: Optional["IdleDexBot"] = None
bot_logs: List[Dict[str, str]] = []


def resolve_resource(filename: str) -> str:
    """Find bundled assets in PyInstaller onedir/onefile or source directory."""
    if getattr(sys, "frozen", False):
        # In PyInstaller, check internal _MEIPASS, then the exe folder
        if hasattr(sys, "_MEIPASS"):
            candidate = os.path.join(sys._MEIPASS, filename)
            if os.path.exists(candidate):
                return candidate
        exe_dir = os.path.dirname(sys.executable)
        candidate = os.path.join(exe_dir, filename)
        if os.path.exists(candidate):
            return candidate
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), filename)


def log_event(message: str, level: str = "info") -> None:
    """Append event to in-memory dashboard log buffer."""
    now_str = datetime.now().strftime("%H:%M:%S")
    entry = {"time": now_str, "level": level, "message": message}
    bot_logs.append(entry)
    if len(bot_logs) > 500:
        bot_logs.pop(0)
    if level == "error":
        log.error(message)
    elif level == "warning":
        log.warning(message)
    else:
        log.info(message)


# ============================================================================
# PROTOCOL DEFINITIONS & BINARY PARSER
# ============================================================================
MAGIC_BYTE = 0x01
FLAG_HAS_ACK = 0x01
FLAG_TELEPORT = 0x02
FLAG_HAS_X = 0x01
FLAG_HAS_Y = 0x02
FLAG_HAS_DIR = 0x04


def parse_binary_frame(data: bytes) -> Optional[dict]:
    """
    Parse native IdleDex binary state frame with exact protocol alignment:
    - 0x01 magic byte
    - tick (Uint32 LE)
    - flags byte (ack, teleport)
    - optional ack (Uint32 LE)
    - entity count (Uint16 LE)
    - entities: flags (Uint8), string length (Uint8), UTF-8 id/name, optional x (Uint16), y (Uint16), dir (Uint8)
    """
    if len(data) < 1 or data[0] != MAGIC_BYTE:
        return None
    try:
        offset = 1
        tick = struct.unpack_from("<I", data, offset)[0]
        offset += 4
        flags = data[offset]
        offset += 1
        ack = None
        if flags & FLAG_HAS_ACK:
            if offset + 4 > len(data):
                return None
            ack = struct.unpack_from("<I", data, offset)[0]
            offset += 4

        teleport = bool(flags & FLAG_TELEPORT)
        if offset + 2 > len(data):
            return None
        entity_count = struct.unpack_from("<H", data, offset)[0]
        offset += 2

        entities = []
        for _ in range(entity_count):
            if offset + 2 > len(data):
                break
            f = data[offset]
            g = data[offset + 1]  # 1-byte length of string
            offset += 2
            if offset + g > len(data):
                break
            name = data[offset : offset + g].decode("utf-8", errors="ignore")
            offset += g

            x, y, direction = None, None, None
            if (f & FLAG_HAS_X) and offset + 2 <= len(data):
                x = struct.unpack_from("<H", data, offset)[0]
                offset += 2
            if (f & FLAG_HAS_Y) and offset + 2 <= len(data):
                y = struct.unpack_from("<H", data, offset)[0]
                offset += 2
            if (f & FLAG_HAS_DIR) and offset < len(data):
                direction = data[offset]
                offset += 1

            entities.append({
                "id": name,
                "name": name,
                "x": x,
                "y": y,
                "dir": direction,
                "is_player": "Player:" in name or "self" in name.lower(),
                "is_enemy": "Enemy:" in name or "Wild" in name,
            })

        return {
            "t": "state",
            "d": {
                "tick": tick,
                "entities": entities,
                "ack": ack,
                "teleport": teleport,
            },
        }
    except Exception as e:
        log.debug(f"Binary frame decode error: {e}")
        return None


# ============================================================================
# HTTP DASHBOARD SERVER
# ============================================================================
class DashboardHandler(BaseHTTPRequestHandler):
    """Exposes REST API and serves local dashboard UI."""

    def _send_json(self, status: int, payload: Any):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        clean_path = self.path.split("?")[0]
        bot = globals().get("current_bot")

        if clean_path in ("/", "/dashboard"):
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            try:
                with open(resolve_resource("dashboard.html"), "rb") as f:
                    self.wfile.write(f.read())
            except Exception as e:
                self.wfile.write(f"<h2>Dashboard HTML missing: {e}</h2>".encode())

        elif clean_path == "/visualizer":
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            try:
                with open(resolve_resource("visualizer.html"), "rb") as f:
                    self.wfile.write(f.read())
            except Exception as e:
                self.wfile.write(f"<h2>Visualizer HTML missing: {e}</h2>".encode())

        elif clean_path == "/state":
            if bot:
                self._send_json(200, bot.get_state_snapshot())
            else:
                self._send_json(200, {"connected": False, "needs_token": True, "token_status": "Inicializando..."})

        elif clean_path == "/logs":
            logs = globals().get("bot_logs", [])
            self._send_json(200, {"logs": logs})

        elif clean_path == "/api/config":
            if bot:
                from dataclasses import asdict
                self._send_json(200, asdict(bot.config))
            else:
                self._send_json(500, {"error": "Bot não inicializado"})
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        clean_path = self.path.split("?")[0]
        bot = globals().get("current_bot")

        length = int(self.headers.get("Content-Length", 0))
        raw_body = self.rfile.read(length).decode("utf-8", errors="ignore") if length > 0 else "{}"
        try:
            payload = json.loads(raw_body) if raw_body else {}
        except Exception:
            payload = {}

        if clean_path == "/api/token":
            # Token submission endpoint
            token_input = payload.get("token") or payload.get("cookies", {}).get("__Secure-better-auth.session_token", "")
            if not token_input and isinstance(payload.get("cookies"), str):
                token_input = payload.get("cookies")
            
            clean_token = clean_session_token(str(token_input))
            if not clean_token:
                self._send_json(400, {"ok": False, "error": "Token vazio ou inválido"})
                return

            if bot:
                bot.config.session_token = clean_token
                bot.config.save()
                log_event("🔐 Novo token recebido e gravado no config.json!", "success")
                bot.trigger_reconnect()
                self._send_json(200, {"ok": True, "message": "Token atualizado com sucesso"})
            else:
                self._send_json(500, {"ok": False, "error": "Bot instance offline"})

        elif clean_path == "/api/config":
            # Config update endpoint
            if bot:
                bot.config.update(payload)
                log_event("⚙️ Configurações salvas e aplicadas!", "info")
                self._send_json(200, {"ok": True, "config": bot.get_state_snapshot().get("config")})
            else:
                self._send_json(500, {"ok": False, "error": "Bot offline"})

        elif clean_path == "/api/connect":
            if bot:
                bot.trigger_reconnect()
                self._send_json(200, {"ok": True, "message": "Reconexão solicitada"})
            else:
                self._send_json(500, {"ok": False, "error": "Bot offline"})

        elif clean_path == "/api/disconnect":
            if bot:
                bot.trigger_disconnect()
                self._send_json(200, {"ok": True, "message": "Desconexão solicitada"})
            else:
                self._send_json(500, {"ok": False, "error": "Bot offline"})
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, format, *args):
        pass  # Suppress verbose standard HTTP request logs


def start_http_dashboard(port: int = 8080) -> HTTPServer:
    """Start the dashboard web server on specified port with fallback."""
    for p in range(port, port + 10):
        try:
            server = HTTPServer(("0.0.0.0", p), DashboardHandler)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            log_event(f"🌐 Dashboard HTTP ativo em http://localhost:{p}/dashboard", "success")
            return server
        except OSError:
            log.warning(f"Porta {p} ocupada, tentando {p+1}...")
    raise RuntimeError(f"Não foi possível iniciar servidor HTTP em portas {port} a {port+10}")


# ============================================================================
# IDLEDEX BOT CLIENT
# ============================================================================
class IdleDexBot:
    """Core autonomous game loop and telemetry agent."""

    def __init__(self, config: BotConfig):
        self.config = config
        self.ws: Optional[websockets.WebSocketClientProtocol] = None
        self.connected = False
        self.needs_token = False
        self.token_status = "Aguardando conexão..."
        self.shard = config.shard
        self.active_token: str = config.ws_token

        self.reconnect_event = asyncio.Event()
        self.manual_disconnect = False
        self.event_loop: Optional[asyncio.AbstractEventLoop] = None
        self.start_time = time.time()
        self.last_ping_rtt = 0

        # State Telemetry
        self.entities: List[Dict[str, Any]] = []
        self.my_mon: Optional[Dict[str, Any]] = None
        self.enemy_mon: Optional[Dict[str, Any]] = None
        self.inventory: Dict[str, Any] = {"ball": {"pokeball": 0, "greatball": 0, "ultraball": 0}, "potion": 0}
        self.collection: Dict[str, Any] = {}
        self.team: List[Dict[str, Any]] = []
        self.wallet: Dict[str, Any] = {"coins": 0, "crystals": 0}
        self.progress: Dict[str, Any] = {"rank": 1, "xp": 0, "wins": 0, "losses": 0, "captures": 0, "shinies": 0}
        self.economy = EconomyMonitor()

    def get_state_snapshot(self) -> Dict[str, Any]:
        """Return thread-safe telemetry snapshot for the dashboard."""
        return {
            "connected": self.connected,
            "needs_token": self.needs_token,
            "token_status": self.token_status,
            "shard": self.shard,
            "strategy_mode": self.config.strategy_mode,
            "uptime_seconds": int(time.time() - self.start_time),
            "ping_rtt_ms": self.last_ping_rtt,
            "ball_inventory": self.inventory.get("ball", {}),
            "potion_inventory": self.inventory.get("potion", 0),
            "inventory": self.inventory,
            "collection": self.collection,
            "team": self.team,
            "wallet": self.wallet,
            "progress": self.progress,
            "enemy_mon": self.enemy_mon,
            "my_mon": self.my_mon,
            "entities": self.entities,
            "config": {
                "session_token_configured": bool(self.config.session_token),
                "strategy_mode": self.config.strategy_mode,
                "iv_collection_threshold": self.config.iv_collection_threshold,
                "iv_sell_threshold": self.config.iv_sell_threshold,
                "flee_hp_pct": self.config.flee_hp_pct,
                "potion_hp_pct": self.config.potion_hp_pct,
                "catch_hp_pct": self.config.catch_hp_pct,
                "auto_idle": self.config.auto_idle,
            },
        }

    def trigger_reconnect(self):
        """Called by HTTP handler to signal immediate reconnect."""
        self.manual_disconnect = False
        if self.event_loop and self.event_loop.is_running():
            self.event_loop.call_soon_threadsafe(self.reconnect_event.set)

    def trigger_disconnect(self):
        """Called by HTTP handler to cleanly disconnect."""
        self.manual_disconnect = True
        self.connected = False
        self.token_status = "Desconectado pelo usuário"
        if self.ws:
            asyncio.run_coroutine_threadsafe(self.ws.close(), self.event_loop)

    async def fetch_token(self) -> bool:
        """Fetch fresh WebSocket token via idledex.com/api/ws-token."""
        if not self.config.session_token:
            self.needs_token = True
            self.token_status = "Nenhum token configurado. Cole o token no painel superior."
            log_event(self.token_status, "warning")
            return False

        headers = {
            "Cookie": f"__Secure-better-auth.session_token={self.config.session_token}",
            "Origin": "https://idledex.com",
            "Referer": "https://idledex.com/play",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
        }

        try:
            async with aiohttp.ClientSession() as session:
                async with session.get("https://idledex.com/api/ws-token", headers=headers, timeout=aiohttp.ClientTimeout(total=10)) as resp:
                    if resp.status in (401, 403):
                        self.needs_token = True
                        self.token_status = "Sessão inválida/expirada (HTTP 401/403). Cole o novo token no painel."
                        log_event(self.token_status, "error")
                        return False
                    if resp.status != 200:
                        self.token_status = f"Erro ao obter ws-token: HTTP {resp.status}"
                        log_event(self.token_status, "error")
                        return False

                    data = await resp.json()
                    self.active_token = data.get("token", "")
                    self.shard = int(data.get("shard", 0))
                    self.needs_token = False
                    self.token_status = f"Token obtido com sucesso (Shard {self.shard})"
                    log_event(self.token_status, "success")
                    return True
        except Exception as e:
            self.token_status = f"Falha de rede ao buscar token: {e}"
            log_event(self.token_status, "error")
            return False

    async def send_event(self, t: str, d: Any = None):
        """Send message obeying IdleDex gateway protocol: { t: ..., d: ... }."""
        if self.ws and self.connected:
            payload = {"t": t}
            if d is not None:
                payload["d"] = d
            await self.ws.send(json.dumps(payload))

    async def ping_loop(self):
        """Send required heartbeat every 5s to prevent disconnection."""
        while self.connected and self.ws:
            try:
                t0 = time.time()
                await self.send_event("ping")
                self.last_ping_rtt = int((time.time() - t0) * 1000)
                await asyncio.sleep(5)
            except Exception:
                break

    async def handle_message(self, raw_data: Any):
        """Handle incoming binary or JSON game packets."""
        if isinstance(raw_data, bytes):
            parsed = parse_binary_frame(raw_data)
            if parsed:
                self.entities = parsed["d"].get("entities", [])
            return

        try:
            msg = json.loads(raw_data)
        except Exception:
            return

        t = msg.get("t") or msg.get("type", "")
        d = msg.get("d", msg)

        if t == "ping":
            return
        elif t == "pong":
            return

        # Auth & Shard events
        elif t == "shard:redirect":
            new_shard = d.get("shard", self.shard)
            log_event(f"🔀 Redirecionado para Shard {new_shard}", "info")
            self.shard = new_shard
            if d.get("token"):
                self.active_token = d["token"]

        # Character & Progress
        elif t == "character:info":
            name = d.get("trainerName") or d.get("name", "Trainer")
            log_event(f"👤 Treinador carregado: {name}", "success")
        elif t == "progress:state":
            self.progress.update({
                "rank": d.get("rank", self.progress["rank"]),
                "xp": d.get("xp", self.progress["xp"]),
                "wins": d.get("wins", self.progress["wins"]),
                "losses": d.get("losses", self.progress["losses"]),
                "captures": d.get("captures", self.progress["captures"]),
                "shinies": d.get("shinies", self.progress["shinies"]),
            })

        # Wallet & Inventory
        elif t == "wallet":
            self.wallet.update(d)
        elif t == "inventory":
            items = d.get("items", [])
            balls = {"pokeball": 0, "greatball": 0, "ultraball": 0}
            potions = 0
            for item in items:
                kind = item.get("kind", "")
                iid = item.get("id", "").lower()
                qty = item.get("quantity", item.get("qty", 1))
                if "ball" in kind or "ball" in iid:
                    if "ultra" in iid:
                        balls["ultraball"] = qty
                    elif "great" in iid:
                        balls["greatball"] = qty
                    else:
                        balls["pokeball"] = qty
                elif "potion" in kind or "potion" in iid:
                    potions += qty
            self.inventory["ball"] = balls
            self.inventory["potion"] = potions

        # Creatures & Team
        elif t in ("team", "team:patch"):
            creatures = d.get("creatures", [])
            self.team = creatures
            for c in creatures:
                cid = str(c.get("id", ""))
                if cid:
                    ivs = c.get("ivs", {})
                    iv_total = sum(int(v) for v in ivs.values() if v is not None) if isinstance(ivs, dict) else c.get("ivTotal", 0)
                    self.collection[cid] = {
                        "id": cid,
                        "name": c.get("name", c.get("species", "Pokémon")),
                        "types": c.get("types", []),
                        "level": c.get("level", 1),
                        "iv_total": iv_total,
                        "nature": c.get("nature", "hardy"),
                        "is_shiny": bool(c.get("isShiny", False)),
                    }

        # Battle events
        elif t == "battle:turn" or t == "battle:control":
            opp = d.get("opponent", {})
            self.enemy_mon = {
                "name": opp.get("name", opp.get("species", "Oponente")),
                "hp_percent": opp.get("hpPercent", opp.get("hp_percent", 1.0)),
                "types": opp.get("types", []),
            }
            player_mon = d.get("player", {})
            self.my_mon = {
                "name": player_mon.get("name", "Seu Pokémon"),
                "hp_percent": player_mon.get("hpPercent", 1.0),
            }
            await self._run_battle_strategy(d)

        elif t == "battle:end":
            victory = d.get("victory", False)
            captured = d.get("captured", False)
            self.enemy_mon = None
            if captured:
                self.progress["captures"] += 1
                log_event(f"✨ Pokémon capturado com sucesso!", "success")
            elif victory:
                self.progress["wins"] += 1
                log_event(f"⚔️ Vitória na batalha!", "success")
            else:
                self.progress["losses"] += 1
                log_event(f"💀 Derrota na batalha.", "warning")

            # Resume idle auto-hunting if configured
            if self.config.auto_idle:
                await asyncio.sleep(1)
                await self.send_event("idle:start")

        # Daily quests
        elif t == "daily:list":
            for q in d.get("quests", []):
                if q.get("completed") and not q.get("claimed"):
                    qid = q.get("id")
                    log_event(f"📋 Resgatando missão diária: {q.get('title', qid)}", "info")
                    await self.send_event("daily:claim", {"questId": qid})
            await self.send_event("pokedex:claim-all")
            await self.send_event("gamepass:claim-all")

        # Notices
        elif t == "notice":
            code = d.get("code", "")
            params = d.get("params", {})
            log_event(f"📢 Aviso do jogo: {code} {params.get('text', '')}", "info")

    async def _run_battle_strategy(self, battle_data: Dict[str, Any]):
        """Decide next combat action: catch, potion, attack, or flee."""
        if not self.enemy_mon or not self.my_mon:
            return

        enemy_hp = self.enemy_mon.get("hp_percent", 1.0)
        my_hp = self.my_mon.get("hp_percent", 1.0)

        # 1. Flee if player HP is critical
        if my_hp < self.config.flee_hp_pct:
            log_event(f"🏃 Fugindo! HP baixo ({my_hp*100:.0f}%)", "warning")
            await self.send_event("battle:flee")
            return

        # 2. Use potion if needed
        if my_hp < self.config.potion_hp_pct and self.inventory.get("potion", 0) > 0:
            log_event(f"💊 Usando poção (HP: {my_hp*100:.0f}%)", "info")
            await self.send_event("battle:item", {"item": "potion"})
            return

        # 3. Attempt catch if opponent HP is weak
        if enemy_hp <= self.config.catch_hp_pct:
            balls = self.inventory.get("ball", {})
            chosen_ball = None
            if enemy_hp < 0.25 and balls.get("ultraball", 0) > 0:
                chosen_ball = "ultraball"
            elif enemy_hp < 0.40 and balls.get("greatball", 0) > 0:
                chosen_ball = "greatball"
            elif balls.get("pokeball", 0) > 0:
                chosen_ball = "pokeball"

            if chosen_ball:
                log_event(f"🔮 Lançando {chosen_ball} (HP inimigo: {enemy_hp*100:.0f}%)", "warning")
                await self.send_event("capture:throw", {"ballId": chosen_ball})
                return

        # 4. Standard offensive action
        await self.send_event("battle:move", {"moveIndex": 0})

    async def run(self):
        """Autonomous connection supervisor."""
        self.event_loop = asyncio.get_running_loop()

        while True:
            self.reconnect_event.clear()
            if self.manual_disconnect:
                log_event("⏸️ Em pausa (desconectado). Clique em 'Conectar' no painel para retomar.", "info")
                await self.reconnect_event.wait()
                continue

            # Step 1: Ensure valid token
            has_token = await self.fetch_token()
            if not has_token:
                log_event("⏳ Aguardando fornecimento de novo token no painel...", "warning")
                # Wait until user submits new token or clicks connect
                await self.reconnect_event.wait()
                continue

            # Step 2: Establish WebSocket Connection
            shard_path = f"/ws/{self.shard}" if self.shard > 0 else "/ws"
            ws_url = f"wss://idledex.com{shard_path}?token={self.active_token}&v=5"

            ws_headers = [
                ("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"),
                ("Cookie", f"__Secure-better-auth.session_token={self.config.session_token}"),
            ]

            log_event(f"🔌 Conectando ao idleDEX (Shard {self.shard})...", "info")
            ping_task: Optional[asyncio.Task] = None

            try:
                async with websockets.connect(
                    ws_url,
                    origin="https://idledex.com",
                    additional_headers=ws_headers,
                    open_timeout=15,
                    ping_interval=None,  # We manage application-level ping {t: "ping"}
                ) as ws:
                    self.ws = ws
                    self.connected = True
                    self.needs_token = False
                    self.token_status = "Conectado e operando"
                    log_event("✅ Conexão WebSocket estabelecida com sucesso!", "success")

                    # Start application-level heartbeat
                    ping_task = asyncio.create_task(self.ping_loop())

                    # Start native idle if enabled
                    if self.config.auto_idle:
                        await self.send_event("idle:start")
                        log_event("⚡ Modo Auto-Idle ativado", "success")

                    # Request initial character and daily info
                    await self.send_event("daily:open")
                    await self.send_event("hunt:open")

                    # Message intake loop
                    async for message in ws:
                        await self.handle_message(message)

            except (websockets.exceptions.InvalidStatus, websockets.exceptions.InvalidStatusCode) as e:
                status_code = getattr(e, "status_code", 0)
                if status_code in (401, 403):
                    self.needs_token = True
                    self.token_status = f"Erro de autenticação HTTP {status_code}. Atualize o token."
                    log_event(self.token_status, "error")
                else:
                    self.token_status = f"Rejeição de conexão HTTP {status_code}"
                    log_event(self.token_status, "warning")

            except websockets.exceptions.ConnectionClosed as e:
                code = e.code
                if code in (4001, 4401, 4403, 4404, 4405, 4503, 4901):
                    self.needs_token = True
                    self.token_status = f"Sessão expirada no servidor (código {code}). Atualize o token."
                    log_event(self.token_status, "error")
                else:
                    self.token_status = f"Conexão encerrada ({code}). Reconectando em 5s..."
                    log_event(self.token_status, "warning")

            except Exception as e:
                self.token_status = f"Erro de comunicação: {e}"
                log_event(self.token_status, "error")

            finally:
                self.connected = False
                self.ws = None
                if ping_task:
                    ping_task.cancel()

            # Wait 5 seconds before next retry, or instant if reconnect_event is triggered
            try:
                await asyncio.wait_for(self.reconnect_event.wait(), timeout=5.0)
            except asyncio.TimeoutError:
                pass


# ============================================================================
# ENTRY POINT
# ============================================================================
def main():
    """Bootstraps dashboard HTTP server and starts client supervisor."""
    print("==================================================")
    print("  idleDEX Bot & Management Suite v2.0")
    print("==================================================")

    # Load persistent configuration
    config = BotConfig.load()
    log.info(f"Loaded configuration from: {get_app_dir()}")

    # Initialize Bot instance
    bot = IdleDexBot(config)
    globals()["current_bot"] = bot

    # 1. Start HTTP Dashboard immediately
    start_http_dashboard(config.port)

    # 2. Run supervisor event loop
    try:
        asyncio.run(bot.run())
    except KeyboardInterrupt:
        log_event("Bot interrompido pelo usuário (CTRL+C)", "warning")
    except Exception as e:
        log.critical(f"Erro fatal: {e}")


if __name__ == "__main__":
    main()
