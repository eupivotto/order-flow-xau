"""
SignalDetector — Detecção de sinais operacionais para XAUUSD Order Flow
Sinais: DELTA_DIV, WALL_CONSUMED, WALL_RESPECTED, LIQ_CLUSTER, SPREAD_ALERT
"""

import time
from collections import deque
from dataclasses import dataclass, field
from typing import List, Optional, Dict, Tuple, Any

# ---------------------------------------------------------------------------
# Dataclasses
# ---------------------------------------------------------------------------

@dataclass
class Signal:
    """Um sinal operacional gerado pelo detector."""
    id: str              # ex: "DELTA_DIV"
    name: str            # nome legível
    direction: str       # "LONG", "SHORT", "CAUTION", "EXIT"
    strength: int        # 1, 2 ou 3 (estrelas)
    message: str         # descrição curta para o trader
    timestamp: float     # epoch seconds

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "direction": self.direction,
            "strength": self.strength,
            "message": self.message,
            "timestamp": self.timestamp,
        }


# ---------------------------------------------------------------------------
# Classe principal
# ---------------------------------------------------------------------------

class SignalDetector:
    """
    Processa snapshots de market data e emite sinais operacionais.

    Uso:
        detector = SignalDetector()
        signals = detector.update(summary, delta_stats, liquidations)
    """

    def __init__(
        self,
        delta_div_window: int = 3,        # amostras consecutivas para confirmar divergência
        wall_spoof_window: float = 10.0,  # segundos para considerar wall "sumiu"
        liq_cluster_window: float = 30.0, # janela para cluster de liquidações
        liq_cluster_min: int = 3,         # mínimo de liquidações para cluster
        spread_mult: float = 5.0,         # multiplicador vs mediana para alerta
        spread_history: int = 60,         # amostras para mediana de spread
        history_maxlen: int = 200,        # máximo de sinais no histórico
    ):
        self.delta_div_window = delta_div_window
        self.wall_spoof_window = wall_spoof_window
        self.liq_cluster_window = liq_cluster_window
        self.liq_cluster_min = liq_cluster_min
        self.spread_mult = spread_mult

        # Histórico interno
        self._price_history: deque = deque(maxlen=30)   # (timestamp, mid)
        self._delta_history: deque = deque(maxlen=30)   # (timestamp, delta)
        self._spread_history: deque = deque(maxlen=spread_history)  # spread values
        self._wall_snapshot: Dict[str, Dict[float, float]] = {
            "bid": {},  # {price: qty}
            "ask": {},
        }
        self._wall_snapshot_time: float = 0.0
        self._signals_history: deque = deque(maxlen=history_maxlen)

        # IDs de sinais recentemente emitidos (debounce)
        self._last_signal_time: Dict[str, float] = {}
        self._debounce: Dict[str, float] = {
            "DELTA_DIV":     15.0,
            "WALL_CONSUMED": 10.0,
            "WALL_RESPECTED": 20.0,
            "LIQ_CLUSTER":  20.0,
            "SPREAD_ALERT":  5.0,
        }

        # Controle de wall_respected
        self._wall_touch: Dict[Tuple[str, float], List[float]] = {}  # (side, price) → [timestamps]

        # Controle de liquidações (passado pelo server)
        self._seen_liqs: deque = deque(maxlen=100)  # timestamps já processados

    # -----------------------------------------------------------------------
    # Método principal
    # -----------------------------------------------------------------------

    def update(
        self,
        summary: Any,         # BookSummary
        delta_stats: Any,     # DeltaStats
        liquidations: List[Any],  # List[LiquidationRecord]
    ) -> List[Signal]:
        """
        Recebe o estado atual do mercado e retorna novos sinais detectados.
        Chamado a cada ciclo do broadcast_loop (~1s).
        """
        now = time.time()
        new_signals: List[Signal] = []

        if summary is None:
            return []

        # Atualiza históricos de preço, delta e spread
        self._price_history.append((now, summary.mid))
        self._delta_history.append((now, delta_stats.delta))
        self._spread_history.append(summary.spread)

        # -------------------------------------------------------------------
        # 1. Delta Divergente
        # -------------------------------------------------------------------
        sig = self._check_delta_divergence(now)
        if sig:
            new_signals.append(sig)

        # -------------------------------------------------------------------
        # 2. Wall Consumido (spoof) e Wall Respeitado
        # -------------------------------------------------------------------
        wall_sigs = self._check_walls(summary, now)
        new_signals.extend(wall_sigs)

        # -------------------------------------------------------------------
        # 3. Cluster de Liquidações
        # -------------------------------------------------------------------
        sig = self._check_liq_cluster(liquidations, now)
        if sig:
            new_signals.append(sig)

        # -------------------------------------------------------------------
        # 4. Spread Anômalo
        # -------------------------------------------------------------------
        sig = self._check_spread(summary.spread, now)
        if sig:
            new_signals.append(sig)

        # Salva no histórico geral
        for s in new_signals:
            self._signals_history.append(s)

        return new_signals

    # -----------------------------------------------------------------------
    # Sinal 1: DELTA_DIV
    # -----------------------------------------------------------------------

    def _check_delta_divergence(self, now: float) -> Optional[Signal]:
        """
        Divergência: preço sobe por N amostras enquanto delta cai (ou vice-versa).
        """
        n = self.delta_div_window
        if len(self._price_history) < n + 1 or len(self._delta_history) < n + 1:
            return None

        prices = [p for _, p in list(self._price_history)[-n - 1:]]
        deltas = [d for _, d in list(self._delta_history)[-n - 1:]]

        price_trend = prices[-1] - prices[0]   # positivo = subindo
        delta_trend = deltas[-1] - deltas[0]   # positivo = mais compradores

        # Divergência bearish: preço sobe mas delta cai (vendedores absorvendo)
        if price_trend > 0.20 and delta_trend < -0.01:
            direction = "SHORT"
            msg = (
                f"Preço +{price_trend:.2f} mas delta {delta_trend:+.4f} — "
                "vendedores absorvendo a alta. Possível reversão."
            )
            strength = 3 if abs(delta_trend) > 0.05 else (2 if abs(delta_trend) > 0.01 else 1)
            return self._emit("DELTA_DIV", "Delta Divergente", direction, strength, msg, now)

        # Divergência bullish: preço cai mas delta sobe (compradores absorvendo)
        if price_trend < -0.20 and delta_trend > 0.01:
            direction = "LONG"
            msg = (
                f"Preço {price_trend:.2f} mas delta {delta_trend:+.4f} — "
                "compradores absorvendo a queda. Possível reversão."
            )
            strength = 3 if abs(delta_trend) > 0.05 else (2 if abs(delta_trend) > 0.01 else 1)
            return self._emit("DELTA_DIV", "Delta Divergente", direction, strength, msg, now)

        return None

    # -----------------------------------------------------------------------
    # Sinal 2+3: WALL_CONSUMED e WALL_RESPECTED
    # -----------------------------------------------------------------------

    def _check_walls(self, summary: Any, now: float) -> List[Signal]:
        signals: List[Signal] = []

        # Snapshot anterior dos walls
        old_bid_walls = self._wall_snapshot["bid"]
        old_ask_walls = self._wall_snapshot["ask"]

        # Novo snapshot
        new_bid_walls: Dict[float, float] = {w.price: w.qty for w in summary.walls if w.side == "bid"}
        new_ask_walls: Dict[float, float] = {w.price: w.qty for w in summary.walls if w.side == "ask"}

        mid = summary.mid
        time_since_snap = now - self._wall_snapshot_time

        if time_since_snap > 0 and self._wall_snapshot_time > 0:

            # --- Wall Consumido (desapareceu sem o preço chegar lá) ---
            for price, qty in old_bid_walls.items():
                if price not in new_bid_walls:
                    # preço está acima do wall de bid que sumiu → spoof suspeito
                    if mid > price * 1.001:  # preço ainda não desceu até lá
                        msg = (
                            f"Wall de BID @ ${price:.2f} ({qty:.3f} XAU) desapareceu "
                            "sem o preço chegar — possível spoof. Cuidado longo."
                        )
                        s = self._emit("WALL_CONSUMED", "Wall Consumido", "CAUTION", 2, msg, now)
                        if s:
                            signals.append(s)

            for price, qty in old_ask_walls.items():
                if price not in new_ask_walls:
                    if mid < price * 0.999:  # preço ainda não subiu até lá
                        msg = (
                            f"Wall de ASK @ ${price:.2f} ({qty:.3f} XAU) desapareceu "
                            "sem o preço chegar — possível spoof. Cuidado curto."
                        )
                        s = self._emit("WALL_CONSUMED", "Wall Consumido", "CAUTION", 2, msg, now)
                        if s:
                            signals.append(s)

            # --- Wall Respeitado (preço testou 2× e voltou) ---
            for price in new_bid_walls:
                key = ("bid", price)
                # Registra toda vez que mid estiver próximo do wall
                if abs(mid - price) / price < 0.001:  # dentro de 0.1% do wall
                    self._wall_touch.setdefault(key, []).append(now)
                    # Remove toques antigos
                    self._wall_touch[key] = [t for t in self._wall_touch[key] if now - t < 120]
                    if len(self._wall_touch[key]) >= 2:
                        msg = (
                            f"Wall de BID @ ${price:.2f} respeitado "
                            f"{len(self._wall_touch[key])}× — suporte real. Setup LONG."
                        )
                        s = self._emit("WALL_RESPECTED", "Wall Respeitado", "LONG", 3, msg, now)
                        if s:
                            signals.append(s)
                            self._wall_touch[key] = []  # reset após emitir

            for price in new_ask_walls:
                key = ("ask", price)
                if abs(mid - price) / price < 0.001:
                    self._wall_touch.setdefault(key, []).append(now)
                    self._wall_touch[key] = [t for t in self._wall_touch[key] if now - t < 120]
                    if len(self._wall_touch[key]) >= 2:
                        msg = (
                            f"Wall de ASK @ ${price:.2f} respeitado "
                            f"{len(self._wall_touch[key])}× — resistência real. Setup SHORT."
                        )
                        s = self._emit("WALL_RESPECTED", "Wall Respeitado", "SHORT", 3, msg, now)
                        if s:
                            signals.append(s)
                            self._wall_touch[key] = []

        # Atualiza snapshot
        self._wall_snapshot["bid"] = new_bid_walls
        self._wall_snapshot["ask"] = new_ask_walls
        self._wall_snapshot_time = now

        return signals

    # -----------------------------------------------------------------------
    # Sinal 4: LIQ_CLUSTER
    # -----------------------------------------------------------------------

    def _check_liq_cluster(self, liquidations: List[Any], now: float) -> Optional[Signal]:
        """
        Detecta ≥ N liquidações no mesmo lado em < liq_cluster_window segundos.
        """
        if not liquidations:
            return None

        cutoff = now - self.liq_cluster_window
        recent = [l for l in liquidations if l.timestamp >= cutoff]

        buys  = [l for l in recent if l.side == "BUY"]
        sells = [l for l in recent if l.side == "SELL"]

        # Cluster de BUY liquidations = longs sendo liquidados = short squeeze possível
        if len(buys) >= self.liq_cluster_min:
            total_val = sum(l.value_usd for l in buys)
            strength = 3 if total_val > 500_000 else (2 if total_val > 100_000 else 1)
            msg = (
                f"{len(buys)} long liquidações em {self.liq_cluster_window:.0f}s "
                f"(${total_val:,.0f}) — movimento bearish violento. Não comprar agora."
            )
            return self._emit("LIQ_CLUSTER", "Cluster de Liquidação", "CAUTION", strength, msg, now)

        # Cluster de SELL liquidations = shorts sendo liquidados = long squeeze
        if len(sells) >= self.liq_cluster_min:
            total_val = sum(l.value_usd for l in sells)
            strength = 3 if total_val > 500_000 else (2 if total_val > 100_000 else 1)
            msg = (
                f"{len(sells)} short liquidações em {self.liq_cluster_window:.0f}s "
                f"(${total_val:,.0f}) — short squeeze. Não vender agora."
            )
            return self._emit("LIQ_CLUSTER", "Cluster de Liquidação", "CAUTION", strength, msg, now)

        return None

    # -----------------------------------------------------------------------
    # Sinal 5: SPREAD_ALERT
    # -----------------------------------------------------------------------

    def _check_spread(self, spread: float, now: float) -> Optional[Signal]:
        """
        Alerta quando o spread ultrapassa self.spread_mult × mediana histórica.
        """
        if len(self._spread_history) < 10:
            return None

        spreads = sorted(self._spread_history)
        median = spreads[len(spreads) // 2]
        if median == 0:
            return None

        ratio = spread / median
        if ratio > self.spread_mult:
            msg = (
                f"Spread {spread:.3f} = {ratio:.1f}× a mediana ({median:.3f}) — "
                "liquidez muito baixa. SAIR do mercado ou aguardar."
            )
            return self._emit("SPREAD_ALERT", "Spread Anômalo", "EXIT", 3, msg, now)

        return None

    # -----------------------------------------------------------------------
    # Histórico
    # -----------------------------------------------------------------------

    def get_history(self) -> List[Signal]:
        """Retorna histórico completo de sinais."""
        return list(self._signals_history)

    # -----------------------------------------------------------------------
    # Helper: debounce + emit
    # -----------------------------------------------------------------------

    def _emit(
        self,
        signal_id: str,
        name: str,
        direction: str,
        strength: int,
        message: str,
        now: float,
    ) -> Optional[Signal]:
        """
        Emite um sinal só se o debounce expirou.
        Evita spam de sinais iguais em sequência.
        """
        last = self._last_signal_time.get(signal_id, 0.0)
        cooldown = self._debounce.get(signal_id, 10.0)
        if now - last < cooldown:
            return None
        self._last_signal_time[signal_id] = now
        return Signal(
            id=signal_id,
            name=name,
            direction=direction,
            strength=strength,
            message=message,
            timestamp=now,
        )
