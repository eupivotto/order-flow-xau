# Usar uma imagem Python oficial
FROM python:3.11-slim

# Instalar dependências de sistema necessárias para compilar o TA-Lib
RUN apt-get update && apt-get install -y \
    build-essential \
    wget \
    && rm -rf /var/lib/apt/lists/*

# Baixar e instalar a biblioteca C do TA-Lib
RUN wget http://prdownloads.sourceforge.net/ta-lib/ta-lib-0.4.0-src.tar.gz && \
    tar -xvzf ta-lib-0.4.0-src.tar.gz && \
    cd ta-lib/ && \
    ./configure --prefix=/usr && \
    make && \
    make install && \
    cd .. && \
    rm -rf ta-lib-0.4.0-src.tar.gz ta-lib/

# Definir diretório de trabalho
WORKDIR /app

# Copiar apenas os arquivos de dependências primeiro (otimiza cache do Docker)
COPY requirements-prod.txt .

# Instalar dependências Python
RUN pip install --no-cache-dir -r requirements-prod.txt

# Copiar o restante do código do backend
COPY . .

# Expor a porta que o FastAPI vai usar
EXPOSE 8000

# Comando para iniciar o servidor
# Usamos uvicorn com host 0.0.0.0 para ser acessível externamente
CMD ["python", "-m", "uvicorn", "src.api.server:app", "--host", "0.0.0.0", "--port", "8000"]
