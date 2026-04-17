from fastapi import FastAPI
from pydantic import BaseModel, Field
from typing import List, Optional
from contextlib import asynccontextmanager
import os
import threading
from core.agent import get_agent, run_agent, summarize_tiered_memory
from core.vector_memory import ingest_messages, search_memories
from core.scavenging import (
    ensure_scavenge_tables,
    maybe_trigger_scavenge,
    pull_pending_scavenge,
    run_scavenge_scheduler,
    update_user_activity,
)

agent = get_agent()
scavenge_stop_event = threading.Event()
scavenge_thread: threading.Thread | None = None


@asynccontextmanager
async def lifespan(_: FastAPI):
    global scavenge_thread
    ensure_scavenge_tables()

    scheduler_enabled = (
        os.getenv("ENABLE_SCAVENGE_SCHEDULER") or "true"
    ).lower() == "true"
    if scheduler_enabled:
        scavenge_stop_event.clear()
        scavenge_thread = threading.Thread(
            target=run_scavenge_scheduler,
            args=(scavenge_stop_event,),
            daemon=True,
            name="scavenge-scheduler",
        )
        scavenge_thread.start()
        print("[SCAVENGE] 后台拾荒调度器已启动")
    else:
        print("[SCAVENGE] 后台拾荒调度器已禁用")

    try:
        yield
    finally:
        scavenge_stop_event.set()
        if scavenge_thread and scavenge_thread.is_alive():
            scavenge_thread.join(timeout=3)


app = FastAPI(lifespan=lifespan)


class HistoryMessage(BaseModel):
    role: str
    content: str


class AgentContext(BaseModel):
    system_prompt: str = ""
    memory_snippet: str = ""
    short_term_history: List[HistoryMessage] = Field(default_factory=list)
    brief_reply: bool = False


class ChatRequest(BaseModel):
    user_id: str
    message: str
    is_idle_long_time: bool = False
    agent_context: Optional[AgentContext] = None


class MemorySummaryRequest(BaseModel):
    dialogue_text: str
    previous_summary: str = ""
    max_chars: int = 1200
    profile_max_items: int = 14
    recent_max_items: int = 10


class MemoryRecord(BaseModel):
    role: str
    content: str
    created_at: str = ""


class MemoryIngestRequest(BaseModel):
    user_id: str
    messages: List[MemoryRecord] = Field(default_factory=list)


class MemorySearchRequest(BaseModel):
    user_id: str
    query: str
    top_k: int = 6
    min_score: float = 0.2


class ActivityUpdateRequest(BaseModel):
    user_id: str
    last_message_at: str = ""


class ScavengeTriggerRequest(BaseModel):
    user_id: str
    idle_hours: float = 12
    probability: float = 0.75
    force: bool = False


class ScavengePullRequest(BaseModel):
    user_id: str
    mark_delivered: bool = True


def _format_history_lines(rows: List[HistoryMessage]) -> str:
    if not rows:
        return ""

    lines = []
    for row in rows:
        role = "你" if row.role == "assistant" else "用户"
        content = (row.content or "").strip()
        if content:
            lines.append(f"{role}: {content}")
    return "\n".join(lines)


def _format_rag_lines(rows: List[dict]) -> str:
    if not rows:
        return ""

    lines = []
    for row in rows:
        role = "你" if row.get("role") == "assistant" else "用户"
        content = str(row.get("content") or "").strip()
        created_at = str(row.get("created_at") or "").strip()
        if not content:
            continue
        if created_at:
            lines.append(f"[{created_at}] {role}: {content}")
        else:
            lines.append(f"{role}: {content}")

    return "\n".join(lines)


def _compose_user_input(req: ChatRequest, rag_rows: List[dict]) -> str:
    blocks = []

    if req.is_idle_long_time:
        blocks.append("[系统提示：该用户潜水很久了]")

    ctx = req.agent_context
    if ctx:
        context_parts = []
        if ctx.system_prompt.strip():
            context_parts.append(f"[系统设定]\n{ctx.system_prompt.strip()}")
        if ctx.memory_snippet.strip():
            context_parts.append(f"[用户记忆]\n{ctx.memory_snippet.strip()}")

        history_text = _format_history_lines(ctx.short_term_history)
        if history_text:
            context_parts.append(f"[最近对话]\n{history_text}")

        rag_text = _format_rag_lines(rag_rows)
        if rag_text and not ctx.memory_snippet.strip():
            context_parts.append(f"[长期检索记忆]\n{rag_text}")

        if ctx.brief_reply:
            context_parts.append("[运行提示]\n本轮回复尽量简洁，但保持口语自然。")

        if context_parts:
            blocks.append("<Context>\n" + "\n\n".join(context_parts) + "\n</Context>")

    blocks.append(f"<LatestMessage>\n{req.message}\n</LatestMessage>")
    return "\n\n".join(blocks)


@app.post("/api/chat")
async def chat_endpoint(req: ChatRequest):
    print(f"收到 Node.js 发来的消息: 用户 {req.user_id} 说: {req.message}")
    print(f"该用户是否潜水很久: {req.is_idle_long_time}")

    rag_rows = search_memories(
        user_id=req.user_id,
        query=req.message,
        top_k=int(os.getenv("VECTOR_RAG_TOP_K") or 6),
        min_score=float(os.getenv("VECTOR_RAG_MIN_SCORE") or 0.2),
    )

    user_input = _compose_user_input(req, rag_rows)
    reply = run_agent(agent, user_input)
    return {"reply": reply}


@app.post("/api/memory/summarize")
async def summarize_memory_endpoint(req: MemorySummaryRequest):
    result = summarize_tiered_memory(
        dialogue_text=req.dialogue_text,
        previous_summary=req.previous_summary,
        max_chars=req.max_chars,
        profile_max_items=req.profile_max_items,
        recent_max_items=req.recent_max_items,
    )
    return result


@app.post("/api/memory/ingest")
async def ingest_memory_endpoint(req: MemoryIngestRequest):
    payload = [
        {
            "role": row.role,
            "content": row.content,
            "created_at": row.created_at,
        }
        for row in req.messages
    ]
    result = ingest_messages(req.user_id, payload)
    return result


@app.post("/api/memory/search")
async def search_memory_endpoint(req: MemorySearchRequest):
    items = search_memories(
        user_id=req.user_id,
        query=req.query,
        top_k=req.top_k,
        min_score=req.min_score,
    )
    return {"ok": True, "items": items}


@app.post("/api/activity/update")
async def update_activity_endpoint(req: ActivityUpdateRequest):
    return update_user_activity(
        user_id=req.user_id, last_message_at=req.last_message_at
    )


@app.post("/api/scavenge/maybe-trigger")
async def maybe_trigger_scavenge_endpoint(req: ScavengeTriggerRequest):
    result = maybe_trigger_scavenge(
        user_id=req.user_id,
        idle_hours=req.idle_hours,
        probability=req.probability,
        force=req.force,
    )
    return result


@app.post("/api/scavenge/pull")
async def pull_scavenge_endpoint(req: ScavengePullRequest):
    item = pull_pending_scavenge(user_id=req.user_id, mark_delivered=req.mark_delivered)
    return {"ok": True, "item": item}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8084)
