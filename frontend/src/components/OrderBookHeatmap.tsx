import React, {
  useEffect,
  useRef,
  useState,
  useCallback,
} from 'react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BookLevel {
  price: number;
  qty: number;
}

export interface HeatmapSnapshot {
  timestamp: number;      // Unix epoch seconds (float)
  bids: BookLevel[];      // sorted desc
  asks: BookLevel[];      // sorted asc
  mid: number;
  vwap?: number;
  walls?: WallInfo[];
}

export interface WallInfo {
  side: 'bid' | 'ask';
  price: number;
  qty: number;
}

interface Props {
  /** Snapshots recebidos do WebSocket, ordered oldest → newest */
  snapshots: HeatmapSnapshot[];
  /** Número de colunas de tempo a renderizar */
  maxColumns?: number;
  /** Altura do canvas em px */
  height?: number;
  /** Número de ticks de preço visíveis (linhas) */
  priceRows?: number;
  /** Trades recentes para desenhar bolhas de volume */
  trades?: TradeBubble[];
}

/** 
 * Escala de cores estilo Bookmap (heatmap térmico) com Noise Reduction:
 * Filtra liquidez irrelevante para focar no Smart Money.
 */
function getBookmapColor(intensity: number, side: 'bid' | 'ask'): string {
  // Threshold de ruído: esconde tudo que for menor que 15% da maior ordem visível
  if (intensity < 0.15) return 'transparent';

  const alpha = 0.3 + intensity * 0.7;
  
  if (side === 'bid') {
    // Escala para Bids: Ciano -> Verde -> Amarelo -> Branco (Glow)
    if (intensity < 0.4) return `rgba(0, 180, 255, ${alpha * 0.4})`; // Ciano suave
    if (intensity < 0.7) return `rgba(0, 255, 150, ${alpha})`;       // Verde limão
    if (intensity < 0.9) return `rgba(255, 255, 0, ${alpha})`;      // Amarelo vibrante
    return `rgba(255, 255, 255, ${alpha})`;                        // Branco (Liquidez Extrema)
  } else {
    // Escala para Asks: Roxo -> Laranja -> Vermelho -> Magenta (Glow)
    if (intensity < 0.4) return `rgba(150, 0, 255, ${alpha * 0.4})`; // Roxo suave
    if (intensity < 0.7) return `rgba(255, 100, 0, ${alpha})`;       // Laranja neon
    if (intensity < 0.9) return `rgba(255, 0, 0, ${alpha})`;         // Vermelho sangue
    return `rgba(255, 0, 255, ${alpha})`;                           // Magenta (Paredão de Venda)
  }
}

/** Cor de wall (brilho neon) */
const WALL_COLOR = '#00ffff';

interface TradeBubble {
  price: number;
  qty: number;
  side: 'BUY' | 'SELL';
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Componente principal
// ---------------------------------------------------------------------------

const OrderBookHeatmap: React.FC<Props> = ({
  snapshots,
  maxColumns = 120,
  height = 400,
  priceRows = 60,
  trades = [],
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [canvasWidth, setCanvasWidth] = useState(900);
  const [tooltip, setTooltip] = useState<{
    x: number; y: number; text: string;
  } | null>(null);

  // Ajusta largura ao container
  useEffect(() => {
    const obs = new ResizeObserver(entries => {
      for (const entry of entries) {
        setCanvasWidth(entry.contentRect.width);
      }
    });
    if (containerRef.current) obs.observe(containerRef.current);
    return () => obs.disconnect();
  }, []);

  // ---------------------------------------------------------------------------
  // Render do heatmap via Canvas 2D
  // ---------------------------------------------------------------------------

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const W = canvas.width;
    const H = canvas.height;
    const PRICE_AXIS_W = 60;  // px reservados para o eixo de preço
    const TIME_AXIS_H = 22;   // px reservados para o eixo de tempo
    const plotW = W - PRICE_AXIS_W;
    const plotH = H - TIME_AXIS_H;

    // Fundo - Estilo Dark Mode profundo
    ctx.fillStyle = '#050505';
    ctx.fillRect(0, 0, W, H);

    if (snapshots.length < 2) {
      ctx.fillStyle = '#444';
      ctx.font = '13px JetBrains Mono, monospace';
      ctx.textAlign = 'center';
      ctx.fillText('Aguardando snapshots do mercado...', W / 2, H / 2);
      return;
    }

    // Janela de colunas: últimas maxColumns
    const window = snapshots.slice(-maxColumns);
    const numCols = window.length;
    const colW = plotW / numCols;

    const startTime = window[0].timestamp;
    const endTime = window[numCols - 1].timestamp;
    const timeRange = endTime - startTime || 1;

    // Faixa de preços e Qty Max para escala
    let globalMin = Infinity;
    let globalMax = -Infinity;
    let globalMaxQty = 0;

    for (const snap of window) {
      for (const b of snap.bids) {
        if (b.price < globalMin) globalMin = b.price;
        if (b.price > globalMax) globalMax = b.price;
        if (b.qty > globalMaxQty) globalMaxQty = b.qty;
      }
      for (const a of snap.asks) {
        if (a.price < globalMin) globalMin = a.price;
        if (a.price > globalMax) globalMax = a.price;
        if (a.qty > globalMaxQty) globalMaxQty = a.qty;
      }
    }

    if (globalMin === Infinity) return;

    const lastMid = window[window.length - 1].mid;
    const actualRange = globalMax - globalMin;
    
    // Zoom Dinâmico: Se o preço não se move, o range encolhe para ver o detalhe.
    // Para Gold (XAU), 2.0 é um range excelente para ver micro-oscilações.
    const MIN_RANGE = lastMid > 1000 ? 5 : 1; 
    const priceRange = Math.max(actualRange, MIN_RANGE);
    
    const visMin = lastMid - priceRange / 2;
    const visMax = lastMid + priceRange / 2;
    const visRange = visMax - visMin;

    const priceToY = (p: number) => plotH - ((p - visMin) / visRange) * plotH;
    const rowH = Math.max(plotH / priceRows, 2);

    // ---------------------------------------------------------------------------
    // 1. PINTAR HEATMAP (Liquidez Filtrada)
    // ---------------------------------------------------------------------------
    for (let col = 0; col < numCols; col++) {
      const snap = window[col];
      const x = col * colW;

      // Concatenar todos os níveis para achar os Top Magnets da coluna
      const allLevels = [...snap.bids, ...snap.asks].filter(l => l.price >= visMin && l.price <= visMax);
      const top3Magnets = [...allLevels].sort((a,b) => b.qty - a.qty).slice(0, 2);

      // Renderizar níveis
      for (const { price, qty } of allLevels) {
        const y = priceToY(price);
        const intensity = Math.min(qty / globalMaxQty, 1);
        const color = getBookmapColor(intensity, snap.bids.some(b => b.price === price) ? 'bid' : 'ask');
        
        if (color !== 'transparent') {
          ctx.fillStyle = color;
          // Efeito de brilho para os Top 3 níveis de liquidez
          const isMagnet = top3Magnets.some(m => m.price === price);
          if (isMagnet) {
            ctx.shadowBlur = intensity * 10;
            ctx.shadowColor = color;
          }
          ctx.fillRect(x, y - rowH / 2, colW + 0.5, rowH + 0.5);
          ctx.shadowBlur = 0;
        }
      }

      // Walls em destaque neon
      for (const wall of snap.walls ?? []) {
        if (wall.price < visMin || wall.price > visMax) continue;
        const y = priceToY(wall.price);
        ctx.fillStyle = WALL_COLOR;
        ctx.shadowBlur = 4;
        ctx.shadowColor = WALL_COLOR;
        ctx.fillRect(x, y - 1, colW, 2);
        ctx.shadowBlur = 0;
      }
    }

    // ---------------------------------------------------------------------------
    // 2. LINHAS DE PREÇO (VWAP / MID) - SUTIS
    // ---------------------------------------------------------------------------
    // VWAP
    ctx.strokeStyle = '#0fbcf9';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 2]);
    ctx.beginPath();
    let isVwapFirst = true;
    for (let col = 0; col < numCols; col++) {
      const snap = window[col];
      if (snap.vwap) {
        const x = col * colW + colW / 2;
        const y = priceToY(snap.vwap);
        if (isVwapFirst) { ctx.moveTo(x, y); isVwapFirst = false; }
        else ctx.lineTo(x, y);
      }
    }
    ctx.stroke();

    // MID PRICE
    ctx.strokeStyle = 'rgba(255,255,255,0.2)';
    ctx.lineWidth = 0.5;
    ctx.setLineDash([2, 2]);
    ctx.beginPath();
    let isMidFirst = true;
    for (let col = 0; col < numCols; col++) {
      const x = col * colW + colW / 2;
      const y = priceToY(window[col].mid);
      if (isMidFirst) { ctx.moveTo(x, y); isMidFirst = false; }
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.setLineDash([]);

    // ---------------------------------------------------------------------------
    // 3. VOLUME BUBBLES (VOLUME PULSE NEON)
    // ---------------------------------------------------------------------------
    for (const trade of trades) {
      if (trade.timestamp < startTime || trade.timestamp > endTime) continue;
      if (trade.price < visMin || trade.price > visMax) continue;

      const x = ((trade.timestamp - startTime) / timeRange) * plotW;
      const y = priceToY(trade.price);
      
      const radius = Math.min(Math.log2(trade.qty + 1) * 3 + 1, 15);
      
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      
      const isBuy = trade.side === 'BUY';
      const bubbleColor = isBuy ? '#00ffa3' : '#ff3131';
      
      ctx.fillStyle = isBuy ? 'rgba(0, 255, 163, 0.4)' : 'rgba(255, 49, 49, 0.4)';
      ctx.shadowBlur = radius > 5 ? 8 : 4;
      ctx.shadowColor = bubbleColor;
      ctx.fill();
      
      if (trade.qty > 10) {
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      ctx.shadowBlur = 0;
    }

    // ---------------------------------------------------------------------------
    // EIXOS E LABELS
    // ---------------------------------------------------------------------------
    // Preço (Direita)
    ctx.fillStyle = '#0a0a0a';
    ctx.fillRect(plotW, 0, PRICE_AXIS_W, plotH);
    ctx.fillStyle = '#888';
    ctx.font = '10px JetBrains Mono, monospace';
    const tickStep = Math.max(Math.ceil(visRange / priceRows / 5) * 5, 0.5);
    const firstTick = Math.ceil(visMin / tickStep) * tickStep;
    for (let tick = firstTick; tick <= visMax; tick += tickStep) {
      const y = priceToY(tick);
      if (y < 0 || y > plotH) continue;
      ctx.fillText(tick.toFixed(0), plotW + 5, y + 4);
    }
    // Mid destacada
    const midY = priceToY(lastMid);
    ctx.fillStyle = '#fff';
    ctx.fillRect(plotW, midY - 9, PRICE_AXIS_W, 18);
    ctx.fillStyle = '#000';
    ctx.fillText(lastMid.toFixed(2), plotW + 2, midY + 4);

    // Tempo (Baixo)
    ctx.fillStyle = '#0d0d0d';
    ctx.fillRect(0, plotH, plotW, TIME_AXIS_H);
    ctx.fillStyle = '#555';
    const labelEvery = Math.max(1, Math.floor(numCols / 6));
    for (let col = 0; col < numCols; col += labelEvery) {
      const x = col * colW;
      const t = new Date(window[col].timestamp * 1000).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
      ctx.fillText(t, x, plotH + 15);
    }

  }, [snapshots, maxColumns, priceRows, trades]);

  useEffect(() => {
    draw();
  }, [draw, canvasWidth]);

  // ---------------------------------------------------------------------------
  // Tooltip
  // ---------------------------------------------------------------------------
  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas || snapshots.length === 0) return;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const plotW = canvas.width - 60;
    const plotH = canvas.height - 22;

    if (mx > plotW || my > plotH) { setTooltip(null); return; }

    const window = snapshots.slice(-maxColumns);
    const colIdx = Math.floor((mx / plotW) * window.length);
    const snap = window[Math.min(colIdx, window.length - 1)];

    // Lógica simplificada de preço para o tooltip
    // Lógica de preço sincronizada com o draw()
    const lastMid = window[window.length - 1].mid;
    
    // Coletar range idêntico ao do draw()
    let gMin = Infinity, gMax = -Infinity;
    for (const s of window) {
      for (const b of s.bids) { if (b.price < gMin) gMin = b.price; if (b.price > gMax) gMax = b.price; }
      for (const a of s.asks) { if (a.price < gMin) gMin = a.price; if (a.price > gMax) gMax = a.price; }
    }
    const MIN_RANGE = lastMid > 1000 ? 5 : 1;
    const pRange = Math.max(gMax - gMin, MIN_RANGE);
    const vMin = lastMid - pRange / 2;
    const vMax = lastMid + pRange / 2;

    const price = vMax - (my / plotH) * (vMax - vMin);

    setTooltip({
      x: e.clientX - rect.left + 15,
      y: e.clientY - rect.top - 15,
      text: `$${price.toFixed(2)} | Liquid: ${snap.mid.toFixed(2)}`,
    });
  }, [snapshots, maxColumns]);

  return (
    <div ref={containerRef} className="heatmap-wrapper bookmap-theme">
      <div style={{ position: 'relative' }}>
        <canvas
          ref={canvasRef}
          width={canvasWidth}
          height={height}
          onMouseMove={handleMouseMove}
          onMouseLeave={() => setTooltip(null)}
          style={{ display: 'block', cursor: 'crosshair', borderRadius: '4px' }}
        />
        {tooltip && (
          <div className="heatmap-tooltip" style={{ left: tooltip.x, top: tooltip.y }}>
            {tooltip.text}
          </div>
        )}
      </div>
    </div>
  );
};
export default OrderBookHeatmap;
