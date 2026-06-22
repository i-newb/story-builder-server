const express = require("express");
const createError = require("http-errors");
const { StatusCodes } = require("http-status-codes");
const { Story } = require("../config/db.js");
const { requireAuth } = require("./auth.js");
const {
  fetchImageAsBase64,
  getJsonBody,
  isPlainObject,
  removeImmutableStoryFields,
  validateObjectId,
} = require("./utils.js");

const router = express.Router();

// 将故事模型转换成前端使用的故事对象，并隐藏数据库内部字段。
function toStoryDto(doc) {
  const obj = typeof doc.toObject === "function" ? doc.toObject() : doc;
  const { _id, __v, owner, ...rest } = obj;
  return {
    ...rest,
    id: _id.toString(),
  };
}

// 保存故事前把插图远程地址转换为 base64，并移除不可直接写入的字段。
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

// 兼容 story 包裹提交和直接提交两种格式，并确保内容是 JSON 对象。
function getStoryPayload(req) {
  const body = getJsonBody(req);
  const story = body.story || body;

  if (!isPlainObject(story)) {
    throw createError(StatusCodes.BAD_REQUEST, "Story must be a JSON object");
  }

  return story;
}

// 故事相关接口都需要登录后才能访问。
router.use(requireAuth);

// 查询当前用户的故事列表。
router.get("/story-list", async (req, res) => {
  const stories = await Story.find({ owner: req.user._id }).sort({ createdAt: -1 }).lean();

  res.status(StatusCodes.OK).json({ stories: stories.map(toStoryDto) });
});

// 查询当前用户名下的单个故事详情。
router.post("/story-detail", async (req, res) => {
  validateObjectId(req.body.id);

  const story = await Story.findOne({ _id: req.body.id, owner: req.user._id }).lean();
  if (!story) {
    throw createError(StatusCodes.NOT_FOUND, "Story not found");
  }

  res.status(StatusCodes.OK).json({ story: toStoryDto(story) });
});

// 新增当前用户名下的故事。
router.post("/story-add", async (req, res) => {
  const story = await convertIllustrationsToBase64(getStoryPayload(req));
  const doc = await Story.create({ ...story, owner: req.user._id });

  res.status(StatusCodes.CREATED).json({ story: toStoryDto(doc) });
});

// 更新当前用户名下的故事。
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

// 删除当前用户名下的故事。
router.delete("/story-delete", async (req, res) => {
  validateObjectId(req.body.id);

  const doc = await Story.findOneAndDelete({ _id: req.body.id, owner: req.user._id });
  if (!doc) {
    throw createError(StatusCodes.NOT_FOUND, "Story not found");
  }

  res.status(StatusCodes.OK).json({ deleted: true });
});

module.exports = router;
