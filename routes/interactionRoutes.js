/**
 * routes/interactionRoutes.js
 * REST routes for contact interactions.
 */
const express = require('express');
const {
  createInteraction,
  getInteractions,
  getInteractionById,
} = require('../controllers/interactionController');

const router = express.Router();

router.route('/').post(createInteraction).get(getInteractions);
router.route('/:id').get(getInteractionById);

module.exports = router;
