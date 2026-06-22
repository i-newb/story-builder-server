const express = require("express");

const { router: authRouter } = require("./auth.js");
const aiRouter = require("./ai.js");
const storyRouter = require("./story.js");

const router = express.Router();

// 挂载认证相关接口。
router.use("/auth", authRouter);
// 挂载大模型生成相关接口。
router.use("/ai", aiRouter);
// 挂载故事增删改查相关接口。
router.use(storyRouter);

module.exports = router;
