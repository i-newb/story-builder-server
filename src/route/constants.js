const API_KEY = process.env.API_KEY;
const AUTH_SECRET = process.env.AUTH_SECRET || "story-builder-auth-secret";
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const GENERATION_LIMIT = 5;
const ZHIPU_HOST = "open.bigmodel.cn";
const STORY_MODEL = "glm-5.1";
const IMAGE_MODEL = "glm-image";
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

module.exports = {
  API_KEY,
  AUTH_SECRET,
  TOKEN_TTL_MS,
  GENERATION_LIMIT,
  ZHIPU_HOST,
  STORY_MODEL,
  IMAGE_MODEL,
  MAX_IMAGE_BYTES,
};
