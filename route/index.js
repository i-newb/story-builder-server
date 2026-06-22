const express = require("express");
const http = require("http");
const https = require("https");
const crypto = require("crypto");
const createError = require("http-errors");
const { StatusCodes } = require("http-status-codes");
const mongoose = require("mongoose");
const { Story, User } = require("../db/index.js");

const router = express.Router();

const API_KEY = process.env.API_KEY;
const AUTH_SECRET = "story-builder-auth-secret";
const ZHIPU_HOST = "open.bigmodel.cn";
const STORY_MODEL = "glm-5.1";
const IMAGE_MODEL = "glm-image";
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const GENERATION_LIMIT = 5;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validateObjectId(id) {
  if (!mongoose.isValidObjectId(id)) {
    throw createError(StatusCodes.BAD_REQUEST, "Invalid story id");
  }
}

function getJsonBody(req) {
  if (!isPlainObject(req.body)) {
    throw createError(StatusCodes.BAD_REQUEST, "Request body must be a JSON object");
  }

  return req.body;
}

function toStoryDto(doc) {
  const obj = typeof doc.toObject === "function" ? doc.toObject() : doc;
  const { _id, __v, owner, ...rest } = obj;
  return {
    ...rest,
    id: _id.toString(),
  };
}

function removeImmutableStoryFields(story) {
  const { _id, id, owner, createdAt, updatedAt, __v, ...rest } = story;
  return rest;
}

function normalizeUsername(username) {
  return String(username || "").trim().toLowerCase();
}

function validateCredentials(username, password) {
  if (!/^[\u4e00-\u9fa5a-z0-9]{1,8}$/i.test(username)) {
    throw createError(StatusCodes.BAD_REQUEST, "Username must be 1-8 Chinese characters, letters, or numbers");
  }

  if (String(password || "").length < 6) {
    throw createError(StatusCodes.BAD_REQUEST, "Password must be at least 6 characters");
  }
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("base64url")) {
  const passwordHash = crypto.pbkdf2Sync(String(password), salt, 120000, 64, "sha512").toString("base64url");
  return { passwordHash, passwordSalt: salt };
}

function timingSafeEqualString(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function verifyPassword(password, user) {
  const { passwordHash } = hashPassword(password, user.passwordSalt);
  return timingSafeEqualString(passwordHash, user.passwordHash);
}

function signToken(user) {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const expiresAt = Date.now() + TOKEN_TTL_MS;
  const payload = Buffer.from(JSON.stringify({
    sub: user._id.toString(),
    username: user.username,
    exp: Math.floor(expiresAt / 1000),
  })).toString("base64url");
  const signature = crypto.createHmac("sha256", AUTH_SECRET).update(`${header}.${payload}`).digest("base64url");

  return {
    token: `${header}.${payload}.${signature}`,
    expiresAt,
  };
}

function verifyToken(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) {
    throw createError(StatusCodes.UNAUTHORIZED, "Invalid token");
  }

  const [header, payload, signature] = parts;
  const expectedSignature = crypto.createHmac("sha256", AUTH_SECRET).update(`${header}.${payload}`).digest("base64url");
  if (!timingSafeEqualString(signature, expectedSignature)) {
    throw createError(StatusCodes.UNAUTHORIZED, "Invalid token");
  }

  let decoded;
  try {
    decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    throw createError(StatusCodes.UNAUTHORIZED, "Invalid token");
  }

  if (!decoded.sub || !decoded.exp || decoded.exp * 1000 <= Date.now()) {
    throw createError(StatusCodes.UNAUTHORIZED, "Login expired");
  }

  return decoded;
}

function getBearerToken(req) {
  const authorization = req.headers.authorization || "";
  const [scheme, token] = authorization.split(" ");
  if (scheme !== "Bearer" || !token) {
    throw createError(StatusCodes.UNAUTHORIZED, "Please login first");
  }

  return token;
}

function toUserDto(user) {
  return {
    id: user._id.toString(),
    username: user.username,
    usage: {
      storyGenerations: user.usage?.storyGenerations || 0,
      imageGenerations: user.usage?.imageGenerations || 0,
      limit: GENERATION_LIMIT,
    },
  };
}

async function requireAuth(req, _res, next) {
  try {
    const payload = verifyToken(getBearerToken(req));
    const user = await User.findById(payload.sub);

    if (!user) {
      throw createError(StatusCodes.UNAUTHORIZED, "User not found");
    }

    req.user = user;
    next();
  } catch (error) {
    next(error);
  }
}

function usageFieldForKind(kind) {
  if (kind === "story") return "usage.storyGenerations";
  if (kind === "image") return "usage.imageGenerations";
  throw createError(StatusCodes.INTERNAL_SERVER_ERROR, "Invalid generation kind");
}

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

async function ensureGenerationAvailable(userId, kind) {
  const field = usageFieldForKind(kind);
  const user = await User.exists({ _id: userId, [field]: { $lt: GENERATION_LIMIT } });

  if (!user) {
    throw createError(StatusCodes.TOO_MANY_REQUESTS, `You can only generate ${GENERATION_LIMIT} ${kind === "story" ? "stories" : "illustrations"}`);
  }
}

function toBase64DataUrl(buffer, mime = "image/png") {
  return `data:${mime};base64,${Buffer.from(buffer).toString("base64")}`;
}

function extractMimeFromUrl(url) {
  if (/\.jpe?g($|\?)/i.test(url)) return "image/jpeg";
  if (/\.webp($|\?)/i.test(url)) return "image/webp";
  if (/\.gif($|\?)/i.test(url)) return "image/gif";
  return "image/png";
}

function fetchImageAsBase64(url, redirectCount = 0) {
  if (redirectCount > 3) {
    return Promise.reject(createError(StatusCodes.BAD_REQUEST, "Image URL redirected too many times"));
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    return Promise.reject(createError(StatusCodes.BAD_REQUEST, "Invalid image URL"));
  }

  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    return Promise.reject(createError(StatusCodes.BAD_REQUEST, "Image URL must use http or https"));
  }

  return new Promise((resolve, reject) => {
    const client = parsedUrl.protocol === "https:" ? https : http;
    const request = client.get(parsedUrl, (response) => {
      const statusCode = response.statusCode || StatusCodes.BAD_GATEWAY;

      if ([301, 302, 303, 307, 308].includes(statusCode) && response.headers.location) {
        response.resume();
        const nextUrl = new URL(response.headers.location, parsedUrl).toString();
        resolve(fetchImageAsBase64(nextUrl, redirectCount + 1));
        return;
      }

      if (statusCode >= StatusCodes.BAD_REQUEST) {
        response.resume();
        reject(createError(StatusCodes.BAD_GATEWAY, `Image download failed with status ${statusCode}`));
        return;
      }

      const chunks = [];
      let totalBytes = 0;

      response.on("error", reject);

      response.on("data", (chunk) => {
        totalBytes += chunk.length;
        if (totalBytes > MAX_IMAGE_BYTES) {
          response.destroy(createError(StatusCodes.PAYLOAD_TOO_LARGE, "Image is too large"));
          return;
        }
        chunks.push(chunk);
      });

      response.on("end", () => {
        const contentType = response.headers["content-type"];
        const headerMime = Array.isArray(contentType) ? contentType[0] : contentType;
        const mime = (headerMime || extractMimeFromUrl(parsedUrl.pathname)).split(";")[0];
        resolve(toBase64DataUrl(Buffer.concat(chunks), mime));
      });
    });

    request.setTimeout(15000, () => {
      request.destroy(createError(StatusCodes.GATEWAY_TIMEOUT, "Image download timed out"));
    });

    request.on("error", reject);
  });
}

async function convertIllustrationsToBase64(story) {
  const cloned = JSON.parse(JSON.stringify(story || {}));

  for (const chapter of cloned.chapters || []) {
    for (const block of chapter.blocks || []) {
      if (block.type === "illustration") {
        const source = block.svg || block.imageUrl;
        if (source && /^https?:\/\//i.test(source)) {
          block.svg = await fetchImageAsBase64(source);
        }
      }
      delete block.imageUrl;
    }
  }

  return removeImmutableStoryFields(cloned);
}

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

function formatPromptValue(value, fallback = "") {
  if (value === undefined || value === null || value === "") return fallback;
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

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

function throwIfUpstreamFailed(result, fallbackMessage) {
  if (result.statusCode < StatusCodes.BAD_REQUEST) return;

  const statusCode = result.statusCode >= StatusCodes.BAD_REQUEST && result.statusCode < 600 ? result.statusCode : StatusCodes.BAD_GATEWAY;
  const rawMessage = result.body?.error?.message || result.body?.message || result.body?.raw || fallbackMessage;
  const message = typeof rawMessage === "string" ? rawMessage : fallbackMessage;

  throw createError(statusCode, message, { details: result.body });
}

function extractGeneratedText(response) {
  return (
    response?.choices?.[0]?.message?.content ||
    response?.choices?.[0]?.delta?.content ||
    response?.text ||
    response?.candidates?.[0]?.content?.parts?.map((part) => part.text).join("") ||
    ""
  );
}

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

function getStoryPayload(req) {
  const body = getJsonBody(req);
  const story = body.story || body;

  if (!isPlainObject(story)) {
    throw createError(StatusCodes.BAD_REQUEST, "Story must be a JSON object");
  }

  return story;
}

router.post("/auth/register", async (req, res) => {
  const body = getJsonBody(req);
  const username = normalizeUsername(body.username);
  const password = String(body.password || "");

  validateCredentials(username, password);

  const exists = await User.exists({ username });
  if (exists) {
    throw createError(StatusCodes.CONFLICT, "Username already exists");
  }

  const passwordFields = hashPassword(password);
  const user = await User.create({ username, ...passwordFields });
  const session = signToken(user);

  res.status(StatusCodes.CREATED).json({
    token: session.token,
    expiresAt: session.expiresAt,
    user: toUserDto(user),
  });
});

router.post("/auth/login", async (req, res) => {
  const body = getJsonBody(req);
  const username = normalizeUsername(body.username);
  const password = String(body.password || "");

  validateCredentials(username, password);

  const user = await User.findOne({ username });
  if (!user || !verifyPassword(password, user)) {
    throw createError(StatusCodes.UNAUTHORIZED, "Invalid username or password");
  }

  const session = signToken(user);

  res.status(StatusCodes.OK).json({
    token: session.token,
    expiresAt: session.expiresAt,
    user: toUserDto(user),
  });
});

router.get("/auth/user", requireAuth, async (req, res) => {
  res.status(StatusCodes.OK).json({ user: toUserDto(req.user) });
});

router.post("/ai/image-generate", requireAuth, async (req, res) => {
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

router.post("/ai/story-generate", requireAuth, async (req, res) => {
  const body = getJsonBody(req);
  await ensureGenerationAvailable(req.user._id, "story");

  const story = await generateStoryWithZhipu(body);
  const usage = await consumeGeneration(req.user._id, "story");

  res.status(StatusCodes.OK).json({ story, usage });
});

router.use(requireAuth);

router.get("/story-list", async (req, res) => {
  const stories = await Story.find({ owner: req.user._id }).sort({ createdAt: -1 }).lean();

  res.status(StatusCodes.OK).json({ stories: stories.map(toStoryDto) });
});

router.post("/story-detail", async (req, res) => {
  validateObjectId(req.body.id);

  const story = await Story.findOne({ _id: req.body.id, owner: req.user._id }).lean();
  if (!story) {
    throw createError(StatusCodes.NOT_FOUND, "Story not found");
  }

  res.status(StatusCodes.OK).json({ story: toStoryDto(story) });
});

router.post("/story-add", async (req, res) => {
  const story = await convertIllustrationsToBase64(getStoryPayload(req));
  const doc = await Story.create({ ...story, owner: req.user._id });

  res.status(StatusCodes.CREATED).json({ story: toStoryDto(doc) });
});

router.put("/story-update", async (req, res) => {
  validateObjectId(req.body.id);

  const story = await convertIllustrationsToBase64(getStoryPayload(req));
  const doc = await Story.findOneAndUpdate({ _id: req.body.id, owner: req.user._id }, story, {
    new: true,
    runValidators: true,
  });

  if (!doc) {
    throw createError(StatusCodes.NOT_FOUND, "Story not found");
  }

  res.status(StatusCodes.OK).json({ story: toStoryDto(doc) });
});

router.delete("/story-delete", async (req, res) => {
  validateObjectId(req.body.id);

  const doc = await Story.findOneAndDelete({ _id: req.body.id, owner: req.user._id });
  if (!doc) {
    throw createError(StatusCodes.NOT_FOUND, "Story not found");
  }

  res.status(StatusCodes.OK).json({ deleted: true });
});

module.exports = router;
