// ai.js
const axios = require('axios');

const QWEN_API_KEY = process.env.QWEN_API_KEY || '';
const API_URL = process.env.QWEN_API_URL || 'https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation';
const CHAT_MODEL = process.env.QWEN_CHAT_MODEL || 'qwen-turbo';
const SUMMARY_MODEL = process.env.QWEN_SUMMARY_MODEL || 'qwen-turbo';
const REQUEST_TIMEOUT_MS = Number(process.env.QWEN_TIMEOUT_MS || 20000);

function getHeaders() {
    if (!QWEN_API_KEY) {
        throw new Error('缺少环境变量 QWEN_API_KEY');
    }

    return {
        Authorization: `Bearer ${QWEN_API_KEY}`,
        'Content-Type': 'application/json'
    };
}

async function requestQwen(payload) {
    const response = await axios.post(API_URL, payload, {
        headers: getHeaders(),
        timeout: REQUEST_TIMEOUT_MS
    });

    const text = response && response.data && response.data.output ? response.data.output.text : '';
    return typeof text === 'string' ? text.trim() : '';
}

function extractJsonCandidate(text) {
    const raw = typeof text === 'string' ? text.trim() : '';
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

// 方法 1：正常聊天请求
async function chatWithQwen(messagesArray) {
    try {
        return await requestQwen({
            model: CHAT_MODEL,
            input: { messages: messagesArray }
        });
    } catch (error) {
        console.error('千问聊天接口报错:', error.response ? error.response.data : error.message);
        throw error;
    }
}

// 方法 2：记忆压缩请求（后台执行）
async function summarizeDialogue(dialogueText, previousSummary, options = {}) {
    const maxChars = Number(options.maxChars || process.env.MEMORY_MAX_CHARS || 1200);
    const profileMaxItems = Number(options.profileMaxItems || process.env.PROFILE_MAX_ITEMS || 14);
    const recentMaxItems = Number(options.recentMaxItems || process.env.RECENT_MAX_ITEMS || 10);

    // 专门为压缩记忆编写的 Prompt
    const prompt = `
你是“分级记忆整理器”，负责把用户长期画像和最近事件分开存储。
你必须只输出 JSON，不要输出任何额外文字。

输出要求：
1. 固定输出格式：
{
    "profile": ["..."],
    "recent": ["..."]
}
2. profile 仅放长期稳定信息（身份背景、偏好、禁忌、长期目标），最多 ${profileMaxItems} 条。
3. 若已知用户名字/称呼，必须保留在 profile，建议格式："用户名字：xxx"，并放在前面。
4. 若新对话里用户明确自报名字（如“我叫xxx”“叫我xxx”），要覆盖旧名字，使用最新称呼。
5. recent 仅放近期有效事件（最近发生的事、当前项目进展、短期计划），最多 ${recentMaxItems} 条。
6. 每条尽量短，建议不超过 40 字，去重，不写废话。
7. 总长度尽量控制在 ${maxChars} 字以内。
8. 如果没有新增有效信息，请尽量保留旧记忆中的有效条目。

【旧记忆(JSON或文本)】：${previousSummary || '无'}

【新对话记录】：
${dialogueText}

再次强调：只输出 JSON。
`;

    try {
        const summary = await requestQwen({
            model: SUMMARY_MODEL,
            input: {
                messages: [
                    { role: 'user', content: prompt }
                ]
            }
        });

        const cleanedSummary = extractJsonCandidate(summary) || summary;

        if (!cleanedSummary) {
            return {
                summary: previousSummary || '',
                ok: false
            };
        }

        return {
            summary: cleanedSummary,
            ok: true
        };
    } catch (error) {
        console.error('记忆压缩接口报错:', error.response ? error.response.data : error.message);
        return {
            summary: previousSummary || '',
            ok: false
        };
    }
}

module.exports = {
    chatWithQwen,
    summarizeDialogue
};