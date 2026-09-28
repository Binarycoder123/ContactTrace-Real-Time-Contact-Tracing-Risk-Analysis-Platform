/**
 * models/Staff.js
 * Stores staff profile and current computed risk score.
 * Supports both assignedWard (new API) and ward (legacy data shape).
 */
const mongoose = require('mongoose');

const normalizePhoneNumber = (value) => {
  if (value === undefined || value === null) {
    return value;
  }

  const trimmed = String(value).trim();
  if (!trimmed) {
    return undefined;
  }

  const compact = trimmed.replace(/[\s\-().]/g, '');
  if (compact.startsWith('00')) {
    const digits = compact.slice(2).replace(/\D/g, '');
    return digits ? `+${digits}` : undefined;
  }

  if (compact.startsWith('+')) {
    const digits = compact.slice(1).replace(/\D/g, '');
    return digits ? `+${digits}` : undefined;
  }

  const digits = compact.replace(/\D/g, '');
  return digits ? `+${digits}` : undefined;
};

const staffSchema = new mongoose.Schema(
  {
    staffId: {
      type: String,
      trim: true,
      unique: true,
      sparse: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    phoneNumber: {
      type: String,
      required: false,
      trim: true,
      set: normalizePhoneNumber,
      validate: {
        validator: (value) => !value || /^\+\d{8,15}$/.test(String(value)),
        message: 'phoneNumber must be in international format (e.g., +919876543210)',
      },
    },
    role: {
      type: String,
      trim: true,
    },
    assignedWard: {
      type: String,
      trim: true,
    },
    ward: {
      type: String,
      trim: true,
    },
    riskScore: {
      type: Number,
      default: 0,
    },
  },
  {
    timestamps: true,
  }
);

staffSchema.pre('validate', function syncWardFields(next) {
  if (!this.assignedWard && this.ward) {
    this.assignedWard = this.ward;
  }
  if (!this.ward && this.assignedWard) {
    this.ward = this.assignedWard;
  }
  next();
});

module.exports = mongoose.model('Staff', staffSchema);
