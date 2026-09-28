/**
 * routes/patientRoutes.js
 * REST routes for patient resources.
 */
const express = require('express');
const {
  createPatient,
  getPatients,
  getPatientById,
} = require('../controllers/patientController');

const router = express.Router();

router.route('/').post(createPatient).get(getPatients);
router.route('/:id').get(getPatientById);

module.exports = router;
