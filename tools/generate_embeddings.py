import json
import numpy as np
from pathlib import Path
from sentence_transformers import SentenceTransformer

ROOT = Path(__file__).parent.parent
INPUT = ROOT / "data" / "lore_kb.json"
OUTPUT = ROOT / "data" / "lore_kb_with_embeddings.json"

MODEL_NAME = "all-MiniLM-L6-v2"

print(f"Loading embedding model: {MODEL_NAME}...")
model = SentenceTransformer(MODEL_NAME)

with open(INPUT, "r", encoding="utf-8") as f:
    kb = json.load(f)

snippets = kb.get("snippets", [])
print(f"Generating embeddings for {len(snippets)} snippets...")

contents = [f"{s['category']} {s['title']} {s['content']} {' '.join(s.get('keywords', []))}" for s in snippets]
embeddings = model.encode(contents, convert_to_numpy=True, normalize_embeddings=True)

for s, emb in zip(snippets, embeddings):
    s["embedding"] = emb.tolist()

kb["embedding_model"] = MODEL_NAME
kb["embedding_dim"] = len(embeddings[0])

with open(OUTPUT, "w", encoding="utf-8") as f:
    json.dump(kb, f, ensure_ascii=False, indent=2)

print(f"Saved to {OUTPUT}")
print(f"Embedding dimension: {len(embeddings[0])}")
