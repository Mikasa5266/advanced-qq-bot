import random
import re
from pathlib import Path
from typing import Dict

SUPPORTED_IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".gif"}

MEME_CATEGORY_MAP: Dict[str, str] = {
    "嘲笑": "laugh",
    "疑问": "question",
}


class MemeInterceptor:
    TAG_PATTERN = re.compile(r"\[\[\s*表情\s*:\s*([^\]]+?)\s*\]\]")

    def __init__(
        self, memes_root: Path | None = None, category_map: Dict[str, str] | None = None
    ):
        self.memes_root = memes_root or (
            Path(__file__).resolve().parent.parent / "memes"
        )
        self.category_map = category_map or MEME_CATEGORY_MAP

    def _pick_image(self, category_name: str) -> str:
        folder_name = self.category_map.get(category_name.strip())
        if not folder_name:
            return ""

        category_dir = (self.memes_root / folder_name).resolve()
        if not category_dir.exists() or not category_dir.is_dir():
            return ""

        candidates = [
            path
            for path in category_dir.iterdir()
            if path.is_file() and path.suffix.lower() in SUPPORTED_IMAGE_SUFFIXES
        ]
        if not candidates:
            return ""

        picked = random.choice(candidates).resolve()
        file_uri = f"file:///{picked.as_posix()}"
        return f"[CQ:image,file={file_uri}]"

    def process(self, text: str) -> str:
        source = text if isinstance(text, str) else str(text or "")

        def replacer(match: re.Match[str]) -> str:
            category_name = (match.group(1) or "").strip()
            if not category_name:
                return ""

            cq_image = self._pick_image(category_name)
            return cq_image or ""

        return self.TAG_PATTERN.sub(replacer, source)


_default_interceptor = MemeInterceptor()


def process_ai_response(text: str) -> str:
    return _default_interceptor.process(text)
