from fastapi import FastAPI
from pydantic import BaseModel, Field
from typing import List, Optional
from core.agent import get_agent, summarize_tiered_memory

app = FastAPI()

agent = get_agent()


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

    user_input = _compose_user_input(req)
    response = agent.invoke({"input": user_input})
    return {"reply": response["output"]}


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


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8084)
