import os
import random
import sqlite3
import threading
from datetime import datetime, timedelta, timezone
from typing import Any

import requests
from dotenv import load_dotenv

load_dotenv()

_DB_PATH = (os.getenv("CYBER_SCAVENGE_DB_PATH") or "./data/cyber_scavenge.db").strip()

_IMAGE_CANDIDATES = [
    (
        "拿着垃圾的小狗.jpg",
        (
            os.getenv("SCAVENGE_IMAGE_TRASH_DOG_URL")
            or "https://picsum.photos/seed/cyber-trash-dog/640/640"
        ).strip(),
    ),
    (
        "给你看个宝贝.jpg",
        (
            os.getenv("SCAVENGE_IMAGE_TREASURE_URL")
            or "https://picsum.photos/seed/cyber-treasure/640/640"
        ).strip(),
    ),
]


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _parse_iso(value: str) -> datetime | None:
    raw = (value or "").strip()
    if not raw:
        return None
    try:
        if raw.endswith("Z"):
            return datetime.fromisoformat(raw.replace("Z", "+00:00"))
        return datetime.fromisoformat(raw)
    except Exception:
        return None


def _ensure_parent_dir(path: str) -> None:
    parent = os.path.dirname(os.path.abspath(path))
    if parent:
        os.makedirs(parent, exist_ok=True)


def _connect() -> sqlite3.Connection:
    _ensure_parent_dir(_DB_PATH)
    conn = sqlite3.connect(_DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def ensure_scavenge_tables() -> None:
    with _connect() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS user_activity (
                user_id TEXT PRIMARY KEY,
                last_message_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                last_scavenge_at TEXT
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS scavenge_box (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id TEXT NOT NULL,
                content TEXT NOT NULL,
                source TEXT NOT NULL,
                image_url TEXT,
                image_caption TEXT,
                status TEXT NOT NULL DEFAULT 'pending',
                created_at TEXT NOT NULL,
                delivered_at TEXT
            )
            """
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_scavenge_box_user_status ON scavenge_box (user_id, status, id)"
        )


def update_user_activity(
    user_id: str, last_message_at: str | None = None
) -> dict[str, Any]:
    normalized_user_id = (user_id or "").strip()
    if not normalized_user_id:
        return {"ok": False, "reason": "empty-user-id"}

    now_iso = _now_iso()
    at = (last_message_at or now_iso).strip()

    with _connect() as conn:
        conn.execute(
            """
            INSERT INTO user_activity (user_id, last_message_at, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(user_id)
            DO UPDATE SET last_message_at = excluded.last_message_at, updated_at = excluded.updated_at
            """,
            (normalized_user_id, at, now_iso),
        )

    return {"ok": True}


def _pending_item_exists(user_id: str) -> bool:
    with _connect() as conn:
        row = conn.execute(
            "SELECT 1 FROM scavenge_box WHERE user_id = ? AND status = 'pending' LIMIT 1",
            (user_id,),
        ).fetchone()
    return row is not None


def _pick_image() -> tuple[str, str]:
    caption, url = random.choice(_IMAGE_CANDIDATES)
    return caption, url


def _fetch_hitokoto() -> tuple[str, str]:
    response = requests.get("https://v1.hitokoto.cn", timeout=6)
    response.raise_for_status()
    data = response.json()
    sentence = str(data.get("hitokoto") or "没捡到东西").strip()
    source = str(data.get("from") or "未知角落").strip()
    return sentence, f"Hitokoto/{source}"


def _fetch_programming_joke() -> tuple[str, str]:
    response = requests.get(
        "https://v2.jokeapi.dev/joke/Programming?type=single",
        timeout=6,
    )
    response.raise_for_status()
    data = response.json()
    joke = str(data.get("joke") or "今天互联网挺安静").strip()
    return joke, "JokeAPI"


def _fetch_reddit_programmer_humor() -> tuple[str, str]:
    headers = {"User-Agent": "advanced-qq-bot/1.0"}
    response = requests.get(
        "https://www.reddit.com/r/ProgrammerHumor/hot.json?limit=20",
        headers=headers,
        timeout=8,
    )
    response.raise_for_status()
    data = response.json()

    posts = ((data or {}).get("data") or {}).get("children") or []
    titles = []
    for post in posts:
        title = str((((post or {}).get("data") or {}).get("title")) or "").strip()
        if title:
            titles.append(title)

    if not titles:
        raise RuntimeError("reddit empty")

    return random.choice(titles), "Reddit/r/ProgrammerHumor"


def _fetch_zhihu_hot() -> tuple[str, str]:
    headers = {"User-Agent": "Mozilla/5.0"}
    response = requests.get(
        "https://www.zhihu.com/api/v3/feed/topstory/hot-lists/total?limit=20",
        headers=headers,
        timeout=8,
    )
    response.raise_for_status()
    data = response.json()

    rows = (data or {}).get("data") or []
    titles = []
    for row in rows:
        target = (row or {}).get("target") or {}
        title = str(target.get("title") or "").strip()
        if title:
            titles.append(title)

    if not titles:
        raise RuntimeError("zhihu empty")

    return random.choice(titles), "知乎热榜"


def _pick_scavenge_content() -> tuple[str, str]:
    fetchers = [
        _fetch_zhihu_hot,
        _fetch_reddit_programmer_humor,
        _fetch_programming_joke,
        _fetch_hitokoto,
    ]
    random.shuffle(fetchers)

    for fetch in fetchers:
        try:
            return fetch()
        except Exception:
            continue

    return "今天互联网废品站只捡到一团缓存灰，不过也算战利品。", "赛博废品站"


def _create_pending_item(user_id: str) -> dict[str, Any]:
    content, source = _pick_scavenge_content()
    image_caption, image_url = _pick_image()
    now_iso = _now_iso()

    with _connect() as conn:
        conn.execute(
            """
            INSERT INTO scavenge_box (user_id, content, source, image_url, image_caption, status, created_at)
            VALUES (?, ?, ?, ?, ?, 'pending', ?)
            """,
            (user_id, content, source, image_url, image_caption, now_iso),
        )
        conn.execute(
            "UPDATE user_activity SET last_scavenge_at = ? WHERE user_id = ?",
            (now_iso, user_id),
        )

    return {
        "user_id": user_id,
        "content": content,
        "source": source,
        "image_url": image_url,
        "image_caption": image_caption,
        "created_at": now_iso,
    }


def maybe_trigger_scavenge(
    user_id: str,
    idle_hours: float = 12,
    probability: float = 0.75,
    force: bool = False,
) -> dict[str, Any]:
    normalized_user_id = (user_id or "").strip()
    if not normalized_user_id:
        return {"ok": False, "triggered": False, "reason": "empty-user-id"}

    ensure_scavenge_tables()

    if _pending_item_exists(normalized_user_id):
        return {"ok": True, "triggered": False, "reason": "pending-exists"}

    with _connect() as conn:
        row = conn.execute(
            "SELECT last_message_at, last_scavenge_at FROM user_activity WHERE user_id = ?",
            (normalized_user_id,),
        ).fetchone()

    now = datetime.now(timezone.utc)

    if force:
        item = _create_pending_item(normalized_user_id)
        return {"ok": True, "triggered": True, "item": item, "reason": "forced"}

    if row is None:
        return {"ok": True, "triggered": False, "reason": "no-activity"}

    last_message_at = _parse_iso(str(row["last_message_at"] or ""))
    if last_message_at is None:
        return {"ok": True, "triggered": False, "reason": "bad-activity-time"}

    idle_delta = now - last_message_at
    if idle_delta < timedelta(hours=float(idle_hours)):
        return {"ok": True, "triggered": False, "reason": "not-idle-enough"}

    last_scavenge_at = _parse_iso(str(row["last_scavenge_at"] or ""))
    if last_scavenge_at and now - last_scavenge_at < timedelta(
        hours=max(1.0, float(idle_hours) / 2.0)
    ):
        return {"ok": True, "triggered": False, "reason": "cooldown"}

    chance = max(0.0, min(1.0, float(probability)))
    if random.random() > chance:
        return {"ok": True, "triggered": False, "reason": "random-not-hit"}

    item = _create_pending_item(normalized_user_id)
    return {"ok": True, "triggered": True, "item": item, "reason": "idle-triggered"}


def pull_pending_scavenge(
    user_id: str, mark_delivered: bool = True
) -> dict[str, Any] | None:
    normalized_user_id = (user_id or "").strip()
    if not normalized_user_id:
        return None

    ensure_scavenge_tables()

    with _connect() as conn:
        row = conn.execute(
            """
            SELECT id, user_id, content, source, image_url, image_caption, created_at
            FROM scavenge_box
            WHERE user_id = ? AND status = 'pending'
            ORDER BY id ASC
            LIMIT 1
            """,
            (normalized_user_id,),
        ).fetchone()

        if row is None:
            return None

        item = {
            "id": int(row["id"]),
            "user_id": str(row["user_id"]),
            "content": str(row["content"]),
            "source": str(row["source"]),
            "image_url": str(row["image_url"] or ""),
            "image_caption": str(row["image_caption"] or ""),
            "created_at": str(row["created_at"] or ""),
        }

        if mark_delivered:
            conn.execute(
                "UPDATE scavenge_box SET status = 'delivered', delivered_at = ? WHERE id = ?",
                (_now_iso(), item["id"]),
            )

    return item


def sweep_idle_users(idle_hours: float, probability: float) -> int:
    ensure_scavenge_tables()

    with _connect() as conn:
        rows = conn.execute("SELECT user_id FROM user_activity").fetchall()

    triggered = 0
    for row in rows:
        user_id = str(row["user_id"])
        result = maybe_trigger_scavenge(
            user_id=user_id,
            idle_hours=idle_hours,
            probability=probability,
            force=False,
        )
        if result.get("triggered"):
            triggered += 1

    return triggered


def run_scavenge_scheduler(stop_event: threading.Event) -> None:
    ensure_scavenge_tables()

    interval_seconds = int(os.getenv("SCAVENGE_SCHEDULER_INTERVAL_SECONDS") or 900)
    idle_hours = float(os.getenv("SCAVENGE_IDLE_HOURS") or 12)
    probability = float(os.getenv("SCAVENGE_TRIGGER_PROBABILITY") or 0.75)

    while not stop_event.is_set():
        try:
            count = sweep_idle_users(idle_hours=idle_hours, probability=probability)
            if count > 0:
                print(f"[SCAVENGE] 本轮后台拾荒触发 {count} 个盲盒")
        except Exception as exc:
            print(f"[SCAVENGE] 后台拾荒任务异常: {exc}")

        stop_event.wait(interval_seconds)
