/**
 * models/Interaction.js
 * Tracks contact events between two people (patient/staff) with duration and ward context.
 */
const mongoose = require('mongoose');

const interactionSchema = new mongoose.Schema(
  {
    person1: {
      type: mongoose.Schema.Types.Mixed,
      required: true,
    },
    person2: {
      type: mongoose.Schema.Types.Mixed,
      required: true,
    },
    duration: {
      type: Number,
      required: true,
      min: 0,
    },
    timestamp: {
      type: Date,
      default: Date.now,
    },
    ward: {
      type: String,
      trim: true,
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model('Interaction', interactionSchema);
