FROM python:3.12-slim

WORKDIR /app

# System deps for sentence-transformers + neo4j driver
RUN apt-get update && apt-get install -y --no-install-recommends \
        gcc g++ git curl \
    && rm -rf /var/lib/apt/lists/*

# Reranker = sentence-transformers MiniLM cross-encoder.
# Torch CPU wheels are fine — reranker is small enough to be CPU-bound.
RUN pip install --no-cache-dir \
        fastapi "uvicorn[standard]" httpx requests pydantic \
        neo4j \
        "sentence-transformers" \
        "torch" --extra-index-url https://download.pytorch.org/whl/cpu

COPY l2-hybridrag-proxy.py /app/server.py
COPY init_databases.py /app/init_databases.py

# Pre-create empty L0 BM25 SQLite + empty workspace
RUN mkdir -p /data/workspace /data/.pentatonic/memory /data/.cache && \
    python init_databases.py /data

# L2 proxy expects various data dirs — point them at /data
ENV PME_WORKSPACE=/data/workspace
ENV PME_QMD_DB=/data/qmd.sqlite
ENV PME_MEMORY_DB=/data/workspace.db
ENV HF_HOME=/data/.cache/huggingface

# OSS-friendly defaults: HyDE off (per request), reranker on
ENV PME_HYDE_ENABLED=false
ENV PME_RERANK_ENABLED=true
ENV PME_NV_EMBED_ENABLED=true

EXPOSE 8031

# Pre-download the MiniLM cross-encoder so cold-start is fast
RUN python -c "from sentence_transformers import CrossEncoder; CrossEncoder('cross-encoder/ms-marco-MiniLM-L-6-v2', cache_folder='/data/.cache/huggingface')"

CMD ["python", "server.py", "--port", "8031", "--host", "0.0.0.0"]
