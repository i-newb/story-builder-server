const express = require("express");
const crypto = require("crypto");
const createError = require("http-errors");
const { StatusCodes } = require("http-status-codes");
const { User } = require("../config/db.js");
const { AUTH_SECRET, GENERATION_LIMIT, TOKEN_TTL_MS } = require("./constants.js");
const { getJsonBody } = require("./utils.js");

const router = express.Router();

// 统一清理用户名格式，避免前后空格或大小写导致重复账号。
function normalizeUsername(username) {
  return String(username || "").trim().toLowerCase();
}

// 校验登录和注册共用的用户名、密码规则。
function validateCredentials(username, password) {
  if (!/^[\u4e00-\u9fa5a-z0-9]{1,8}$/i.test(username)) {
    throw createError(StatusCodes.BAD_REQUEST, "Username must be 1-8 Chinese characters, letters, or numbers");
  }

  if (String(password || "").length < 6) {
    throw createError(StatusCodes.BAD_REQUEST, "Password must be at least 6 characters");
  }
}

// 使用 PBKDF2 对密码加盐哈希，数据库只保存盐和哈希值。
function hashPassword(password, salt = crypto.randomBytes(16).toString("base64url")) {
  const passwordHash = crypto.pbkdf2Sync(String(password), salt, 120000, 64, "sha512").toString("base64url");
  return { passwordHash, passwordSalt: salt };
}

// 使用固定时间比较字符串，降低密码哈希或签名比较时的时序攻击风险。
function timingSafeEqualString(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

// 校验用户输入的密码是否和数据库中的密码哈希匹配。
function verifyPassword(password, user) {
  const { passwordHash } = hashPassword(password, user.passwordSalt);
  return timingSafeEqualString(passwordHash, user.passwordHash);
}

// 签发 24 小时有效的登录 token。
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

// 校验登录 token 的签名和过期时间，并返回 token 中的用户信息。
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

// 从 Authorization 请求头中读取 Bearer token。
function getBearerToken(req) {
  const authorization = req.headers.authorization || "";
  const [scheme, token] = authorization.split(" ");
  if (scheme !== "Bearer" || !token) {
    throw createError(StatusCodes.UNAUTHORIZED, "Please login first");
  }

  return token;
}

// 将用户模型转换成前端需要的安全用户信息。
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

// 登录鉴权中间件，校验 token 后把当前用户挂到 req.user。
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

// 注册接口：创建账号后直接返回登录态。
router.post("/register", async (req, res) => {
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

// 登录接口：校验账号密码后返回新的登录态。
router.post("/login", async (req, res) => {
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

// 当前用户接口：用于前端刷新页面后恢复登录用户信息。
router.get("/user", requireAuth, async (req, res) => {
  res.status(StatusCodes.OK).json({ user: toUserDto(req.user) });
});

module.exports = {
  router,
  requireAuth,
  toUserDto,
};
