const mongoose = require("mongoose");
const storySchema = require("../models/story.js");
const userSchema = require("../models/user.js");

const MONGO_URI = "mongodb://localhost:27017/story-builder";

const Story = mongoose.models.Story || mongoose.model("Story", storySchema);
const User = mongoose.models.User || mongoose.model("User", userSchema);

async function connectDB() {
  await mongoose.connect(MONGO_URI);
  console.log(`MongoDB connected: ${MONGO_URI}`);
}

mongoose.connection.on("error", (err) => {
  console.error("MongoDB connection error:", err.message);
});

mongoose.connection.on("disconnected", () => {
  console.warn("MongoDB disconnected");
});

module.exports = {
  Story,
  User,
  connectDB,
};
