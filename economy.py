"""
idleDEX Market/Economy Module
Monitors market prices, suggests buy/sell decisions
"""

import asyncio
from dataclasses import dataclass
from typing import Optional, Dict, List
from datetime import datetime
import json


@dataclass
class MarketItem:
    id: int
    name: str
    category: str  # "pokemon", "ball", "item"
    price: float
    seller_id: int
    quantity: int


@dataclass
class PriceHistory:
    item_id: int
    timestamps: List[datetime]
    prices: List[float]

    @property
    def avg_price(self) -> float:
        return sum(self.prices) / len(self.prices) if self.prices else 0

    @property
    def trend(self) -> str:
        if len(self.prices) < 2:
            return "unknown"
        recent = self.prices[-3:]
        if recent[-1] > recent[0] * 1.1:
            return "rising"
        elif recent[-1] < recent[0] * 0.9:
            return "falling"
        return "stable"


class EconomyMonitor:
    """Tracks market prices and suggests trades."""

    def __init__(self):
        self.price_history: Dict[int, PriceHistory] = {}
        self.my_listings: Dict[int, MarketItem] = {}
        self.target_prices: Dict[str, float] = {}  # name -> max buy price

    def record_price(self, item_id: int, price: float):
        """Track price over time."""
        if item_id not in self.price_history:
            self.price_history[item_id] = PriceHistory(
                item_id=item_id,
                timestamps=[],
                prices=[]
            )

        history = self.price_history[item_id]
        history.timestamps.append(datetime.now())
        history.prices.append(price)

        # Keep only last 100 data points
        if len(history.prices) > 100:
            history.prices = history.prices[-100:]
            history.timestamps = history.timestamps[-100:]

    def get_suggested_buy_price(self, item_name, current_price: float) -> Optional[float]:
        """Suggest buy price based on history.
        item_name may be str or int; history stores item_id as int."""
        if item_name in self.target_prices:
            target = self.target_prices[item_name]
            return target if current_price > target else None

        # Use average of last 10 prices; match by name OR int(item_id)
        target_id = None
        try:
            target_id = int(item_name)
        except (TypeError, ValueError):
            target_id = item_name  # fall back to string match

        history = self.price_history.get(target_id)
        if history and len(history.prices) >= 5:
            avg = history.avg_price
            return avg * 0.9
        return None

    def should_list(self, item: MarketItem, my_quantity: int) -> bool:
        """Decide if we should list item for sale."""
        # ponytail: simple heuristic - list if we have > 2 and price is above average
        history = self.price_history.get(item.id)
        if history and item.price > history.avg_price * 1.1:
            return my_quantity > 2
        return False

    def analyze_market_opportunity(self) -> List[Dict]:
        """Find profitable trading opportunities."""
        opportunities = []

        for item_id, history in self.price_history.items():
            if history.trend == "rising" and len(history.prices) >= 5:
                opportunities.append({
                    "item_id": item_id,
                    "trend": history.trend,
                    "avg_price": history.avg_price,
                    "current_price": history.prices[-1],
                    "potential_profit": (history.prices[-1] - history.avg_price) / history.avg_price
                })

        return sorted(opportunities, key=lambda x: x["potential_profit"], reverse=True)


class PokemonValuator:
    """Evaluates Pokemon value based on IVs, nature, and meta relevance."""

    # Meta-relevant Pokemon (example - would need game data)
    META_POKEMON = {
        "charizard": {"role": "attacker", "ideal_nature": "adamant"},
        "blastoise": {"role": "tank", "ideal_nature": "impish"},
        "venusaur": {"role": "special", "ideal_nature": "modest"},
        "pikachu": {"role": "speedster", "ideal_nature": "jolly"},
    }

    def calculate_value(self, pokemon: 'MonData', market_prices: EconomyMonitor) -> float:
        """Calculate overall value score."""
        base_score = self._base_iv_score(pokemon)
        nature_bonus = self._nature_bonus(pokemon)
        meta_bonus = self._meta_bonus(pokemon)
        shiny_bonus = 15 if pokemon.is_shiny else 0

        return base_score + nature_bonus + meta_bonus + shiny_bonus

    def _base_iv_score(self, mon: 'MonData') -> float:
        """Score based on IV distribution."""
        ivs = mon.ivs
        total = sum(ivs.values())

        # Weight certain stats differently based on role
        weights = {
            "attack": 1.2,
            "sp_atk": 1.2,
            "speed": 1.1,
            "defense": 1.0,
            "sp_def": 1.0,
            "hp": 0.8
        }

        weighted_sum = sum(ivs.get(stat, 0) * weights.get(stat, 1.0)
                          for stat in ivs)
        return (weighted_sum / 126) * 60  # Normalize to 0-60

    def _nature_bonus(self, mon: 'MonData') -> float:
        """Bonus for correct nature."""
        ideal = self.META_POKEMON.get(mon.name.lower(), {})
        if not ideal:
            return 5  # Neutral bonus

        ideal_nature = ideal.get("ideal_nature", "")
        if mon.nature.lower() == ideal_nature:
            return 15
        return 5

    def _meta_bonus(self, mon: 'MonData') -> float:
        """Bonus for being meta-relevant."""
        if mon.name.lower() in self.META_POKEMON:
            return 10
        return 0
