/**
 * models/Patient.js
 * Stores patient records in a format compatible with existing hospital data
 * while retaining risk-tracking fields used by PathoTrace.
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

const patientSchema = new mongoose.Schema(
  {
    patientId: {
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
    age: {
      type: Number,
      min: 0,
    },
    gender: {
      type: String,
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
    pathogen: {
      type: String,
      trim: true,
    },
    ward: {
      type: String,
      required: true,
      trim: true,
    },
    bed: {
      type: String,
      trim: true,
    },
    bedNumber: {
      type: String,
      trim: true,
    },
    admissionDate: {
      type: Date,
    },
    status: {
      type: String,
      trim: true,
    },
    infectionStatus: {
      type: String,
      enum: ['yes', 'no'],
      default: 'no',
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

patientSchema.pre('validate', function syncPatientFields(next) {
  if (!this.bed && this.bedNumber) {
    this.bed = this.bedNumber;
  }
  if (!this.bedNumber && this.bed) {
    this.bedNumber = this.bed;
  }

  if (typeof this.infectionStatus === 'string') {
    this.infectionStatus = this.infectionStatus.toLowerCase();
  }

  const hasPathogen = typeof this.pathogen === 'string' && this.pathogen.trim() !== '';
  if (hasPathogen && this.infectionStatus !== 'yes') {
    this.infectionStatus = 'yes';
  }

  next();
});

module.exports = mongoose.model('Patient', patientSchema);
