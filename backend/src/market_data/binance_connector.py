"""
BinanceXAUConnector - Conector WebSocket para XAUUSDT Binance Futures
Streams: order book (depth@100ms), aggTrade, forceOrder (liquidações)
"""

import asyncio
import json
import logging
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

import numpy as np
import websockets

# ---------------------------------------------------------------------------
# Configurações globais
# ---------------------------------------------------------------------------
logger = logging.getLogger(__name__)

BASE_WS_URL = "wss://fstream.binance.com/ws"
SYMBOL = "xauusdt"

# Janela de delta em segundos
DELTA_WINDOW_SECONDS = 60

# Critério direto de wall: volume em XAUUSDT equivalente a 100 BTC (~3.000.000 USD)
WALL_ABSOLUTE_THRESHOLD = 100.0  # em BTC de referência (ajuste conforme seu risco)

# Heatmap: salva snapshots dos últimos N segundos (4 horas = 14400s)
HEATMAP_MAX_SNAPSHOTS = 14400       # 1 snapshot/segundo → 4h
HEATMAP_SNAPSHOT_INTERVAL = 1.0    # segundos entre snapshots

# Backoff exponencial para reconexão
RECONNECT_BASE_DELAY = 1.0   # segundos
RECONNECT_MAX_DELAY = 60.0   # máximo


# ---------------------------------------------------------------------------
# Dataclasses
# ---------------------------------------------------------------------------

@dataclass
class BookSnapshot:
    """Snapshot do order book em um instante dado."""
    timestamp: float                    # epoch seconds
    bids: List[Tuple[float, float]]     # [(price, qty), ...] top 10
    asks: List[Tuple[float, float]]     # [(price, qty), ...] top 10
    mid: float
    spread: float


@dataclass
class TradeRecord:
    """Registro de um aggTrade processado."""
    timestamp: float
    price: float
    qty: float
    is_buyer_maker: bool  # True → venda de mercado (seller hit bid)


@dataclass
class FootprintCandle:
    """Candle de 1 minuto contendo o histórico de volume por preço."""
    timestamp: float        # início do minuto (epoch)
    open: float
    high: float
    low: float
    close: float
    volume: float
    buy_volume: float
    sell_volume: float
    levels: Dict[float, Dict[str, float]] # {price: {"buy": qty, "sell": qty}}
    
    def to_dict(self):
        return {
            "timestamp": self.timestamp,
            "open": self.open,
            "high": self.high,
            "low": self.low,
            "close": self.close,
            "volume": self.volume,
            "buy_volume": self.buy_volume,
            "sell_volume": self.sell_volume,
            "levels": self.levels,
        }


@dataclass
class LiquidationRecord:
    """Registro de uma liquidação forçada."""
    timestamp: float
    side: str       # "BUY" ou "SELL"
    price: float
    qty: float
    value_usd: float


@dataclass
class WallLevel:
    """Nível do book identificado como wall."""
    side: str       # "bid" ou "ask"
    price: float
    qty: float
    method: str     # "absolute" ou "zscore"


@dataclass
class BookSummary:
    """Retorno de get_book_summary()."""
    mid: float
    spread: float
    spread_pct: float
    top_bids: List[Tuple[float, float]]
    top_asks: List[Tuple[float, float]]
    walls: List[WallLevel]
    timestamp: float


@dataclass
class DeltaStats:
    """Retorno de get_delta_stats()."""
    delta: float            # buy_volume - sell_volume (últimos 60s)
    buy_volume: float
    sell_volume: float
    total_volume: float
    pressure: str           # "BUY", "SELL", "NEUTRAL"
    window_seconds: int


@dataclass
class SessionStats:
    """Retorno de get_session_stats(). Usado para o Pre-Market Bias."""
    start_time: float
    start_price: float
    high: float
    low: float
    buy_volume: float
    sell_volume: float
    delta_xau: float
    cumulative_delta: float
    vwap: float

# ---------------------------------------------------------------------------
# Classe principal
# ---------------------------------------------------------------------------

class BinanceXAUConnector:
    """
    Conector assíncrono para XAUUSDT Binance Futures.

    Uso básico:
        connector = BinanceXAUConnector()
        asyncio.run(connector.connect())
    """

    def __init__(
        self,
        wall_absolute: float = WALL_ABSOLUTE_THRESHOLD,
        wall_zscore: float = 2.0,
        delta_window: int = DELTA_WINDOW_SECONDS,
        heatmap_max: int = HEATMAP_MAX_SNAPSHOTS,
        heatmap_interval: float = HEATMAP_SNAPSHOT_INTERVAL,
    ):
        self.wall_absolute = wall_absolute
        self.wall_zscore = wall_zscore
        self.delta_window = delta_window
        self.heatmap_max = heatmap_max
        self.heatmap_interval = heatmap_interval

        # Order book: {price_str: qty_float}
        self._bids: Dict[str, float] = {}
        self._asks: Dict[str, float] = {}
        self._last_update_id: int = 0

        # Trades para cálculo de delta (deque com timestamp de expiração)
        self._trades: deque = deque()  # deque de TradeRecord

        # Liquidações (histórico das últimas 4h)
        self._liquidations: deque = deque(maxlen=heatmap_max)

        # Heatmap: snapshots do book
        self._heatmap: deque = deque(maxlen=heatmap_max)
        self._last_snapshot_time: float = 0.0
        
        # Footprint Chart (Number Bars): guarda os últimos 60 candles de 1min
        self._footprint_history: deque = deque(maxlen=60)
        self._current_footprint: Optional[FootprintCandle] = None

        # Pre-Market Bias (Tracker de Sessão Longa)
        self._session_start_time: float = time.time()
        self._session_start_price: float = 0.0
        self._session_high: float = 0.0
        self._session_low: float = float("inf")
        self._session_buy_vol: float = 0.0
        self._session_sell_vol: float = 0.0
        self._session_pv_sum: float = 0.0
        self._session_v_sum: float = 0.0

        # Controle de tasks e parada
        self._running = False
        self._tasks: List[asyncio.Task] = []

        # Lock para acesso ao book
        self._book_lock = asyncio.Lock()

    # -----------------------------------------------------------------------
    # Controle de Sessão Diária / Fim de Semana
    # -----------------------------------------------------------------------
    
    def reset_session(self, current_price: float = 0.0) -> None:
        """Reseta os trackers de longo prazo (útil toda sexta 17h ou manualmente)."""
        self._session_start_time = time.time()
        self._session_start_price = current_price
        self._session_high = current_price
        self._session_low = current_price if current_price > 0 else float("inf")
        self._session_buy_vol = 0.0
        self._session_sell_vol = 0.0
        
        # VWAP: (Sum of Price * Volume) / (Sum of Volume)
        self._session_pv_sum = 0.0
        self._session_v_sum = 0.0
        logger.info(f"Sessão resetada! Preço base: {current_price}")

    # -----------------------------------------------------------------------
    # Ponto de entrada público
    # -----------------------------------------------------------------------

    async def connect(self) -> None:
        """Inicia todas as conexões WebSocket de forma assíncrona."""
        self._running = True
        logger.info("BinanceXAUConnector: iniciando conexões...")

        streams = [
            f"{SYMBOL}@depth@100ms",
            f"{SYMBOL}@aggTrade",
            f"{SYMBOL}@forceOrder",
        ]

        # Cria uma task por stream, cada uma com reconexão automática
        self._tasks = [
            asyncio.create_task(self._stream_loop(stream), name=stream)
            for stream in streams
        ]

        # Task de geração de snapshots para heatmap
        self._tasks.append(
            asyncio.create_task(self._snapshot_loop(), name="snapshot_loop")
        )

        await asyncio.gather(*self._tasks, return_exceptions=True)

    async def stop(self) -> None:
        """Para todas as conexões e tasks."""
        self._running = False
        for task in self._tasks:
            task.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)
        logger.info("BinanceXAUConnector: parado.")

    # -----------------------------------------------------------------------
    # Loop de stream com reconexão exponencial
    # -----------------------------------------------------------------------

    async def _stream_loop(self, stream: str) -> None:
        """Mantém conexão ao stream com backoff exponencial."""
        url = f"{BASE_WS_URL}/{stream}"
        delay = RECONNECT_BASE_DELAY

        while self._running:
            try:
                logger.info(f"Conectando a {url}")
                async with websockets.connect(
                    url,
                    ping_interval=20,
                    ping_timeout=10,
                    close_timeout=5,
                ) as ws:
                    delay = RECONNECT_BASE_DELAY  # reset ao conectar com sucesso
                    logger.info(f"Conectado: {stream}")
                    async for raw in ws:
                        if not self._running:
                            return
                        await self._dispatch(stream, raw)

            except asyncio.CancelledError:
                return
            except Exception as exc:
                logger.warning(f"Erro em {stream}: {exc}. Reconectando em {delay:.1f}s")
                await asyncio.sleep(delay)
                delay = min(delay * 2, RECONNECT_MAX_DELAY)

    # -----------------------------------------------------------------------
    # Despachante de mensagens
    # -----------------------------------------------------------------------

    async def _dispatch(self, stream: str, raw: str) -> None:
        """Direciona mensagem para o handler correto com base no stream."""
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            logger.error(f"JSON inválido em {stream}: {raw[:80]}")
            return

        if "depth" in stream:
            await self.process_order_book(data)
        elif "aggTrade" in stream:
            await self.process_trade(data)
        elif "forceOrder" in stream:
            await self._process_liquidation(data)

    # -----------------------------------------------------------------------
    # Processamento do Order Book (depth diff stream)
    # -----------------------------------------------------------------------

    async def process_order_book(self, data: dict) -> None:
        """
        Atualiza bids e asks a partir de uma mensagem diff do depth stream.
        Regra: qty == 0 → remove o nível; caso contrário, atualiza/insere.
        """
        async with self._book_lock:
            for price_str, qty_str in data.get("b", []):
                qty = float(qty_str)
                if qty == 0.0:
                    self._bids.pop(price_str, None)
                else:
                    self._bids[price_str] = qty

            for price_str, qty_str in data.get("a", []):
                qty = float(qty_str)
                if qty == 0.0:
                    self._asks.pop(price_str, None)
                else:
                    self._asks[price_str] = qty

            self._last_update_id = data.get("u", self._last_update_id)

    # -----------------------------------------------------------------------
    # Processamento de Trades Agregados
    # -----------------------------------------------------------------------

    async def process_trade(self, data: dict) -> None:
        """
        Processa um aggTrade.
        m=True  → buyer is maker → venda de mercado (sell pressure)
        m=False → buyer is taker → compra de mercado (buy pressure)
        """
        record = TradeRecord(
            timestamp=data["T"] / 1000.0,  # ms → s
            price=float(data["p"]),
            qty=float(data["q"]),
            is_buyer_maker=data["m"],
        )
        self._trades.append(record)
        
        # Atualização do Tracker de Sessão (Pre-Market Bias)
        if self._session_start_price == 0.0:
            self._session_start_price = record.price
            self._session_high = record.price
            self._session_low = record.price
        
        if record.price > self._session_high:
            self._session_high = record.price
        if record.price < self._session_low:
            self._session_low = record.price
            
        if record.is_buyer_maker: # Venda de Mercado
            self._session_sell_vol += record.qty
        else: # Compra de Mercado
            self._session_buy_vol += record.qty

        # Atualização de VWAP
        self._session_pv_sum += (record.price * record.qty)
        self._session_v_sum += record.qty
        
        # Atualizações normais
        self._update_footprint(record)
        self._purge_old_trades()

    def _purge_old_trades(self) -> None:
        """Remove trades mais antigos que a janela de delta."""
        cutoff = time.time() - self.delta_window
        while self._trades and self._trades[0].timestamp < cutoff:
            self._trades.popleft()

    # -----------------------------------------------------------------------
    # Processamento de Footprint (Number Bars)
    # -----------------------------------------------------------------------

    def _update_footprint(self, trade: TradeRecord) -> None:
        """Agrega o trade em candles de 1 minuto agrupados por preço."""
        # Trunca para o minuto atual
        minute_ts = float(int(trade.timestamp / 60) * 60)
        
        # Cria novo candle se virou o minuto ou é o primeiro
        if not self._current_footprint or self._current_footprint.timestamp < minute_ts:
            if self._current_footprint:
                self._footprint_history.append(self._current_footprint)
            
            self._current_footprint = FootprintCandle(
                timestamp=minute_ts,
                open=trade.price,
                high=trade.price,
                low=trade.price,
                close=trade.price,
                volume=0.0,
                buy_volume=0.0,
                sell_volume=0.0,
                levels={}
            )
            
        fp = self._current_footprint
        
        # Atualiza OHLC
        fp.high = max(fp.high, trade.price)
        fp.low = min(fp.low, trade.price)
        fp.close = trade.price
        
        # Agrupa preços em bins de $0.50 para o footprint chart
        price_bin = np.floor(trade.price / 0.5) * 0.5
        
        if price_bin not in fp.levels:
            fp.levels[price_bin] = {"buy": 0.0, "sell": 0.0}
            
        fp.volume += trade.qty
        if trade.is_buyer_maker: # Maker era comprador -> agressor VENDEU a mercado
            fp.sell_volume += trade.qty
            fp.levels[price_bin]["sell"] += trade.qty
        else:
            fp.buy_volume += trade.qty
            fp.levels[price_bin]["buy"] += trade.qty

    # -----------------------------------------------------------------------
    # Processamento de Liquidações
    # -----------------------------------------------------------------------

    async def _process_liquidation(self, data: dict) -> None:
        """Registra uma liquidação forçada."""
        order = data.get("o", {})
        price = float(order.get("p", 0) or order.get("ap", 0))
        qty = float(order.get("q", 0))
        record = LiquidationRecord(
            timestamp=data.get("E", time.time() * 1000) / 1000.0,
            side=order.get("S", "UNKNOWN"),
            price=price,
            qty=qty,
            value_usd=price * qty,
        )
        self._liquidations.append(record)
        logger.info(
            f"LIQUIDAÇÃO {record.side}: {record.qty:.4f} @ {record.price:.2f} "
            f"(${record.value_usd:,.0f})"
        )

    # -----------------------------------------------------------------------
    # Snapshot para Heatmap
    # -----------------------------------------------------------------------

    async def _snapshot_loop(self) -> None:
        """Gera snapshots periódicos do book para o heatmap."""
        while self._running:
            now = time.time()
            if now - self._last_snapshot_time >= self.heatmap_interval:
                snap = self._build_snapshot(now)
                if snap:
                    self._heatmap.append(snap)
                    self._last_snapshot_time = now
            await asyncio.sleep(0.1)  # checagem a cada 100ms

    def _build_snapshot(self, ts: float) -> Optional[BookSnapshot]:
        """Constrói um BookSnapshot a partir do estado atual do book."""
        if not self._bids or not self._asks:
            return None

        top_bids = sorted(
            ((float(p), q) for p, q in self._bids.items()),
            reverse=True
        )[:100]
        top_asks = sorted(
            ((float(p), q) for p, q in self._asks.items())
        )[:100]

        best_bid = top_bids[0][0] if top_bids else 0.0
        best_ask = top_asks[0][0] if top_asks else 0.0
        mid = (best_bid + best_ask) / 2.0 if best_bid and best_ask else 0.0
        spread = best_ask - best_bid if best_bid and best_ask else 0.0

        return BookSnapshot(
            timestamp=ts,
            bids=top_bids,
            asks=top_asks,
            mid=mid,
            spread=spread,
        )

    # -----------------------------------------------------------------------
    # API Pública: get_book_summary
    # -----------------------------------------------------------------------

    def get_book_summary(self) -> Optional[BookSummary]:
        """
        Retorna estado atual do book: mid, spread, top 10 bids/asks, walls.
        Thread-safe para leituras (sem lock — usa cópia local).
        """
        if not self._bids or not self._asks:
            return None

        # Cópias locais para evitar race condition durante leitura
        bids = {float(p): q for p, q in self._bids.items()}
        asks = {float(p): q for p, q in self._asks.items()}

        top_bids = sorted(bids.items(), reverse=True)[:10]
        top_asks = sorted(asks.items())[:10]

        best_bid = top_bids[0][0] if top_bids else 0.0
        best_ask = top_asks[0][0] if top_asks else 0.0
        mid = (best_bid + best_ask) / 2.0
        spread = best_ask - best_bid
        spread_pct = (spread / mid * 100.0) if mid else 0.0

        walls = self.detect_walls(bids, asks)

        return BookSummary(
            mid=mid,
            spread=spread,
            spread_pct=spread_pct,
            top_bids=top_bids,
            top_asks=top_asks,
            walls=walls,
            timestamp=time.time(),
        )

    # -----------------------------------------------------------------------
    # API Pública: get_delta_stats
    # -----------------------------------------------------------------------

    def get_delta_stats(self) -> DeltaStats:
        """
        Calcula delta de pressão compradora/vendedora na janela de delta_window segundos.
        - is_buyer_maker=True  → venda de mercado → sell_volume
        - is_buyer_maker=False → compra de mercado → buy_volume
        """
        self._purge_old_trades()
        buy_volume = 0.0
        sell_volume = 0.0

        for t in self._trades:
            if t.is_buyer_maker:
                sell_volume += t.qty
            else:
                buy_volume += t.qty

        delta = buy_volume - sell_volume
        total = buy_volume + sell_volume

        if total == 0:
            pressure = "NEUTRAL"
        elif delta / total > 0.1:
            pressure = "BUY"
        elif delta / total < -0.1:
            pressure = "SELL"
        else:
            pressure = "NEUTRAL"

        return DeltaStats(
            delta=delta,
            buy_volume=buy_volume,
            sell_volume=sell_volume,
            total_volume=total,
            pressure=pressure,
            window_seconds=self.delta_window,
        )

    # -----------------------------------------------------------------------
    # API Pública: Session Stats (Pre-Market Bias)
    # -----------------------------------------------------------------------

    def get_session_stats(self) -> SessionStats:
        """Retorna as estatísticas persistentes de longa duração da sessão de bias."""
        return SessionStats(
            start_time=self._session_start_time,
            start_price=self._session_start_price,
            high=self._session_high,
            low=self._session_low,
            buy_volume=self._session_buy_vol,
            sell_volume=self._session_sell_vol,
            delta_xau=self._session_buy_vol - self._session_sell_vol,
            cumulative_delta=self._session_buy_vol - self._session_sell_vol,
            vwap=self._session_pv_sum / self._session_v_sum if self._session_v_sum > 0 else 0.0
        )

    # -----------------------------------------------------------------------
    # API Pública: get_heatmap_data e get_recent_trades
    # -----------------------------------------------------------------------

    def get_heatmap_data(self) -> List[BookSnapshot]:
        """Retorna lista de snapshots do book (até 4h de histórico)."""
        return list(self._heatmap)

    def get_recent_trades(self, limit: int = 50) -> List[Dict]:
        """Retorna os últimos `limit` trades executados."""
        trades = list(self._trades)[-limit:]
        return [
            {
                "timestamp": t.timestamp,
                "price": t.price,
                "qty": t.qty,
                "side": "SELL" if t.is_buyer_maker else "BUY",
                "value_usd": t.price * t.qty,
            }
            for t in trades
        ]

    # -----------------------------------------------------------------------
    # API Pública: Footprint Chart
    # -----------------------------------------------------------------------

    def get_footprint_history(self) -> List[Dict]:
        """Retorna histórico completo de candles do footprint."""
        return [fp.to_dict() for fp in self._footprint_history]

    def get_current_footprint(self) -> Optional[Dict]:
        """Retorna a vela de footprint que está em formação agora."""
        if self._current_footprint:
            return self._current_footprint.to_dict()
        return None

    # -----------------------------------------------------------------------
    # API Pública: get_stop_clusters (Radar de Stops/Liquidez)
    # -----------------------------------------------------------------------

    def get_stop_clusters(self, bin_size: float = 1.0, top_n: int = 3) -> Dict[str, List[Dict]]:
        """
        Agrupa o order book em blocos (bins) de `bin_size` e retorna as zonas com maior acumulação.
        Ideal para identificar prováveis zonas de stops ou clusters de liquidez institucionais.
        """
        if not self._bids or not self._asks:
            return {"bids": [], "asks": []}

        # Cópias locais
        bids = {float(p): q for p, q in self._bids.items()}
        asks = {float(p): q for p, q in self._asks.items()}

        def _aggregate(levels: Dict[float, float], side: str) -> List[Dict]:
            bins = {}
            for price, qty in levels.items():
                if side == "bid":
                    # bids arredondados para baixo (ex: 2045.8 -> 2045.0 se bin_size=1)
                    bin_price = np.floor(price / bin_size) * bin_size
                else:
                    # asks arredondados para cima (ex: 2045.2 -> 2046.0 se bin_size=1)
                    bin_price = np.ceil(price / bin_size) * bin_size

                bins[bin_price] = bins.get(bin_price, 0.0) + qty

            # Ordena por volume decrescente e pega os top_n maiores blocos
            sorted_bins = sorted(bins.items(), key=lambda x: x[1], reverse=True)[:top_n]
            return [{"price": p, "qty": q} for p, q in sorted_bins]

        return {
            "bids": _aggregate(bids, "bid"),
            "asks": _aggregate(asks, "ask"),
        }

    # -----------------------------------------------------------------------
    # Detecção de Walls (numpy)
    # -----------------------------------------------------------------------

    def detect_walls(
        self,
        bids: Optional[Dict[float, float]] = None,
        asks: Optional[Dict[float, float]] = None,
    ) -> List[WallLevel]:
        """
        Detecta walls usando dois critérios complementares:
        1. Absoluto: qty > wall_absolute (padrão 100 BTC equivalente)
        2. Z-score:  qty > mean + wall_zscore * std (padrão 2σ)

        Parâmetros opcionais para reutilizar dicts já copiados (evita double-copy).
        """
        if bids is None:
            bids = {float(p): q for p, q in self._bids.items()}
        if asks is None:
            asks = {float(p): q for p, q in self._asks.items()}

        walls: List[WallLevel] = []

        for side_name, levels in [("bid", bids), ("ask", asks)]:
            if not levels:
                continue

            prices = np.array(list(levels.keys()), dtype=np.float64)
            qtys = np.array(list(levels.values()), dtype=np.float64)

            # Volumes em USD (price * qty) para critério absoluto
            values_usd = prices * qtys

            # Threshold absoluto: converte 100 BTC em USD usando preço médio do book
            mean_price = float(prices.mean())
            absolute_usd = self.wall_absolute * mean_price
            absolute_mask = values_usd > absolute_usd

            # Z-score sobre as quantidades
            mu = qtys.mean()
            sigma = qtys.std()
            zscore_mask = (qtys > mu + self.wall_zscore * sigma) if sigma > 0 else np.zeros(len(qtys), dtype=bool)

            combined_mask = absolute_mask | zscore_mask

            for i in np.where(combined_mask)[0]:
                method = []
                if absolute_mask[i]:
                    method.append("absolute")
                if zscore_mask[i]:
                    method.append("zscore")
                walls.append(WallLevel(
                    side=side_name,
                    price=float(prices[i]),
                    qty=float(qtys[i]),
                    method="+".join(method),
                ))

        # Ordena por valor USD descendente
        walls.sort(key=lambda w: w.price * w.qty, reverse=True)
        return walls

    # -----------------------------------------------------------------------
    # Propriedades de conveniência (leitura direta)
    # -----------------------------------------------------------------------

    @property
    def is_running(self) -> bool:
        return self._running

    @property
    def book_depth(self) -> Tuple[int, int]:
        """Retorna (num_bids, num_asks) atualmente no book."""
        return len(self._bids), len(self._asks)

    @property
    def liquidations(self) -> List[LiquidationRecord]:
        """Histórico de liquidações."""
        return list(self._liquidations)


# ---------------------------------------------------------------------------
# Exemplo de uso standalone
# ---------------------------------------------------------------------------

async def _main():
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )
    connector = BinanceXAUConnector()

    async def _monitor():
        """Imprime stats a cada 5 segundos."""
        await asyncio.sleep(5)
        while connector.is_running:
            summary = connector.get_book_summary()
            delta = connector.get_delta_stats()
            if summary:
                print(
                    f"\n[BOOK] mid={summary.mid:.2f}  spread={summary.spread:.2f} "
                    f"({summary.spread_pct:.3f}%)  "
                    f"bids/asks={connector.book_depth}"
                )
                print(f"[DELTA] Δ={delta.delta:+.4f}  buy={delta.buy_volume:.4f}  "
                      f"sell={delta.sell_volume:.4f}  pressão={delta.pressure}")
                if summary.walls:
                    print(f"[WALLS] {len(summary.walls)} wall(s) detectado(s):")
                    for w in summary.walls[:5]:
                        print(f"  {w.side.upper():4s} @ {w.price:.2f}  qty={w.qty:.4f}  [{w.method}]")
                print(f"[HEATMAP] snapshots={len(connector.get_heatmap_data())}")
            await asyncio.sleep(5)

    monitor_task = asyncio.create_task(_monitor())
    try:
        await connector.connect()
    except KeyboardInterrupt:
        pass
    finally:
        await connector.stop()
        monitor_task.cancel()


if __name__ == "__main__":
    asyncio.run(_main())
