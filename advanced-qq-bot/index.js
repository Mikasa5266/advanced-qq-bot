require("dotenv").config({ override: true });
const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const db = require("./db");
const ai = require("./ai");

const app = express();
app.use(express.json());

const PORT = Number(process.env.PORT || 8081);
const NAPCAT_API_URL = process.env.NAPCAT_API_URL || "http://127.0.0.1:3000";
const NAPCAT_TOKEN = process.env.NAPCAT_TOKEN || "";
const WRITE_MEMORY_ASYNC =
  (process.env.BAILIAN_WRITE_MEMORY_ASYNC || "true") === "true";
const ENABLE_PROGRESS_HINT =
  (process.env.BAILIAN_PROGRESS_HINT || "true") === "true";
const PROGRESS_HINT_TEXT =
  process.env.BAILIAN_PROGRESS_HINT_TEXT ||
  "⏳ 正在思考并调用插件中，请稍候...";
const PROGRESS_HINT_DELAY_MS = Math.max(
  0,
  Number(process.env.BAILIAN_PROGRESS_HINT_DELAY_MS || 4000),
);
const MARKDOWN_IMAGE_REGEX = /!\[[^\]]*\]\((<)?(https?:\/\/[^\s)]+)(>)?\)/gi;
const MEME_TAG_REGEX = /\[\[\s*表情\s*:\s*([^\]]+?)\s*\]\]/g;
const MEME_CATEGORY_MAP = {
  嘲笑: "laugh",
  疑问: "question",
};
const MEME_IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif"]);
const MEMES_ROOT = path.resolve(__dirname, "..", "memes");
const BAILIAN_SANITY_CHECK_ENABLED =
  (process.env.BAILIAN_SANITY_CHECK_ENABLED || "true") === "true";
const BAILIAN_SANITY_CHECK_STRICT =
  (process.env.BAILIAN_SANITY_CHECK_STRICT || "false") === "true";
const BAILIAN_IDENTITY_CHECK_PROMPT =
  process.env.BAILIAN_IDENTITY_CHECK_PROMPT || "你是谁";
const BAILIAN_EXPECTED_IDENTITY_KEYWORDS = parseCsvKeywords(
  process.env.BAILIAN_EXPECTED_IDENTITY_KEYWORDS,
);

function parseCsvKeywords(value) {
  if (typeof value !== "string") return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function getErrorMessage(error) {
  if (!error) return "unknown error";
  if (error.response && error.response.data) {
    try {
      return JSON.stringify(error.response.data);
    } catch (_) {
      return String(error.response.data);
    }
  }
  return error.message || "unknown error";
}

function convertMarkdownImagesToQQMessage(text) {
  const source = normalizeText(text);
  if (!source) return "";

  return source.replace(
    MARKDOWN_IMAGE_REGEX,
    (_, _left, url) => `[CQ:image,file=${url}]`,
  );
}

function processMemeTags(text) {
  const source = normalizeText(text);
  if (!source) return "";

  return source.replace(MEME_TAG_REGEX, (_full, rawCategory) => {
    const category = normalizeText(rawCategory);
    const folderName = MEME_CATEGORY_MAP[category];
    if (!folderName) {
      return "";
    }

    const folderPath = path.resolve(MEMES_ROOT, folderName);
    try {
      if (!fs.existsSync(folderPath)) {
        return "";
      }

      const candidates = fs
        .readdirSync(folderPath, { withFileTypes: true })
        .filter(
          (entry) =>
            entry.isFile() &&
            MEME_IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()),
        )
        .map((entry) => path.resolve(folderPath, entry.name));

      if (candidates.length === 0) {
        return "";
      }

      const picked =
        candidates[Math.floor(Math.random() * candidates.length)] || "";
      if (!picked) {
        return "";
      }

      const fileUri = `file:///${picked.replace(/\\/g, "/")}`;
      return `[CQ:image,file=${fileUri}]`;
    } catch (error) {
      console.warn("[表情包转换] 读取本地表情包失败:", getErrorMessage(error));
      return "";
    }
  });
}

async function saveChatMessage(userId, role, content) {
  const message = normalizeText(content);
  if (!userId || !role || !message) return;

  try {
    await db.query(
      "INSERT INTO chat_history (user_id, role, content) VALUES (?, ?, ?)",
      [userId, role, message],
    );
  } catch (error) {
    console.error("写入 chat_history 失败:", getErrorMessage(error));
  }
}

async function sendQQMessage(userId, text) {
  try {
    const normalized = normalizeText(text);
    if (!normalized) return;

    const qqMessage = convertMarkdownImagesToQQMessage(normalized);
    if (qqMessage !== normalized) {
      console.log("[图片转换] 检测到 Markdown 图片，已转换为 CQ 码发送");
    }

    const headers = {};
    if (NAPCAT_TOKEN) {
      headers.Authorization = `Bearer ${NAPCAT_TOKEN}`;
    }

    await axios.post(
      `${NAPCAT_API_URL}/send_private_msg`,
      {
        user_id: Number(userId),
        message: qqMessage,
      },
      { headers },
    );

    console.log(`[回复完成] -> 用户 ${userId}`);
  } catch (error) {
    console.error("发送 QQ 消息失败:", getErrorMessage(error));
  }
}

function createProgressHintController(userId) {
  let timer = null;
  let canceled = false;

  return {
    start() {
      if (!ENABLE_PROGRESS_HINT || PROGRESS_HINT_DELAY_MS <= 0) return;

      timer = setTimeout(() => {
        if (canceled) return;

        sendQQMessage(userId, PROGRESS_HINT_TEXT).catch((error) => {
          console.error("发送处理中提示失败:", getErrorMessage(error));
        });
      }, PROGRESS_HINT_DELAY_MS);
    },
    cancel() {
      canceled = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}

async function runBailianSanityCheck() {
  if (!BAILIAN_SANITY_CHECK_ENABLED) {
    return;
  }

  const result = await ai.sanityCheckAgentBinding({
    probePrompt: BAILIAN_IDENTITY_CHECK_PROMPT,
    expectedKeywords: BAILIAN_EXPECTED_IDENTITY_KEYWORDS,
  });

  const briefReply = normalizeText(result.reply).slice(0, 120);
  console.log(
    `[Bailian SANITY] app_id=${result.appId} prompt=${result.probePrompt}`,
  );
  console.log(`[Bailian SANITY] reply=${briefReply}`);

  if (result.ok) {
    return;
  }

  const expected = result.expectedKeywords.join(", ");
  const warnMessage =
    `[Bailian SANITY] 身份校验未命中预期关键词: ${expected}. ` +
    "请确认控制台已发布最新版本，且 BAILIAN_APP_ID 指向当前应用。";

  if (BAILIAN_SANITY_CHECK_STRICT) {
    throw new Error(warnMessage);
  }

  console.warn(warnMessage);
}

async function handlePrivateMessage(userId, message) {
  const progressHint = createProgressHintController(userId);
  progressHint.start();

  try {
    console.log(`\n[收到消息] 用户 ${userId}: ${message}`);

    await saveChatMessage(userId, "user", message);

    // Step A: Read memory and profile from Bailian Memory Library.
    const memoryContext = await ai.readUserMemoryContext({
      userId,
      query: message,
    });

    // Step B: Call Bailian Agent App with current message + memory context.
    let reply =
      normalizeText(
        await ai.callAgentAppWithMemory({
          userId,
          userMessage: message,
          memoryNodes: memoryContext.memoryNodes,
          profile: memoryContext.profile,
        }),
      ) || "我刚刚有点走神了，你再发一次试试。";

    reply = processMemeTags(reply);

    await saveChatMessage(userId, "assistant", reply);
    await sendQQMessage(userId, reply);

    // Step C: Write this round conversation back to Memory Library.
    const writeTask = ai.writeConversationMemory({
      userId,
      userMessage: message,
      assistantMessage: reply,
    });

    if (WRITE_MEMORY_ASYNC) {
      writeTask.catch((error) => {
        console.error("[Step C] 写记忆失败:", getErrorMessage(error));
      });
    } else {
      await writeTask;
    }
  } catch (error) {
    console.error("业务逻辑出错:", getErrorMessage(error));
    await sendQQMessage(userId, "我这边暂时有点忙不过来，等会再聊。\n");
  } finally {
    progressHint.cancel();
  }
}

app.post("/", (req, res) => {
  const data = req.body || {};

  // Fast ack to NapCat webhook.
  res.status(200).send({});

  if (!(data.post_type === "message" && data.message_type === "private")) {
    return;
  }

  const userId = normalizeText(String(data.user_id || ""));
  const message = normalizeText(data.raw_message);

  if (!userId || !message) return;

  // Fire and forget: keep webhook path fast, then push final result actively.
  handlePrivateMessage(userId, message).catch((error) => {
    console.error("后台消息处理失败:", getErrorMessage(error));
  });
});

if (!process.env.BAILIAN_API_KEY) {
  console.warn("警告: 未设置 BAILIAN_API_KEY，百炼 API 调用会失败");
}

if (!process.env.BAILIAN_APP_ID) {
  console.warn("警告: 未设置 BAILIAN_APP_ID，智能体应用调用会失败");
}

if (!process.env.BAILIAN_MEMORY_LIBRARY_ID) {
  console.warn("提示: 未设置 BAILIAN_MEMORY_LIBRARY_ID，将使用默认记忆库");
}

if (!NAPCAT_TOKEN) {
  console.warn("提示: 未设置 NAPCAT_TOKEN，将以无鉴权方式调用 NapCat");
}

async function startServer() {
  try {
    await runBailianSanityCheck();
  } catch (error) {
    console.error("[Bailian SANITY] 启动前校验失败:", getErrorMessage(error));
    process.exit(1);
  }

  app.listen(PORT, () => {
    console.log(`Bot Server 监听端口 ${PORT}`);
  });
}

startServer().catch((error) => {
  console.error("服务启动失败:", getErrorMessage(error));
  process.exit(1);
});
