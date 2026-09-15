"""
idleDEX Bot Configuration & Persistence Module
Handles loading, saving, and normalizing bot settings.
"""

import json
import math
import os
import sys
import tempfile
import urllib.parse
from dataclasses import dataclass, asdict, field, fields, replace
from typing import Optional, Dict, Any, List


def get_app_dir() -> str:
    """Return persistent directory where config and user data should be stored."""
    if getattr(sys, 'frozen', False):
        return os.path.dirname(sys.executable)
    return os.path.dirname(os.path.abspath(__file__))


CONFIG_FILE_PATH = os.path.join(get_app_dir(), "config.json")


def clean_session_token(raw: str) -> str:
    """Extract clean session token from raw input (cookie string, header, or raw token)."""
    if not raw:
        return ""
    text = raw.strip()
    
    # Check if input is a JSON string
    if text.startswith("{") and text.endswith("}"):
        try:
            data = json.loads(text)
            if isinstance(data, dict):
                cookies = data.get("cookies")
                if isinstance(cookies, dict):
                    token = cookies.get("__Secure-better-auth.session_token", "")
                    if isinstance(token, str) and token:
                        return clean_session_token(token)
                elif isinstance(cookies, str) and cookies:
                    return clean_session_token(cookies)
                for k, v in data.items():
                    if "token" in k.lower() and isinstance(v, str):
                        return clean_session_token(v)
        except Exception:
            pass
            
    # Check if input is a Cookie header string (e.g. __Secure-better-auth.session_token=xyz; foo=bar)
    if "__Secure-better-auth.session_token=" in text:
        parts = text.split(";")
        for part in parts:
            part = part.strip()
            if part.startswith("__Secure-better-auth.session_token="):
                val = part.split("=", 1)[1].strip()
                return urllib.parse.unquote(val)
                
    # If starts with key=val
    if "=" in text and not text.startswith("http"):
        left, right = text.split("=", 1)
        if "token" in left.lower():
            text = right.strip()
            
    # Strip any accidental surrounding quotes
    text = text.strip('"\'')
    if "%" in text:
        try:
            text = urllib.parse.unquote(text)
        except Exception:
            pass
    return text


@dataclass
class BotConfig:
    session_token: str = ""
    ws_token: str = ""
    shard: int = 0
    port: int = 8080
    strategy_mode: str = "balanced"  # balanced, collection, monetize
    iv_collection_threshold: int = 150
    iv_sell_threshold: int = 120
    flee_hp_pct: float = 0.30
    potion_hp_pct: float = 0.35
    potion_mode: str = "smart"  # smart, potion, super-potion, hyper-potion, max-potion
    use_revive_battle: bool = True
    use_revive_overworld: bool = True
    auto_heal_center: bool = True
    catch_hp_pct: float = 0.50
    catch_only_shiny: bool = False
    catch_only_uncaught: bool = False
    ball_priority: str = "balanced"  # balanced, economy, force_highest
    move_selection_mode: str = "smart"  # smart, max_damage, first
    target_species: List[str] = field(default_factory=list)
    unselected_action: str = "battle"  # battle, flee
    min_iv_alert: int = 130
    discard_iv_pct: int = 50
    pause_on_no_balls: bool = True
    roam_step_delay_ms: int = 300
    auto_idle: bool = True
    auto_roam: bool = True
    auto_claim_dailies: bool = True
    auto_lock_valuable: bool = True
    auto_use_boosts: bool = False
    auto_npc_quests: bool = True
    auto_travel_deliveries: bool = True
    auto_travel_surplus_threshold: int = 5
    discord_webhook: str = ""


    @classmethod
    def load(cls, path: str = CONFIG_FILE_PATH) -> "BotConfig":
        """Load configuration from disk or create default."""
        config = cls()
        config._config_path = path
        if os.path.exists(path):
            try:
                with open(path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                values = cls._normalize(data)
                for key, value in values.items():
                    setattr(config, key, value)
            except (OSError, ValueError, TypeError) as error:
                print(f"[config] Cannot load configuration ({type(error).__name__}); using defaults.")
        else:
            config.save(path)
        return config

    def save(self, path: Optional[str] = None) -> None:
        """Replace the saved configuration atomically; propagate write errors."""
        path = os.path.abspath(path or getattr(self, "_config_path", CONFIG_FILE_PATH))
        directory = os.path.dirname(path)
        os.makedirs(directory, exist_ok=True)
        descriptor, temporary = tempfile.mkstemp(prefix=".config-", suffix=".tmp", dir=directory)
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
                json.dump(asdict(self), stream, indent=4, ensure_ascii=False, allow_nan=False)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, path)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)

    @classmethod
    def _normalize(cls, data: Dict[str, Any]) -> Dict[str, Any]:
        """Validate fields against defaults before applying any of them."""
        if not isinstance(data, dict):
            raise ValueError("Configuration must be an object")
        defaults = cls()
        known = {item.name for item in fields(cls)}
        normalized = {}
        enums = {
            "strategy_mode": {"balanced", "collection", "monetize"},
            "potion_mode": {"smart", "potion", "super-potion", "hyper-potion", "max-potion"},
            "ball_priority": {"balanced", "economy", "force_highest"},
            "move_selection_mode": {"smart", "max_damage", "first"},
            "unselected_action": {"battle", "flee"},
        }
        for key, value in data.items():
            if key not in known:
                continue
            default = getattr(defaults, key)
            if isinstance(default, bool):
                if isinstance(value, str):
                    text = value.strip().lower()
                    if text not in {"true", "false", "yes", "no", "1", "0"}:
                        raise ValueError(f"Invalid boolean for {key}")
                    value = text in {"true", "yes", "1"}
                elif isinstance(value, (bool, int)) and value in (0, 1):
                    value = bool(value)
                else:
                    raise ValueError(f"Invalid boolean for {key}")
            elif isinstance(default, (int, float)):
                if isinstance(value, bool) or not isinstance(value, (int, float, str)):
                    raise ValueError(f"Invalid number for {key}")
                try:
                    value = float(value)
                except (ValueError, OverflowError):
                    raise ValueError(f"Invalid number for {key}") from None
                if not math.isfinite(value) or (isinstance(default, int) and not value.is_integer()):
                    raise ValueError(f"Invalid number for {key}")
                if isinstance(default, int):
                    value = int(value)
                maximum = 1 if key.endswith("_hp_pct") else None
                if key in {"iv_collection_threshold", "iv_sell_threshold", "min_iv_alert"}:
                    maximum = 186
                elif key == "discard_iv_pct":
                    maximum = 100
                elif key == "port":
                    maximum = 65535
                minimum = 1 if key in {"port", "roam_step_delay_ms", "auto_travel_surplus_threshold"} else 0
                if value < minimum or (maximum is not None and value > maximum):
                    raise ValueError(f"Out-of-range number for {key}")
            elif isinstance(default, list):
                if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
                    raise ValueError(f"Invalid list for {key}")
                value = list(dict.fromkeys(item.strip() for item in value if item.strip()))
            elif not isinstance(value, str):
                raise ValueError(f"Invalid text for {key}")
            if key in enums and value not in enums[key]:
                raise ValueError(f"Invalid option for {key}")
            if key == "session_token":
                value = clean_session_token(value)
            normalized[key] = value
        return normalized

    def update(self, new_data: Dict[str, Any]) -> None:
        """Commit validated settings in memory only after persistence succeeds."""
        normalized = self._normalize(new_data)
        candidate = replace(self, **normalized)
        candidate._config_path = getattr(self, "_config_path", CONFIG_FILE_PATH)
        candidate.save()
        for key, value in normalized.items():
            setattr(self, key, value)
