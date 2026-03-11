import asyncio
import logging
import sys
import os

# Adicionar src ao path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'src'))

from market_data.binance_connector import BinanceXAUConnector

# Configurar logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)

async def main():
    print("=" * 60)
    print("TESTE CONECTOR BINANCE XAUUSDT - FINAL")
    print("=" * 60)
    
    connector = BinanceXAUConnector()
    
    # Monitor que imprime a cada 3 segundos
    async def monitor():
        await asyncio.sleep(3)  # Aguarda inicialização
        
        while connector.is_running:
            summary = connector.get_book_summary()
            delta = connector.get_delta_stats()
            
            if summary:
                print(f"\n[BOOK] Mid: ${summary.mid:.2f} | Spread: {summary.spread:.2f}")
                print(f"[DEPTH] Bids: {connector.book_depth[0]} | Asks: {connector.book_depth[1]}")
                print(f"[DELTA] {delta.pressure} | Δ: {delta.delta:+.2f}")
                
                if summary.walls:
                    print(f"[WALLS] {len(summary.walls)} detectados")
                    for w in summary.walls[:3]:
                        print(f"  → {w.side.upper()} @ ${w.price:.2f} | {w.qty:.4f} XAU")
            else:
                print("[AGUARDANDO] Book ainda vazio...")
                
            await asyncio.sleep(3)
    
    monitor_task = asyncio.create_task(monitor())
    
    try:
        print("\nConectando... Pressione Ctrl+C para parar\n")
        await connector.connect()
        
    except KeyboardInterrupt:
        print("\n\nInterrompido pelo usuário...")
    finally:
        print("Parando conector...")
        await connector.stop()  # <-- CORRIGIDO: await aqui!
        monitor_task.cancel()
        try:
            await monitor_task
        except asyncio.CancelledError:
            pass
        print("✅ Conector finalizado com sucesso.")

if __name__ == "__main__":
    asyncio.run(main())