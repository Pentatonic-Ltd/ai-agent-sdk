#!/usr/bin/env python3
"""
NV-Embed-v2 Embedding Service

Persistent FastAPI service that keeps the 7B model loaded in GPU memory.
Exposes OpenAI-compatible /v1/embeddings endpoint.

Uses SentenceTransformer for better transformers version compatibility.

Port: 8041 (default)
"""

import argparse
import logging
import time
from typing import Any, List, Union

import torch
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
import uvicorn

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("nv-embed-service")

MODEL_ID = "nvidia/NV-Embed-v2"
INSTRUCTION = "Given a question, retrieve passages that answer the question"

app = FastAPI(title="NV-Embed-v2 Service", version="1.1.0")

# Global model reference
model = None
load_time = None


class EmbeddingRequest(BaseModel):
    input: Union[str, List[str]]
    model: str = "nv-embed-v2"
    instruction: str = ""


class EmbeddingResponse(BaseModel):
    object: str = "list"
    data: List[dict]
    model: str = "nv-embed-v2"
    usage: dict


def load_model():
    """Load NV-Embed-v2 via SentenceTransformer to GPU."""
    global model, load_time
    log.info("Loading NV-Embed-v2 via SentenceTransformer...")
    t0 = time.time()

    from sentence_transformers import SentenceTransformer
    # Load to CPU first, then move to GPU to avoid OOM during loading
    model = SentenceTransformer(MODEL_ID, trust_remote_code=True, device="cpu")
    model = model.to("cuda")

    load_time = time.time() - t0
    log.info(f"Model loaded in {load_time:.1f}s")


@app.on_event("startup")
async def startup():
    load_model()


@app.post("/v1/embeddings")
async def create_embeddings(request: EmbeddingRequest) -> dict:
    """OpenAI-compatible embeddings endpoint."""
    if model is None:
        raise HTTPException(status_code=503, detail="Model not loaded yet")

    texts = [request.input] if isinstance(request.input, str) else request.input
    if not texts:
        raise HTTPException(status_code=400, detail="Empty input")

    # Prepend instruction if provided (NV-Embed-v2 uses instruction-based embedding)
    instruction = request.instruction or INSTRUCTION
    if instruction:
        texts = [f"Instruct: {instruction}\nQuery: {t}" for t in texts]

    t0 = time.time()

    try:
        # SentenceTransformer.encode() returns numpy array
        with torch.no_grad():
            embeddings = model.encode(texts, convert_to_numpy=True, normalize_embeddings=True)
        torch.cuda.empty_cache()

        result = []
        for i, emb in enumerate(embeddings):
            result.append({
                "object": "embedding",
                "embedding": emb.tolist(),
                "index": i,
            })

        elapsed = time.time() - t0
        log.info(f"Embedded {len(texts)} texts in {elapsed:.2f}s ({elapsed/len(texts):.2f}s/text)")

        return {
            "object": "list",
            "data": result,
            "model": "nv-embed-v2",
            "usage": {
                "prompt_tokens": sum(len(t.split()) for t in texts),
                "total_tokens": sum(len(t.split()) for t in texts),
            },
        }
    except Exception as e:
        log.error(f"Embedding failed: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/v1/models")
async def list_models():
    return {
        "object": "list",
        "data": [
            {
                "id": "nv-embed-v2",
                "object": "model",
                "owned_by": "nvidia",
                "dimensions": 4096,
                "loaded": model is not None,
                "load_time_s": load_time,
            }
        ],
    }


@app.get("/health")
async def health():
    return {
        "status": "ok" if model is not None else "loading",
        "model": "nv-embed-v2",
        "dimensions": 4096,
        "gpu_loaded": model is not None,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8041)
    parser.add_argument("--host", type=str, default="127.0.0.1")
    args = parser.parse_args()

    uvicorn.run(app, host=args.host, port=args.port)
