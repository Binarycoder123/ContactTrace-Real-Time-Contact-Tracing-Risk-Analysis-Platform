/**
 * controllers/riskController.js
 * Exposes risk-calculation, contact lookup, high-risk listing, and risk-log retrieval.
 */
const mongoose = require('mongoose');
const Patient = require('../models/Patient');
const Staff = require('../models/Staff');
const Interaction = require('../models/Interaction');
const VisitLog = require('../models/VisitLog');
const RiskLog = require('../models/RiskLog');
const Alert = require('../models/Alert');
const { asyncHandler, getPersonById } = require('../utils/helpers');
const { calculateRiskForPerson, calculateRiskForAll } = require('../services/riskEngine');
const { triggerAlert } = require('../services/alertService');

const getRiskLevel = (score) => {
  const normalizedScore = Number(score) || 0;
  if (normalizedScore < 20) return 'Low';
  if (normalizedScore <= 50) return 'Medium';
  return 'High';
};

const findPatientByIdentifier = async (patientId) => {
  if (!patientId) {
    return null;
  }

  const idValue = String(patientId).trim();
  if (mongoose.Types.ObjectId.isValid(idValue)) {
    const patientByObjectId = await Patient.findById(idValue);
    if (patientByObjectId) {
      return patientByObjectId;
    }
  }

  return Patient.findOne({ patientId: idValue });
};

const recalculatePersonRisk = asyncHandler(async (req, res) => {
  const result = await calculateRiskForPerson(req.params.personId);
  res.json(result);
});

const recalculateAllRisks = asyncHandler(async (req, res) => {
  const results = await calculateRiskForAll();
  res.json({ count: results.length, results });
});

const getHighRiskPeople = asyncHandler(async (req, res) => {
  const [patients, staff] = await Promise.all([
    Patient.find().lean(),
    Staff.find().lean(),
  ]);

  const highRiskPeople = [
    ...patients.map((person) => {
      const riskScore = Number(person.riskScore) || 0;
      return {
        id: person._id,
        name: person.name,
        role: 'Patient',
        type: 'Patient',
        riskScore,
        riskLevel: getRiskLevel(riskScore),
      };
    }),
    ...staff.map((person) => {
      const riskScore = Number(person.riskScore) || 0;
      return {
        id: person._id,
        name: person.name,
        role: person.role || 'Staff',
        type: 'Staff',
        riskScore,
        riskLevel: getRiskLevel(riskScore),
      };
    }),
  ].sort((a, b) => b.riskScore - a.riskScore);

  res.json({ count: highRiskPeople.length, people: highRiskPeople });
});

const getPatientContacts = asyncHandler(async (req, res) => {
  const patient = await findPatientByIdentifier(req.params.patientId);
  if (!patient) {
    res.status(404);
    throw new Error('Patient not found');
  }

  const patientReferenceValues = [patient._id];
  const patientReferenceStrings = [String(patient._id)];

  if (patient.patientId) {
    patientReferenceValues.push(String(patient.patientId));
    patientReferenceStrings.push(String(patient.patientId));
  }

  const contactsMap = new Map();
  const upsertContact = (contact) => {
    const key = `${contact.type}:${contact.id}`;
    const existing = contactsMap.get(key);
    if (!existing || contact.riskScore > existing.riskScore) {
      contactsMap.set(key, contact);
    }
  };

  const interactions = await Interaction.find({
    $or: [
      { person1: { $in: patientReferenceValues } },
      { person2: { $in: patientReferenceValues } },
    ],
  }).sort({ timestamp: -1 });

  for (const interaction of interactions) {
    if (patient.ward && interaction.ward && interaction.ward !== patient.ward) {
      continue;
    }

    if (patient.admissionDate && interaction.timestamp) {
      const interactionTime = new Date(interaction.timestamp);
      if (!Number.isNaN(interactionTime.getTime()) && interactionTime < patient.admissionDate) {
        continue;
      }
    }

    const person1Match = patientReferenceStrings.includes(String(interaction.person1));
    const person2Match = patientReferenceStrings.includes(String(interaction.person2));
    const otherPersonId = person1Match ? interaction.person2 : person2Match ? interaction.person1 : null;

    if (!otherPersonId) {
      continue;
    }

    const contactRecord = await getPersonById(otherPersonId);
    if (!contactRecord) {
      continue;
    }

    if (
      contactRecord.type === 'Patient' &&
      String(contactRecord.data._id) === String(patient._id)
    ) {
      continue;
    }

    const riskScore = Number(contactRecord.data.riskScore) || 0;
    const role = contactRecord.type === 'Staff' ? contactRecord.data.role || 'Staff' : 'Patient';

    upsertContact({
      id: String(contactRecord.data._id),
      type: contactRecord.type,
      name: contactRecord.data.name,
      role,
      riskScore,
      riskLevel: getRiskLevel(riskScore),
    });
  }

  const patientWindowStart = patient.admissionDate || patient.createdAt || new Date(0);
  const patientWindowEnd = new Date();

  if (patient.ward) {
    const wardVisitLogs = await VisitLog.find({
      ward: patient.ward,
      entryTime: { $lte: patientWindowEnd },
      $or: [{ exitTime: null }, { exitTime: { $gte: patientWindowStart } }],
    })
      .populate('staffId', 'name role riskScore')
      .lean();

    for (const visitLog of wardVisitLogs) {
      if (!visitLog.staffId || !visitLog.staffId._id) {
        continue;
      }

      const riskScore = Number(visitLog.staffId.riskScore) || 0;
      upsertContact({
        id: String(visitLog.staffId._id),
        type: 'Staff',
        name: visitLog.staffId.name,
        role: visitLog.staffId.role || 'Staff',
        riskScore,
        riskLevel: getRiskLevel(riskScore),
      });
    }
  }

  const contacts = Array.from(contactsMap.values()).sort((a, b) => b.riskScore - a.riskScore);

  res.json({
    patient: {
      id: patient._id,
      patientId: patient.patientId || null,
      name: patient.name,
      ward: patient.ward,
    },
    count: contacts.length,
    contacts,
  });
});

const getRiskLogs = asyncHandler(async (req, res) => {
  const logs = await RiskLog.find().sort({ date: -1 });
  res.json(logs);
});

const getAlerts = asyncHandler(async (req, res) => {
  const alerts = await Alert.find().sort({ createdAt: -1 });
  res.json(alerts);
});

const syncHighRiskPatientAlerts = asyncHandler(async (req, res) => {
  const highRiskPatients = await Patient.find({ riskScore: { $gt: 50 } })
    .select('_id name ward phoneNumber riskScore')
    .lean();

  if (!highRiskPatients.length) {
    res.json({
      count: 0,
      triggered: 0,
      skipped: 0,
      results: [],
    });
    return;
  }

  const patientIds = highRiskPatients.map((patient) => patient._id);
  const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);

  const recentAlerts = await Alert.find({
    type: 'HIGH_RISK_PATIENT',
    triggeredBy: { $in: patientIds },
    createdAt: { $gte: fiveMinutesAgo },
  })
    .select('triggeredBy')
    .lean();

  const recentAlertPatientSet = new Set(
    recentAlerts.map((alert) => String(alert.triggeredBy || '').trim()).filter(Boolean)
  );

  const results = [];

  for (const patient of highRiskPatients) {
    const patientId = String(patient._id || '').trim();
    if (!patientId) {
      continue;
    }

    if (recentAlertPatientSet.has(patientId)) {
      results.push({
        patientId,
        patientName: patient.name,
        ward: patient.ward || null,
        skipped: true,
        reason: 'Recent patient alert already exists',
      });
      continue;
    }

    try {
      const result = await triggerAlert({
        type: 'HIGH_RISK_PATIENT',
        message: `High infection exposure detected. Patient ${patient.name} exceeded safe threshold in ward ${patient.ward || 'Unassigned'}. Immediate review required.`,
        severity: 'High',
        staff: patient._id,
        ward: patient.ward || null,
        toNumber: patient.phoneNumber || undefined,
      });

      results.push({
        patientId,
        patientName: patient.name,
        ward: patient.ward || null,
        ...result,
      });
    } catch (error) {
      console.error('Failed to sync patient alert:', error.message);
      results.push({
        patientId,
        patientName: patient.name,
        ward: patient.ward || null,
        skipped: false,
        error: error.message,
      });
    }
  }

  const triggered = results.filter((item) => !item.skipped && !item.error).length;
  const skipped = results.length - triggered;

  res.json({
    count: highRiskPatients.length,
    triggered,
    skipped,
    results,
  });
});

const triggerManualCallAlert = asyncHandler(async (req, res) => {
  const {
    type = 'MANUAL_ALERT',
    message = 'Manual emergency alert from PathoTrace dashboard.',
    severity = 'High',
    staff = null,
    ward = null,
    toNumber,
  } = req.body || {};

  const result = await triggerAlert({
    type,
    message,
    severity,
    staff,
    ward,
    toNumber,
  });

  if (result?.skipped) {
    res.status(429).json({
      ok: false,
      message: result.reason || 'Alert cooldown active',
      nextEligibleAt: result.nextEligibleAt || null,
      result,
    });
    return;
  }

  res.json({
    ok: true,
    message: 'Alert call flow executed.',
    result,
  });
});

const buildPatientReferenceSet = (patient) => {
  const values = new Set([String(patient._id)]);
  if (patient.patientId) {
    values.add(String(patient.patientId).trim());
  }
  return values;
};

const collectUniqueContactIdentifiers = (interactions, patientReferenceSet) => {
  const contacts = new Set();

  interactions.forEach((interaction) => {
    const person1 = String(interaction.person1 || '').trim();
    const person2 = String(interaction.person2 || '').trim();
    const interactionPatientId = String(interaction.patientId || '').trim();
    const interactionStaffId = String(interaction.staffId || '').trim();

    if (person1 && patientReferenceSet.has(person1) && person2 && !patientReferenceSet.has(person2)) {
      contacts.add(person2);
    } else if (person2 && patientReferenceSet.has(person2) && person1 && !patientReferenceSet.has(person1)) {
      contacts.add(person1);
    }

    if (
      interactionPatientId &&
      patientReferenceSet.has(interactionPatientId) &&
      interactionStaffId
    ) {
      contacts.add(interactionStaffId);
    }
  });

  return Array.from(contacts);
};

const resolveContactDetails = async (contactIdentifiers, patientReferenceSet) => {
  if (!contactIdentifiers.length) {
    return [];
  }

  const objectIds = contactIdentifiers
    .filter((identifier) => mongoose.Types.ObjectId.isValid(identifier))
    .map((identifier) => new mongoose.Types.ObjectId(identifier));

  const [patientMatches, staffMatches] = await Promise.all([
    Patient.find({
      $or: [
        ...(objectIds.length ? [{ _id: { $in: objectIds } }] : []),
        { patientId: { $in: contactIdentifiers } },
      ],
    })
      .select('name riskScore patientId')
      .lean(),
    Staff.find({
      $or: [
        ...(objectIds.length ? [{ _id: { $in: objectIds } }] : []),
        { staffId: { $in: contactIdentifiers } },
      ],
    })
      .select('name role riskScore staffId')
      .lean(),
  ]);

  const contacts = [];
  const seen = new Set();

  patientMatches.forEach((person) => {
    const patientKey = `Patient:${person._id}`;
    if (seen.has(patientKey)) {
      return;
    }
    if (patientReferenceSet.has(String(person._id))) {
      return;
    }
    if (person.patientId && patientReferenceSet.has(String(person.patientId).trim())) {
      return;
    }

    seen.add(patientKey);
    contacts.push({
      name: person.name || 'Unknown',
      role: 'Patient',
      riskScore: Number(person.riskScore || 0),
    });
  });

  staffMatches.forEach((person) => {
    const staffKey = `Staff:${person._id}`;
    if (seen.has(staffKey)) {
      return;
    }

    seen.add(staffKey);
    contacts.push({
      name: person.name || 'Unknown',
      role: person.role || 'Staff',
      riskScore: Number(person.riskScore || 0),
    });
  });

  return contacts.sort((a, b) => b.riskScore - a.riskScore);
};

const getHighestPatientContacts = asyncHandler(async (req, res) => {
  const highestRiskPatient = await Patient.findOne({ riskScore: { $gt: 50 } })
    .sort({ riskScore: -1 })
    .select('_id patientId name ward riskScore')
    .lean();

  if (!highestRiskPatient) {
    res.json({ message: 'No high-risk patient found.' });
    return;
  }

  const patientReferenceSet = buildPatientReferenceSet(highestRiskPatient);
  const patientReferenceValues = Array.from(patientReferenceSet);

  const interactions = await Interaction.find({
    $or: [
      { person1: { $in: patientReferenceValues } },
      { person2: { $in: patientReferenceValues } },
      { patientId: { $in: patientReferenceValues } },
    ],
  })
    .select('person1 person2 patientId staffId')
    .lean();

  if (!interactions.length) {
    res.json({
      patient: {
        id: highestRiskPatient._id,
        name: highestRiskPatient.name,
        ward: highestRiskPatient.ward,
        riskScore: Number(highestRiskPatient.riskScore || 0),
      },
      contactCount: 0,
      contacts: [],
    });
    return;
  }

  const contactIdentifiers = collectUniqueContactIdentifiers(interactions, patientReferenceSet);
  const contacts = await resolveContactDetails(contactIdentifiers, patientReferenceSet);

  res.json({
    patient: {
      id: highestRiskPatient._id,
      name: highestRiskPatient.name,
      ward: highestRiskPatient.ward,
      riskScore: Number(highestRiskPatient.riskScore || 0),
    },
    contactCount: contacts.length,
    contacts,
  });
});

const getWardStats = asyncHandler(async (req, res) => {
  try {
    const wardRows = await Patient.aggregate([
      {
        $project: {
          wardNormalized: {
            $trim: {
              input: {
                $toString: {
                  $ifNull: ['$ward', ''],
                },
              },
            },
          },
          pathogenNormalized: {
            $trim: {
              input: {
                $toString: {
                  $ifNull: ['$pathogen', ''],
                },
              },
            },
          },
        },
      },
      {
        $project: {
          ward: {
            $cond: [
              { $gt: [{ $strLenCP: '$wardNormalized' }, 0] },
              '$wardNormalized',
              'Unassigned',
            ],
          },
          isInfected: {
            $cond: [
              { $gt: [{ $strLenCP: '$pathogenNormalized' }, 0] },
              1,
              0,
            ],
          },
        },
      },
      {
        $group: {
          _id: '$ward',
          totalPatients: { $sum: 1 },
          infectedPatients: { $sum: '$isInfected' },
        },
      },
      {
        $project: {
          _id: 0,
          ward: '$_id',
          totalPatients: 1,
          infectedPatients: 1,
        },
      },
      {
        $sort: { ward: 1 },
      },
    ]);

    if (!Array.isArray(wardRows) || wardRows.length === 0) {
      res.json([]);
      return;
    }

    const result = wardRows.map((row) => {
      const totalPatients = Number(row.totalPatients || 0);
      const infectedPatients = Number(row.infectedPatients || 0);
      const rawRate = totalPatients > 0 ? (infectedPatients / totalPatients) * 100 : 0;
      const infectionRate = Math.min(100, Number(rawRate.toFixed(2)));

      let status = 'Stable';
      if (infectionRate > 30) {
        status = 'Critical';
      } else if (infectionRate >= 10) {
        status = 'Moderate';
      }

      return {
        ward: String(row.ward || 'Unassigned'),
        totalPatients,
        infectedPatients,
        infectionRate,
        status,
      };
    });

    res.json(result);
  } catch (error) {
    res.status(500);
    throw new Error(`Failed to compute ward stats: ${error.message}`);
  }
});

module.exports = {
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
};
