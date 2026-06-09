const express = require("express");
const https = require("https");
const path = require("path");

require("dotenv").config({
  path: path.resolve(__dirname, ".env"),
});

const PORT = 3000;
const API_KEY = process.env.API_KEY;

if (!API_KEY) {
  console.error("❌ 未设置 API_KEY 环境变量");
  process.exit(1);
}

const app = express();

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }
  next();
});

app.use(express.raw({ type: "application/json", limit: "10mb" }));

// 智谱 AI 图片生成接口代理
app.post("/v1/zhipu/image-generate", (req, res) => {
  let body;
  try {
    body = JSON.parse(req.body);
  } catch {
    return res.status(400).json({ error: { message: "请求体 JSON 解析失败" } });
  }

  if (!body.model) {
    body.model = "glm-image";
  }

  const bodyStr = JSON.stringify(body);

  const options = {
    hostname: "open.bigmodel.cn",
    path: "/api/paas/v4/images/generations",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
      "Content-Length": Buffer.byteLength(bodyStr),
    },
  };

  console.log("→ 智谱 AI 图片生成请求，model:", body.model, "| prompt:", body.prompt?.slice(0, 60));

  const proxyReq = https.request(options, (proxyRes) => {
    res.status(proxyRes.statusCode);
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Access-Control-Allow-Origin", "*");
    proxyRes.pipe(res);
  });

  proxyReq.on("error", (e) => {
    console.error("智谱 AI 代理请求失败:", e.message);
    res.status(502).json({ error: { message: e.message } });
  });

  proxyReq.write(bodyStr);
  proxyReq.end();
});

app.use((_req, res) => {
  res.status(404).send("Not found");
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ 代理服务器已启动：http://localhost:${PORT}`);
  console.log(`   现在可以直接用浏览器打开 index.html 使用 AI 插图功能`);
  console.log(`   按 Ctrl+C 停止服务器`);
});
