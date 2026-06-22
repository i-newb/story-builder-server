const http = require("http");
const https = require("https");
const createError = require("http-errors");
const { StatusCodes } = require("http-status-codes");
const mongoose = require("mongoose");
const { MAX_IMAGE_BYTES } = require("./constants.js");

// 判断传入值是否为普通 JSON 对象。
function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// 校验故事 id 是否是合法的 MongoDB ObjectId。
function validateObjectId(id) {
  if (!mongoose.isValidObjectId(id)) {
    throw createError(StatusCodes.BAD_REQUEST, "Invalid story id");
  }
}

// 读取并校验请求体必须是 JSON 对象。
function getJsonBody(req) {
  if (!isPlainObject(req.body)) {
    throw createError(StatusCodes.BAD_REQUEST, "Request body must be a JSON object");
  }

  return req.body;
}

// 移除故事数据中不允许由客户端直接写入的数据库字段。
function removeImmutableStoryFields(story) {
  const { _id, id, owner, createdAt, updatedAt, __v, ...rest } = story;
  return rest;
}

// 将图片二进制内容转换成浏览器可直接展示的 base64 data URL。
function toBase64DataUrl(buffer, mime = "image/png") {
  return `data:${mime};base64,${Buffer.from(buffer).toString("base64")}`;
}

// 根据图片 URL 后缀推断 MIME 类型。
function extractMimeFromUrl(url) {
  if (/\.jpe?g($|\?)/i.test(url)) return "image/jpeg";
  if (/\.webp($|\?)/i.test(url)) return "image/webp";
  if (/\.gif($|\?)/i.test(url)) return "image/gif";
  return "image/png";
}

// 下载远程图片并转成 base64，支持有限次数重定向和大小限制。
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

module.exports = {
  isPlainObject,
  validateObjectId,
  getJsonBody,
  removeImmutableStoryFields,
  fetchImageAsBase64,
};
