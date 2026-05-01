FROM python:3.12-slim
WORKDIR /app
RUN pip install --no-cache-dir fastapi "uvicorn[standard]" httpx "pymilvus[milvus_lite]" "setuptools<70" pydantic
COPY l5-comms-layer.py /app/server.py
RUN mkdir -p /data
ENV L5_DB_PATH=/data/comms.db
EXPOSE 8034
ENV HOST=0.0.0.0
CMD ["python", "server.py", "serve", "--port", "8034"]
