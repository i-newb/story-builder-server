const mongoose = require("mongoose");

const userSchema = new mongoose.Schema(
  {
    username: { type: String, required: true, unique: true, trim: true, lowercase: true },
    passwordHash: { type: String, required: true },
    passwordSalt: { type: String, required: true },
    usage: {
      storyGenerations: { type: Number, default: 0, min: 0 },
      imageGenerations: { type: Number, default: 0, min: 0 },
    },
  },
  {
    timestamps: true,
    collection: "users",
    versionKey: false,
    minimize: false,
  },
);

module.exports = userSchema;
