"""
API FastAPI + WebSocket para XAU Order Flow
"""

import asyncio
import json
import logging
from datetime import datetime
from typing import List, Dict, Optional
from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from market_data.binance_connector import BinanceXAUConnector
from market_data.signal_detector import SignalDetector

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Gerenciador de conexões
class ConnectionManager:
    def __init__(self):
        self.active_connections: List[WebSocket] = []
        self.connector: Optional[BinanceXAUConnector] = None
        
    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)
        logger.info(f"Cliente conectado. Total: {len(self.active_connections)}")
        
    def disconnect(self, websocket: WebSocket):
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)
            
    async def broadcast(self, message: Dict):
        disconnected = []
        for connection in self.active_connections:
            try:
                await connection.send_json(message)
            except:
                disconnected.append(connection)
        for conn in disconnected:
            self.disconnect(conn)

manager = ConnectionManager()
detector = SignalDetector()

# Lifespan (startup/shutdown)
@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Iniciando conector Binance...")
    manager.connector = BinanceXAUConnector()
    
    # Broadcast loop — envia market_data + heatmap_snapshot a cada 1s
    async def broadcast_loop():
        while True:
            if manager.connector and manager.connector.is_running:
                summary = manager.connector.get_book_summary()
                delta = manager.connector.get_delta_stats()
                if summary:
                    # Detecta sinais operacionais
                    new_signals = detector.update(
                        summary, delta, manager.connector.liquidations
                    )

                    await manager.broadcast({
                        "type": "market_data",
                        "timestamp": datetime.now().isoformat(),
                        "mid": summary.mid,
                        "spread": summary.spread,
                        "delta_pressure": delta.pressure,
                        "delta_value": delta.delta,
                        "walls": len(summary.walls),
                        "depth": manager.connector.book_depth,
                        "top_bids": [
                            {"price": p, "qty": q}
                            for p, q in summary.top_bids
                        ],
                        "top_asks": [
                            {"price": p, "qty": q}
                            for p, q in summary.top_asks
                        ],
                        "wall_levels": [
                            {"side": w.side, "price": w.price, "qty": w.qty}
                            for w in summary.walls[:10]
                        ],
                        # Radar de Stops (clusters de liquidez agrupados de $1 em $1)
                        "stop_clusters": manager.connector.get_stop_clusters(bin_size=1.0, top_n=3),
                        # Fita de Impressão (Time & Sales)
                        "recent_trades": manager.connector.get_recent_trades(limit=100),
                        # Footprint Chart (atualiza a vela do minuto atual em tempo real)
                        "current_footprint": manager.connector.get_current_footprint(),
                        # Sinais operacionais: apenas os novos neste ciclo
                        "new_signals": [s.to_dict() for s in new_signals],
                        # Estatísticas de Sessão (Pre-Market Bias / Weekend Tracker)
                        "session_stats": manager.connector.get_session_stats().__dict__,
                    })
            await asyncio.sleep(1)
    
    asyncio.create_task(broadcast_loop())
    asyncio.create_task(manager.connector.connect())
    
    yield
    
    await manager.connector.stop()

app = FastAPI(title="XAU Order Flow API", lifespan=lifespan)

# Configuração de CORS para produção
ALLOWED_ORIGINS = os.getenv("ALLOWED_ORIGINS", "http://localhost:3000").split(",")

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/")
async def root():
    return {
        "status": "online",
        "mid": manager.connector.get_book_summary().mid if manager.connector else None,
        "clients": len(manager.active_connections)
    }

@app.get("/api/snapshot")
async def snapshot():
    if not manager.connector:
        return {"error": "offline"}
    s = manager.connector.get_book_summary()
    d = manager.connector.get_delta_stats()
    return {
        "mid": s.mid if s else None,
        "spread": s.spread if s else None,
        "walls": [{"side": w.side, "price": w.price, "qty": w.qty} for w in (s.walls if s else [])],
        "delta": d.delta,
        "pressure": d.pressure
    }

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await manager.connect(websocket)
    try:
        while True:
            data = await websocket.receive_text()
            msg = json.loads(data)
            if msg.get("action") == "ping":
                await websocket.send_json({"type": "pong"})
    except WebSocketDisconnect:
        manager.disconnect(websocket)
    except Exception as e:
        logger.error(f"Erro: {e}")
        manager.disconnect(websocket)


@app.get("/api/heatmap")
async def get_heatmap():
    """
    Retorna os snapshots do heatmap dos últimos 4h.
    Usado para carga inicial ou polling REST.
    """
    if not manager.connector:
        return {"snapshots": []}

    snaps = manager.connector.get_heatmap_data()
    return {
        "count": len(snaps),
        "snapshots": [
            {
                "timestamp": s.timestamp,
                "mid": s.mid,
                "vwap": (sum(p*q for p,q in s.bids) + sum(p*q for p,q in s.asks)) / (sum(q for p,q in s.bids) + sum(q for p,q in s.asks)) if (sum(q for p,q in s.bids) + sum(q for p,q in s.asks)) > 0 else s.mid,
                "spread": s.spread,
                "bids": [{"price": p, "qty": q} for p, q in s.bids],
                "asks": [{"price": p, "qty": q} for p, q in s.asks],
            }
            for s in snaps[-3600:]  # últimas 1h para performance
        ],
    }

@app.get("/api/signals")
async def get_signals():
    """Retorna histórico de sinais detectados."""
    return {
        "signals": [s.to_dict() for s in detector.get_history()],
    }

@app.get("/api/footprint")
async def get_footprint():
    """Retorna histórico de candles do footprint."""
    if not manager.connector:
        return {"candles": []}
        
    return {
        "candles": manager.connector.get_footprint_history()
    }

@app.post("/api/session/reset")
async def reset_session():
    """Reseta manualmente o tracker de viés de abertura."""
    summary = manager.connector.get_book_summary()
    price = summary.mid if summary else 0.0
    manager.connector.reset_session(current_price=price)
    return {"status": "ok", "reset_price": price}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)