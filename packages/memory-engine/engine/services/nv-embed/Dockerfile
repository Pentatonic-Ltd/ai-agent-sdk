FROM python:3.11-slim

WORKDIR /app

# Install system deps
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Install Python deps
# transformers must stay <4.50 — newer versions break NV-Embed-v2 (removed all_tied_weights_keys)
RUN pip install --no-cache-dir \
    "torch>=2.0" \
    "transformers>=4.42,<4.50" \
    "datasets>=2.14.0" \
    "einops>=0.7.0" \
    "sentence-transformers" \
    "fastapi>=0.100.0" \
    "uvicorn>=0.23.0"

COPY server.py .

# Model cache volume
ENV HF_HOME=/cache/huggingface

EXPOSE 8041

CMD ["python", "server.py", "--host", "0.0.0.0", "--port", "8041"]
