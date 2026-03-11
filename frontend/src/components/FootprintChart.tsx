import React, { useRef, useEffect } from 'react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FootprintLevel {
  buy: number;
  sell: number;
}

export interface FootprintCandle {
  timestamp: number; // epoch
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  buy_volume: number;
  sell_volume: number;
  levels: Record<string, FootprintLevel>; // { "2045.5": {buy: 10, sell: 5} }
}

interface Props {
  candles: FootprintCandle[];
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const FootprintChart: React.FC<Props> = ({ candles }) => {
  const containerRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to the rightmost (newest) candle and center the vertical scroll
  useEffect(() => {
    if (containerRef.current) {
      // Horizontal scroll
      containerRef.current.scrollLeft = containerRef.current.scrollWidth;

      // Vertical scroll: simple attempt to keep recent price near the top/middle
      if (candles.length > 0) {
        const lastCandle = candles[candles.length - 1];
        const lastMidPrice = (lastCandle.close + lastCandle.open) / 2;
        
        // Find the relative height of this price 
        const allHighs = candles.map(c => c.high);
        const allLows = candles.map(c => c.low);
        const globalMax = Math.max(...allHighs);
        const globalMin = Math.min(...allLows);
        
        if (globalMax > globalMin) {
           const range = globalMax - globalMin;
           const percentFromTop = (globalMax - lastMidPrice) / range;
           
           // Scroll Y to position the current price roughly in the middle of the viewport
           const targetScroll = (containerRef.current.scrollHeight * percentFromTop) - (containerRef.current.clientHeight / 2);
           
           // Only snap if we are very far away (user might be manually scrolling)
           // But since it's a fast-moving tape, we will smoothly enforce it
           containerRef.current.scrollTo({
             top: Math.max(0, targetScroll),
             behavior: 'smooth'
           });
        }
      }
    }
  }, [candles.length, candles.at(-1)?.volume]);

  if (!candles || candles.length === 0) {
    return (
      <div className="footprint-empty">
        <div className="footprint-empty-icon">👣</div>
        Aguardando agregação de trades para o Footprint...
      </div>
    );
  }

  // Encontra os extremos Y (max high e min low) dos candles visíveis para traçar o eixo de preço global
  const allHighs = candles.map(c => c.high);
  const allLows = candles.map(c => c.low);
  const globalMax = Math.max(...allHighs);
  const globalMin = Math.min(...allLows);

  // Cria uma lista de bins de $0.50 do topo ao fundo
  const priceLevels: number[] = [];
  const bin = 0.5;
  const start = Math.ceil(globalMax / bin) * bin;
  const end = Math.floor(globalMin / bin) * bin;
  for (let p = start; p >= end; p -= bin) {
    priceLevels.push(p);
  }

  // Helpers
  const formatVol = (v: number) => (v === 0 ? '' : v.toFixed(1));
  const formatTime = (ts: number) => {
    const d = new Date(ts * 1000);
    return d.toISOString().substr(11, 5); // HH:MM
  };

  // Função para desenhar UMA célula do footprint avaliando IMBALANCE (3x maior)
  const renderCell = (candle: FootprintCandle, price: number) => {
    // No backend nós agrupamos com floor() -> $0.50 bins
    const pStr = price.toFixed(1);
    const data = candle.levels[pStr] || { buy: 0, sell: 0 };
    
    // Imbalance math: O agressor compra o ASK (linha atual) e o agressor vende pro BID (linha inferior).
    // Num footprint real a diagonal é lida, mas para simplificação deste protótipo leremos o Imbalance da célula local.
    const isBuyImbalance = data.buy > 0 && data.buy >= data.sell * 3 && data.buy > 5;
    const isSellImbalance = data.sell > 0 && data.sell >= data.buy * 3 && data.sell > 5;
    const isPOC = data.buy + data.sell === Math.max(...Object.values(candle.levels).map(l => l.buy + l.sell)); // maior vol da barra

    let cellClass = "fp-cell";
    if (isBuyImbalance) cellClass += " fp-buy-imb";
    if (isSellImbalance) cellClass += " fp-sell-imb";
    if (isPOC && (data.buy + data.sell > 0)) cellClass += " fp-poc";

    // POC (Point of Control) da barra = Borda amarela

    // Fundo da célula baseado na soma = densidade de volume
    const totalCellVol = data.buy + data.sell;
    const opacity = Math.min(0.8, totalCellVol / 50); // máx 50XAU saturação
    
    return (
      <div key={pStr} className={cellClass} style={{ backgroundColor: `rgba(255,255,255, ${opacity * 0.1})` }}>
        <div className="fp-cell-sell">{formatVol(data.sell)}</div>
        <div className="fp-cell-sep"></div>
        <div className="fp-cell-buy">{formatVol(data.buy)}</div>
      </div>
    );
  };

  return (
    <div className="footprint-wrapper">
      
      {/* Container scrolável X e Y */}
      <div className="footprint-scroll-container" ref={containerRef}>
        <div className="footprint-grid">
          
          {/* Eixo Y de Preços (Fixo à esquerda visualmente, mas rola no eixo Y junto) */}
          <div className="fp-y-axis">
            <div className="fp-spacer"></div> {/* spacer do header */}
            {priceLevels.map(p => (
              <div key={p} className="fp-y-label">{p.toFixed(2)}</div>
            ))}
            <div className="fp-spacer-footer"></div> {/* spacer do footer */}
          </div>

          {/* Colunas de Candles */}
          {candles.map(c => {
            const isBullish = c.close >= c.open;
            const delta = c.buy_volume - c.sell_volume;
            
            return (
              <div key={c.timestamp} className="fp-candle-col">
                {/* Header do Candle */}
                <div className={`fp-c-header ${isBullish ? 'fp-bull' : 'fp-bear'}`}>
                  {formatTime(c.timestamp)}
                  <div className="fp-c-delta" style={{ color: delta >= 0 ? 'var(--green)' : 'var(--red)' }}>
                    Δ {delta > 0 ? '+' : ''}{delta.toFixed(1)}
                  </div>
                </div>

                {/* Células de Preço */}
                <div className="fp-c-body">
                  {priceLevels.map(p => {
                    // Se o preço atual está fora da máxima e mínima tocada neste candle, fica vazio pra desenhar o formato da vela
                    if (p > Math.ceil(c.high / bin) * bin || p < Math.floor(c.low / bin) * bin) {
                      return <div key={p} className="fp-cell-empty"></div>;
                    }
                    return renderCell(c, p);
                  })}
                </div>

                {/* Footer do Candle (Volume total) */}
                <div className="fp-c-footer">
                  Vol: {c.volume.toFixed(0)}
                </div>
              </div>
            );
          })}
          
        </div>
      </div>
    </div>
  );
};

export default FootprintChart;
