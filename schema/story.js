const mongoose = require("mongoose");

const storySchema = new mongoose.Schema(
  {
    owner: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    title: { type: String, default: "", trim: true },
    subtitle: { type: String, default: "", trim: true },
    tag: { type: String, default: "", trim: true },
    ending: { type: String, default: "" },
    characters: { type: [mongoose.Schema.Types.Mixed], default: [] },
    accent: { type: String, default: "#C07858" },
    bg: { type: String, default: "#F7F3EE" },
    chapters: { type: [mongoose.Schema.Types.Mixed], default: [] },
  },
  {
    timestamps: true,
    collection: "story_list",
    versionKey: false,
    minimize: false,
  },
);

storySchema.index({ owner: 1, createdAt: -1 });

module.exports = storySchema;
