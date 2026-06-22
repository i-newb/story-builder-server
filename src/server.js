const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const path = require("path");

require("dotenv").config({
  path: path.resolve(__dirname, "..", ".env"),
});

const { connectDB } = require("./config/db.js");
const { notFoundHandler, errorHandler } = require("./middleware/response.js");

const PORT = 3000;
const API_KEY = process.env.API_KEY;

if (!API_KEY) {
  console.error("Missing API_KEY or ZHIPU_API_KEY environment variable");
  process.exit(1);
}

const app = express();

app.disable("x-powered-by");

app.use(cors());

app.use(bodyParser.json({ limit: "20mb", strict: true }));
app.use(bodyParser.urlencoded({ extended: true, limit: "20mb" }));

app.use("/v1", require("./route/index.js"));
app.use(notFoundHandler);
app.use(errorHandler);

connectDB()
  .then(() => {
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`Server listening on http://localhost:${PORT}`);
    });
  })
  .catch((error) => {
    console.error("MongoDB connection failed:", error.message);
    process.exit(1);
  });
