/**
 * models/RiskLog.js
 * Audit trail of risk-score recalculations for transparency and debugging.
 */
const mongoose = require('mongoose');

const riskLogSchema = new mongoose.Schema(
  {
    personId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      index: true,
    },
    oldScore: {
      type: Number,
      required: true,
    },
    newScore: {
      type: Number,
      required: true,
    },
    reason: {
      type: String,
      trim: true,
    },
    date: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model('RiskLog', riskLogSchema);
