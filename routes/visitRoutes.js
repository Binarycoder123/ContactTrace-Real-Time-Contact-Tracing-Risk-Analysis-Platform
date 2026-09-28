/**
 * routes/visitRoutes.js
 * REST routes for staff visit entry/exit scans.
 */
const express = require('express');
const { createVisitEntry, createVisitExit } = require('../controllers/visitController');

const router = express.Router();

router.post('/entry', createVisitEntry);
router.post('/exit', createVisitExit);

module.exports = router;
