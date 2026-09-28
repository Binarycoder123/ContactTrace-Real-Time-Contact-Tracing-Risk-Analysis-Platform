/**
 * controllers/patientController.js
 * Handles patient creation and retrieval endpoints.
 */
const mongoose = require('mongoose');
const Patient = require('../models/Patient');
const { asyncHandler } = require('../utils/helpers');

const createPatient = asyncHandler(async (req, res) => {
  const {
    patientId,
    name,
    age,
    gender,
    phoneNumber,
    pathogen,
    ward,
    bed,
    bedNumber,
    admissionDate,
    status,
    infectionStatus,
  } = req.body;

  const patient = await Patient.create({
    patientId,
    name,
    age,
    gender,
    phoneNumber,
    pathogen,
    ward,
    bed: bed || bedNumber,
    bedNumber: bedNumber || bed,
    admissionDate,
    status,
    infectionStatus,
  });

  res.status(201).json(patient);
});

const getPatients = asyncHandler(async (req, res) => {
  const patients = await Patient.find().sort({ createdAt: -1 });
  res.json(patients);
});

const getPatientById = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const patient = mongoose.Types.ObjectId.isValid(id)
    ? await Patient.findById(id)
    : await Patient.findOne({ patientId: id });

  if (!patient) {
    res.status(404);
    throw new Error('Patient not found');
  }

  res.json(patient);
});

module.exports = {
  createPatient,
  getPatients,
  getPatientById,
};
