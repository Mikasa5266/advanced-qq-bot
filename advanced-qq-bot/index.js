require("dotenv").config();
const express = require("express");
const axios = require("axios");
const db = require("./db"); // 引入咱们刚刚写的数据库模块
const ai = require("./ai"); // 引入大模型交互模块

const app = express();
app.use(express.json());

const PORT = Number(process.env.PORT || 8081);
const NAPCAT_API_URL = process.env.NAPCAT_API_URL || "http://127.0.0.1:3000";
const NAPCAT_TOKEN = process.env.NAPCAT_TOKEN || "";
console.log("👉 当前请求的 API URL 是:", NAPCAT_API_URL);
console.log("👉 当前使用的 Token 是:", NAPCAT_TOKEN ? "已设置" : "为空！");
const MAX_HISTORY_MESSAGES = Number(process.env.MAX_HISTORY_MESSAGES || 8);
const MAX_HISTORY_CONTEXT_CHARS = Number(
  process.env.MAX_HISTORY_CONTEXT_CHARS || 1400,
);
const SUMMARY_TRIGGER_MESSAGES = Number(
  process.env.SUMMARY_TRIGGER_MESSAGES || 24,
);
const SUMMARY_BATCH_SIZE = Number(process.env.SUMMARY_BATCH_SIZE || 12);
const MEMORY_MAX_CHARS = Number(process.env.MEMORY_MAX_CHARS || 1200);
const MEMORY_INJECT_MAX_CHARS = Number(
  process.env.MEMORY_INJECT_MAX_CHARS || 420,
);
const PROFILE_MAX_ITEMS = Number(process.env.PROFILE_MAX_ITEMS || 14);
const RECENT_MAX_ITEMS = Number(process.env.RECENT_MAX_ITEMS || 10);
const PROFILE_INJECT_MAX_ITEMS = Number(
  process.env.PROFILE_INJECT_MAX_ITEMS || 5,
);
const RECENT_INJECT_MAX_ITEMS = Number(
  process.env.RECENT_INJECT_MAX_ITEMS || 4,
);
const HISTORY_FETCH_LIMIT = Number(process.env.HISTORY_FETCH_LIMIT || 30);
const COLD_START_ROUNDS = Number(process.env.COLD_START_ROUNDS || 4);
const SHORT_REPLY_TRIGGER_CHARS = Number(
  process.env.SHORT_REPLY_TRIGGER_CHARS || 6,
);
const SHORT_REPLY_HISTORY_CHARS = Number(
  process.env.SHORT_REPLY_HISTORY_CHARS || 500,
);
const SHORT_REPLY_MEMORY_CHARS = Number(
  process.env.SHORT_REPLY_MEMORY_CHARS || 180,
);
const AGENT_IDLE_GAP_MINUTES = Number(
  process.env.AGENT_IDLE_GAP_MINUTES || 180,
);
const ENABLE_FAST_REPLY = (process.env.ENABLE_FAST_REPLY || "true") === "true";
const ENABLE_FEWSHOT = (process.env.ENABLE_FEWSHOT || "false") === "true";

const summarizingUsers = new Set();

// ==========================================
// 🎭 高级风格定制区 (System Prompt + Few-Shot)
// ==========================================
const MY_PERSONA_CORE = `
<Role>
你是“叉叉”，用户的靠谱损友。
人设是：情绪稳定、微腹黑、极度随性，带点二次元宅属性。
</Role>

<Tone>
整体口吻像熟人私聊，不端着，不营业，不客服。
可以懒一点、损一点，但底层是站在用户这边。
正常讲话，像真人聊天，不要表演式输出。
</Tone>

<Rules>
默认给出完整自然的口语回复，通常 2 到 5 句。
先接住情绪，再给可执行的建议或下一步。
已知用户名字时，优先记住并自然使用该称呼。
遇到抱怨、发癫或无意义刷屏时，允许简短敷衍但有情绪价值的吐槽。
可参考语气：啊对对对、你看我像理你的样子吗、打游戏呢，晚点卷。
不确定就直说不知道，别编造事实。
</Rules>

<Constraints>
绝对禁止说教。
绝对禁止长篇大论分析。
绝对禁止使用“首先”“其次”“总而言之”这类连接词。
不要自称AI、模型、助手、客服。
不要使用 [吃瓜]、[/咦]、[[聪明]] 这类方括号表情码。
</Constraints>

<Output>
默认 2-5 句，口语自然，别写成客服模板。
用户明确要详细说明时，才适度展开。
</Output>
`;

const MY_PERSONA_FEWSHOT = `
<Examples>
<Example>
<User>今天被需求按在地上摩擦，我人要炸了。</User>
<Assistant>先缓一下，你现在只是被需求追着跑，不是世界末日。</Assistant>
<Assistant>把最急的那一条先做完，剩下的我们明天继续收拾。</Assistant>
</Example>

<Example>
<User>111111111111111</User>
<Assistant>啊对对对，你键盘今天状态挺好。</Assistant>
<Assistant>来点有信息量的，我再认真回你。</Assistant>
</Example>

<Example>
<User>我都吐槽半天了你怎么不哄我</User>
<Assistant>你看我像理你的样子吗，先把气撒完。</Assistant>
<Assistant>然后列三条待办，我陪你把第一条干掉。</Assistant>
</Example>

<Example>
<User>在吗</User>
<Assistant>在的，刚好有空。</Assistant>
<Assistant>你直接说重点，我跟你一起看。</Assistant>
</Example>
</Examples>
`;

function sanitizeNameCandidate(rawName) {
  let name = normalizeText(rawName)
    .replace(/["'“”‘’`]/g, "")
    .replace(/[。！!？?,，、;；:：]/g, "")
    .trim();

  name = name.replace(/^(?:是|叫)\s*/i, "").trim();

  if (!name) return "";
  if (name.length < 2 || name.length > 16) return "";
  if (/^\d+$/.test(name)) return "";
  if (
    /^(自己|本人|用户|朋友|同学|哥哥|姐姐|老板|主人|学生|老师|程序员|打工人|社畜)$/i.test(
      name,
    )
  )
    return "";

  return name;
}

function extractNameFromText(text) {
  const source = normalizeText(text);
  if (!source) return "";

  const patterns = [
    /(?:我叫|叫我|我的名字是|你可以叫我|喊我)\s*([A-Za-z\u4e00-\u9fa5][A-Za-z0-9_\u4e00-\u9fa5·\- ]{0,15})/i,
    /(?:我是)\s*([\u4e00-\u9fa5]{2,4})(?:[，。！!？?\s]|$)/,
    /(?:my\s+name\s+is|call\s+me)\s+([A-Za-z][A-Za-z0-9_\- ]{0,20})/i,
  ];

  for (const pattern of patterns) {
    const matched = source.match(pattern);
    if (!matched || !matched[1]) continue;

    const name = sanitizeNameCandidate(matched[1]);
    if (name) return name;
  }

  return "";
}

function extractNameFromProfile(profileItems) {
  const items = Array.isArray(profileItems) ? profileItems : [];

  for (let i = items.length - 1; i >= 0; i -= 1) {
    const line = normalizeText(items[i]);
    if (!line) continue;

    const matched = line.match(
      /(?:用户名字|名字|称呼|姓名)\s*(?:是|为|:|：)\s*([A-Za-z\u4e00-\u9fa5][A-Za-z0-9_\u4e00-\u9fa5·\- ]{0,15})/i,
    );
    if (!matched || !matched[1]) continue;

    const name = sanitizeNameCandidate(matched[1]);
    if (name) return name;
  }

  return "";
}

function inferPinnedName(oldProfileItems, historyRows) {
  let latestName = extractNameFromProfile(oldProfileItems);

  for (const row of historyRows || []) {
    if (row.role !== "user") continue;
    const name = extractNameFromText(row.content);
    if (name) {
      latestName = name;
    }
  }

  return latestName;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function dedupeMemoryLines(lines, maxItemChars = 140) {
  const seen = new Set();
  const deduped = [];

  for (const line of lines || []) {
    const cleaned = normalizeText(line)
      .replace(/^(?:[-*]\s+|\d+[.)]\s+)/, "")
      .replace(/^(P|R)[:：]\s*/i, "")
      .trim();

    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    deduped.push(cleaned.slice(0, maxItemChars));
  }

  return deduped;
}

function extractKeywords(text) {
  const source = normalizeText(text).toLowerCase();
  if (!source) return new Set();

  const enWords = source.match(/[a-z0-9_]{2,}/g) || [];
  const cnChars = source.match(/[\u4e00-\u9fa5]/g) || [];
  const cnBigrams = [];
  for (let i = 0; i < cnChars.length - 1; i += 1) {
    cnBigrams.push(cnChars[i] + cnChars[i + 1]);
  }

  return new Set([...enWords, ...cnBigrams]);
}

function isDetailedRequest(text) {
  const source = normalizeText(text);
  if (!source) return false;

  return /(详细|具体|步骤|分析|解释|怎么|如何|为什么|原理|排查|优化|对比|教程|展开|细说|仔细)/i.test(
    source,
  );
}

function estimateHistoryRounds(descRows) {
  return (descRows || []).reduce((count, row) => {
    return count + (row.role === "user" ? 1 : 0);
  }, 0);
}

function buildAdaptiveBudget(message, historyRounds) {
  const normalized = normalizeText(message);
  const briefReply =
    normalized.length <= SHORT_REPLY_TRIGGER_CHARS &&
    !isDetailedRequest(normalized);
  const coldStart = historyRounds < COLD_START_ROUNDS;

  let historyMessages = MAX_HISTORY_MESSAGES;
  let historyChars = MAX_HISTORY_CONTEXT_CHARS;
  let memoryChars = MEMORY_INJECT_MAX_CHARS;

  if (briefReply) {
    historyMessages = Math.min(MAX_HISTORY_MESSAGES, 4);
    historyChars = Math.min(
      MAX_HISTORY_CONTEXT_CHARS,
      SHORT_REPLY_HISTORY_CHARS,
    );
    memoryChars = Math.min(MEMORY_INJECT_MAX_CHARS, SHORT_REPLY_MEMORY_CHARS);
  } else if (coldStart) {
    historyMessages = Math.min(MAX_HISTORY_MESSAGES, 6);
    historyChars = Math.min(MAX_HISTORY_CONTEXT_CHARS, 1000);
    memoryChars = Math.min(MEMORY_INJECT_MAX_CHARS, 280);
  }

  return {
    briefReply,
    coldStart,
    historyMessages,
    historyChars,
    memoryChars,
    includeFewShot: ENABLE_FEWSHOT && coldStart,
  };
}

function extractJsonCandidate(text) {
  const raw = normalizeText(text);
  if (!raw) return "";

  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced && fenced[1]) {
    return fenced[1].trim();
  }

  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start !== -1 && end > start) {
    return raw.slice(start, end + 1);
  }

  return "";
}

function normalizeTieredMemory(memory) {
  const profileSource =
    memory && Array.isArray(memory.profile) ? memory.profile : [];
  const recentSource =
    memory && Array.isArray(memory.recent) ? memory.recent : [];

  return {
    profile: dedupeMemoryLines(profileSource).slice(0, PROFILE_MAX_ITEMS),
    recent: dedupeMemoryLines(recentSource).slice(-RECENT_MAX_ITEMS),
  };
}

function parseTieredSummary(summaryText) {
  const raw = normalizeText(summaryText);
  if (!raw) {
    return { profile: [], recent: [] };
  }

  const jsonCandidate = extractJsonCandidate(raw);
  if (jsonCandidate) {
    try {
      const parsed = JSON.parse(jsonCandidate);
      return normalizeTieredMemory(parsed);
    } catch (_) {
      // fall through to text mode parsing
    }
  }

  const lines = raw
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const profile = [];
  const recent = [];
  let mode = "profile";

  for (const sourceLine of lines) {
    const line = sourceLine.replace(/^(?:[-*]\s+|\d+[.)]\s+)/, "").trim();
    if (!line) continue;
    if (/^[\[\]{}",]+$/.test(line)) continue;

    if (/^(profile|persona|长期画像|长期记忆|背景画像)[:：]?$/i.test(line)) {
      mode = "profile";
      continue;
    }
    if (/^(recent|timeline|最近事件|近期事件|近期动态)[:：]?$/i.test(line)) {
      mode = "recent";
      continue;
    }
    if (/^P[:：]/i.test(line)) {
      profile.push(line.replace(/^P[:：]\s*/i, ""));
      continue;
    }
    if (/^R[:：]/i.test(line)) {
      recent.push(line.replace(/^R[:：]\s*/i, ""));
      continue;
    }
    if (/^"?(profile|recent)"?\s*:\s*\[?$/i.test(line)) {
      mode = /^"?recent"?/i.test(line) ? "recent" : "profile";
      continue;
    }

    if (mode === "recent") {
      recent.push(line);
    } else {
      profile.push(line);
    }
  }

  if (!profile.length && !recent.length) {
    const legacy = dedupeMemoryLines(lines);
    for (const item of legacy) {
      if (/(今天|昨天|最近|刚刚|这周|本周|本月|近期)/.test(item)) {
        recent.push(item);
      } else {
        profile.push(item);
      }
    }
  }

  return normalizeTieredMemory({ profile, recent });
}

function serializeTieredSummary(memory, maxChars) {
  let { profile, recent } = normalizeTieredMemory(memory);

  const serialize = () => JSON.stringify({ profile, recent });
  let output = serialize();

  while (output.length > maxChars && recent.length > 0) {
    recent.shift();
    output = serialize();
  }

  while (output.length > maxChars && profile.length > 0) {
    profile.pop();
    output = serialize();
  }

  if (output.length <= maxChars) {
    return output;
  }

  output = JSON.stringify({
    profile: profile.map((item) => item.slice(0, 40)).slice(0, 2),
    recent: recent.map((item) => item.slice(0, 40)).slice(0, 1),
  });

  if (output.length <= maxChars) {
    return output;
  }

  return JSON.stringify({ profile: [], recent: [] });
}

function scoreMemoryItems(items, keywords, options = {}) {
  const stablePattern = options.stablePattern || null;
  const recentBoost = Boolean(options.recentBoost);
  const baseScore = Number(options.baseScore || 0);

  const scored = items.map((item, index) => {
    const lowered = item.toLowerCase();
    let score = baseScore;

    if (stablePattern && stablePattern.test(item)) {
      score += 2;
    }

    if (/(用户名字|名字|称呼|姓名)/.test(item)) {
      score += 4;
    }

    for (const kw of keywords) {
      if (kw.length < 2) continue;
      if (lowered.includes(kw)) {
        score += 3;
      }
    }

    if (recentBoost) {
      score += (index + 1) / Math.max(items.length, 1);
    }

    return { item, index, score };
  });

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (recentBoost) return b.index - a.index;
    return a.index - b.index;
  });

  return scored;
}

function pickScoredItems(scoredItems, maxItems, maxChars) {
  const chosen = [];
  let usedChars = 0;

  for (const row of scoredItems) {
    const cost = row.item.length + 3;
    if (chosen.length >= maxItems) break;
    if (chosen.length > 0 && usedChars + cost > maxChars) break;

    chosen.push(row);
    usedChars += cost;
  }

  chosen.sort((a, b) => a.index - b.index);
  return chosen.map((row) => row.item);
}

function renderMemorySnippet(profileItems, recentItems) {
  const sections = [];

  if (profileItems.length > 0) {
    sections.push(
      `长期画像:\n${profileItems.map((item) => `- ${item}`).join("\n")}`,
    );
  }
  if (recentItems.length > 0) {
    sections.push(
      `最近事件:\n${recentItems.map((item) => `- ${item}`).join("\n")}`,
    );
  }

  return sections.join("\n");
}

function buildMemorySnippet(
  summaryText,
  latestMessage,
  maxInjectChars = MEMORY_INJECT_MAX_CHARS,
) {
  const memory = parseTieredSummary(summaryText);
  if (!memory.profile.length && !memory.recent.length) {
    return "";
  }

  const keywords = extractKeywords(latestMessage);
  const profileScored = scoreMemoryItems(memory.profile, keywords, {
    stablePattern:
      /(偏好|禁忌|身份|职业|关系|背景|长期|目标|习惯|名字|称呼|姓名)/,
    recentBoost: false,
  });
  const recentScored = scoreMemoryItems(memory.recent, keywords, {
    recentBoost: true,
    baseScore: 0.5,
  });

  const profileBudget = Math.floor(maxInjectChars * 0.62);
  const recentBudget = Math.max(40, maxInjectChars - profileBudget);

  let profileItems = pickScoredItems(
    profileScored,
    PROFILE_INJECT_MAX_ITEMS,
    profileBudget,
  );
  let recentItems = pickScoredItems(
    recentScored,
    RECENT_INJECT_MAX_ITEMS,
    recentBudget,
  );

  let snippet = renderMemorySnippet(profileItems, recentItems);

  while (snippet.length > maxInjectChars && recentItems.length > 0) {
    recentItems.shift();
    snippet = renderMemorySnippet(profileItems, recentItems);
  }

  while (snippet.length > maxInjectChars && profileItems.length > 0) {
    profileItems.pop();
    snippet = renderMemorySnippet(profileItems, recentItems);
  }

  return snippet.slice(0, maxInjectChars);
}

function pickShortTermHistory(descRows, options = {}) {
  const maxMessages = Number(options.maxMessages || MAX_HISTORY_MESSAGES);
  const maxChars = Number(options.maxChars || MAX_HISTORY_CONTEXT_CHARS);

  const selected = [];
  let usedChars = 0;

  for (const row of descRows) {
    const content = normalizeText(row.content);
    if (!content) continue;

    const role = row.role === "assistant" ? "assistant" : "user";
    const cost = content.length + 8;

    if (selected.length >= maxMessages) break;
    if (selected.length > 0 && usedChars + cost > maxChars) break;

    selected.push({ role, content });
    usedChars += cost;
  }

  return selected.reverse();
}

function buildAgentContext(
  systemParts,
  memorySnippet,
  shortTermHistory,
  budget,
) {
  return {
    system_prompt: Array.isArray(systemParts) ? systemParts.join("\n\n") : "",
    memory_snippet: memorySnippet || "",
    short_term_history: (shortTermHistory || []).map((row) => ({
      role: row.role === "assistant" ? "assistant" : "user",
      content: normalizeText(row.content),
    })),
    brief_reply: Boolean(budget && budget.briefReply),
  };
}

function tryFastReply(message, options = {}) {
  if (!ENABLE_FAST_REPLY) return "";

  const text = normalizeText(message);
  if (!text) return "";

  const historyRounds = Number(options.historyRounds || 0);
  if (historyRounds > 0) return "";

  if (/^(在吗|在么|嗨|hi|hello|你好|哈喽|早|早安|晚安|\?|？)+$/i.test(text)) {
    return "在呢，你直接说想聊什么，我看着回。";
  }

  if (/^(谢谢|多谢|辛苦了|thx|thanks)+$/i.test(text)) {
    return "收到，能帮上就行。你下次也可以直接把背景一次说全。";
  }

  return "";
}

function detectIdleLongTime(historyRows) {
  if (!Array.isArray(historyRows) || historyRows.length === 0) {
    return false;
  }

  const latestAtRaw = historyRows[0] && historyRows[0].created_at;
  const latestAtMs = new Date(latestAtRaw).getTime();
  if (!Number.isFinite(latestAtMs)) {
    return false;
  }

  const gapMs = Date.now() - latestAtMs;
  return gapMs >= AGENT_IDLE_GAP_MINUTES * 60 * 1000;
}

// ==========================================
// 🧠 核心消息处理路由
// ==========================================
app.post("/", async (req, res) => {
  const data = req.body;

  // 1. 快速响应 NapCat，防止 Webhook 判定超时
  res.status(200).send({});

  // 2. 过滤：只处理普通私聊消息
  if (data.post_type === "message" && data.message_type === "private") {
    const userId = data.user_id.toString();
    const message = normalizeText(data.raw_message);
    if (!message) return;

    try {
      console.log(`\n[收到消息] 用户 ${userId}: ${message}`);

      // -----------------------------------------
      // 步骤 A: 记忆装载 (短期流水 + 长期摘要)
      // -----------------------------------------
      // 1. 获取短期记忆，并计算本轮预算
      const [historyRows] = await db.query(
        "SELECT role, content, created_at FROM chat_history WHERE user_id = ? ORDER BY id DESC LIMIT ?",
        [userId, HISTORY_FETCH_LIMIT],
      );
      const historyRounds = estimateHistoryRounds(historyRows);
      const budget = buildAdaptiveBudget(message, historyRounds);
      const isIdleLongTime = detectIdleLongTime(historyRows);

      // 2. 获取长期记忆（只注入与当前问题相关的片段）
      const [memoryRows] = await db.query(
        "SELECT summary FROM user_memory WHERE user_id = ?",
        [userId],
      );
      const fullSummary =
        memoryRows.length > 0 ? normalizeText(memoryRows[0].summary) : "";
      const memorySnippet = buildMemorySnippet(
        fullSummary,
        message,
        budget.memoryChars,
      );

      // 3. 组装短期上下文
      const shortTermHistory = pickShortTermHistory(historyRows, {
        maxMessages: budget.historyMessages,
        maxChars: budget.historyChars,
      });

      const systemParts = [MY_PERSONA_CORE];
      if (budget.includeFewShot && shortTermHistory.length <= 2) {
        systemParts.push(
          `<StyleReference>\n${MY_PERSONA_FEWSHOT}\n</StyleReference>`,
        );
      }
      if (memorySnippet) {
        systemParts.push(
          `<MemoryContext>\n仅在当前问题相关时参考，不要生硬复读：\n${memorySnippet}\n</MemoryContext>`,
        );
      }
      if (budget.briefReply) {
        systemParts.push(
          "<RuntimeHint>本轮回复尽量简洁，但保持正常口语，不要只回一个短词。</RuntimeHint>",
        );
      }

      const agentContext = buildAgentContext(
        systemParts,
        memorySnippet,
        shortTermHistory,
        budget,
      );

      const shouldTryFastReply = !(ai.isCyberAgentEnabled() && isIdleLongTime);
      const fastReply = shouldTryFastReply
        ? tryFastReply(message, { historyRounds })
        : "";

      // -----------------------------------------
      // 步骤 B: 思考与回复
      // -----------------------------------------
      // 1. 把用户的最新消息存入数据库
      await db.query(
        "INSERT INTO chat_history (user_id, role, content) VALUES (?, ?, ?)",
        [userId, "user", message],
      );

      // 2. 优先走低成本快速回复，否则调用大模型
      let reply = "";
      if (fastReply) {
        reply = fastReply;
      } else {
        const messagesArray = [
          { role: "system", content: systemParts.join("\n\n") },
          ...shortTermHistory,
          { role: "user", content: message },
        ];

        reply =
          normalizeText(
            await ai.generateReply({
              userId,
              message,
              isIdleLongTime,
              messagesArray,
              agentContext,
            }),
          ) || "刚刚有点走神，你再说一遍。";
      }

      // 3. 把大模型的回复也存入数据库
      await db.query(
        "INSERT INTO chat_history (user_id, role, content) VALUES (?, ?, ?)",
        [userId, "assistant", reply],
      );

      // 4. 防风控：模拟打字延迟后发送 QQ 消息
      const delay = Math.floor(Math.random() * 1500) + 1500;
      setTimeout(() => {
        sendQQMessage(userId, reply);
      }, delay);

      // -----------------------------------------
      // 步骤 C: 触发异步记忆压缩 (无感进行，不卡顿)
      // -----------------------------------------
      checkAndSummarize(userId).catch((error) => {
        console.error("异步记忆压缩失败:", error.message);
      });
    } catch (error) {
      console.error("业务逻辑出错:", error);
    }
  }
});

// ==========================================
// 🗜️ 记忆压缩算法 (滑动窗口清除)
// ==========================================
async function checkAndSummarize(userId) {
  if (summarizingUsers.has(userId)) return;
  summarizingUsers.add(userId);

  try {
    while (true) {
      const [countRow] = await db.query(
        "SELECT COUNT(*) as total FROM chat_history WHERE user_id = ?",
        [userId],
      );
      const totalMessages = countRow[0].total;

      if (totalMessages <= SUMMARY_TRIGGER_MESSAGES) break;
      console.log(`用户 ${userId} 记忆达到 ${totalMessages} 条，开始压缩`);

      const [oldMsgs] = await db.query(
        "SELECT id, role, content FROM chat_history WHERE user_id = ? ORDER BY id ASC LIMIT ?",
        [userId, SUMMARY_BATCH_SIZE],
      );
      if (!oldMsgs.length) break;

      const dialogueText = oldMsgs
        .map(
          (m) =>
            `${m.role === "user" ? "用户" : "你"}: ${normalizeText(m.content)}`,
        )
        .filter(Boolean)
        .join("\n");
      if (!dialogueText) break;

      const idsToDelete = oldMsgs.map((m) => m.id);
      const [memoryRows] = await db.query(
        "SELECT summary FROM user_memory WHERE user_id = ?",
        [userId],
      );
      const oldSummary =
        memoryRows.length > 0 ? normalizeText(memoryRows[0].summary) : "";

      const summaryResult = await ai.summarizeDialogue(
        dialogueText,
        oldSummary,
        {
          maxChars: MEMORY_MAX_CHARS,
          profileMaxItems: PROFILE_MAX_ITEMS,
          recentMaxItems: RECENT_MAX_ITEMS,
        },
      );
      if (!summaryResult.ok) {
        console.warn(`用户 ${userId} 本轮摘要失败，跳过删除，避免记忆丢失`);
        break;
      }

      const oldMemory = parseTieredSummary(oldSummary);
      const newMemory = parseTieredSummary(summaryResult.summary);
      const pinnedName = inferPinnedName(oldMemory.profile, oldMsgs);
      const mergedMemory = {
        profile: [...oldMemory.profile, ...newMemory.profile],
        recent: [...oldMemory.recent, ...newMemory.recent],
      };

      if (pinnedName) {
        mergedMemory.profile = [
          `用户名字：${pinnedName}`,
          ...mergedMemory.profile,
        ];
      }

      const boundedSummary = serializeTieredSummary(
        mergedMemory,
        MEMORY_MAX_CHARS,
      );
      const checkMemory = parseTieredSummary(boundedSummary);
      const hasUsefulMemory =
        checkMemory.profile.length > 0 || checkMemory.recent.length > 0;

      if (hasUsefulMemory) {
        if (memoryRows.length === 0) {
          await db.query(
            "INSERT INTO user_memory (user_id, summary) VALUES (?, ?)",
            [userId, boundedSummary],
          );
        } else {
          await db.query(
            "UPDATE user_memory SET summary = ? WHERE user_id = ?",
            [boundedSummary, userId],
          );
        }
      } else {
        console.log(
          `用户 ${userId} 本轮对话无有效记忆，跳过写入，仅推进滑动窗口`,
        );
      }

      await db.query("DELETE FROM chat_history WHERE id IN (?)", [idsToDelete]);
      console.log(
        `用户 ${userId} 完成一轮记忆压缩，删除 ${idsToDelete.length} 条流水`,
      );
    }
  } catch (error) {
    console.error("记忆压缩失败:", error);
  } finally {
    summarizingUsers.delete(userId);
  }
}

// ==========================================
// 📤 调用 NapCat API 发送消息
// ==========================================
async function sendQQMessage(userId, text) {
  try {
    const headers = {};
    if (NAPCAT_TOKEN) {
      headers.Authorization = `Bearer ${NAPCAT_TOKEN}`;
    }

    await axios.post(
      `${NAPCAT_API_URL}/send_private_msg`,
      {
        user_id: Number(userId),
        message: text,
      },
      { headers },
    );
    console.log(`[回复完成] -> 用户 ${userId}`);
  } catch (error) {
    console.error("发送 QQ 消息失败:", error.message);
  }
}

if (!process.env.QWEN_API_KEY) {
  console.warn("警告: 未设置 QWEN_API_KEY，AI 调用将失败");
}
if (!NAPCAT_TOKEN) {
  console.warn("提示: 未设置 NAPCAT_TOKEN，将以无鉴权方式调用 NapCat");
}

// 启动服务
app.listen(PORT, () => {
  console.log(`Bot Server 监听端口 ${PORT}`);
});
