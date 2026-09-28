/**
 * models/Alert.js
 * Stores escalation events triggered by risk thresholds.
 */
const mongoose = require('mongoose');

const alertSchema = new mongoose.Schema({
  type: {
    type: String,
    required: true,
    trim: true,
  },
  message: {
    type: String,
    required: true,
    trim: true,
  },
  severity: {
    type: String,
    enum: ['Low', 'Medium', 'High'],
    required: true,
    default: 'High',
  },
  triggeredBy: {
    type: mongoose.Schema.Types.ObjectId,
    default: null,
  },
  ward: {
    type: String,
    trim: true,
    default: null,
  },
  acknowledged: {
    type: Boolean,
    default: false,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

module.exports = mongoose.model('Alert', alertSchema);
