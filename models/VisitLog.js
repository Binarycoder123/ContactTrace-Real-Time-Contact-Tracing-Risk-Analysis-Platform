/**
 * models/VisitLog.js
 * Tracks staff ward entry/exit events captured via QR scans.
 */
const mongoose = require('mongoose');

const visitLogSchema = new mongoose.Schema(
  {
    staffId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Staff',
      required: true,
      index: true,
    },
    ward: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    entryTime: {
      type: Date,
      required: true,
      default: Date.now,
      index: true,
    },
    exitTime: {
      type: Date,
      default: null,
      index: true,
    },
    durationMinutes: {
      type: Number,
      min: 0,
      default: 0,
    },
  },
  {
    timestamps: true,
  }
);

visitLogSchema.pre('save', function calculateDurationOnExit(next) {
  if (!this.entryTime || !this.exitTime) {
    return next();
  }

  const durationMs = this.exitTime.getTime() - this.entryTime.getTime();
  this.durationMinutes = Math.max(0, Number((durationMs / 60000).toFixed(2)));
  next();
});

module.exports = mongoose.model('VisitLog', visitLogSchema);
