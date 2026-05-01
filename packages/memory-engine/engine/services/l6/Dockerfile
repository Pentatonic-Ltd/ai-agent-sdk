FROM python:3.12-slim
WORKDIR /app
RUN apt-get update && apt-get install -y curl && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir fastapi "uvicorn[standard]" httpx "pymilvus[milvus_lite]" "setuptools<70" pydantic spacy
RUN python -m spacy download en_core_web_sm
COPY l6-document-store.py /app/server.py
RUN mkdir -p /data
ENV L6_DATA_DIR=/data
EXPOSE 8037
ENV HOST=0.0.0.0
CMD ["python", "server.py", "serve", "--port", "8037"]
