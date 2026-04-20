from contextlib import asynccontextmanager
from typing import List

from fastapi import FastAPI
from pydantic import BaseModel, Field

from core.llm import call_bailian_agent
from tools.meme_interceptor import process_ai_response


@asynccontextmanager
async def lifespan(_: FastAPI):
    print("[BAILIAN] cyber-brain 服务已启动")
    yield


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


def _compose_user_input(req: ChatRequest) -> str:
    blocks = []
    blocks.append(req.message)
    return "\n\n".join(blocks)


@app.post("/api/chat")
async def chat_endpoint(req: ChatRequest):
    print(f"收到消息: 用户 {req.user_id} 说: {req.message}")
    raw_reply = await call_bailian_agent(user_input=req.message, user_id=req.user_id)
    final_reply = process_ai_response(raw_reply)
    return {"reply": final_reply}


@app.post("/api/memory/summarize")
async def summarize_memory_endpoint(_: MemorySummaryRequest):
    return {
        "ok": False,
        "summary": "",
        "error": "memory summarize 已停用：当前已切换为百炼 Agent 会话模式",
    }


@app.post("/api/memory/ingest")
async def ingest_memory_endpoint(_: MemoryIngestRequest):
    return {
        "ok": False,
        "error": "memory ingest 已停用：当前已切换为百炼 Agent 会话模式",
    }


@app.post("/api/memory/search")
async def search_memory_endpoint(_: MemorySearchRequest):
    return {
        "ok": False,
        "items": [],
        "error": "memory search 已停用：当前已切换为百炼 Agent 会话模式",
    }


@app.post("/api/activity/update")
async def update_activity_endpoint(_: ActivityUpdateRequest):
    return {"ok": True, "message": "activity update 已降级为 no-op"}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8084)
