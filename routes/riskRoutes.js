/**
 * routes/riskRoutes.js
 * REST routes for risk calculations, contacts, high-risk listing, and audit logs.
 */
const express = require('express');
const {
  recalculatePersonRisk,
  recalculateAllRisks,
  getHighRiskPeople,
  getPatientContacts,
  getRiskLogs,
  getAlerts,
  syncHighRiskPatientAlerts,
  triggerManualCallAlert,
  getHighestPatientContacts,
  getWardStats,
} = require('../controllers/riskController');

const router = express.Router();

router.get('/high', getHighRiskPeople);
router.get('/high-risk', getHighRiskPeople);
router.get('/highest-patient-contacts', getHighestPatientContacts);
router.get('/ward-stats', getWardStats);
router.get('/contacts/:patientId', getPatientContacts);
router.get('/logs', getRiskLogs);
router.get('/alerts', getAlerts);
router.post('/sync-high-risk-patient-alerts', syncHighRiskPatientAlerts);
router.post('/call-alert', triggerManualCallAlert);
router.get('/person/:personId', recalculatePersonRisk);
router.post('/recalculate', recalculateAllRisks);

module.exports = router;
