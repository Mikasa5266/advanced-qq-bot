require('dotenv').config();
const express = require('express');
const axios = require('axios');
const db = require('./db'); // 引入咱们刚刚写的数据库模块
const ai = require('./ai'); // 引入大模型交互模块

const app = express();
app.use(express.json());

const PORT = Number(process.env.PORT || 8081);
const NAPCAT_API_URL = process.env.NAPCAT_API_URL || 'http://127.0.0.1:3000';
const NAPCAT_TOKEN = process.env.NAPCAT_TOKEN || '';
console.log("👉 当前请求的 API URL 是:", NAPCAT_API_URL);
console.log("👉 当前使用的 Token 是:", NAPCAT_TOKEN ? "已设置" : "为空！");
const MAX_HISTORY_MESSAGES = Number(process.env.MAX_HISTORY_MESSAGES || 8);
const MAX_HISTORY_CONTEXT_CHARS = Number(process.env.MAX_HISTORY_CONTEXT_CHARS || 1400);
const SUMMARY_TRIGGER_MESSAGES = Number(process.env.SUMMARY_TRIGGER_MESSAGES || 24);
const SUMMARY_BATCH_SIZE = Number(process.env.SUMMARY_BATCH_SIZE || 12);
const MEMORY_MAX_CHARS = Number(process.env.MEMORY_MAX_CHARS || 1200);
const MEMORY_INJECT_MAX_CHARS = Number(process.env.MEMORY_INJECT_MAX_CHARS || 420);
const PROFILE_MAX_ITEMS = Number(process.env.PROFILE_MAX_ITEMS || 14);
const RECENT_MAX_ITEMS = Number(process.env.RECENT_MAX_ITEMS || 10);
const PROFILE_INJECT_MAX_ITEMS = Number(process.env.PROFILE_INJECT_MAX_ITEMS || 5);
const RECENT_INJECT_MAX_ITEMS = Number(process.env.RECENT_INJECT_MAX_ITEMS || 4);
const HISTORY_FETCH_LIMIT = Number(process.env.HISTORY_FETCH_LIMIT || 30);
const COLD_START_ROUNDS = Number(process.env.COLD_START_ROUNDS || 4);
const SHORT_REPLY_TRIGGER_CHARS = Number(process.env.SHORT_REPLY_TRIGGER_CHARS || 14);
const SHORT_REPLY_HISTORY_CHARS = Number(process.env.SHORT_REPLY_HISTORY_CHARS || 500);
const SHORT_REPLY_MEMORY_CHARS = Number(process.env.SHORT_REPLY_MEMORY_CHARS || 180);
const ENABLE_FAST_REPLY = (process.env.ENABLE_FAST_REPLY || 'true') === 'true';
const ENABLE_FEWSHOT = (process.env.ENABLE_FEWSHOT || 'false') === 'true';

const summarizingUsers = new Set();

// ==========================================
// 🎭 高级风格定制区 (System Prompt + Few-Shot)
// ==========================================
const MY_PERSONA_CORE = `
# Role
[随和、理智、幽默且带点腹黑的靠谱损友“叉叉”。]

# Profile
- 性格：情绪绝对稳定，务实且自带生活松弛感。面对朋友的抓狂或吐槽，总能保持理智，给出实在且带点调侃的建议，能提供极高的情绪价值。
- 习惯：
  1. 极度偏爱短句：说话不喜欢打长段文字，习惯把一个完整的意思拆成好几个极短的词组或短句（在回复中通过频繁换行来模拟连续发送多条消息）。
  2. 高频口头禅：“不造啊”、“可恶啊”、“无碍无碍”、“没事没事”、“好奇怪”、“能者多劳”。
  3. 表情符号偏好：喜欢连续发三个相同的表情加重语气（如 [/咦][/咦][/咦]、[/敬礼][/敬礼][/敬礼]），常用 [[聪明]]、[/狼狗]、[/喵喵]。
- 禁忌：绝不长篇大论说教；绝不使用华丽、官方、客套的书面语；拒绝过度热情，保持适度的慵懒和随性；绝对不要表现出AI客服的机械感。

# Reply Rules
- 回复必须自然、极度口语化。
- 强制短句输出机制：将长句子打散，用换行符（\\n）隔开，模拟真人在聊天软件上“短句连发”的节奏感。
- 保持情绪稳定，多用幽默和调侃化解对方的焦虑或崩溃。
- 保持角色一致，不要突然切换文风。
`;

const MY_PERSONA_FEWSHOT = `
# Few-Shot（新会话早期启用）
User: 救命啊，今天军训走方阵我居然同手同脚了，被全班看到了，尴尬得我想连夜逃离地球！！！
Assistant: 无碍无碍
退一万步来说
总比顺拐把自己绊倒好啊
[/咦][/咦][/咦]

User: 学校那个破征文比赛强制要求参加，我半个字都写不出来，烦死了补药啊！
Assistant: 学会用ai啊
去让ai写一篇
你应用商店下个天工
直接用就行了
方便
[[聪明]]

User: 完蛋了完蛋了，明天要交的项目我代码还有个大bug没调出来，今晚又要熬大夜了！
Assistant: 可恶啊
能者多劳
没事没事
大不了明天先糊弄一下
[/狼狗]

User: 喂，你平时周末都在寝室干嘛啊？
Assistant: 睡觉
安静睡午觉
或者去踢足球
快散架了都
然后去吃大份鸭肠
不造啊，大概就这些
[/喵喵]
`;

function normalizeText(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function dedupeMemoryLines(lines, maxItemChars = 140) {
    const seen = new Set();
    const deduped = [];

    for (const line of lines || []) {
        const cleaned = normalizeText(line)
            .replace(/^(?:[-*]\s+|\d+[.)]\s+)/, '')
            .replace(/^(P|R)[:：]\s*/i, '')
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

    return /(详细|具体|步骤|分析|解释|怎么|如何|为什么|原理|排查|优化|对比|教程|展开|细说|仔细)/i.test(source);
}

function estimateHistoryRounds(descRows) {
    return (descRows || []).reduce((count, row) => {
        return count + (row.role === 'user' ? 1 : 0);
    }, 0);
}

function buildAdaptiveBudget(message, historyRounds) {
    const normalized = normalizeText(message);
    const briefReply = normalized.length <= SHORT_REPLY_TRIGGER_CHARS && !isDetailedRequest(normalized);
    const coldStart = historyRounds < COLD_START_ROUNDS;

    let historyMessages = MAX_HISTORY_MESSAGES;
    let historyChars = MAX_HISTORY_CONTEXT_CHARS;
    let memoryChars = MEMORY_INJECT_MAX_CHARS;

    if (briefReply) {
        historyMessages = Math.min(MAX_HISTORY_MESSAGES, 4);
        historyChars = Math.min(MAX_HISTORY_CONTEXT_CHARS, SHORT_REPLY_HISTORY_CHARS);
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
        includeFewShot: ENABLE_FEWSHOT && coldStart
    };
}

function extractJsonCandidate(text) {
    const raw = normalizeText(text);
    if (!raw) return '';

    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (fenced && fenced[1]) {
        return fenced[1].trim();
    }

    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start !== -1 && end > start) {
        return raw.slice(start, end + 1);
    }

    return '';
}

function normalizeTieredMemory(memory) {
    const profileSource = memory && Array.isArray(memory.profile) ? memory.profile : [];
    const recentSource = memory && Array.isArray(memory.recent) ? memory.recent : [];

    return {
        profile: dedupeMemoryLines(profileSource).slice(0, PROFILE_MAX_ITEMS),
        recent: dedupeMemoryLines(recentSource).slice(-RECENT_MAX_ITEMS)
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
        .replace(/\r/g, '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);

    const profile = [];
    const recent = [];
    let mode = 'profile';

    for (const sourceLine of lines) {
        const line = sourceLine.replace(/^(?:[-*]\s+|\d+[.)]\s+)/, '').trim();
        if (!line) continue;
        if (/^[\[\]{}",]+$/.test(line)) continue;

        if (/^(profile|persona|长期画像|长期记忆|背景画像)[:：]?$/i.test(line)) {
            mode = 'profile';
            continue;
        }
        if (/^(recent|timeline|最近事件|近期事件|近期动态)[:：]?$/i.test(line)) {
            mode = 'recent';
            continue;
        }
        if (/^P[:：]/i.test(line)) {
            profile.push(line.replace(/^P[:：]\s*/i, ''));
            continue;
        }
        if (/^R[:：]/i.test(line)) {
            recent.push(line.replace(/^R[:：]\s*/i, ''));
            continue;
        }
        if (/^"?(profile|recent)"?\s*:\s*\[?$/i.test(line)) {
            mode = /^"?recent"?/i.test(line) ? 'recent' : 'profile';
            continue;
        }

        if (mode === 'recent') {
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
        recent: recent.map((item) => item.slice(0, 40)).slice(0, 1)
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
        sections.push(`长期画像:\n${profileItems.map((item) => `- ${item}`).join('\n')}`);
    }
    if (recentItems.length > 0) {
        sections.push(`最近事件:\n${recentItems.map((item) => `- ${item}`).join('\n')}`);
    }

    return sections.join('\n');
}

function buildMemorySnippet(summaryText, latestMessage, maxInjectChars = MEMORY_INJECT_MAX_CHARS) {
    const memory = parseTieredSummary(summaryText);
    if (!memory.profile.length && !memory.recent.length) {
        return '';
    }

    const keywords = extractKeywords(latestMessage);
    const profileScored = scoreMemoryItems(memory.profile, keywords, {
        stablePattern: /(偏好|禁忌|身份|职业|关系|背景|长期|目标|习惯)/,
        recentBoost: false
    });
    const recentScored = scoreMemoryItems(memory.recent, keywords, {
        recentBoost: true,
        baseScore: 0.5
    });

    const profileBudget = Math.floor(maxInjectChars * 0.62);
    const recentBudget = Math.max(40, maxInjectChars - profileBudget);

    let profileItems = pickScoredItems(profileScored, PROFILE_INJECT_MAX_ITEMS, profileBudget);
    let recentItems = pickScoredItems(recentScored, RECENT_INJECT_MAX_ITEMS, recentBudget);

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

        const role = row.role === 'assistant' ? 'assistant' : 'user';
        const cost = content.length + 8;

        if (selected.length >= maxMessages) break;
        if (selected.length > 0 && usedChars + cost > maxChars) break;

        selected.push({ role, content });
        usedChars += cost;
    }

    return selected.reverse();
}

function tryFastReply(message, options = {}) {
    if (!ENABLE_FAST_REPLY) return '';

    const text = normalizeText(message);
    if (!text) return '';

    const historyRounds = Number(options.historyRounds || 0);
    if (historyRounds > 0) return '';

    if (/^(在吗|在么|嗨|hi|hello|你好|哈喽|早|早安|晚安|\?|？)+$/i.test(text)) {
        return '在，别磨叽，直接说你想让我干嘛。';
    }

    if (/^(谢谢|多谢|辛苦了|thx|thanks)+$/i.test(text)) {
        return '哼，知道就好。下次把需求一次说清楚。';
    }

    return '';
}

// ==========================================
// 🧠 核心消息处理路由
// ==========================================
app.post('/', async (req, res) => {
    const data = req.body;
    
    // 1. 快速响应 NapCat，防止 Webhook 判定超时
    res.status(200).send({});

    // 2. 过滤：只处理普通私聊消息
    if (data.post_type === 'message' && data.message_type === 'private') {
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
                'SELECT role, content FROM chat_history WHERE user_id = ? ORDER BY id DESC LIMIT ?',
                [userId, HISTORY_FETCH_LIMIT]
            );
            const historyRounds = estimateHistoryRounds(historyRows);
            const budget = buildAdaptiveBudget(message, historyRounds);

            // 2. 获取长期记忆（只注入与当前问题相关的片段）
            const [memoryRows] = await db.query('SELECT summary FROM user_memory WHERE user_id = ?', [userId]);
            const fullSummary = memoryRows.length > 0 ? normalizeText(memoryRows[0].summary) : '';
            const memorySnippet = buildMemorySnippet(fullSummary, message, budget.memoryChars);

            // 3. 组装短期上下文
            const shortTermHistory = pickShortTermHistory(historyRows, {
                maxMessages: budget.historyMessages,
                maxChars: budget.historyChars
            });

            const systemParts = [MY_PERSONA_CORE];
            if (budget.includeFewShot && shortTermHistory.length <= 2) {
                systemParts.push(MY_PERSONA_FEWSHOT);
            }
            if (memorySnippet) {
                systemParts.push(`【记忆参考（仅在相关时使用）\n${memorySnippet}\n】`);
            }
            if (budget.briefReply) {
                systemParts.push('本轮回复请控制在 1 到 2 句，直给结论，不要长篇。');
            }

            const fastReply = tryFastReply(message, { historyRounds });

            // -----------------------------------------
            // 步骤 B: 思考与回复
            // -----------------------------------------
            // 1. 把用户的最新消息存入数据库
            await db.query('INSERT INTO chat_history (user_id, role, content) VALUES (?, ?, ?)', [userId, 'user', message]);

            // 2. 优先走低成本快速回复，否则调用大模型
            let reply = '';
            if (fastReply) {
                reply = fastReply;
            } else {
                const messagesArray = [
                    { role: 'system', content: systemParts.join('\n\n') },
                    ...shortTermHistory,
                    { role: 'user', content: message }
                ];

                reply = normalizeText(await ai.chatWithQwen(messagesArray)) || '刚刚有点走神，你再说一遍。';
            }

            // 3. 把大模型的回复也存入数据库
            await db.query('INSERT INTO chat_history (user_id, role, content) VALUES (?, ?, ?)', [userId, 'assistant', reply]);

            // 4. 防风控：模拟打字延迟后发送 QQ 消息
            const delay = Math.floor(Math.random() * 1500) + 1500;
            setTimeout(() => {
                sendQQMessage(userId, reply);
            }, delay);

            // -----------------------------------------
            // 步骤 C: 触发异步记忆压缩 (无感进行，不卡顿)
            // -----------------------------------------
            checkAndSummarize(userId).catch((error) => {
                console.error('异步记忆压缩失败:', error.message);
            });

        } catch (error) {
            console.error('业务逻辑出错:', error);
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
            const [countRow] = await db.query('SELECT COUNT(*) as total FROM chat_history WHERE user_id = ?', [userId]);
            const totalMessages = countRow[0].total;

            if (totalMessages <= SUMMARY_TRIGGER_MESSAGES) break;
            console.log(`用户 ${userId} 记忆达到 ${totalMessages} 条，开始压缩`);

            const [oldMsgs] = await db.query(
                'SELECT id, role, content FROM chat_history WHERE user_id = ? ORDER BY id ASC LIMIT ?',
                [userId, SUMMARY_BATCH_SIZE]
            );
            if (!oldMsgs.length) break;

            const dialogueText = oldMsgs
                .map((m) => `${m.role === 'user' ? '用户' : '你'}: ${normalizeText(m.content)}`)
                .filter(Boolean)
                .join('\n');
            if (!dialogueText) break;

            const idsToDelete = oldMsgs.map((m) => m.id);
            const [memoryRows] = await db.query('SELECT summary FROM user_memory WHERE user_id = ?', [userId]);
            const oldSummary = memoryRows.length > 0 ? normalizeText(memoryRows[0].summary) : '';

            const summaryResult = await ai.summarizeDialogue(dialogueText, oldSummary, {
                maxChars: MEMORY_MAX_CHARS,
                profileMaxItems: PROFILE_MAX_ITEMS,
                recentMaxItems: RECENT_MAX_ITEMS
            });
            if (!summaryResult.ok) {
                console.warn(`用户 ${userId} 本轮摘要失败，跳过删除，避免记忆丢失`);
                break;
            }

            const oldMemory = parseTieredSummary(oldSummary);
            const newMemory = parseTieredSummary(summaryResult.summary);
            const mergedMemory = {
                profile: [...oldMemory.profile, ...newMemory.profile],
                recent: [...oldMemory.recent, ...newMemory.recent]
            };

            const boundedSummary = serializeTieredSummary(mergedMemory, MEMORY_MAX_CHARS);
            const checkMemory = parseTieredSummary(boundedSummary);
            if (!checkMemory.profile.length && !checkMemory.recent.length) {
                console.warn(`用户 ${userId} 摘要结果为空，跳过删除避免记忆丢失`);
                break;
            }

            if (memoryRows.length === 0) {
                await db.query('INSERT INTO user_memory (user_id, summary) VALUES (?, ?)', [userId, boundedSummary]);
            } else {
                await db.query('UPDATE user_memory SET summary = ? WHERE user_id = ?', [boundedSummary, userId]);
            }

            await db.query('DELETE FROM chat_history WHERE id IN (?)', [idsToDelete]);
            console.log(`用户 ${userId} 完成一轮记忆压缩，删除 ${idsToDelete.length} 条流水`);
        }
    } catch (error) {
        console.error('记忆压缩失败:', error);
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
                message: text
            },
            { headers }
        );
        console.log(`[回复完成] -> 用户 ${userId}`);
    } catch (error) {
        console.error('发送 QQ 消息失败:', error.message);
    }
}

if (!process.env.QWEN_API_KEY) {
    console.warn('警告: 未设置 QWEN_API_KEY，AI 调用将失败');
}
if (!NAPCAT_TOKEN) {
    console.warn('提示: 未设置 NAPCAT_TOKEN，将以无鉴权方式调用 NapCat');
}

// 启动服务
app.listen(PORT, () => {
    console.log(`Bot Server 监听端口 ${PORT}`);
});