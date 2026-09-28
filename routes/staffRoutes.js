/**
 * routes/staffRoutes.js
 * REST routes for staff resources.
 */
const express = require('express');
const {
  createStaff,
  getStaff,
  getStaffById,
} = require('../controllers/staffController');

const router = express.Router();

router.route('/').post(createStaff).get(getStaff);
router.route('/:id').get(getStaffById);

module.exports = router;
