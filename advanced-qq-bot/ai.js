const axios = require("axios");

const BAILIAN_BASE_URL =
  process.env.BAILIAN_BASE_URL || "https://dashscope.aliyuncs.com";
const BAILIAN_TIMEOUT_MS = Number(process.env.BAILIAN_TIMEOUT_MS || 20000);

const BAILIAN_API_KEY = process.env.BAILIAN_API_KEY || "";
const BAILIAN_APP_ID = process.env.BAILIAN_APP_ID || "";
const BAILIAN_MEMORY_LIBRARY_ID = process.env.BAILIAN_MEMORY_LIBRARY_ID || "";
const BAILIAN_PROFILE_TEMPLATE_ID =
  process.env.BAILIAN_PROFILE_TEMPLATE_ID || "";

const AGENT_COMPLETION_PATH =
  process.env.BAILIAN_AGENT_COMPLETION_PATH ||
  "/api/v1/apps/{app_id}/completion";
const MEMORY_SEARCH_PATH =
  process.env.BAILIAN_MEMORY_SEARCH_PATH ||
  "/api/v2/apps/memory/memory_nodes/search";
const MEMORY_ADD_PATH =
  process.env.BAILIAN_MEMORY_ADD_PATH || "/api/v2/apps/memory/add";
const PROFILE_QUERY_PATH =
  process.env.BAILIAN_PROFILE_QUERY_PATH ||
  "/api/v2/apps/memory/profile_schemas/{profile_schema_id}/user_profile";

const MEMORY_TOP_K = Number(process.env.BAILIAN_MEMORY_TOP_K || 8);
const MEMORY_MIN_SCORE = Number(process.env.BAILIAN_MEMORY_MIN_SCORE || 0.3);

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function ensureApiKey() {
  if (!BAILIAN_API_KEY) {
    throw new Error("缺少环境变量 BAILIAN_API_KEY");
  }
}

function buildPath(template, replacements = {}) {
  const source = normalizeText(template);
  if (!source) return "";

  return source.replace(/\{([a-zA-Z0-9_]+)\}/g, (_, key) => {
    return encodeURIComponent(normalizeText(replacements[key]));
  });
}

function getCommonHeaders() {
  ensureApiKey();
  return {
    Authorization: `Bearer ${BAILIAN_API_KEY}`,
    "Content-Type": "application/json",
  };
}

function safeJsonStringify(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch (_) {
    return String(value);
  }
}

function logRawBailianResponse(method, url, payload) {
  console.log(
    `[Bailian RAW][${method}] ${url}\n${safeJsonStringify(payload || {})}`,
  );
  logToolCallProbe(payload);
}

function normalizeToolName(toolCall) {
  return normalizeText(
    (toolCall &&
      (toolCall.name ||
        (toolCall.function && toolCall.function.name) ||
        toolCall.tool_name ||
        toolCall.plugin_name ||
        toolCall.api_name)) ||
      "",
  );
}

function normalizeToolArguments(toolCall) {
  return (
    (toolCall && toolCall.arguments) ||
    (toolCall && toolCall.function && toolCall.function.arguments) ||
    (toolCall && toolCall.parameters) ||
    (toolCall && toolCall.input) ||
    null
  );
}

function normalizeToolOutput(toolCall) {
  return (
    (toolCall && toolCall.output) ||
    (toolCall && toolCall.result) ||
    (toolCall && toolCall.response) ||
    null
  );
}

function extractToolCalls(payload) {
  const rows = [];
  const seen = new Set();
  const targetKeys = new Set(["tool_calls", "plugin_calls", "actions"]);

  const pushToolCall = (item, sourcePath) => {
    if (!item || typeof item !== "object") return;

    const name = normalizeToolName(item);
    const args = normalizeToolArguments(item);
    const output = normalizeToolOutput(item);
    const id = normalizeText(item.id || item.tool_call_id || "");

    if (!name && args == null && output == null) {
      return;
    }

    const fingerprint = `${sourcePath}|${id}|${name}|${safeJsonStringify(args)}|${safeJsonStringify(output)}`;
    if (seen.has(fingerprint)) return;
    seen.add(fingerprint);

    rows.push({
      sourcePath,
      id,
      name: name || "(unknown)",
      arguments: args,
      output,
    });
  };

  const walk = (node, path = "root", depth = 0) => {
    if (!node || depth > 8) return;

    if (Array.isArray(node)) {
      node.forEach((item, index) => {
        walk(item, `${path}[${index}]`, depth + 1);
      });
      return;
    }

    if (typeof node !== "object") return;

    for (const [key, value] of Object.entries(node)) {
      const currentPath = `${path}.${key}`;

      if (targetKeys.has(key) && Array.isArray(value)) {
        value.forEach((item, index) => {
          pushToolCall(item, `${currentPath}[${index}]`);
        });
      }

      walk(value, currentPath, depth + 1);
    }
  };

  walk(payload);
  return rows;
}

function logToolCallProbe(payload) {
  const toolCalls = extractToolCalls(payload);

  if (toolCalls.length === 0) {
    console.log("[Bailian TOOL_CALLS] none");
    return;
  }

  for (const row of toolCalls) {
    const header =
      `[Bailian TOOL_CALL] source=${row.sourcePath}` +
      ` name=${row.name}` +
      (row.id ? ` id=${row.id}` : "");
    console.log(header);

    if (row.arguments != null) {
      console.log(`[Bailian TOOL_ARGS] ${safeJsonStringify(row.arguments)}`);
    }

    if (row.output != null) {
      console.log(`[Bailian TOOL_OUTPUT] ${safeJsonStringify(row.output)}`);
    }
  }
}

function ensureAgentAppEndpointConfigured() {
  const path = normalizeText(AGENT_COMPLETION_PATH).toLowerCase();
  const hasAppsPath = path.includes("/apps/");
  const isBaseModelPath = path.includes("/chat/completions");

  if (!hasAppsPath || isBaseModelPath) {
    throw new Error(
      "BAILIAN_AGENT_COMPLETION_PATH 配置错误：必须使用 Agent App 接口（包含 /apps/），且不能是 /v1/chat/completions",
    );
  }
}

function toReadableMemoryLine(node) {
  if (typeof node === "string") {
    return normalizeText(node);
  }

  const content = normalizeText(node && node.content);
  if (content) return content;

  const text = normalizeText(node && node.text);
  if (text) return text;

  const event = normalizeText(node && node.event);
  if (event) return event;

  return "";
}

function normalizeMemoryNodes(rawNodes) {
  const nodes = Array.isArray(rawNodes) ? rawNodes : [];
  return nodes
    .map((item) => {
      if (typeof item === "string") {
        return { content: normalizeText(item) };
      }

      const content = toReadableMemoryLine(item);
      if (!content) return null;

      return {
        content,
        score: Number(item && item.score),
        created_at: normalizeText(item && item.created_at),
        updated_at: normalizeText(item && item.updated_at),
      };
    })
    .filter(Boolean);
}

function normalizeProfile(rawProfile) {
  if (!rawProfile) return null;

  if (typeof rawProfile === "string") {
    const text = normalizeText(rawProfile);
    return text ? text : null;
  }

  if (Array.isArray(rawProfile)) {
    const list = rawProfile
      .map((item) => normalizeText(typeof item === "string" ? item : ""))
      .filter(Boolean);
    return list.length > 0 ? list : null;
  }

  if (typeof rawProfile === "object") {
    return rawProfile;
  }

  return null;
}

function profileToText(profile) {
  if (!profile) return "";

  if (typeof profile === "string") {
    return profile;
  }

  if (Array.isArray(profile)) {
    return profile
      .filter(Boolean)
      .map((item) => `- ${item}`)
      .join("\n");
  }

  return safeJsonStringify(profile);
}

function memoryNodesToText(memoryNodes, maxItems = 8) {
  const rows = Array.isArray(memoryNodes) ? memoryNodes : [];

  return rows
    .slice(0, maxItems)
    .map((node) => normalizeText(node && node.content))
    .filter(Boolean)
    .map((line) => `- ${line}`)
    .join("\n");
}

function extractTextFromMessageContent(content) {
  if (typeof content === "string") {
    return normalizeText(content);
  }

  if (content && typeof content === "object" && !Array.isArray(content)) {
    return extractTextFromMessageContent([content]);
  }

  const rows = Array.isArray(content) ? content : [];
  const fragments = [];

  for (const item of rows) {
    if (typeof item === "string") {
      const text = normalizeText(item);
      if (text) fragments.push(text);
      continue;
    }

    if (!item || typeof item !== "object") continue;

    const text = normalizeText(item.text || item.content);
    if (text) {
      fragments.push(text);
    }

    const imageUrl = normalizeText(
      (item.image_url && (item.image_url.url || item.image_url)) ||
        item.image ||
        item.imageUrl ||
        item.url,
    );

    if (imageUrl && /^https?:\/\//i.test(imageUrl)) {
      fragments.push(`![image](${imageUrl})`);
    }
  }

  return fragments.join("\n").trim();
}

function extractAgentReply(payload) {
  const data = payload || {};

  const outputText = normalizeText(data && data.output && data.output.text);
  if (outputText) return outputText;

  const choices =
    data && data.output && Array.isArray(data.output.choices)
      ? data.output.choices
      : [];

  const outputMessageText = extractTextFromMessageContent(
    data && data.output && data.output.message && data.output.message.content,
  );
  if (outputMessageText) return outputMessageText;

  const outputMessages =
    data && data.output && Array.isArray(data.output.messages)
      ? data.output.messages
      : [];

  for (const msg of outputMessages) {
    const text = extractTextFromMessageContent(msg && msg.content);
    if (text) return text;
  }

  for (const choice of choices) {
    const messageText =
      extractTextFromMessageContent(
        choice && choice.message && choice.message.content,
      ) ||
      normalizeText(choice && choice.message && (choice.message.text || ""));
    if (messageText) return messageText;
  }

  const fallbackText = normalizeText(data && data.text);
  if (fallbackText) return fallbackText;

  return "";
}

function resolveErrorMessage(error) {
  if (!error) return "unknown error";

  if (error.response && error.response.data) {
    return safeJsonStringify(error.response.data);
  }

  return error.message || "unknown error";
}

async function requestPost(pathTemplate, payload, replacements = {}) {
  const path = buildPath(pathTemplate, replacements);
  const url = `${BAILIAN_BASE_URL}${path}`;

  const response = await axios.post(url, payload, {
    headers: getCommonHeaders(),
    timeout: BAILIAN_TIMEOUT_MS,
  });
  logRawBailianResponse("POST", url, response && response.data);

  return response && response.data ? response.data : {};
}

async function requestGet(pathTemplate, params, replacements = {}) {
  const path = buildPath(pathTemplate, replacements);
  const url = `${BAILIAN_BASE_URL}${path}`;

  const response = await axios.get(url, {
    params,
    headers: getCommonHeaders(),
    timeout: BAILIAN_TIMEOUT_MS,
  });
  logRawBailianResponse(
    "GET",
    `${url}?${safeJsonStringify(params)}`,
    response && response.data,
  );

  return response && response.data ? response.data : {};
}

async function searchMemoryLibrary(options = {}) {
  const userId = normalizeText(options.userId);
  const query = normalizeText(options.query);

  if (!userId || !query) {
    return [];
  }

  const payload = {
    user_id: userId,
    messages: [{ role: "user", content: query }],
    top_k: MEMORY_TOP_K,
    min_score: MEMORY_MIN_SCORE,
    enable_rerank: false,
    enable_judge: false,
    enable_rewrite: false,
  };

  if (BAILIAN_MEMORY_LIBRARY_ID) {
    payload.memory_library_id = BAILIAN_MEMORY_LIBRARY_ID;
  }

  try {
    const result = await requestPost(MEMORY_SEARCH_PATH, payload);
    const sourceNodes =
      (result && result.memory_nodes) ||
      (result && result.output && result.output.memory_nodes) ||
      [];

    return normalizeMemoryNodes(sourceNodes);
  } catch (error) {
    console.error("[Bailian] 读记忆失败:", resolveErrorMessage(error));
    return [];
  }
}

async function getUserProfile(options = {}) {
  const userId = normalizeText(options.userId);

  if (!userId || !BAILIAN_PROFILE_TEMPLATE_ID) {
    return null;
  }

  const params = { user_id: userId };
  if (BAILIAN_MEMORY_LIBRARY_ID) {
    params.memory_library_id = BAILIAN_MEMORY_LIBRARY_ID;
  }

  try {
    const result = await requestGet(PROFILE_QUERY_PATH, params, {
      profile_schema_id: BAILIAN_PROFILE_TEMPLATE_ID,
    });

    const rawProfile =
      (result && result.user_profile) ||
      (result && result.profile) ||
      (result && result.data) ||
      null;

    return normalizeProfile(rawProfile);
  } catch (error) {
    console.error("[Bailian] 读画像失败:", resolveErrorMessage(error));
    return null;
  }
}

async function readUserMemoryContext(options = {}) {
  const userId = normalizeText(options.userId);
  const query = normalizeText(options.query);

  if (!userId || !query) {
    return { memoryNodes: [], profile: null };
  }

  const [memoryNodes, profile] = await Promise.all([
    searchMemoryLibrary({ userId, query }),
    getUserProfile({ userId }),
  ]);

  return {
    memoryNodes: Array.isArray(memoryNodes) ? memoryNodes : [],
    profile: profile || null,
  };
}

function buildPromptWithContext(options = {}) {
  const userMessage = normalizeText(options.userMessage);
  const memoryNodes = Array.isArray(options.memoryNodes)
    ? options.memoryNodes
    : [];
  const profile = options.profile || null;

  const sections = ["你是一个 QQ 聊天机器人，请自然、直接地回答用户问题。"];

  const memoryText = memoryNodesToText(memoryNodes, 8);
  if (memoryText) {
    sections.push(`历史记忆:\n${memoryText}`);
  }

  const profileText = profileToText(profile);
  if (profileText) {
    sections.push(`用户画像:\n${profileText}`);
  }

  sections.push(`用户当前消息:\n${userMessage}`);

  return sections.join("\n\n");
}

async function callAgentAppWithMemory(options = {}) {
  const userMessage = normalizeText(options.userMessage);
  if (!userMessage) return "";

  ensureAgentAppEndpointConfigured();

  if (!BAILIAN_APP_ID) {
    throw new Error("缺少环境变量 BAILIAN_APP_ID");
  }

  const prompt = buildPromptWithContext({
    userMessage,
    memoryNodes: options.memoryNodes,
    profile: options.profile,
  });

  const payload = {
    input: {
      prompt,
    },
    parameters: {},
  };

  const result = await requestPost(AGENT_COMPLETION_PATH, payload, {
    app_id: BAILIAN_APP_ID,
  });

  return extractAgentReply(result);
}

async function writeConversationMemory(options = {}) {
  const userId = normalizeText(options.userId);
  const userMessage = normalizeText(options.userMessage);
  const assistantMessage = normalizeText(options.assistantMessage);

  if (!userId || !userMessage || !assistantMessage) {
    return { ok: false, skipped: true };
  }

  const payload = {
    user_id: userId,
    messages: [
      { role: "user", content: userMessage },
      { role: "assistant", content: assistantMessage },
    ],
  };

  if (BAILIAN_MEMORY_LIBRARY_ID) {
    payload.memory_library_id = BAILIAN_MEMORY_LIBRARY_ID;
  }

  if (BAILIAN_PROFILE_TEMPLATE_ID) {
    payload.profile_schema = BAILIAN_PROFILE_TEMPLATE_ID;
  }

  return requestPost(MEMORY_ADD_PATH, payload);
}

module.exports = {
  readUserMemoryContext,
  callAgentAppWithMemory,
  writeConversationMemory,
};
