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
}

// ---------------------------------------------------------------------------
// Helpers de cor
// ---------------------------------------------------------------------------

/** Intensidade 0→1 para cor de bid (verde) */
function bidColor(intensity: number): string {
  const alpha = 0.2 + intensity * 0.8;
  // verde escuro → verde neon brillante
  const r = Math.round(0 + intensity * 60);
  const g = Math.round(120 + intensity * 135);
  const b = Math.round(60 + intensity * 70);
  return `rgba(${r},${g},${b},${alpha})`;
}

/** Intensidade 0→1 para cor de ask (vermelho) */
function askColor(intensity: number): string {
  const alpha = 0.2 + intensity * 0.8;
  // vermelho escuro → vermelho vivo brillante
  const r = Math.round(150 + intensity * 105);
  const g = Math.round(20 + intensity * 50);
  const b = Math.round(40 + intensity * 40);
  return `rgba(${r},${g},${b},${alpha})`;
}

/** Cor de wall piscante (amarelo/ouro) */
const WALL_COLOR = 'rgba(255, 200, 0, 0.9)';

// ---------------------------------------------------------------------------
// Componente principal
// ---------------------------------------------------------------------------

const OrderBookHeatmap: React.FC<Props> = ({
  snapshots,
  maxColumns = 120,
  height = 400,
  priceRows = 60,
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

    // Fundo
    ctx.fillStyle = '#0a0a0a';
    ctx.fillRect(0, 0, W, H);

    if (snapshots.length < 2) {
      ctx.fillStyle = '#444';
      ctx.font = '13px JetBrains Mono, monospace';
      ctx.textAlign = 'center';
      ctx.fillText('Aguardando snapshots do heatmap...', W / 2, H / 2);
      return;
    }

    // Janela de colunas: últimas maxColumns
    const window = snapshots.slice(-maxColumns);
    const numCols = window.length;
    const colW = plotW / numCols;

    // Faixa de preços: coletar todos para determinar min/max
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

    // Centraliza no mid mais recente
    const lastMid = window[window.length - 1].mid;

    // Janela de preços mais estável:
    // Garante no mínimo $15 de range longitudinal para ver o "macro" da liquidez
    const MIN_RANGE = 15;
    const actualRange = globalMax - globalMin;
    const priceRange = Math.max(actualRange, MIN_RANGE);
    
    const visMin = lastMid - priceRange * 0.6; // Mostramos um pouco mais pra baixo (bids) por padrão
    const visMax = lastMid + priceRange * 0.4;
    const visRange = visMax - visMin;

    const priceToY = (p: number) =>
      plotH - ((p - visMin) / visRange) * plotH;

    const rowH = Math.max(plotH / priceRows, 3); // Garante altura mínima para os blocos da matriz

    // Calcular ticks de preço visíveis
    const tickStep = Math.max(Math.ceil(visRange / priceRows / 5) * 5, 0.5); // Deixa o eixo esquerdo mostrar mais centavos
    const firstTick = Math.ceil(visMin / tickStep) * tickStep;

    // ---------------------------------------------------------------------------
    // Pintar células (coluna × faixa de preço)
    // ---------------------------------------------------------------------------

    for (let col = 0; col < numCols; col++) {
      const snap = window[col];
      const x = col * colW;

      // Bids
      for (const { price, qty } of snap.bids) {
        if (price < visMin || price > visMax) continue;
        const y = priceToY(price);
        const intensity = Math.min(qty / globalMaxQty, 1);
        ctx.fillStyle = bidColor(intensity);
        ctx.fillRect(x, y - rowH / 2, colW, rowH);
      }

      // Asks
      for (const { price, qty } of snap.asks) {
        if (price < visMin || price > visMax) continue;
        const y = priceToY(price);
        const intensity = Math.min(qty / globalMaxQty, 1);
        ctx.fillStyle = askColor(intensity);
        ctx.fillRect(x, y - rowH / 2, colW, rowH);
      }

      // Walls: marcador horizontal em amarelo
      for (const wall of snap.walls ?? []) {
        if (wall.price < visMin || wall.price > visMax) continue;
        const y = priceToY(wall.price);
        ctx.strokeStyle = WALL_COLOR;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([3, 2]);
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + colW, y);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    // ---------------------------------------------------------------------------
    // Linha de VWAP (azul claro sólido)
    // ---------------------------------------------------------------------------
    ctx.strokeStyle = '#0fbcf9';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([]);
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

    // ---------------------------------------------------------------------------
    // Linha de mid price (branco tracejado)
    // ---------------------------------------------------------------------------
    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    let isMidFirst = true;
    for (let col = 0; col < numCols; col++) {
      const snap = window[col];
      const x = col * colW + colW / 2;
      const y = priceToY(snap.mid);
      if (isMidFirst) { ctx.moveTo(x, y); isMidFirst = false; }
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.setLineDash([]);

    // ---------------------------------------------------------------------------
    // Eixo de preço (direita)
    // ---------------------------------------------------------------------------
    ctx.fillStyle = '#111';
    ctx.fillRect(plotW, 0, PRICE_AXIS_W, plotH);

    ctx.fillStyle = '#888';
    ctx.font = '10px JetBrains Mono, monospace';
    ctx.textAlign = 'left';

    for (let tick = firstTick; tick <= visMax; tick += tickStep) {
      const y = priceToY(tick);
      if (y < 0 || y > plotH) continue;
      // linha de grade horizontal
      ctx.strokeStyle = '#1a1a1a';
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(plotW, y);
      ctx.stroke();
      // label
      ctx.fillStyle = Math.abs(tick - lastMid) < tickStep / 2 ? '#fff' : '#666';
      ctx.fillText(`${tick.toFixed(0)}`, plotW + 4, y + 4);
    }

    // Mid label destacado
    const midY = priceToY(lastMid);
    ctx.fillStyle = '#fff';
    ctx.fillRect(plotW, midY - 9, PRICE_AXIS_W, 18);
    ctx.fillStyle = '#000';
    ctx.font = 'bold 10px JetBrains Mono, monospace';
    ctx.fillText(lastMid.toFixed(2), plotW + 2, midY + 4);

    // ---------------------------------------------------------------------------
    // Eixo de tempo (baixo)
    // ---------------------------------------------------------------------------
    ctx.fillStyle = '#0d0d0d';
    ctx.fillRect(0, plotH, plotW, TIME_AXIS_H);
    ctx.fillStyle = '#555';
    ctx.font = '9px JetBrains Mono, monospace';
    ctx.textAlign = 'center';

    const labelEvery = Math.max(1, Math.floor(numCols / 10));
    for (let col = 0; col < numCols; col += labelEvery) {
      const snap = window[col];
      const x = col * colW + colW / 2;
      const d = new Date(snap.timestamp * 1000);
      const label = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      ctx.fillText(label, x, plotH + 15);
    }

    // ---------------------------------------------------------------------------
    // Legenda de intensidade (canto superior esquerdo)
    // ---------------------------------------------------------------------------
    const lgW = 120, lgH = 12;
    const lgX = 8, lgY = 8;

    const bidGrad = ctx.createLinearGradient(lgX, 0, lgX + lgW, 0);
    bidGrad.addColorStop(0, bidColor(0.05));
    bidGrad.addColorStop(1, bidColor(1));
    ctx.fillStyle = bidGrad;
    ctx.fillRect(lgX, lgY, lgW, lgH);

    const askGrad = ctx.createLinearGradient(lgX, 0, lgX + lgW, 0);
    askGrad.addColorStop(0, askColor(0.05));
    askGrad.addColorStop(1, askColor(1));
    ctx.fillStyle = askGrad;
    ctx.fillRect(lgX, lgY + lgH + 3, lgW, lgH);

    ctx.fillStyle = '#777';
    ctx.font = '9px JetBrains Mono, monospace';
    ctx.textAlign = 'left';
    ctx.fillText('BID', lgX + lgW + 4, lgY + 10);
    ctx.fillText('ASK', lgX + lgW + 4, lgY + lgH + 13);

    // Wall legend
    ctx.strokeStyle = WALL_COLOR;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([3, 2]);
    ctx.beginPath();
    ctx.moveTo(lgX, lgY + lgH * 2 + 14);
    ctx.lineTo(lgX + lgW, lgY + lgH * 2 + 14);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = WALL_COLOR;
    ctx.fillText('WALL', lgX + lgW + 4, lgY + lgH * 2 + 18);

  }, [snapshots, maxColumns, priceRows]);

  useEffect(() => {
    draw();
  }, [draw, canvasWidth]);

  // ---------------------------------------------------------------------------
  // Tooltip ao passar o mouse
  // ---------------------------------------------------------------------------
  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas || snapshots.length === 0) return;

    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    const PRICE_AXIS_W = 60;
    const TIME_AXIS_H = 22;
    const plotW = canvas.width - PRICE_AXIS_W;
    const plotH = canvas.height - TIME_AXIS_H;

    if (mx > plotW || my > plotH) { setTooltip(null); return; }

    const window = snapshots.slice(-maxColumns);
    const numCols = window.length;
    const colW = plotW / numCols;
    const colIdx = Math.floor(mx / colW);
    const snap = window[Math.min(colIdx, window.length - 1)];

    // Determinar preço na posição y
    let globalMin = Infinity, globalMax = -Infinity;
    for (const s of window) {
      for (const b of s.bids) { if (b.price < globalMin) globalMin = b.price; if (b.price > globalMax) globalMax = b.price; }
      for (const a of s.asks) { if (a.price < globalMin) globalMin = a.price; if (a.price > globalMax) globalMax = a.price; }
    }
    const lastMid = window[window.length - 1].mid;
    const priceRange = Math.max((globalMax - globalMin) * 1.5, 5); // Acompanha a lógica de zoom acima
    const visMin = lastMid - priceRange / 2;
    const visMax = lastMid + priceRange / 2;

    const price = visMax - (my / plotH) * (visMax - visMin);
    const time = new Date(snap.timestamp * 1000).toLocaleTimeString('pt-BR');

    // Encontrar nível mais próximo
    const allLevels = [...snap.bids, ...snap.asks];
    const closest = allLevels.reduce<BookLevel | null>((best, l) =>
      !best || Math.abs(l.price - price) < Math.abs(best.price - price) ? l : best
    , null);

    if (closest) {
      const side = snap.bids.some(b => b.price === closest.price) ? 'BID' : 'ASK';
      setTooltip({
        x: e.clientX - rect.left + 12,
        y: e.clientY - rect.top - 10,
        text: `${time} | ${side} @ $${closest.price.toFixed(2)} | ${closest.qty.toFixed(4)} XAU`,
      });
    } else {
      setTooltip(null);
    }
  }, [snapshots, maxColumns]);

  return (
    <div ref={containerRef} className="heatmap-wrapper">
      <div className="heatmap-header">
        <span className="heatmap-title">ORDER BOOK HEATMAP</span>
        <span className="heatmap-meta">
          {snapshots.length} snapshots · {maxColumns}s visíveis
        </span>
      </div>

      <div style={{ position: 'relative' }}>
        <canvas
          ref={canvasRef}
          width={canvasWidth}
          height={height}
          onMouseMove={handleMouseMove}
          onMouseLeave={() => setTooltip(null)}
          style={{ display: 'block', cursor: 'crosshair' }}
        />

        {tooltip && (
          <div
            className="heatmap-tooltip"
            style={{ left: tooltip.x, top: tooltip.y }}
          >
            {tooltip.text}
          </div>
        )}
      </div>
    </div>
  );
};

export default OrderBookHeatmap;
