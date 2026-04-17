import hashlib
import os
from typing import Any

from chromadb.utils import embedding_functions
from dotenv import load_dotenv
from langchain_chroma import Chroma
from langchain_core.documents import Document
from langchain_core.embeddings import Embeddings
from langchain_openai import OpenAIEmbeddings

load_dotenv()


class LocalChromaEmbeddings(Embeddings):
    def __init__(self) -> None:
        self._fn = embedding_functions.DefaultEmbeddingFunction()

    def embed_documents(self, texts: list[str]) -> list[list[float]]:
        return self._fn(texts)

    def embed_query(self, text: str) -> list[float]:
        vectors = self._fn([text])
        return vectors[0]


_embeddings: Embeddings | None = None
_vector_store: Chroma | None = None


def get_embeddings() -> Embeddings:
    global _embeddings
    if _embeddings is not None:
        return _embeddings

    provider = (os.getenv("EMBEDDING_PROVIDER") or "openai").strip().lower()
    if provider in {"openai", "openai-compatible", "openai_compatible"}:
        api_key = (os.getenv("EMBEDDING_API_KEY") or "").strip()
        base_url = (os.getenv("EMBEDDING_API_BASE_URL") or "").strip()
        model = (os.getenv("EMBEDDING_MODEL") or "text-embedding-3-small").strip()

        if not api_key:
            raise ValueError("EMBEDDING_PROVIDER=openai 时缺少 EMBEDDING_API_KEY")
        if not base_url:
            raise ValueError("EMBEDDING_PROVIDER=openai 时缺少 EMBEDDING_API_BASE_URL")

        _embeddings = OpenAIEmbeddings(
            api_key=api_key,
            base_url=base_url,
            model=model,
            tiktoken_enabled=False,
            check_embedding_ctx_length=False,
        )
    else:
        _embeddings = LocalChromaEmbeddings()

    return _embeddings


def get_vector_store() -> Chroma:
    global _vector_store
    if _vector_store is not None:
        return _vector_store

    persist_dir = (os.getenv("CHROMA_PERSIST_DIR") or "./data/chroma").strip()
    collection_name = (
        os.getenv("CHROMA_COLLECTION") or "qq_chat_long_term_memory"
    ).strip()

    os.makedirs(persist_dir, exist_ok=True)

    _vector_store = Chroma(
        collection_name=collection_name,
        persist_directory=persist_dir,
        embedding_function=get_embeddings(),
    )
    return _vector_store


def _stable_doc_id(user_id: str, role: str, content: str, created_at: str) -> str:
    source = f"{user_id}|{role}|{created_at}|{content}".encode("utf-8", errors="ignore")
    return hashlib.sha1(source).hexdigest()


def ingest_messages(user_id: str, messages: list[dict[str, Any]]) -> dict[str, Any]:
    normalized_user_id = (user_id or "").strip()
    if not normalized_user_id:
        return {"ok": False, "added": 0, "reason": "empty-user-id"}

    docs: list[Document] = []
    ids: list[str] = []

    for item in messages or []:
        role = str(item.get("role") or "user").strip()
        content = str(item.get("content") or "").strip()
        created_at = str(item.get("created_at") or "").strip()
        if not content:
            continue

        metadata = {
            "user_id": normalized_user_id,
            "role": role,
            "created_at": created_at,
        }
        docs.append(Document(page_content=content, metadata=metadata))
        ids.append(_stable_doc_id(normalized_user_id, role, content, created_at))

    if not docs:
        return {"ok": True, "added": 0}

    vector_store = get_vector_store()
    vector_store.add_documents(documents=docs, ids=ids)
    return {"ok": True, "added": len(docs)}


def search_memories(
    user_id: str,
    query: str,
    top_k: int = 6,
    min_score: float = 0.2,
) -> list[dict[str, Any]]:
    normalized_user_id = (user_id or "").strip()
    normalized_query = (query or "").strip()
    if not normalized_user_id or not normalized_query:
        return []

    k = max(1, int(top_k or 1))
    threshold = float(min_score)

    vector_store = get_vector_store()
    rows = vector_store.similarity_search_with_score(
        query=normalized_query,
        k=k,
        filter={"user_id": normalized_user_id},
    )

    results: list[dict[str, Any]] = []
    for document, distance in rows:
        distance_value = float(distance)
        if distance_value < 0:
            distance_value = 0.0

        # Chroma 返回的是距离，越小越相似；转换成 (0,1] 的相关度分数。
        relevance = 1.0 / (1.0 + distance_value)
        if relevance < threshold:
            continue

        metadata = document.metadata or {}
        results.append(
            {
                "content": document.page_content,
                "role": str(metadata.get("role") or "user"),
                "created_at": str(metadata.get("created_at") or ""),
                "score": relevance,
            }
        )

    results.sort(key=lambda row: row.get("score", 0.0), reverse=True)
    return results
