/**
 * utils/helpers.js
 * Shared utility helpers for async controller wrapping and person resolution.
 */
const mongoose = require('mongoose');
const Patient = require('../models/Patient');
const Staff = require('../models/Staff');

const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

const getPersonById = async (id) => {
  if (!id) {
    return null;
  }

  const idValue = String(id).trim();
  let patient = null;
  let staff = null;

  if (mongoose.Types.ObjectId.isValid(idValue)) {
    [patient, staff] = await Promise.all([
      Patient.findById(idValue),
      Staff.findById(idValue),
    ]);
  }

  if (!patient && !staff) {
    [patient, staff] = await Promise.all([
      Patient.findOne({ patientId: idValue }),
      Staff.findOne({ staffId: idValue }),
    ]);
  }

  if (patient) {
    return { type: 'Patient', data: patient };
  }

  if (staff) {
    return { type: 'Staff', data: staff };
  }

  return null;
};

const isPatientInfectedDoc = (patientDoc) => {
  if (!patientDoc) return false;

  const infectionStatus = String(patientDoc.infectionStatus || '').toLowerCase();
  if (infectionStatus === 'yes') {
    return true;
  }

  const pathogen = String(patientDoc.pathogen || '').trim().toLowerCase();
  if (!pathogen) {
    return false;
  }

  return !['none', 'na', 'n/a', 'negative', 'nil'].includes(pathogen);
};

const isPersonInfected = (personRecord) => {
  if (!personRecord) return false;
  return personRecord.type === 'Patient' && isPatientInfectedDoc(personRecord.data);
};

const getPersonWard = (personRecord) => {
  if (!personRecord) return null;
  return personRecord.type === 'Patient'
    ? personRecord.data.ward || null
    : personRecord.data.assignedWard || personRecord.data.ward || null;
};

module.exports = {
  asyncHandler,
  getPersonById,
  isPersonInfected,
  isPatientInfectedDoc,
  getPersonWard,
};
