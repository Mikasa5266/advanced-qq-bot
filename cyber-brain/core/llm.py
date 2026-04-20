import asyncio
import os
from http import HTTPStatus
from typing import Any

import dashscope
from dotenv import load_dotenv

load_dotenv()


def _read_bailian_env() -> tuple[str, str]:
    api_key = (os.getenv("DASHSCOPE_API_KEY") or "").strip()
    app_id = (os.getenv("BAILIAN_APP_ID") or "").strip()

    if not api_key:
        raise ValueError("请在 .env 中配置 DASHSCOPE_API_KEY")
    if not app_id:
        raise ValueError("请在 .env 中配置 BAILIAN_APP_ID")

    return api_key, app_id


def _normalize_text(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def _extract_text_from_content(content: Any) -> str:
    if isinstance(content, str):
        return content.strip()

    if isinstance(content, dict):
        text = _normalize_text(content.get("text") or content.get("content"))
        return text

    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, str):
                cleaned = item.strip()
                if cleaned:
                    parts.append(cleaned)
            elif isinstance(item, dict):
                cleaned = _normalize_text(item.get("text") or item.get("content"))
                if cleaned:
                    parts.append(cleaned)
        return "\n".join(parts).strip()

    return ""


def _extract_response_text(response: Any) -> str:
    if response is None:
        return ""

    if isinstance(response, dict):
        output = response.get("output")
        if isinstance(output, dict):
            text = _normalize_text(output.get("text"))
            if text:
                return text

            message = output.get("message")
            message_text = _extract_text_from_content(
                message.get("content") if isinstance(message, dict) else None
            )
            if message_text:
                return message_text

            choices = output.get("choices")
            if isinstance(choices, list):
                for choice in choices:
                    if not isinstance(choice, dict):
                        continue
                    message = choice.get("message")
                    candidate = _extract_text_from_content(
                        message.get("content") if isinstance(message, dict) else None
                    )
                    if candidate:
                        return candidate

        return _normalize_text(response.get("text"))

    output = getattr(response, "output", None)
    if output is not None:
        text = _normalize_text(getattr(output, "text", None))
        if text:
            return text

        if isinstance(output, dict):
            message = output.get("message")
            candidate = _extract_text_from_content(
                message.get("content") if isinstance(message, dict) else None
            )
            if candidate:
                return candidate

    return _normalize_text(getattr(response, "text", None))


def _extract_error_message(response: Any) -> str:
    if response is None:
        return "未知错误"

    if isinstance(response, dict):
        return _normalize_text(response.get("message")) or _normalize_text(
            response.get("code")
        )

    return _normalize_text(getattr(response, "message", None)) or _normalize_text(
        getattr(response, "code", None)
    )


def _call_bailian_agent_sync(user_input: str, user_id: str) -> str:
    api_key, app_id = _read_bailian_env()
    dashscope.api_key = api_key

    response = dashscope.Application.call(
        app_id=app_id,
        prompt=user_input,
        session_id=user_id,
    )

    status_code = None
    if isinstance(response, dict):
        status_code = response.get("status_code")
    else:
        status_code = getattr(response, "status_code", None)

    if status_code not in (None, HTTPStatus.OK, HTTPStatus.CREATED, 200, 201):
        detail = _extract_error_message(response) or "百炼服务返回异常"
        raise RuntimeError(detail)

    text = _extract_response_text(response)
    if not text:
        raise RuntimeError("百炼返回为空")

    return text


async def call_bailian_agent(user_input: str, user_id: str) -> str:
    normalized_input = (user_input or "").strip()
    normalized_user_id = (user_id or "").strip()

    if not normalized_input:
        return "你还没输入内容，发一句话试试。"
    if not normalized_user_id:
        return "会话信息缺失，请稍后重试。"

    timeout_seconds = float(os.getenv("BAILIAN_TIMEOUT_SECONDS") or 30)

    try:
        return await asyncio.wait_for(
            asyncio.to_thread(
                _call_bailian_agent_sync,
                normalized_input,
                normalized_user_id,
            ),
            timeout=timeout_seconds,
        )
    except asyncio.TimeoutError:
        return "抱歉，我这边请求超时了，稍后再试一次吧。"
    except Exception as exc:  # noqa: BLE001
        print(f"[BAILIAN] 调用失败: {exc}")
        return "抱歉，我现在有点忙不过来，请稍后再试。"
