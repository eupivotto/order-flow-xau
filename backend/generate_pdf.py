from reportlab.lib.pagesizes import A4
from reportlab.lib import colors
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer
import os

def create_pdf(filename):
    doc = SimpleDocTemplate(filename, pagesize=A4,
                            rightMargin=50, leftMargin=50,
                            topMargin=50, bottomMargin=50)
    
    styles = getSampleStyleSheet()
    
    # Estilos customizados
    title_style = ParagraphStyle(
        name='CustomTitle',
        parent=styles['Heading1'],
        fontSize=20,
        textColor=colors.HexColor('#2c3e50'),
        spaceAfter=20,
        alignment=1 # Center
    )
    
    h2_style = ParagraphStyle(
        name='CustomH2',
        parent=styles['Heading2'],
        fontSize=15,
        textColor=colors.HexColor('#2980b9'),
        spaceBefore=15,
        spaceAfter=10
    )
    
    h3_style = ParagraphStyle(
        name='CustomH3',
        parent=styles['Heading3'],
        fontSize=13,
        textColor=colors.HexColor('#d35400'),
        spaceBefore=10,
        spaceAfter=5
    )
    
    body_style = ParagraphStyle(
        name='CustomBody',
        parent=styles['Normal'],
        fontSize=11,
        spaceAfter=8,
        leading=15
    )
    
    bullet_style = ParagraphStyle(
        name='CustomBullet',
        parent=body_style,
        leftIndent=20,
        firstLineIndent=-10
    )

    story = []
    
    # Título
    story.append(Paragraph("XAUUSD Order Flow Dashboard", title_style))
    story.append(Paragraph("Guia Prático e Estratégias de Operação", title_style))
    story.append(Spacer(1, 10))
    story.append(Paragraph("Este guia explica como interpretar as três ferramentas de microestrutura de mercado para operar Ouro (XAU/USD) utilizando o fluxo institucional ao seu favor.", body_style))
    
    # Seção 1
    story.append(Paragraph("1. Trade Tape (Fita de Impressão)", h2_style))
    story.append(Paragraph("A Fita mostra o histórico em tempo real de quem está agredindo o mercado (Market Orders). Ou seja, quem está apertando o botão de Comprar ou Vender a mercado.", body_style))
    story.append(Paragraph("• <b>Linhas normas/fracas:</b> Robôs de HFT e sardinhas (ex: 0.01 a 2 XAU). Podem ser ignoradas, pos não deslocam o preço real.", bullet_style))
    story.append(Paragraph("• <font color='#00d084'><b>Linhas Verdes ou Vermelhas sólidas (Mini-Whales 5~15 XAU):</b></font> Agressão direcional real de fundos. Mostra intenção clara de deslocar o preço.", bullet_style))
    story.append(Paragraph("• <b>WHALES com Destaque Brilhante (> 15 XAU):</b> Passagem de lotes massivos, comuns em instituições de forex e derivativos que usam a corretora de cripto para hedge. Um fluxo que geralmente rasga o book.", bullet_style))
    
    story.append(Paragraph("Estratégia (Rompimento Básico):", h3_style))
    story.append(Paragraph("Quando o mercado está em consolidação (caixote) e você vê 3 ou mais boletadas seguidas de Venda (Vermelho) > 15 XAU, os institucionais estão empurrando o suporte ativamente. É o trigger para entrar vendido (SHORT) a favor do fluxo pesado.", body_style))
    
    # Seção 2
    story.append(Paragraph("2. Radar de Stops (Zonas de Liquidez)", h2_style))
    story.append(Paragraph("O Radar é um mapeamento de Limit Orders descansando na pedra do Book, agrupadas em blocos gigantes de $1. Ali mora a liquidez que o preço busca feito um ímã.", body_style))
    story.append(Paragraph("• <b>Zonas:</b> O sistema identifica o maior bloco acima (Resistência/Buy Stops) e o menor bloco abaixo (Suporte/Sell Stops).", bullet_style))
    story.append(Paragraph("• <font color='#e74c3c'><b>Danger Zone (Alerta Vermelho/Verde Piscante):</b></font> Quando o preço fica a uma distância percentual menor que 0.15% dessa zona inteira, as baterias começam a pulsar indicando perigo eminente de Sweep (Varredura de Stops).", bullet_style))
    
    story.append(Paragraph("Estratégia (Sweep Hunter):", h3_style))
    story.append(Paragraph("Os grandes players AMAM estourar liquidez antes de reverter o mercado. Se o radar indica que o Suporte está piscando (varredura nos vendidos), o preço espeta essa zona agulhando e é rejeitado rapidamente para cima... É uma caça-aos-stops clássica. A oportunidade de ouro é entrar Comprado (LONG) logo no fechamento do candle de rejeição. O alvo é sempre a piscina oposta mostrada no Radar.", body_style))

    # Seção 3
    story.append(Paragraph("3. Sinais Operacionais (O Algoritmo)", h2_style))
    story.append(Paragraph("O Algoritmo de Sinais do dashboard avalia constantemente as variações quantitativas do book, spread e fluxo financeiro em segundo plano. Ele apita na barra lateral.", body_style))
    
    story.append(Paragraph("• <b>Divergência Delta (O sinal mais forte):</b> Ocorre quando o Ouro sobe por vários segundos seguidos, mas o Delta/Flow foi massivamente VENDEDOR. O que isso significa? Absorção Direcional. Um grande institucional colocou uma barreira passiva invisível e absorveu toda a compra cega das sardinhas (limit order icebergs). Trigue Venda (SHORT) porque a absorção não deve deixar o preço subir dali.", bullet_style))
    story.append(Paragraph("• <b>Cluster de Liquidação:</b> Se piscar amarelo indicando liquidações de shorts ou longs, os Stop OBRIGATÓRIOS de traders em margin call na Binance foram ativados. Se forem liquidações 'Short', a corretora foi obrigada a comprar a mercado na força bruta, o que causa os temidos Short Squeezes rasgando o gráfico. Não opere contra isso.", bullet_style))
    story.append(Paragraph("• <b>Wall Consumido (Spoofing):</b> A barreira gigante do heatmap (ex: 500 XAU a 2100) sumiu antes do preço encostar? Spoof. Um robô blefador só queria empurrar o varejo numa direção. Ignore falsos suportes.", bullet_style))

    story.append(Paragraph("A Confluência Suprema (Master Setup):", h3_style))
    story.append(Paragraph("Se o Radar de Stops (2) está piscando na resistência em cima, a Fita de Impressão (1) cospe ordens vendedoras extremas, e de repente o painel de Sinais (3) apita 'Divergência Delta SHORT', você acabou de presenciar em tempo real um Institutional injetando liquidez absorvida no topo para montar posição Short. É um setup perfeito para a Venda.", body_style))

    doc.build(story)

if __name__ == '__main__':
    create_pdf('Guia_Operacional_XAUUSD.pdf')
    print("PDF gerado com sucesso!")
