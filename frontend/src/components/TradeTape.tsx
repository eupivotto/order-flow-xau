import React, { useRef, useEffect } from 'react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Trade {
  timestamp: number; // epoch
  price: number;
  qty: number;
  side: 'BUY' | 'SELL';
  value_usd: number;
}

interface Props {
  trades: Trade[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTime(ts: number): string {
  const d = new Date(ts * 1000);
  return d.toISOString().substr(11, 8); // HH:MM:SS
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const TradeTape: React.FC<Props> = ({ trades }) => {
  const listRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to top (newest are at the top)
  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = 0;
    }
  }, [trades.length]);

  if (!trades || trades.length === 0) {
    return (
      <div className="tape-empty">
        <div className="tape-empty-icon">⏳</div>
        Aguardando trades...
      </div>
    );
  }

  // Reverse so newest is at the top
  const reversedTrades = [...trades].reverse();

  return (
    <div className="tape-panel">
      <div className="tape-header-panel">
        <h3>Tape (Time & Sales) 📜</h3>
        <p className="tape-desc">Execuções reais a mercado</p>
      </div>

      <div className="tape-list-header">
        <span className="col-time">HORA</span>
        <span className="col-price">PREÇO</span>
        <span className="col-qty">QTD (XAU)</span>
      </div>

      <div className="tape-list" ref={listRef}>
        {reversedTrades.map((t, idx) => {
          // Destaca ordens "Whale" (ex: > 15 XAUUSD que representam lotes muito grandes no ouro)
          const isWhale = t.qty > 15;
          const isMiniWhale = t.qty > 5 && t.qty <= 15;
          
          let rowClass = `tape-row ${t.side === 'BUY' ? 'tape-buy' : 'tape-sell'}`;
          if (isWhale) rowClass += ' tape-whale';
          else if (isMiniWhale) rowClass += ' tape-mini-whale';

          return (
            <div key={`${t.timestamp}-${idx}`} className={rowClass}>
              <span className="col-time">{formatTime(t.timestamp)}</span>
              <span className="col-price">${t.price.toFixed(2)}</span>
              <span className="col-qty">
                {t.qty.toFixed(3)}
                {isWhale && <span className="whale-icon">🐳</span>}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default TradeTape;
