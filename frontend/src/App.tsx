import React, { useEffect, useState, useRef, useCallback } from 'react';
import './App.css';
import OrderBookHeatmap, { HeatmapSnapshot } from './components/OrderBookHeatmap';
import SignalsDashboard, { Signal } from './components/SignalsDashboard';
import TradeTape, { Trade } from './components/TradeTape';
import FootprintChart, { FootprintCandle } from './components/FootprintChart';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MarketData {
  type: string;
  timestamp: string;
  mid: number;
  spread: number;
  delta_pressure: string;
  delta_value: number;
  walls: number;
  depth: [number, number];
  top_bids?: { price: number; qty: number }[];
  top_asks?: { price: number; qty: number }[];
  wall_levels?: { side: string; price: number; qty: number }[];
  stop_clusters?: { 
    bids: { price: number; qty: number }[]; 
    asks: { price: number; qty: number }[]; 
  };
  recent_trades?: Trade[];
  current_footprint?: FootprintCandle;
  new_signals?: Signal[];
  session_stats?: {
    start_time: number;
    start_price: number;
    high: number;
    low: number;
    buy_volume: number;
    sell_volume: number;
    delta_xau: number;
  };
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

function App() {
  const [connected, setConnected] = useState(false);
  const [data, setData] = useState<MarketData | null>(null);
  const [history, setHistory] = useState<number[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [heatmapSnaps, setHeatmapSnaps] = useState<HeatmapSnapshot[]>([]);
  const [signals, setSignals] = useState<Signal[]>([]);
  const [newSignalCount, setNewSignalCount] = useState(0);
  const [activeTab, setActiveTab] = useState<'chart' | 'heatmap' | 'signals' | 'footprint'>('heatmap');
  const [footprints, setFootprints] = useState<FootprintCandle[]>([]);

  // Ref para acumular snapshots sem forçar render a cada mensagem
  const snapAccumRef = useRef<HeatmapSnapshot[]>([]);

  // Carga inicial de snapshots históricos via REST
  useEffect(() => {
    fetch('http://localhost:8000/api/heatmap')
      .then(r => r.json())
      .then(resp => {
        if (resp.snapshots?.length) {
          const loaded: HeatmapSnapshot[] = resp.snapshots.map((s: any) => ({
            timestamp: s.timestamp,
            mid: s.mid,
            bids: s.bids,
            asks: s.asks,
            walls: s.walls
          }));
          snapAccumRef.current = loaded;
          setHeatmapSnaps(loaded);
        }
      });
      
    fetch('http://localhost:8000/api/footprint')
      .then(r => r.json())
      .then(resp => {
        if (resp.candles) {
          setFootprints(resp.candles);
        }
      });

    // Pré-carrega histórico de sinais
    fetch('http://localhost:8000/api/signals')
      .then(r => r.json())
      .then(resp => {
        if (resp.signals?.length) {
          setSignals(resp.signals as Signal[]);
        }
      })
      .catch(() => {});
  }, []);

  // WebSocket principal: recebe market_data e gera snapshots em tempo real
  useEffect(() => {
    const ws = new WebSocket('ws://localhost:8000/ws');

    ws.onopen = () => {
      setConnected(true);
      setError(null);
    };

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data) as MarketData;
      if (msg.type === 'market_data') {
        setData(msg);
        setHistory(prev => [...prev.slice(-80), msg.mid]);

        // Acumula snapshot para heatmap (a cada mensagem recebida ~1s)
        if (msg.top_bids && msg.top_asks && msg.mid) {
          const snap: HeatmapSnapshot = {
            timestamp: Date.now() / 1000,
            mid: msg.mid,
            bids: msg.top_bids.map(l => ({ price: l.price, qty: l.qty })),
            asks: msg.top_asks.map(l => ({ price: l.price, qty: l.qty })),
            walls: msg.wall_levels?.map(w => ({
              side: w.side as 'bid' | 'ask',
              price: w.price,
              qty: w.qty,
            })),
          };
          snapAccumRef.current = [...snapAccumRef.current.slice(-14399), snap];
          setHeatmapSnaps([...snapAccumRef.current]);
        }

        // Acumula sinais recebidos no ciclo
        if (msg.new_signals && msg.new_signals.length > 0) {
          const incoming = msg.new_signals;
          setSignals(prev => [...prev.slice(-199), ...incoming]);
          // Incrementa badge apenas se aba não estiver ativa
          setNewSignalCount(prev =>
            activeTab !== 'signals' ? prev + incoming.length : 0
          );
        }
        
        // Acumula Footprint real-time (substitui vela atual se mesmo timestamp, ou adiciona vela nova)
        if (msg.current_footprint) {
          const curr = msg.current_footprint;
          setFootprints(prev => {
            const arr = [...prev];
            const idx = arr.findIndex(f => f.timestamp === curr.timestamp);
            if (idx >= 0) {
              arr[idx] = curr; // atualiza vela do minuto em tempo real
            } else {
              arr.push(curr); // fechou minuto anterior, cria nova
              if (arr.length > 60) arr.shift();
            }
            return arr;
          });
        }
      }
    };

    ws.onerror = () => {
      setError('Erro na conexão WebSocket');
      setConnected(false);
    };

    ws.onclose = () => setConnected(false);

    return () => ws.close();
  }, []);

  // ---------------------------------------------------------------------------
  // UI helpers
  // ---------------------------------------------------------------------------

  const getPressureColor = (pressure: string) => {
    if (pressure === 'BUY') return '#00d084';
    if (pressure === 'SELL') return '#ff4757';
    return '#ffa502';
  };

  const getPressureGlow = (pressure: string) => {
    if (pressure === 'BUY') return '0 0 20px rgba(0,208,132,0.3)';
    if (pressure === 'SELL') return '0 0 20px rgba(255,71,87,0.3)';
    return '0 0 20px rgba(255,165,2,0.2)';
  };

  // ---------------------------------------------------------------------------
  // Mini price chart (sparkline)
  // ---------------------------------------------------------------------------
  const PriceChart = useCallback(() => {
    const min = Math.min(...history);
    const max = Math.max(...history);
    const range = max - min || 1;
    return (
      <div className="price-chart">
        {history.map((price, i) => {
          const height = ((price - min) / range) * 100;
          const isLast = i === history.length - 1;
          return (
            <div
              key={i}
              className="chart-bar"
              style={{
                height: `${Math.max(height, 3)}%`,
                background: isLast
                  ? 'linear-gradient(to top, #fff 0%, #aaa 100%)'
                  : undefined,
              }}
              title={`$${price.toFixed(2)}`}
            />
          );
        })}
      </div>
    );
  }, [history]);

  // ---------------------------------------------------------------------------
  // Stop Radar Helper
  // ---------------------------------------------------------------------------
  const renderStopRadar = () => {
    if (!data?.stop_clusters) return null;
    const { bids, asks } = data.stop_clusters;
    const topAsk = asks[0]; // maior cluster de ask (Resistência / Buy Stops)
    const topBid = bids[0]; // maior cluster de bid (Suporte / Sell Stops)

    const renderClusterRow = (cluster: {price: number; qty: number} | undefined, side: 'ask'|'bid') => {
      if (!cluster) return <div className="radar-empty">Aguardando...</div>;
      
      const distUsd = Math.abs(cluster.price - data.mid);
      const distPct = (distUsd / data.mid) * 100;
      const isDanger = distPct < 0.15; // < 0.15% de distância = Perigo
      
      return (
        <div className={`radar-row ${isDanger ? 'radar-danger' : ''} ${side === 'ask' ? 'radar-ask' : 'radar-bid'}`}>
          <div className="radar-header">
            <span className="radar-price">${cluster.price.toFixed(0)}</span>
            <span className="radar-dist">{distPct.toFixed(2)}% (${distUsd.toFixed(1)})</span>
          </div>
          <div className="radar-bar-bg">
            <div 
              className="radar-bar-fill" 
              style={{ width: `${Math.min((cluster.qty / 500) * 100, 100)}%` }}
            />
          </div>
          <div className="radar-footer">
            <span className="radar-label">{side === 'ask' ? 'Buy Stops / Resistência' : 'Sell Stops / Suporte'}</span>
            <span className="radar-qty">{cluster.qty.toFixed(1)} XAU</span>
          </div>
        </div>
      );
    };

    return (
      <div className="radar-panel">
        <h3>Radar de Stops 🎯</h3>
        <p className="radar-desc">Acúmulos de liquidez (blocos de $1)</p>
        <div className="radar-zones">
          {renderClusterRow(topAsk, 'ask')}
          <div className="radar-mid-marker">
            <div className="radar-mid-line" />
            <span>${data.mid.toFixed(2)}</span>
          </div>
          {renderClusterRow(topBid, 'bid')}
        </div>
      </div>
    );
  };

  // ---------------------------------------------------------------------------
  // Session Bias Helper (Weekend/Pause Tracker)
  // ---------------------------------------------------------------------------
  const renderSessionBias = () => {
    if (!data?.session_stats) return null;
    const s = data.session_stats;
    const isBull = s.delta_xau > 0;
    const sessionRange = s.high - s.low;
    const priceFromStart = data.mid - s.start_price;
    const gapPct = (priceFromStart / s.start_price) * 100;
    
    return (
      <div className={`session-bias-panel ${isBull ? 'bias-bull' : 'bias-bear'}`}>
        <div className="bias-header">
            <h3>PRE-MARKET BIAS ⏱️</h3>
            <span className={`bias-indicator ${isBull ? 'bull' : 'bear'}`}>
                {isBull ? '💹 BULLISH' : '📉 BEARISH'}
            </span>
        </div>
        
        <div className="bias-body">
            <div className="bias-stat">
                <span className="label">Saldo Δ (CVD)</span>
                <span className="value">{s.delta_xau > 0 ? '+' : ''}{s.delta_xau.toFixed(2)} XAU</span>
            </div>
            <div className={`bias-stat ${priceFromStart >= 0 ? 'up' : 'down'}`}>
                <span className="label">Gap Desvio</span>
                <span className="value">{priceFromStart >= 0 ? '+' : ''}${priceFromStart.toFixed(2)} ({gapPct.toFixed(2)}%)</span>
            </div>
            <div className="bias-range-bar">
                <div className="range-labels">
                    <span>L: ${s.low.toFixed(0)}</span>
                    <span>H: ${s.high.toFixed(0)}</span>
                </div>
                <div className="range-track">
                    <div 
                        className="range-fill" 
                        style={{ 
                            left: `${((s.start_price - s.low) / (sessionRange || 1)) * 100}%`,
                            width: '2px',
                            background: '#fff',
                            position: 'absolute',
                            height: '100%',
                            opacity: 0.5
                        }}
                        title="Opening Price"
                    />
                    <div 
                        className="range-marker" 
                        style={{ left: `${((data.mid - s.low) / (sessionRange || 1)) * 100}%` }}
                    />
                </div>
            </div>
        </div>
        
        <button 
            className="session-reset-btn"
            onClick={() => {
                if(window.confirm("Deseja resetar a sessão de viés agora?")) {
                    fetch('http://localhost:8000/api/session/reset', { method: 'POST' });
                }
            }}
        >
            RESETAR SESSÃO
        </button>
      </div>
    );
  };

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  return (
    <div className="app">
      {/* Header */}
      <header className="header">
        <div className="header-left">
          <span className="header-symbol">XAU</span>
          <span className="header-subtitle">ORDER FLOW · BINANCE FUTURES</span>
        </div>
        <div className={`status ${connected ? 'online' : 'offline'}`}>
          {connected ? '● LIVE' : '● OFFLINE'}
        </div>
      </header>

      {error && <div className="error-banner">{error} — reconectando...</div>}

      <div className="dashboard">
        {/* Painel Principal */}
        <div className="main-panel">
          {data ? (
            <>
              {/* Preço / spread / pressão em destaque */}
              <div className="price-row">
                <div className="price-block">
                  <div className="price-label">MID PRICE</div>
                  <div className="price-value">${data.mid.toLocaleString('en-US', { minimumFractionDigits: 2 })}</div>
                  <div className="price-spread">spread {data.spread.toFixed(2)}</div>
                </div>

                <div
                  className="pressure-block"
                  style={{
                    color: getPressureColor(data.delta_pressure),
                    boxShadow: getPressureGlow(data.delta_pressure),
                  }}
                >
                  <div className="pressure-label">PRESSÃO</div>
                  <div className="pressure-value">{data.delta_pressure}</div>
                  <div className="pressure-delta">
                    Δ {data.delta_value > 0 ? '+' : ''}{data.delta_value.toFixed(4)}
                  </div>
                </div>

                <div className="stats-mini">
                  <div className="mini-stat">
                    <span className="mini-label">WALLS</span>
                    <span className="mini-value accent">{data.walls}</span>
                  </div>
                  <div className="mini-stat">
                    <span className="mini-label">BIDS</span>
                    <span className="mini-value green">{data.depth[0]}</span>
                  </div>
                  <div className="mini-stat">
                    <span className="mini-label">ASKS</span>
                    <span className="mini-value red">{data.depth[1]}</span>
                  </div>
                </div>
              </div>

              {/* Tabs: Heatmap | Gráfico de preço | Sinais | Footprint */}
              <div className="tab-bar">
                <button
                  className={`tab-btn ${activeTab === 'heatmap' ? 'active' : ''}`}
                  onClick={() => setActiveTab('heatmap')}
                >
                  HEATMAP
                </button>
                <button
                  className={`tab-btn ${activeTab === 'chart' ? 'active' : ''}`}
                  onClick={() => setActiveTab('chart')}
                >
                  PRICE CHART
                </button>
                <button
                  className={`tab-btn ${activeTab === 'signals' ? 'active' : ''}`}
                  onClick={() => { setActiveTab('signals'); setNewSignalCount(0); }}
                >
                  SINAIS
                  {newSignalCount > 0 && (
                    <span className="tab-badge">{newSignalCount}</span>
                  )}
                </button>
                <button
                  className={`tab-btn ${activeTab === 'footprint' ? 'active' : ''}`}
                  onClick={() => setActiveTab('footprint')}
                >
                  👣 FOOTPRINT
                </button>
              </div>

              {activeTab === 'signals' && (
                <SignalsDashboard signals={signals} />
              )}

              {activeTab === 'heatmap' && (
                <OrderBookHeatmap
                  snapshots={heatmapSnaps}
                  maxColumns={120}
                  height={380}
                  priceRows={60}
                />
              )}

              {activeTab === 'chart' && (
                <div className="chart-container">
                  <div className="chart-label">Preço — últimos {history.length} ticks</div>
                  <PriceChart />
                </div>
              )}

              {activeTab === 'footprint' && (
                <div className="chart-wrapper footprint-view" style={{ height: 400 }}>
                  <FootprintChart candles={footprints} />
                </div>
              )}


              {/* Mini Book (top 5 bids/asks) */}
              {data.top_bids && data.top_asks && (
                <div className="mini-book">
                  <div className="mini-book-col">
                    <div className="mini-book-header asks-header">ASKS</div>
                    {[...(data.top_asks ?? [])].reverse().map((l, i) => (
                      <div key={i} className="mini-book-row ask-row">
                        <span className="book-qty">{l.qty.toFixed(4)}</span>
                        <span className="book-price ask-price">${l.price.toFixed(2)}</span>
                      </div>
                    ))}
                  </div>
                  <div className="mini-book-sep">
                    <div className="sep-mid">${data.mid.toFixed(2)}</div>
                  </div>
                  <div className="mini-book-col">
                    <div className="mini-book-header bids-header">BIDS</div>
                    {(data.top_bids ?? []).map((l, i) => (
                      <div key={i} className="mini-book-row bid-row">
                        <span className="book-price bid-price">${l.price.toFixed(2)}</span>
                        <span className="book-qty">{l.qty.toFixed(4)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className="loading">
              <div className="loading-dot" />
              Aguardando dados do servidor...
            </div>
          )}
        </div>

        {/* Sidebar */}
        <div className="sidebar">
          <div className="info-panel">
            <h3>Configuração</h3>
            <p><strong>Stream:</strong> Binance Futures</p>
            <p><strong>Par:</strong> XAUUSDT Perp.</p>
            <p><strong>Book:</strong> depth@100ms</p>
            <p><strong>Trades:</strong> aggTrade</p>
            <p><strong>Liq.:</strong> forceOrder</p>
            <p><strong>Delta:</strong> janela 60s</p>
            <p><strong>Heatmap:</strong> 4h / 1s</p>
          </div>

          <div className="legend">
            <h3>Heatmap</h3>
            <div className="legend-item">
              <span className="dot green"></span> Volume de compra (bid)
            </div>
            <div className="legend-item">
              <span className="dot red"></span> Volume de venda (ask)
            </div>
            <div className="legend-item">
              <span className="dot yellow"></span> Wall detectado
            </div>
            <div className="legend-item">
              <span className="dot white"></span> Mid price
            </div>
          </div>

          <div className="alerts">
            <h3>Status</h3>
            <div className="status-item">
              <span className="label">WebSocket</span>
              <span className={connected ? 'value online' : 'value offline'}>
                {connected ? 'Ativo' : 'Inativo'}
              </span>
            </div>
            <div className="status-item">
              <span className="label">Dados</span>
              <span className={data ? 'value online' : 'value offline'}>
                {data ? 'Recebendo' : 'Pendente'}
              </span>
            </div>
            <div className="status-item">
              <span className="label">Snapshots</span>
              <span className="value">{heatmapSnaps.length}</span>
            </div>
            <div className="status-item">
              <span className="label">Walls</span>
              <span className="value accent">{data?.walls ?? 0}</span>
            </div>
          </div>

          {/* Viés de Sessão (Weekend / Pre-Market Bias) */}
          {renderSessionBias()}

          {/* Radar de Stops */}
          {renderStopRadar()}

          {/* Trade Tape (Time & Sales) */}
          {data?.recent_trades && data.recent_trades.length > 0 && (
            <div className="tape-wrapper">
              <TradeTape trades={data.recent_trades} />
            </div>
          )}

          {/* Top walls */}
          {data?.wall_levels && data.wall_levels.length > 0 && (
            <div className="walls-panel">
              <h3>Walls Detectados</h3>
              {data.wall_levels.slice(0, 5).map((w, i) => (
                <div key={i} className="wall-row">
                  <span className={`wall-side ${w.side === 'bid' ? 'green' : 'red'}`}>
                    {w.side.toUpperCase()}
                  </span>
                  <span className="wall-price">${w.price.toFixed(2)}</span>
                  <span className="wall-qty">{w.qty.toFixed(3)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <footer className="footer">
        <div>
          {data?.timestamp
            ? new Date(data.timestamp).toLocaleTimeString('pt-BR')
            : '—'}{' '}
          · {heatmapSnaps.length} snapshots
        </div>
        <div className="disclaimer">
          Binance Futures XAUUSDT · Mesa proprietária
        </div>
      </footer>
    </div>
  );
}

export default App;