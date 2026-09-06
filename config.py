"""
idleDEX Bot Configuration & Persistence Module
Handles loading, saving, and normalizing bot settings.
"""

import json
import os
import sys
import urllib.parse
from dataclasses import dataclass, asdict
from typing import Optional, Dict, Any


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
                if "cookies" in data and isinstance(data["cookies"], dict):
                    token = data["cookies"].get("__Secure-better-auth.session_token", "")
                    if token:
                        return clean_session_token(token)
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
    roam_step_delay_ms: int = 300
    auto_idle: bool = True
    auto_roam: bool = True
    discord_webhook: str = ""


    @classmethod
    def load(cls, path: str = CONFIG_FILE_PATH) -> "BotConfig":
        """Load configuration from disk or create default."""
        config = cls()
        if os.path.exists(path):
            try:
                with open(path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                if isinstance(data, dict):
                    for k, v in data.items():
                        if hasattr(config, k):
                            setattr(config, k, v)
            except Exception as e:
                print(f"[config] Error reading {path}: {e}, using defaults.")
        else:
            config.save(path)
        return config

    def save(self, path: str = CONFIG_FILE_PATH) -> None:
        """Persist current configuration to disk."""
        try:
            os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
            with open(path, "w", encoding="utf-8") as f:
                json.dump(asdict(self), f, indent=4, ensure_ascii=False)
        except Exception as e:
            print(f"[config] Error saving {path}: {e}")

    def update(self, new_data: Dict[str, Any]) -> None:
        """Update fields from dictionary and save."""
        if "session_token" in new_data:
            self.session_token = clean_session_token(str(new_data["session_token"]))
        for k, v in new_data.items():
            if k == "session_token":
                continue
            if hasattr(self, k):
                # Type coerce
                orig = getattr(self, k)
                if isinstance(orig, int):
                    setattr(self, k, int(v))
                elif isinstance(orig, float):
                    setattr(self, k, float(v))
                elif isinstance(orig, bool):
                    setattr(self, k, bool(v) if not isinstance(v, str) else v.lower() in ("true", "1", "yes"))
                else:
                    setattr(self, k, v)
        self.save()
