const express = require("express");
const https = require("https");
const createError = require("http-errors");
const { StatusCodes } = require("http-status-codes");
const { User } = require("../config/db.js");
const { requireAuth, toUserDto } = require("./auth.js");
const {
  API_KEY,
  GENERATION_LIMIT,
  IMAGE_MODEL,
  STORY_MODEL,
  ZHIPU_HOST,
} = require("./constants.js");
const { fetchImageAsBase64, getJsonBody } = require("./utils.js");

const router = express.Router();

// 根据生成类型找到用户用量中对应的计数字段。
function usageFieldForKind(kind) {
  if (kind === "story") return "usage.storyGenerations";
  if (kind === "image") return "usage.imageGenerations";
  throw createError(StatusCodes.INTERNAL_SERVER_ERROR, "Invalid generation kind");
}

// 大模型成功响应后扣减一次对应类型的生成额度。
async function consumeGeneration(userId, kind) {
  const field = usageFieldForKind(kind);
  const user = await User.findOneAndUpdate(
    { _id: userId, [field]: { $lt: GENERATION_LIMIT } },
    { $inc: { [field]: 1 } },
    { new: true },
  );

  if (!user) {
    throw createError(StatusCodes.TOO_MANY_REQUESTS, `You can only generate ${GENERATION_LIMIT} ${kind === "story" ? "stories" : "illustrations"}`);
  }

  return toUserDto(user).usage;
}

// 调用大模型前检查当前用户是否还有对应类型的生成额度。
async function ensureGenerationAvailable(userId, kind) {
  const field = usageFieldForKind(kind);
  const user = await User.exists({ _id: userId, [field]: { $lt: GENERATION_LIMIT } });

  if (!user) {
    throw createError(StatusCodes.TOO_MANY_REQUESTS, `You can only generate ${GENERATION_LIMIT} ${kind === "story" ? "stories" : "illustrations"}`);
  }
}

// 将大模型返回的远程图片地址转换成 base64，便于前端保存到故事数据中。
async function convertGeneratedImageUrlsToBase64(payload) {
  const cloned = JSON.parse(JSON.stringify(payload || {}));

  if (!Array.isArray(cloned.data)) return cloned;

  for (const item of cloned.data) {
    if (item?.url && /^https?:\/\//i.test(item.url)) {
      item.url = await fetchImageAsBase64(item.url);
    }
  }

  return cloned;
}

// 格式化提示词字段，缺省值和对象类型在这里统一处理。
function formatPromptValue(value, fallback = "") {
  if (value === undefined || value === null || value === "") return fallback;
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

// 根据前端提交的创意参数组装故事生成提示词。
function buildPrompt(payload) {
  return `请生成一篇适合图文故事编辑器使用的中文故事，并严格返回 JSON，不要返回 Markdown。

  JSON 结构如下：
  {
    "title": "故事标题",
    "subtitle": "副标题",
    "tag": "标签",
    "ending": "结尾寄语",
    "characters": [{ "name": "角色名", "color": "#E0F0E4", "side": "left 或 right" }],
    "chapters": [{
      "title": "章节标题",
      "numeral": "一",
      "blocks": [
        { "type": "timestamp", "time": "时间", "place": "地点" },
        { "type": "narrator", "text": "旁白" },
        { "type": "dialogue", "speaker": "角色名", "text": "台词", "thought": "可选心理活动" },
        { "type": "monologue", "text": "内心独白" },
        { "type": "quote", "text": "金句" },
        { "type": "phone", "header": "-- 微信消息 --", "messages": [{ "speaker": "角色名", "text": "消息" }] },
        { "type": "illustration", "prompt": "插图画面描述" }
      ]
    }]
  }

  创意：${formatPromptValue(payload.idea)}
  类型：${formatPromptValue(payload.genre)}
  风格：${formatPromptValue(payload.tone)}
  章节数：${formatPromptValue(payload.chapterCount, 3)}
  主要角色：${formatPromptValue(payload.characters, "请根据创意自行设计角色")}

  要求：剧情完整，有冲突和转折；每章最少 8 个内容块；对话和旁白交替出现。characters 的颜色要浅一些，适合做气泡背景色。`;
}

// 向智谱接口发送 JSON 请求，并统一解析响应内容。
function postJsonToZhipu(path, payload, timeout = 360000) {
  const body = JSON.stringify(payload);

  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        hostname: ZHIPU_HOST,
        path,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${API_KEY}`,
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (response) => {
        const chunks = [];

        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let parsed = text;

          if (text) {
            try {
              parsed = JSON.parse(text);
            } catch {
              parsed = { raw: text };
            }
          }

          resolve({
            statusCode: response.statusCode || 502,
            body: parsed,
          });
        });
      }
    );

    request.setTimeout(timeout, () => {
      request.destroy(createError(StatusCodes.GATEWAY_TIMEOUT, "Zhipu request timed out"));
    });

    request.on("error", reject);
    request.write(body);
    request.end();
  });
}

// 检查上游接口状态码，失败时抛出带上游信息的错误。
function throwIfUpstreamFailed(result, fallbackMessage) {
  if (result.statusCode < StatusCodes.BAD_REQUEST) return;

  const statusCode = result.statusCode >= StatusCodes.BAD_REQUEST && result.statusCode < 600 ? result.statusCode : StatusCodes.BAD_GATEWAY;
  const rawMessage = result.body?.error?.message || result.body?.message || result.body?.raw || fallbackMessage;
  const message = typeof rawMessage === "string" ? rawMessage : fallbackMessage;

  throw createError(statusCode, message, { details: result.body });
}

// 从不同模型响应结构中提取生成文本。
function extractGeneratedText(response) {
  return (
    response?.choices?.[0]?.message?.content ||
    response?.choices?.[0]?.delta?.content ||
    response?.text ||
    response?.candidates?.[0]?.content?.parts?.map((part) => part.text).join("") ||
    ""
  );
}

// 解析模型返回的 JSON 文本，兼容包裹在 Markdown 代码块里的内容。
function parseModelJson(text) {
  const cleaned = text
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "");

  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");

    if (start >= 0 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1));
      } catch {
        // Fall through to the normalized upstream error below.
      }
    }
  }

  throw createError(StatusCodes.BAD_GATEWAY, "Story model returned invalid JSON");
}

// 调用故事大模型并返回解析后的故事 JSON。
async function generateStoryWithZhipu(payload) {
  const result = await postJsonToZhipu("/api/paas/v4/chat/completions", {
    model: STORY_MODEL,
    messages: [{ role: "user", content: buildPrompt(payload) }],
    response_format: { type: "json_object" },
  });

  throwIfUpstreamFailed(result, "Story generation failed");

  const text = extractGeneratedText(result.body);
  if (!text) {
    throw createError(StatusCodes.BAD_GATEWAY, "Story model returned empty content", { details: result.body });
  }

  return parseModelJson(text);
}

// 插图生成接口：成功拿到图片结果后才计入用户插图生成次数。
router.post("/image-generate", requireAuth, async (req, res) => {
  const body = getJsonBody(req);
  await ensureGenerationAvailable(req.user._id, "image");

  const result = await postJsonToZhipu("/api/paas/v4/images/generations", {
    ...body,
    model: body.model || IMAGE_MODEL,
  });

  throwIfUpstreamFailed(result, "Image generation failed");

  const payload = await convertGeneratedImageUrlsToBase64(result.body);
  const usage = await consumeGeneration(req.user._id, "image");
  res.status(StatusCodes.OK).json({ ...payload, usage });
});

// 故事生成接口：成功拿到故事结果后才计入用户故事生成次数。
router.post("/story-generate", requireAuth, async (req, res) => {
  const body = getJsonBody(req);
  await ensureGenerationAvailable(req.user._id, "story");

  const story = await generateStoryWithZhipu(body);
  const usage = await consumeGeneration(req.user._id, "story");

  res.status(StatusCodes.OK).json({ story, usage });
});

module.exports = router;
