FROM python:3.12-slim

WORKDIR /app

RUN pip install --no-cache-dir fastapi 'uvicorn[standard]' httpx pydantic

COPY server.py /app/server.py

RUN mkdir -p /data
ENV L4_DB_PATH=/data/vec.db
ENV PORT=8042

EXPOSE 8042

CMD ["python", "server.py", "--port", "8042"]
