/**
 * services/riskEngine.js
 * Domain service that computes and persists risk scores using PathoTrace rules.
 */
const mongoose = require('mongoose');
const Patient = require('../models/Patient');
const Staff = require('../models/Staff');
const Interaction = require('../models/Interaction');
const VisitLog = require('../models/VisitLog');
const RiskLog = require('../models/RiskLog');
const { triggerAlert } = require('./alertService');
const {
  getPersonById,
  getPersonWard,
  isPersonInfected,
  isPatientInfectedDoc,
} = require('../utils/helpers');

const DEFAULT_VISIT_EXPOSURE_WEIGHT = 2;
const parsedWeight = Number(process.env.VISIT_EXPOSURE_WEIGHT_PER_MINUTE);
const VISIT_EXPOSURE_WEIGHT_PER_MINUTE = Number.isFinite(parsedWeight)
  ? parsedWeight
  : DEFAULT_VISIT_EXPOSURE_WEIGHT;

const resolveStaffDocument = async (staffIdentifier) => {
  if (!staffIdentifier) {
    return null;
  }

  if (staffIdentifier._id && typeof staffIdentifier.save === 'function') {
    return staffIdentifier;
  }

  const rawIdentifier = staffIdentifier._id || staffIdentifier;
  const identifier = String(rawIdentifier).trim();
  let staffDoc = null;

  if (mongoose.Types.ObjectId.isValid(identifier)) {
    staffDoc = await Staff.findById(identifier);
  }

  if (!staffDoc) {
    staffDoc = await Staff.findOne({ staffId: identifier });
  }

  return staffDoc;
};

const calculateVisitExposureRiskForStaff = async (staffIdentifier) => {
  const staffDoc = await resolveStaffDocument(staffIdentifier);

  if (!staffDoc) {
    throw new Error('Staff member not found');
  }

  const completedVisits = await VisitLog.find({
    staffId: staffDoc._id,
    entryTime: { $ne: null },
    exitTime: { $ne: null },
  })
    .select('ward entryTime exitTime durationMinutes')
    .lean();

  const wards = Array.from(
    new Set(completedVisits.map((visit) => String(visit.ward || '').trim()).filter(Boolean))
  );

  let wardPatients = [];
  if (wards.length > 0) {
    wardPatients = await Patient.find({ ward: { $in: wards } })
      .select('ward infectionStatus pathogen admissionDate')
      .lean();
  }

  const patientsByWard = wardPatients.reduce((acc, patient) => {
    const ward = String(patient.ward || '').trim();
    if (!ward) {
      return acc;
    }

    if (!acc[ward]) {
      acc[ward] = [];
    }
    acc[ward].push(patient);
    return acc;
  }, {});

  let exposedMinutes = 0;

  for (const visit of completedVisits) {
    const ward = String(visit.ward || '').trim();
    if (!ward || !visit.entryTime || !visit.exitTime) {
      continue;
    }

    const visitStart = new Date(visit.entryTime);
    const visitEnd = new Date(visit.exitTime);

    if (
      Number.isNaN(visitStart.getTime()) ||
      Number.isNaN(visitEnd.getTime()) ||
      visitEnd <= visitStart
    ) {
      continue;
    }

    const infectedPresent = (patientsByWard[ward] || []).some((patient) => {
      if (!isPatientInfectedDoc(patient)) {
        return false;
      }

      if (!patient.admissionDate) {
        return true;
      }

      const admissionDate = new Date(patient.admissionDate);
      if (Number.isNaN(admissionDate.getTime())) {
        return true;
      }

      return admissionDate <= visitEnd;
    });

    if (!infectedPresent) {
      continue;
    }

    const durationFromLog = Number(visit.durationMinutes);
    const visitMinutes =
      Number.isFinite(durationFromLog) && durationFromLog >= 0
        ? durationFromLog
        : (visitEnd.getTime() - visitStart.getTime()) / 60000;

    exposedMinutes += visitMinutes;
  }

  const normalizedExposedMinutes = Number(exposedMinutes.toFixed(2));
  const riskScore = Number((normalizedExposedMinutes * VISIT_EXPOSURE_WEIGHT_PER_MINUTE).toFixed(2));

  return {
    staffId: staffDoc._id,
    exposedMinutes: normalizedExposedMinutes,
    weightPerMinute: VISIT_EXPOSURE_WEIGHT_PER_MINUTE,
    riskScore,
  };
};

const calculateWardInfectionRate = async (ward) => {
  const normalizedWard = String(ward || '').trim();
  if (!normalizedWard) {
    return { totalPatients: 0, infectedPatients: 0, infectionRate: 0 };
  }

  const [totalPatients, infectedPatients] = await Promise.all([
    Patient.countDocuments({ ward: normalizedWard }),
    Patient.countDocuments({
      ward: normalizedWard,
      $or: [{ infectionStatus: /^yes$/i }, { pathogen: /\S/ }],
    }),
  ]);

  const rawRate = totalPatients > 0 ? (infectedPatients / totalPatients) * 100 : 0;
  const infectionRate = Math.min(100, Number(rawRate.toFixed(2)));

  return {
    totalPatients,
    infectedPatients,
    infectionRate,
  };
};

const safelyTriggerAlert = async (alertPayload) => {
  try {
    return await triggerAlert(alertPayload);
  } catch (error) {
    console.error('Alert trigger failed:', error.message);
    return null;
  }
};

const resolvePatientAlertNumber = (patientDoc) => {
  if (!patientDoc) {
    return null;
  }

  const candidates = [
    patientDoc.phoneNumber,
    patientDoc.phone,
    patientDoc.mobile,
    patientDoc.contactNumber,
    patientDoc.contactPhone,
    patientDoc.emergencyContact?.phone,
  ];

  const matched = candidates
    .map((value) => String(value || '').trim())
    .find((value) => value.length > 0);

  return matched || null;
};

const calculateRiskForPerson = async (personId) => {
  const personRecord = await getPersonById(personId);

  if (!personRecord) {
    throw new Error('Person not found');
  }

  const resolvedPersonId = personRecord.data._id;
  const personIdentifiers = new Set([resolvedPersonId.toString()]);
  if (personRecord.type === 'Patient' && personRecord.data.patientId) {
    personIdentifiers.add(String(personRecord.data.patientId));
  }
  if (personRecord.type === 'Staff' && personRecord.data.staffId) {
    personIdentifiers.add(String(personRecord.data.staffId));
  }

  const interactionMatchValues = [resolvedPersonId, ...Array.from(personIdentifiers)];

  const interactions = await Interaction.find({
    $or: [
      { person1: { $in: interactionMatchValues } },
      { person2: { $in: interactionMatchValues } },
    ],
  });

  let infectedInteractionRisk = 0;

  for (const interaction of interactions) {
    const person1Value = String(interaction.person1);
    const isPrimary = personIdentifiers.has(person1Value);
    const otherPersonId = isPrimary ? interaction.person2 : interaction.person1;

    const otherPersonRecord = await getPersonById(otherPersonId);
    if (isPersonInfected(otherPersonRecord)) {
      infectedInteractionRisk += (interaction.duration || 0) * 2;
    }
  }

  const interactionVolumeRisk = interactions.length * 10;

  const ward = getPersonWard(personRecord);
  let sameWardRisk = 0;

  if (ward) {
    const wardPatients = await Patient.find({
      ward,
      _id: { $ne: resolvedPersonId },
    }).select('infectionStatus pathogen');

    if (wardPatients.some((patient) => isPatientInfectedDoc(patient))) {
      sameWardRisk = 15;
    }
  }

  let visitExposureRisk = 0;
  let exposedVisitMinutes = 0;
  let visitExposureWeight = VISIT_EXPOSURE_WEIGHT_PER_MINUTE;

  if (personRecord.type === 'Staff') {
    const visitExposure = await calculateVisitExposureRiskForStaff(personRecord.data);
    visitExposureRisk = visitExposure.riskScore;
    exposedVisitMinutes = visitExposure.exposedMinutes;
    visitExposureWeight = visitExposure.weightPerMinute;
  }

  const newScore =
    infectedInteractionRisk + sameWardRisk + interactionVolumeRisk + visitExposureRisk;
  const oldScore = personRecord.data.riskScore || 0;

  personRecord.data.riskScore = newScore;
  await personRecord.data.save();

  await RiskLog.create({
    personId: resolvedPersonId,
    oldScore,
    newScore,
    reason: `infected_interaction:${infectedInteractionRisk};same_ward:${sameWardRisk};interaction_volume:${interactionVolumeRisk};visit_exposure:${visitExposureRisk}`,
  });

  if (personRecord.type === 'Staff' && newScore > 50) {
    await safelyTriggerAlert({
      type: 'HIGH_RISK_STAFF',
      message: `High infection exposure detected. Staff ${personRecord.data.name} exceeded safe threshold in ward ${ward || 'Unassigned'}. Immediate review required.`,
      severity: 'High',
      staff: resolvedPersonId,
      ward,
    });
  }

  if (personRecord.type === 'Patient' && newScore > 50) {
    await safelyTriggerAlert({
      type: 'HIGH_RISK_PATIENT',
      message: `High infection exposure detected. Patient ${personRecord.data.name} exceeded safe threshold in ward ${ward || 'Unassigned'}. Immediate review required.`,
      severity: 'High',
      staff: resolvedPersonId,
      ward,
      toNumber: resolvePatientAlertNumber(personRecord.data),
    });
  }

  if (ward) {
    const wardStats = await calculateWardInfectionRate(ward);
    if (wardStats.infectionRate > 30) {
      await safelyTriggerAlert({
        type: 'WARD_CRITICAL',
        message: `Critical infection risk in ward ${ward}. Infection rate is ${wardStats.infectionRate}% (${wardStats.infectedPatients}/${wardStats.totalPatients} patients). Immediate containment required.`,
        severity: 'High',
        staff: personRecord.type === 'Staff' ? resolvedPersonId : null,
        ward,
      });
    }
  }

  return {
    personId: resolvedPersonId,
    personType: personRecord.type,
    oldScore,
    newScore,
    breakdown: {
      infectedInteractionRisk,
      sameWardRisk,
      interactionVolumeRisk,
      visitExposureRisk,
      exposedVisitMinutes,
      visitExposureWeight,
    },
  };
};

const calculateRiskForAll = async () => {
  const [patients, staff] = await Promise.all([
    Patient.find().select('_id'),
    Staff.find().select('_id'),
  ]);

  const everyone = [...patients, ...staff];
  const results = [];

  for (const person of everyone) {
    const result = await calculateRiskForPerson(person._id);
    results.push(result);
  }

  return results;
};

module.exports = {
  calculateRiskForPerson,
  calculateRiskForAll,
  calculateVisitExposureRiskForStaff,
};
