/**
 * services/alertService.js
 * Centralized alerting (DB log + SMS + voice call) with cooldown protection.
 */
const Alert = require('../models/Alert');

let twilio = null;
try {
  twilio = require('twilio');
} catch (error) {
  console.error('Twilio SDK unavailable. Install with `npm install twilio` to enable SMS/call alerts.');
}

const ALERT_COOLDOWN_MS = 5 * 60 * 1000;
const lastAlertTimeByKey = new Map();

let cachedClient = null;
let cachedClientKey = null;

const getAlertConfig = () => {
  return {
    accountSid: process.env.TWILIO_ACCOUNT_SID,
    authToken: process.env.TWILIO_AUTH_TOKEN,
    fromNumber: process.env.TWILIO_PHONE_NUMBER,
    defaultTo:
      process.env.ALERT_NOTIFICATION_TO ||
      process.env.ALERT_PHONE_NUMBER ||
      process.env.EMERGENCY_PHONE_NUMBER ||
      null,
  };
};

const getTwilioClient = () => {
  const { accountSid, authToken } = getAlertConfig();
  const clientKey = `${accountSid || ''}:${authToken || ''}`;

  if (!accountSid || !authToken) {
    return null;
  }

  if (!twilio) {
    return null;
  }

  if (cachedClient && cachedClientKey === clientKey) {
    return cachedClient;
  }

  cachedClient = twilio(accountSid, authToken);
  cachedClientKey = clientKey;
  return cachedClient;
};

const getDefaultRecipient = () => {
  return getAlertConfig().defaultTo;
};

const sanitizeForTwiml = (value) => {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
};

const buildCallMessage = ({ type, severity, ward, fallbackMessage }) => {
  const normalizedType = String(type || '').toUpperCase().trim();
  const normalizedSeverity = String(severity || 'High').trim() || 'High';
  const normalizedWard = String(ward || '').trim();
  const wardSegment = normalizedWard ? ` in ward ${normalizedWard}` : '';

  if (normalizedType === 'HIGH_RISK_PATIENT' || normalizedType === 'HIGH_RISK_STAFF') {
    return `Important PathoTrace health alert. You may have been in contact with an affected person${wardSegment}. Please follow isolation protocol and contact infection control immediately. Severity level ${normalizedSeverity}.`;
  }

  if (normalizedType === 'WARD_CRITICAL') {
    return `Important PathoTrace health alert. Elevated infection risk is active${wardSegment}. You may have been in contact with an affected person. Please follow infection control protocol immediately. Severity level ${normalizedSeverity}.`;
  }

  if (String(fallbackMessage || '').trim()) {
    return `Important PathoTrace health alert. You may have been in contact with an affected person. Please review the alert details sent by SMS and follow infection control protocol immediately. Severity level ${normalizedSeverity}.`;
  }

  return `Important PathoTrace health alert. You may have been in contact with an affected person. Please follow infection control protocol immediately. Severity level ${normalizedSeverity}.`;
};

const buildCooldownKey = ({ type, staff, ward, toNumber }) => {
  const typeKey = String(type || 'ALERT').toUpperCase().trim() || 'ALERT';
  const subjectKey =
    String(staff || '').trim() ||
    String(toNumber || '').trim() ||
    String(ward || '').trim() ||
    'GLOBAL';

  return `${typeKey}:${subjectKey}`;
};

const sendSMS = async (toNumber, message) => {
  const { accountSid, authToken } = getAlertConfig();
  const { fromNumber } = getAlertConfig();
  const client = getTwilioClient();
  if (!client || !fromNumber || !toNumber) {
    return {
      sent: false,
      reason: 'Missing Twilio configuration or destination number',
      details: {
        hasClient: Boolean(client),
        hasFromNumber: Boolean(fromNumber),
        hasToNumber: Boolean(toNumber),
        hasAccountSid: Boolean(accountSid),
        hasAuthToken: Boolean(authToken),
      },
    };
  }

  try {
    const response = await client.messages.create({
      body: String(message || ''),
      from: fromNumber,
      to: toNumber,
    });

    return { sent: true, sid: response.sid };
  } catch (error) {
    console.error('Twilio SMS error:', error.message);
    return { sent: false, error: error.message };
  }
};

const makeCall = async (toNumber, message, options = {}) => {
  const { accountSid, authToken } = getAlertConfig();
  const { fromNumber } = getAlertConfig();
  const client = getTwilioClient();
  if (!client || !fromNumber || !toNumber) {
    return {
      called: false,
      reason: 'Missing Twilio configuration or destination number',
      details: {
        hasClient: Boolean(client),
        hasFromNumber: Boolean(fromNumber),
        hasToNumber: Boolean(toNumber),
        hasAccountSid: Boolean(accountSid),
        hasAuthToken: Boolean(authToken),
      },
    };
  }

  const callMessage = buildCallMessage({
    type: options.type,
    severity: options.severity,
    ward: options.ward,
    fallbackMessage: message,
  });
  const safeMessage = sanitizeForTwiml(callMessage);
  const twiml = `<Response><Say voice="alice">${safeMessage}</Say></Response>`;

  try {
    const response = await client.calls.create({
      from: fromNumber,
      to: toNumber,
      twiml,
    });

    return { called: true, sid: response.sid };
  } catch (error) {
    console.error('Twilio voice call error:', error.message);
    return { called: false, error: error.message };
  }
};

const triggerAlert = async ({ type, message, severity = 'High', staff, ward, toNumber }) => {
  const now = Date.now();
  const cooldownKey = buildCooldownKey({ type, staff, ward, toNumber });
  const lastAlertTime = lastAlertTimeByKey.get(cooldownKey);

  if (lastAlertTime && now - lastAlertTime <= ALERT_COOLDOWN_MS) {
    return {
      skipped: true,
      reason: 'Alert cooldown active',
      nextEligibleAt: new Date(lastAlertTime + ALERT_COOLDOWN_MS),
    };
  }

  const alert = await Alert.create({
    type,
    message,
    severity,
    triggeredBy: staff || null,
    ward: ward || null,
  });

  const recipient = toNumber || getDefaultRecipient();
  const [smsResult, callResult] = await Promise.all([
    sendSMS(recipient, message),
    makeCall(recipient, message, { type, severity, ward }),
  ]);

  lastAlertTimeByKey.set(cooldownKey, Date.now());

  return {
    skipped: false,
    alertId: alert._id,
    sms: smsResult,
    call: callResult,
  };
};

module.exports = {
  sendSMS,
  makeCall,
  triggerAlert,
};
