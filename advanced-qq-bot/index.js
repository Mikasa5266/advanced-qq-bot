require("dotenv").config();
const express = require("express");
const axios = require("axios");
const db = require("./db");
const ai = require("./ai");

const app = express();
app.use(express.json());

const PORT = Number(process.env.PORT || 8081);
const NAPCAT_API_URL = process.env.NAPCAT_API_URL || "http://127.0.0.1:3000";
const NAPCAT_TOKEN = process.env.NAPCAT_TOKEN || "";
const WRITE_MEMORY_ASYNC =
  (process.env.BAILIAN_WRITE_MEMORY_ASYNC || "true") === "true";
const MARKDOWN_IMAGE_REGEX = /!\[[^\]]*\]\((<)?(https?:\/\/[^\s)]+)(>)?\)/gi;

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

app.post("/", async (req, res) => {
  const data = req.body || {};

  // Fast ack to NapCat webhook.
  res.status(200).send({});

  if (!(data.post_type === "message" && data.message_type === "private")) {
    return;
  }

  const userId = normalizeText(String(data.user_id || ""));
  const message = normalizeText(data.raw_message);

  if (!userId || !message) return;

  try {
    console.log(`\n[收到消息] 用户 ${userId}: ${message}`);

    await saveChatMessage(userId, "user", message);

    // Step A: Read memory and profile from Bailian Memory Library.
    const memoryContext = await ai.readUserMemoryContext({
      userId,
      query: message,
    });

    // Step B: Call Bailian Agent App with current message + memory context.
    const reply =
      normalizeText(
        await ai.callAgentAppWithMemory({
          userId,
          userMessage: message,
          memoryNodes: memoryContext.memoryNodes,
          profile: memoryContext.profile,
        }),
      ) || "我刚刚有点走神了，你再发一次试试。";

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
  }
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

app.listen(PORT, () => {
  console.log(`Bot Server 监听端口 ${PORT}`);
});
