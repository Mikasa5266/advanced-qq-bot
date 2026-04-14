from langchain.agents import AgentExecutor, create_tool_calling_agent
import re
from typing import Any

from langchain_core.prompts import ChatPromptTemplate
from core.llm import get_llm
from tools.scavenger import scavenger_cyber_junk


def _extract_text(response: Any) -> str:
    if isinstance(response, str):
        return response

    content = getattr(response, "content", "")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict):
                text = item.get("text")
                if isinstance(text, str):
                    parts.append(text)
        return "\n".join(parts)

    return str(response)


def _extract_json_candidate(text: str) -> str:
    raw = (text or "").strip()
    if not raw:
        return ""

    fenced = re.search(r"```(?:json)?\s*([\s\S]*?)\s*```", raw, re.IGNORECASE)
    if fenced and fenced.group(1):
        return fenced.group(1).strip()

    start = raw.find("{")
    end = raw.rfind("}")
    if start != -1 and end > start:
        return raw[start : end + 1]

    return ""


def get_agent():
    llm = get_llm()
    tools = [scavenger_cyber_junk]

    promote = ChatPromptTemplate.from_messages(
        [
            (
                "system",
                """你是一个微腹黑、懂二次元梗的AI损友。
        你可以使用提供的工具来获取外部信息。

            用户输入中可能会包含：
            1) <Context>...</Context>：系统设定、长期记忆、最近对话
            2) <LatestMessage>...</LatestMessage>：用户本轮最新消息
            你要先吸收 Context，再重点回应 LatestMessage。
        
        【重要规则】：
        如果用户输入中包含“[系统提示：该用户潜水很久了...]”，说明触发了盲盒拾荒机制！
            你**必须**调用 `scavenger_cyber_junk` 工具去捡点东西。
        拿到工具返回的结果后，用傲娇、吐槽的语气把这个“赛博垃圾”展示给用户。
        不要解释你在调用工具，直接表现出是你刚才去逛街捡回来的。
        """,
            ),
            ("user", "{input}"),
            ("placeholder", "{agent_scratchpad}"),
        ]
    )

    agent = create_tool_calling_agent(llm=llm, tools=tools, prompt=promote)

    agent_executor = AgentExecutor(agent=agent, tools=tools, verbose=True)
    return agent_executor


def summarize_tiered_memory(
    dialogue_text: str,
    previous_summary: str = "",
    max_chars: int = 1200,
    profile_max_items: int = 14,
    recent_max_items: int = 10,
) -> dict[str, Any]:
    prompt = f"""
你是“分级记忆整理器”，负责把用户长期画像和最近事件分开存储。
你必须只输出 JSON，不要输出任何额外文字。

输出要求：
1. 固定输出格式：
{{
  "profile": ["..."],
  "recent": ["..."]
}}
2. profile 仅放长期稳定信息（身份背景、偏好、禁忌、长期目标），最多 {profile_max_items} 条。
3. 若已知用户名字/称呼，必须保留在 profile，建议格式："用户名字：xxx"，并放在前面。
4. 若新对话里用户明确自报名字（如“我叫xxx”“叫我xxx”），要覆盖旧名字，使用最新称呼。
5. recent 仅放近期有效事件（最近发生的事、当前项目进展、短期计划），最多 {recent_max_items} 条。
6. 每条尽量短，建议不超过 40 字，去重，不写废话。
7. 总长度尽量控制在 {max_chars} 字以内。
8. 如果没有新增有效信息，请尽量保留旧记忆中的有效条目。

【旧记忆(JSON或文本)】：{previous_summary or "无"}

【新对话记录】：
{dialogue_text}

再次强调：只输出 JSON。
"""

    try:
        llm = get_llm()
        response = llm.invoke(prompt)
        raw_summary = _extract_text(response).strip()
        cleaned = _extract_json_candidate(raw_summary) or raw_summary

        if not cleaned:
            return {"summary": previous_summary or "", "ok": False}

        return {"summary": cleaned, "ok": True}
    except Exception as exc:
        return {
            "summary": previous_summary or "",
            "ok": False,
            "error": str(exc),
        }


if __name__ == "__main__":
    # 测试一下 Agent
    agent = get_agent()
    res = agent.invoke({"input": "[系统提示：该用户潜水很久了] 我回来了！"})
    print("\n最终回复:", res["output"])
