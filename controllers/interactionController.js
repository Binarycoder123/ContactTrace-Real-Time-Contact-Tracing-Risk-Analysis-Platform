/**
 * controllers/interactionController.js
 * Handles interaction creation/retrieval and triggers risk recalculation for involved people.
 */
const Interaction = require('../models/Interaction');
const { calculateRiskForPerson } = require('../services/riskEngine');
const { asyncHandler, getPersonById, getPersonWard } = require('../utils/helpers');

const createInteraction = asyncHandler(async (req, res) => {
  const { person1, person2, duration, timestamp, ward } = req.body;

  if (!person1 || !person2) {
    res.status(400);
    throw new Error('person1 and person2 are required');
  }

  const [p1Record, p2Record] = await Promise.all([
    getPersonById(person1),
    getPersonById(person2),
  ]);

  if (!p1Record || !p2Record) {
    res.status(404);
    throw new Error('One or both people were not found');
  }

  const interaction = await Interaction.create({
    person1: p1Record.data._id,
    person2: p2Record.data._id,
    duration,
    timestamp,
    ward: ward || getPersonWard(p1Record) || getPersonWard(p2Record),
  });

  await Promise.all([
    calculateRiskForPerson(p1Record.data._id),
    calculateRiskForPerson(p2Record.data._id),
  ]);

  res.status(201).json(interaction);
});

const getInteractions = asyncHandler(async (req, res) => {
  const interactions = await Interaction.find().sort({ timestamp: -1 });
  res.json(interactions);
});

const getInteractionById = asyncHandler(async (req, res) => {
  const interaction = await Interaction.findById(req.params.id);

  if (!interaction) {
    res.status(404);
    throw new Error('Interaction not found');
  }

  res.json(interaction);
});

module.exports = {
  createInteraction,
  getInteractions,
  getInteractionById,
};
