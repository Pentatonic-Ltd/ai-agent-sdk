FROM python:3.12-slim

WORKDIR /app

RUN pip install --no-cache-dir fastapi uvicorn[standard] httpx pydantic

COPY server.py /app/server.py

EXPOSE 8099

CMD ["python", "-m", "uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8099"]
