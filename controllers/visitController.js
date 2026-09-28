/**
 * controllers/visitController.js
 * Handles ward entry/exit scans for staff and triggers post-exit risk updates.
 */
const mongoose = require('mongoose');
const Staff = require('../models/Staff');
const VisitLog = require('../models/VisitLog');
const { calculateRiskForPerson } = require('../services/riskEngine');
const { asyncHandler } = require('../utils/helpers');

const createVisitEntry = asyncHandler(async (req, res) => {
  const { staffId, ward } = req.body;

  if (!staffId || !ward) {
    res.status(400);
    throw new Error('staffId and ward are required');
  }

  if (!mongoose.Types.ObjectId.isValid(staffId)) {
    res.status(400);
    throw new Error('staffId must be a valid ObjectId');
  }

  const staff = await Staff.findById(staffId);
  if (!staff) {
    res.status(404);
    throw new Error('Staff member not found');
  }

  const visitLog = await VisitLog.create({
    staffId: staff._id,
    ward,
    entryTime: new Date(),
  });

  res.status(201).json(visitLog);
});

const createVisitExit = asyncHandler(async (req, res) => {
  const { visitLogId } = req.body;

  if (!visitLogId) {
    res.status(400);
    throw new Error('visitLogId is required');
  }

  if (!mongoose.Types.ObjectId.isValid(visitLogId)) {
    res.status(400);
    throw new Error('visitLogId must be a valid ObjectId');
  }

  const visitLog = await VisitLog.findById(visitLogId);
  if (!visitLog) {
    res.status(404);
    throw new Error('Visit log not found');
  }

  if (visitLog.exitTime) {
    res.status(400);
    throw new Error('Visit log already has an exit scan');
  }

  visitLog.exitTime = new Date();
  await visitLog.save();

  await calculateRiskForPerson(visitLog.staffId);

  res.json(visitLog);
});

module.exports = {
  createVisitEntry,
  createVisitExit,
};
