/**
 * controllers/staffController.js
 * Handles staff creation and retrieval endpoints.
 */
const mongoose = require('mongoose');
const Staff = require('../models/Staff');
const { asyncHandler } = require('../utils/helpers');

const createStaff = asyncHandler(async (req, res) => {
  const { staffId, name, role, phoneNumber, assignedWard, ward } = req.body;

  const staff = await Staff.create({
    staffId,
    name,
    role,
    phoneNumber,
    assignedWard: assignedWard || ward,
    ward: ward || assignedWard,
  });

  res.status(201).json(staff);
});

const getStaff = asyncHandler(async (req, res) => {
  const staff = await Staff.find().sort({ createdAt: -1 });
  res.json(staff);
});

const getStaffById = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const staff = mongoose.Types.ObjectId.isValid(id)
    ? await Staff.findById(id)
    : await Staff.findOne({ staffId: id });

  if (!staff) {
    res.status(404);
    throw new Error('Staff member not found');
  }

  res.json(staff);
});

module.exports = {
  createStaff,
  getStaff,
  getStaffById,
};
