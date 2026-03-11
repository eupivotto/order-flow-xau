import asyncio
import sys
import os

# Adicionar src ao path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'src'))

from market_data.binance_connector import BinanceXAUConnector

async def main():
    print("=" * 50)
    print("TESTE CONECTOR BINANCE XAUUSDT")
    print("=" * 50)
    
    connector = BinanceXAUConnector()
    
    # Callback para printar atualizações
    async def on_book_update(summary):
        mid = summary.get('mid_price', 0)
        walls = len(summary.get('walls', []))
        spread = summary.get('spread', 0)
        print(f"[BOOK] Mid: ${mid:.2f} | Spread: {spread:.2f} | Walls: {walls}")
    
    async def on_trade(trade):
        side = "COMPRA" if trade.side == "buy" else "VENDA"
        icon = "🔥" if trade.quantity > 10 else "⚡" if trade.quantity > 5 else ""
        print(f"[TRADE] {side} {trade.quantity:.2f} BTC @ ${trade.price:.2f} {icon}")
    
    connector.on_book_update = on_book_update
    connector.on_trade = on_trade
    
    try:
        # Conectar (vai rodar indefinidamente até Ctrl+C)
        print("\nConectando ao Binance Futures...")
        print("Pressione Ctrl+C para parar\n")
        
        await connector.connect()
        
    except KeyboardInterrupt:
        print("\n\nParando conector...")
    finally:
        connector.stop()
        print("Conector finalizado.")

if __name__ == "__main__":
    asyncio.run(main())