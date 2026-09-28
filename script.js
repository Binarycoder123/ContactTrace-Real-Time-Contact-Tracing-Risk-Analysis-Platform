/* PathoTrace frontend controller logic (vanilla JS). */
const API_BASE_URL = 'http://localhost:5001';

const state = {
  patients: [],
  staff: [],
  highRiskPeople: [],
  wardStats: [],
  interactions: [],
  interactionCsvRows: [],
  wardStatusRows: [],
  networkCache: {
    nodes: [],
    edges: [],
    adjacency: new Map(),
  },
  highRiskFilters: {
    search: '',
    type: 'all',
    level: 'all',
  },
  dashboardExposure: {
    highRiskPatientCount: 0,
    highRiskStaffCount: 0,
    highRiskPatientContactsCount: 0,
    highestRiskPatient: null,
    contacts: [],
    error: '',
  },
  calledPatientAlerts: [],
  calledPatientAlertsError: '',
  networkInstance: null,
  scanner: {
    instance: null,
    running: false,
    staffRawId: '',
    resolvedStaffId: '',
    ward: '',
    activeVisit: null,
    entryInFlight: false,
    lastScanText: '',
    lastScanAt: 0,
  },
  voice: {
    supported: false,
    listening: false,
    recognition: null,
    initializing: false,
    manualStop: false,
    inactivityTimer: null,
    lastCommand: '',
    lastCommandAt: 0,
  },
};

const commandMap = {
  dashboard: 'dashboard',
  'add patient': 'addPatient',
  'add staff': 'addStaff',
  qr: 'visitLog',
  scanner: 'visitLog',
  'risk monitor': 'riskMonitor',
  'high risk': 'highRiskList',
};

const voiceNavTargetAliases = {
  dashboard: ['dashboard', 'dashboard-section'],
  addPatient: ['addPatient', 'patient-section'],
  addStaff: ['addStaff', 'staff-section'],
  visitLog: ['visitLog', 'visit-section'],
  riskMonitor: ['riskMonitor', 'high-risk-section'],
  highRiskList: ['highRiskList', 'high-risk-section'],
  ward: ['ward', 'ward-section'],
};

let commandExecuted = false;

document.addEventListener('DOMContentLoaded', () => {
  initializeApp().catch((error) => {
    setMessage('dashboard-message', `Startup failed: ${getErrorMessage(error)}`, 'error');
  });
});

async function initializeApp() {
  setupNavigation();
  setupActions();
  setupForms();
  setupScannerControls();
  setupHighRiskControls();
  setupNetworkSearchControls();
  setupVoiceControl();
  restoreActiveVisitFromStorage();

  await refreshAllData();
  setInterval(() => {
    refreshRiskOnly().catch((error) => {
      setMessage('high-risk-message', getErrorMessage(error), 'error');
    });
  }, 30000);
}

function setupNavigation() {
  const navButtons = document.querySelectorAll('.nav-link');

  navButtons.forEach((button) => {
    button.addEventListener('click', () => {
      navigateToSection(button.dataset.section);
    });
  });
}

function navigateToSection(sectionId) {
  const target = String(sectionId || '').trim();
  if (!target) {
    return;
  }

  document.querySelectorAll('.nav-link').forEach((button) => {
    button.classList.toggle('active', button.dataset.section === target);
  });

  document.querySelectorAll('.view-section').forEach((section) => {
    section.classList.toggle('active', section.id === target);
  });
}

function setupActions() {
  document.getElementById('refresh-btn').addEventListener('click', async () => {
    await refreshAllData();
  });
}

function setupVoiceControl() {
  const voiceToggleBtn = document.getElementById('voice-toggle-btn');
  const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;

  if (!voiceToggleBtn) return;

  setVoiceStatus('Voice ready.');

  if (location.protocol === 'file:') {
    voiceToggleBtn.disabled = true;
    setVoiceStatus('Voice unavailable on file://');
    return;
  }

  if (!SpeechRecognitionCtor) {
    voiceToggleBtn.disabled = true;
    setVoiceStatus('Voice not supported in this browser');
    return;
  }

  state.voice.supported = true;
  state.voice.recognition = createRecognitionInstance(SpeechRecognitionCtor);

  voiceToggleBtn.addEventListener('click', () => {
    if (state.voice.listening) {
      stopVoiceRecognition('Voice control stopped.');
    } else {
      startVoiceRecognition();
    }
  });

  window.addEventListener('beforeunload', () => {
    stopVoiceRecognition('');
  });
}

function createRecognitionInstance(SpeechRecognitionCtor) {
  const recognition = new SpeechRecognitionCtor();
  recognition.lang = 'en-IN';
  recognition.continuous = true;
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;

  recognition.onstart = () => {
    state.voice.listening = true;
    setVoiceUiState(true);
    setVoiceStatus('Listening...');
    setMessage('dashboard-message', 'Voice control listening...', 'success');
    resetVoiceInactivityTimer();
  };

  recognition.onresult = async (event) => {
    const result = event.results?.[event.resultIndex] || event.results?.[0];
    const transcript = String(result?.[0]?.transcript || '').trim();
    if (!transcript) return;

    setVoiceStatus(`Recognized: ${transcript}`);
    try {
      // Execute once for a finalized speech result.
      if (event.results?.[0]?.isFinal && result?.isFinal) {
        commandExecuted = false;
        await handleVoiceCommand(transcript);
      }
    } catch (error) {
      console.error('Voice command execution failed:', error);
      speak('Unable to execute that command right now.');
    }
  };

  recognition.onerror = (event) => {
    const errorName = String(event?.error || 'unknown');
    console.error('Voice recognition error:', errorName);

    if (errorName === 'not-allowed' || errorName === 'service-not-allowed') {
      setVoiceStatus('Microphone permission denied');
      stopVoiceRecognition('Microphone permission denied.');
      return;
    }

    if (errorName === 'no-speech') {
      setVoiceStatus('Listening... say a command');
      resetVoiceInactivityTimer();
      return;
    }

    setVoiceStatus(`Recognition error: ${errorName}`);
  };

  recognition.onend = () => {
    commandExecuted = false;
    if (state.voice.manualStop) {
      state.voice.listening = false;
      setVoiceUiState(false);
      return;
    }

    // Keep listening unless explicitly stopped.
    try {
      recognition.start();
    } catch (error) {
      state.voice.listening = false;
      setVoiceUiState(false);
      setVoiceStatus('Voice restart failed');
    }
  };

  return recognition;
}

async function startVoiceRecognition() {
  if (!state.voice.supported || !state.voice.recognition || state.voice.initializing) return;
  state.voice.initializing = true;
  state.voice.manualStop = false;
  setVoiceStatus('Starting voice control...');

  try {
    await warmupMicrophonePermission();
    state.voice.recognition.start();
    speak('Voice control activated.');
  } catch (error) {
    setVoiceStatus(`Voice start failed: ${getErrorMessage(error)}`);
    setMessage('dashboard-message', `Voice control unavailable: ${getErrorMessage(error)}`, 'error');
  } finally {
    state.voice.initializing = false;
  }
}

function stopVoiceRecognition(feedbackText = '') {
  state.voice.manualStop = true;
  clearVoiceInactivityTimer();
  state.voice.listening = false;
  setVoiceUiState(false);
  setVoiceStatus('Voice control stopped');

  if (state.voice.recognition) {
    try {
      state.voice.recognition.stop();
    } catch {}
  }

  if (feedbackText) speak(feedbackText);
}

function setVoiceUiState(isListening) {
  const voiceToggleBtn = document.getElementById('voice-toggle-btn');
  const listeningPill = document.getElementById('voice-listening-pill');

  if (voiceToggleBtn) {
    voiceToggleBtn.classList.toggle('listening', Boolean(isListening));
    voiceToggleBtn.setAttribute('aria-pressed', isListening ? 'true' : 'false');
  }
  if (listeningPill) {
    listeningPill.classList.toggle('hidden', !isListening);
  }
}

function setVoiceStatus(message) {
  const statusEl = document.getElementById('voice-status-text');
  if (!statusEl) return;
  statusEl.textContent = String(message || '').trim();
}

function resetVoiceInactivityTimer() {
  clearVoiceInactivityTimer();
  state.voice.inactivityTimer = setTimeout(() => {
    stopVoiceRecognition('Voice control stopped due to inactivity.');
  }, 20000);
}

function clearVoiceInactivityTimer() {
  if (!state.voice.inactivityTimer) return;
  clearTimeout(state.voice.inactivityTimer);
  state.voice.inactivityTimer = null;
}

async function warmupMicrophonePermission() {
  if (!navigator.mediaDevices?.getUserMedia) return;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((track) => track.stop());
  } catch {}
}

function triggerExistingNavigation(targetSection) {
  const navTargets = voiceNavTargetAliases[targetSection] || [targetSection];

  // 1) Global showSection (if available).
  if (typeof window.showSection === 'function') {
    for (const sectionKey of navTargets) {
      try {
        window.showSection(sectionKey);
      } catch (error) {
        console.error('showSection failed for:', sectionKey, error);
      }
      const sectionEl = document.getElementById(sectionKey);
      if (sectionEl?.classList.contains('active')) return true;
    }
    return true;
  }

  // 2) Existing navbar button click flow.
  const navButtons = document.querySelectorAll('[data-section]');
  if (navButtons.length > 0) {
    for (const sectionKey of navTargets) {
      const navButton = document.querySelector(`[data-section="${sectionKey}"]`);
      if (navButton) {
        navButton.click();
        return true;
      }
    }
    console.error('Navigation button not found for:', targetSection);
    return false;
  }

  // 3) No known navigation method detected.
  console.error('Navigation method not detected');
  return false;
}

async function handleVoiceCommand(rawTranscript) {
  let command = String(rawTranscript || '').toLowerCase().trim();
  if (!command) return;
  if (commandExecuted) return;

  command = normalizeVoiceCommand(command);
  console.log('Voice Received:', command);
  resetVoiceInactivityTimer();

  const now = Date.now();
  if (command === state.voice.lastCommand && now - state.voice.lastCommandAt < 1500) return;
  state.voice.lastCommand = command;
  state.voice.lastCommandAt = now;

  let matched = false;
  for (const key in commandMap) {
    if (!command.includes(key)) continue;
    const targetSection = commandMap[key];
    console.log('Switching to:', targetSection);
    const switched = triggerExistingNavigation(targetSection);
    if (!switched) {
      console.error('No nav button for:', targetSection);
    }
    commandExecuted = true;
    matched = true;
    break;
  }
  if (matched) return;

  if (matchesVoiceCommand(command, ['show ward statistics', 'ward statistics'])) {
    triggerExistingNavigation('ward');
    commandExecuted = true;
    speak('Opening ward statistics');
    return;
  }
  if (matchesVoiceCommand(command, ['show high risk staff', 'high risk staff'])) {
    triggerExistingNavigation('riskMonitor');
    const typeFilter = document.getElementById('high-risk-type-filter');
    if (typeFilter) {
      typeFilter.value = 'staff';
      state.highRiskFilters.type = 'staff';
      renderHighRiskTable();
    }
    commandExecuted = true;
    speak('Showing high risk staff');
    return;
  }
  if (matchesVoiceCommand(command, ['exit current visit', 'exit visit', 'end visit'])) {
    await exitCurrentVisit();
    commandExecuted = true;
    speak('Exiting current visit');
    return;
  }
  if (matchesVoiceCommand(command, ['call infection room', 'call infection control'])) {
    await triggerVoiceAlertCommand('infection');
    commandExecuted = true;
    speak('Calling infection control room.');
    return;
  }
  if (matchesVoiceCommand(command, ['trigger alert', 'send alert', 'raise alert'])) {
    await triggerVoiceAlertCommand('general');
    commandExecuted = true;
    speak('Triggering alert.');
    return;
  }

  console.log('No matching voice command.');
  speak('Command not recognized. Please try again.');
}

async function handleVoiceTranscript(rawTranscript) {
  await handleVoiceCommand(rawTranscript);
}

function normalizeVoiceCommand(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\b(please|kindly|the|a|an)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function matchesVoiceCommand(transcript, phrases) {
  const normalized = normalizeVoiceCommand(transcript);
  return phrases.some((phrase) => normalized.includes(normalizeVoiceCommand(phrase)));
}

async function triggerVoiceAlertCommand(mode) {
  const payload = {
    type: 'VOICE_ALERT',
    severity: 'High',
    message:
      mode === 'infection'
        ? 'Voice command: call infection room.'
        : 'Voice command: trigger alert.',
  };

  try {
    const response = await fetch(`${API_BASE_URL}/api/risk/call-alert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (response.ok) return;
  } catch {}

  // Spec fallback endpoint.
  const fallback = await fetch('http://localhost:5000/api/risk/trigger-alert', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!fallback.ok) {
    throw new Error('Unable to trigger alert command.');
  }
}

function speak(text) {
  if (!('speechSynthesis' in window)) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(String(text || '').trim());
  utterance.lang = 'en-IN';
  window.speechSynthesis.speak(utterance);
}

function setupForms() {
  const patientForm = document.getElementById('patient-form');
  const staffForm = document.getElementById('staff-form');

  patientForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    setMessage('patient-form-message', 'Creating patient...', '');

    const formData = new FormData(patientForm);
    const payload = {
      patientId: String(formData.get('patientId') || '').trim(),
      name: String(formData.get('name') || '').trim(),
      age: Number(formData.get('age')),
      gender: String(formData.get('gender') || '').trim(),
      phoneNumber: String(formData.get('phoneNumber') || '').trim(),
      ward: String(formData.get('ward') || '').trim(),
      bed: String(formData.get('bed') || '').trim(),
      pathogen: String(formData.get('pathogen') || '').trim(),
    };

    try {
      await apiRequest('/api/patients', {
        method: 'POST',
        body: payload,
      });

      patientForm.reset();
      setMessage('patient-form-message', 'Patient created successfully.', 'success');
      await refreshAllData();
    } catch (error) {
      setMessage('patient-form-message', getErrorMessage(error), 'error');
    }
  });

  staffForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    setMessage('staff-form-message', 'Creating staff member...', '');

    const formData = new FormData(staffForm);
    const payload = {
      name: String(formData.get('name') || '').trim(),
      role: String(formData.get('role') || '').trim(),
      phoneNumber: String(formData.get('phoneNumber') || '').trim(),
    };

    try {
      await apiRequest('/api/staff', {
        method: 'POST',
        body: payload,
      });

      staffForm.reset();
      setMessage('staff-form-message', 'Staff member created successfully.', 'success');
      await refreshAllData();
    } catch (error) {
      setMessage('staff-form-message', getErrorMessage(error), 'error');
    }
  });
}

function setupScannerControls() {
  document.getElementById('start-scan-btn').addEventListener('click', startScanner);
  document.getElementById('stop-scan-btn').addEventListener('click', stopScanner);
  document.getElementById('clear-scan-btn').addEventListener('click', clearCurrentScan);
  document.getElementById('exit-visit-btn').addEventListener('click', exitCurrentVisit);

  renderScanState();
}

function setupHighRiskControls() {
  const searchInput = document.getElementById('high-risk-search-input');
  const typeFilter = document.getElementById('high-risk-type-filter');
  const levelFilter = document.getElementById('high-risk-level-filter');
  const clearButton = document.getElementById('high-risk-filter-clear');

  if (!searchInput || !typeFilter || !levelFilter || !clearButton) {
    return;
  }

  searchInput.addEventListener('input', () => {
    state.highRiskFilters.search = String(searchInput.value || '').trim();
    renderHighRiskTable();
  });

  typeFilter.addEventListener('change', () => {
    state.highRiskFilters.type = String(typeFilter.value || 'all').toLowerCase();
    renderHighRiskTable();
  });

  levelFilter.addEventListener('change', () => {
    state.highRiskFilters.level = String(levelFilter.value || 'all').toLowerCase();
    renderHighRiskTable();
  });

  clearButton.addEventListener('click', () => {
    state.highRiskFilters = { search: '', type: 'all', level: 'all' };
    searchInput.value = '';
    typeFilter.value = 'all';
    levelFilter.value = 'all';
    renderHighRiskTable();
  });
}

function setupNetworkSearchControls() {
  const searchInput = document.getElementById('network-search-input');
  const clearButton = document.getElementById('network-search-clear');

  if (!searchInput || !clearButton) {
    return;
  }

  searchInput.addEventListener('input', () => {
    applyNetworkSearch(searchInput.value);
  });

  clearButton.addEventListener('click', () => {
    searchInput.value = '';
    resetNetworkSearch();
  });
}

async function refreshAllData() {
  setMessage('dashboard-message', 'Loading latest metrics...', '');
  setDashboardExposureLoadingState();

  try {
    const [patients, staff] = await Promise.all([
      apiRequest('/api/patients'),
      apiRequest('/api/staff'),
    ]);

    state.patients = Array.isArray(patients) ? patients : [];
    state.staff = Array.isArray(staff) ? staff : [];
    const [highRiskPeople, dashboardExposure, calledPatientAlertsPayload] = await Promise.all([
      loadHighRiskPeopleFromRiskLogs(),
      loadDashboardExposureData(),
      loadCalledPatientAlerts(),
    ]);
    state.highRiskPeople = highRiskPeople;
    state.dashboardExposure = dashboardExposure;
    state.calledPatientAlerts = calledPatientAlertsPayload.alerts;
    state.calledPatientAlertsError = calledPatientAlertsPayload.error;

    await loadSupplementalCsvData();

    renderDashboardKpis();
    renderCalledPersonList();
    renderHighRiskTable();
    renderRealTimeAlert();

    await Promise.all([renderWardStatsPanel(), renderNetworkGraph()]);

    setMessage('dashboard-message', 'Dashboard updated.', 'success');
    updateLastUpdatedTimestamp();
  } catch (error) {
    setMessage('dashboard-message', getErrorMessage(error), 'error');
    throw error;
  }
}

async function refreshRiskOnly() {
  setDashboardExposureLoadingState();

  const [patients, staff, highRiskPeople, dashboardExposure, calledPatientAlertsPayload] = await Promise.all([
    apiRequest('/api/patients'),
    apiRequest('/api/staff'),
    loadHighRiskPeopleFromRiskLogs(),
    loadDashboardExposureData(),
    loadCalledPatientAlerts(),
  ]);
  state.patients = Array.isArray(patients) ? patients : [];
  state.staff = Array.isArray(staff) ? staff : [];
  state.highRiskPeople = highRiskPeople;
  state.dashboardExposure = dashboardExposure;
  state.calledPatientAlerts = calledPatientAlertsPayload.alerts;
  state.calledPatientAlertsError = calledPatientAlertsPayload.error;

  renderDashboardKpis();
  renderCalledPersonList();
  renderHighRiskTable();
  renderRealTimeAlert();
  updateLastUpdatedTimestamp();
}

async function loadSupplementalCsvData() {
  const [interactionRows, wardStatusRows] = await Promise.all([
    loadInteractionsCsv(),
    loadWardStatusCsv(),
  ]);

  state.interactionCsvRows = interactionRows;
  state.wardStatusRows = wardStatusRows;
}

function setDashboardExposureLoadingState() {
  const highRiskPatientEl = document.getElementById('kpi-high-risk-patient');
  const highRiskStaffEl = document.getElementById('kpi-high-risk-staff');
  const highRiskContactsEl = document.getElementById('kpi-high-risk-contacts');

  if (highRiskPatientEl) highRiskPatientEl.textContent = '...';
  if (highRiskStaffEl) highRiskStaffEl.textContent = '...';
  if (highRiskContactsEl) highRiskContactsEl.textContent = '...';
}

async function loadDashboardExposureData() {
  const baseState = {
    highRiskPatientCount: 0,
    highRiskStaffCount: 0,
    highRiskPatientContactsCount: 0,
    highestRiskPatient: null,
    contacts: [],
    error: '',
  };

  try {
    const [logsResponse, interactionsResponse] = await Promise.all([
      apiRequest('/api/risk/logs'),
      apiRequest('/api/interactions'),
    ]);
    const logs = Array.isArray(logsResponse) ? logsResponse : [];
    const interactions = Array.isArray(interactionsResponse) ? interactionsResponse : [];
    state.interactions = interactions;

    if (!logs.length || !interactions.length) {
      return baseState;
    }

    const interactionById = buildInteractionLookupById(interactions);
    const patientLookup = buildEntityLookup(state.patients, 'patientId');
    const staffLookup = buildEntityLookup(state.staff, 'staffId');
    const highRiskStaffKeys = new Set();
    const patientRiskMap = new Map();

    logs.forEach((log) => {
      const riskFactor = Number(log?.riskScore ?? log?.newScore ?? 0);
      if (!Number.isFinite(riskFactor) || riskFactor <= 50) {
        return;
      }

      const interaction = resolveInteractionFromRiskLog(log, interactionById);
      if (!interaction) {
        return;
      }

      const staffIdentifier = getInteractionStaffIdentifier(interaction);
      if (staffIdentifier) {
        const staffMatch = resolveEntityByIdentifier(staffIdentifier, staffLookup);
        highRiskStaffKeys.add(staffMatch ? `staff:${staffMatch.id}` : `staff_raw:${staffIdentifier}`);
      }

      const patientIdentifier = getInteractionPatientIdentifier(interaction);
      if (!patientIdentifier) {
        return;
      }

      const patientMatch = resolveEntityByIdentifier(patientIdentifier, patientLookup);
      const patientKey = patientMatch ? `patient:${patientMatch.id}` : `patient_raw:${patientIdentifier}`;
      const current = patientRiskMap.get(patientKey);

      if (!current || riskFactor > current.riskScore) {
        patientRiskMap.set(patientKey, {
          riskScore: riskFactor,
          patient: patientMatch || {
            id: patientIdentifier,
            externalId: patientIdentifier,
            name: 'Unknown',
            ward: 'N/A',
          },
        });
      }
    });

    const highestRiskPatientEntry = Array.from(patientRiskMap.values()).sort(
      (a, b) => b.riskScore - a.riskScore
    )[0];
    const highRiskPatientCount = patientRiskMap.size;

    if (!highestRiskPatientEntry) {
      return {
        ...baseState,
        highRiskPatientCount,
        highRiskStaffCount: highRiskStaffKeys.size,
      };
    }

    const highestRiskPatient = highestRiskPatientEntry.patient;
    const patientIdentifiers = new Set(
      [highestRiskPatient.id, highestRiskPatient.externalId]
        .map((value) => String(value || '').trim())
        .filter(Boolean)
    );

    const contactKeys = collectContactsForPatientFromInteractions(
      interactions,
      patientIdentifiers,
      patientLookup,
      staffLookup
    );

    return {
      highRiskPatientCount,
      highRiskStaffCount: highRiskStaffKeys.size,
      highRiskPatientContactsCount: contactKeys.size,
      highestRiskPatient: {
        id: highestRiskPatient.id,
        name: highestRiskPatient.name || 'Unknown',
        ward: highestRiskPatient.ward || 'N/A',
        riskScore: Number(highestRiskPatientEntry.riskScore || 0),
      },
      contacts: [],
      error: '',
    };
  } catch (error) {
    return {
      ...baseState,
      error: `Unable to load dashboard exposure data: ${getErrorMessage(error)}`,
    };
  }
}

function buildEntityLookup(items, externalKey) {
  const byObjectId = new Map();
  const byExternalId = new Map();

  (Array.isArray(items) ? items : []).forEach((item) => {
    const objectId = String(item?._id || '').trim();
    const externalId = String(item?.[externalKey] || '').trim();

    if (objectId) {
      byObjectId.set(objectId, item);
    }
    if (externalId) {
      byExternalId.set(externalId, item);
    }
  });

  return { byObjectId, byExternalId, externalKey };
}

function resolveEntityByIdentifier(identifier, lookup) {
  const key = String(identifier || '').trim();
  if (!key) {
    return null;
  }

  const match = lookup.byObjectId.get(key) || lookup.byExternalId.get(key);
  if (!match) {
    return null;
  }

  const objectId = String(match._id || '').trim();
  const externalId = String(match[lookup.externalKey] || '').trim();
  return {
    id: objectId || key,
    externalId: externalId || key,
    name: match.name || 'Unknown',
    ward: match.ward || match.assignedWard || 'N/A',
    role: match.role || (lookup.externalKey === 'staffId' ? 'Staff' : 'Patient'),
  };
}

function buildInteractionLookupById(interactions) {
  const byId = new Map();
  (Array.isArray(interactions) ? interactions : []).forEach((interaction) => {
    const keys = [
      String(interaction?._id || '').trim(),
      String(interaction?.interactionId || '').trim(),
    ].filter(Boolean);

    keys.forEach((key) => byId.set(key, interaction));
  });
  return byId;
}

function resolveInteractionFromRiskLog(log, interactionById) {
  const keys = [
    String(log?.interactionId || '').trim(),
    String(log?._id || '').trim(),
  ].filter(Boolean);

  for (const key of keys) {
    if (interactionById.has(key)) {
      return interactionById.get(key);
    }
  }
  return null;
}

function getInteractionPatientIdentifier(interaction) {
  const directPatientId = String(interaction?.patientId || '').trim();
  if (directPatientId) {
    return directPatientId;
  }

  const person1 = String(interaction?.person1 || '').trim();
  const person2 = String(interaction?.person2 || '').trim();
  return person1 || person2 || '';
}

function getInteractionStaffIdentifier(interaction) {
  const directStaffId = String(interaction?.staffId || '').trim();
  if (directStaffId) {
    return directStaffId;
  }

  const person2 = String(interaction?.person2 || '').trim();
  const person1 = String(interaction?.person1 || '').trim();
  return person2 || person1 || '';
}

function collectContactsForPatientFromInteractions(
  interactions,
  patientIdentifiers,
  patientLookup,
  staffLookup
) {
  const contacts = new Set();

  (Array.isArray(interactions) ? interactions : []).forEach((interaction) => {
    const patientIdField = String(interaction?.patientId || '').trim();
    const staffIdField = String(interaction?.staffId || '').trim();
    const person1 = String(interaction?.person1 || '').trim();
    const person2 = String(interaction?.person2 || '').trim();

    const matchesByPatientField = patientIdField && patientIdentifiers.has(patientIdField);
    const matchesByPersonField =
      (person1 && patientIdentifiers.has(person1)) ||
      (person2 && patientIdentifiers.has(person2));

    if (!matchesByPatientField && !matchesByPersonField) {
      return;
    }

    const contactCandidates = [
      staffIdField,
      matchesByPersonField && patientIdentifiers.has(person1) ? person2 : '',
      matchesByPersonField && patientIdentifiers.has(person2) ? person1 : '',
    ].filter(Boolean);

    contactCandidates.forEach((candidate) => {
      if (patientIdentifiers.has(candidate)) {
        return;
      }

      const staffMatch = resolveEntityByIdentifier(candidate, staffLookup);
      if (staffMatch) {
        contacts.add(`staff:${staffMatch.id}`);
        return;
      }

      const patientMatch = resolveEntityByIdentifier(candidate, patientLookup);
      if (patientMatch && !patientIdentifiers.has(patientMatch.id) && !patientIdentifiers.has(patientMatch.externalId)) {
        contacts.add(`patient:${patientMatch.id}`);
      }
    });
  });

  return contacts;
}

async function loadHighRiskPeopleFromRiskLogs() {
  try {
    const highRiskPeopleResponse = await apiRequest('/api/risk/high');
    const fromDataset = Array.isArray(highRiskPeopleResponse?.people)
      ? highRiskPeopleResponse.people
      : Array.isArray(highRiskPeopleResponse)
        ? highRiskPeopleResponse
        : [];

    if (fromDataset.length) {
      return fromDataset;
    }
  } catch {}

  try {
    const logsResponse = await apiRequest('/api/risk/logs');
    const logs = Array.isArray(logsResponse) ? logsResponse : [];
    const fromLogs = await buildHighRiskPeopleFromRiskLogs(logs, state.patients, state.staff);
    if (fromLogs.length) {
      return fromLogs;
    }
  } catch {}

  return [];
}

async function buildHighRiskPeopleFromRiskLogs(logs, patients, staffMembers) {
  if (!Array.isArray(logs) || !logs.length) {
    return [];
  }

  const {
    patientByObjectId,
    patientByExternalId,
    staffByObjectId,
    staffByExternalId,
  } = buildPersonLookupsForRiskLogs(patients, staffMembers);
  const interactions = await getInteractionsForRiskLogs();
  const interactionById = new Map();

  interactions.forEach((interaction) => {
    if (interaction?._id) {
      interactionById.set(String(interaction._id), interaction);
    }
    if (interaction?.interactionId) {
      interactionById.set(String(interaction.interactionId), interaction);
    }
  });

  const personRisk = new Map();

  logs.forEach((log, index) => {
    const score = Number(log.riskScore ?? log.newScore ?? 0);
    if (!Number.isFinite(score)) {
      return;
    }

    const riskLevel = normalizeRiskLevel(
      log.riskLevel || log.level || getRiskLevelFromScore(score)
    );
    const eventTime = Number(
      new Date(log.evaluatedAt || log.date || log.createdAt || 0).getTime()
    );

    const personId = String(log.personId || '').trim();
    if (personId) {
      const patient = patientByObjectId.get(personId) || patientByExternalId.get(personId);
      const staff = staffByObjectId.get(personId) || staffByExternalId.get(personId);

      if (patient) {
        upsertRiskLogPerson(personRisk, {
          key: `Patient:${patient._id}`,
          id: patient._id,
          name: patient.name,
          role: 'Patient',
          type: 'Patient',
          riskScore: score,
          riskLevel,
          eventTime,
          fallbackIndex: index,
        });
      }

      if (staff) {
        upsertRiskLogPerson(personRisk, {
          key: `Staff:${staff._id}`,
          id: staff._id,
          name: staff.name,
          role: staff.role || 'Staff',
          type: 'Staff',
          riskScore: score,
          riskLevel,
          eventTime,
          fallbackIndex: index,
        });
      }

      return;
    }

    const interaction = interactionById.get(String(log.interactionId || ''));
    if (!interaction) {
      return;
    }

    const linkedPeople = resolvePeopleFromInteractionRiskLog(
      interaction,
      patientByObjectId,
      patientByExternalId,
      staffByObjectId,
      staffByExternalId
    );

    linkedPeople.forEach((person) => {
      upsertRiskLogPerson(personRisk, {
        key: `${person.type}:${person.id}`,
        id: person.id,
        name: person.name,
        role: person.role,
        type: person.type,
        riskScore: score,
        riskLevel,
        eventTime,
        fallbackIndex: index,
      });
    });
  });

  return Array.from(personRisk.values())
    .sort((a, b) => b.riskScore - a.riskScore)
    .map(({ eventTime: _eventTime, fallbackIndex: _fallbackIndex, ...person }) => person);
}

async function getInteractionsForRiskLogs() {
  if (Array.isArray(state.interactions) && state.interactions.length) {
    return state.interactions;
  }

  try {
    const interactionsResponse = await apiRequest('/api/interactions');
    state.interactions = Array.isArray(interactionsResponse) ? interactionsResponse : [];
  } catch {
    state.interactions = [];
  }

  return state.interactions;
}

function buildPersonLookupsForRiskLogs(patients, staffMembers) {
  const patientByObjectId = new Map();
  const patientByExternalId = new Map();
  const staffByObjectId = new Map();
  const staffByExternalId = new Map();

  patients.forEach((patient) => {
    if (patient?._id) {
      patientByObjectId.set(String(patient._id), patient);
    }
    if (patient?.patientId) {
      patientByExternalId.set(String(patient.patientId), patient);
    }
  });

  staffMembers.forEach((staff) => {
    if (staff?._id) {
      staffByObjectId.set(String(staff._id), staff);
    }
    if (staff?.staffId) {
      staffByExternalId.set(String(staff.staffId), staff);
    }
  });

  return {
    patientByObjectId,
    patientByExternalId,
    staffByObjectId,
    staffByExternalId,
  };
}

function resolvePeopleFromInteractionRiskLog(
  interaction,
  patientByObjectId,
  patientByExternalId,
  staffByObjectId,
  staffByExternalId
) {
  const people = [];
  const seen = new Set();

  const addPerson = (type, record) => {
    if (!record?._id) {
      return;
    }
    const key = `${type}:${record._id}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);

    if (type === 'Patient') {
      people.push({
        type: 'Patient',
        id: record._id,
        name: record.name || 'Unknown',
        role: 'Patient',
      });
      return;
    }

    people.push({
      type: 'Staff',
      id: record._id,
      name: record.name || 'Unknown',
      role: record.role || 'Staff',
    });
  };

  const patientFromDirect =
    patientByExternalId.get(String(interaction.patientId || '')) ||
    patientByObjectId.get(String(interaction.patientId || ''));
  const staffFromDirect =
    staffByExternalId.get(String(interaction.staffId || '')) ||
    staffByObjectId.get(String(interaction.staffId || ''));

  addPerson('Patient', patientFromDirect);
  addPerson('Staff', staffFromDirect);

  const sideA = String(interaction.person1 || '').trim();
  const sideB = String(interaction.person2 || '').trim();

  const patientA = patientByObjectId.get(sideA) || patientByExternalId.get(sideA);
  const patientB = patientByObjectId.get(sideB) || patientByExternalId.get(sideB);
  const staffA = staffByObjectId.get(sideA) || staffByExternalId.get(sideA);
  const staffB = staffByObjectId.get(sideB) || staffByExternalId.get(sideB);

  addPerson('Patient', patientA);
  addPerson('Patient', patientB);
  addPerson('Staff', staffA);
  addPerson('Staff', staffB);

  return people;
}

function upsertRiskLogPerson(store, candidate) {
  const existing = store.get(candidate.key);
  if (!existing) {
    store.set(candidate.key, candidate);
    return;
  }

  if (candidate.riskScore > existing.riskScore) {
    store.set(candidate.key, candidate);
    return;
  }

  if (
    candidate.riskScore === existing.riskScore &&
    candidate.eventTime >= existing.eventTime &&
    candidate.fallbackIndex >= existing.fallbackIndex
  ) {
    store.set(candidate.key, candidate);
  }
}

function renderDashboardKpis() {
  document.getElementById('kpi-patients').textContent = String(state.patients.length);
  document.getElementById('kpi-staff').textContent = String(state.staff.length);
  document.getElementById('kpi-high-risk-patient').textContent = String(
    Number(state.dashboardExposure?.highRiskPatientCount || 0)
  );
  document.getElementById('kpi-high-risk-staff').textContent = String(
    Number(state.dashboardExposure?.highRiskStaffCount || 0)
  );
  const highRiskContactsKpi = document.getElementById('kpi-high-risk-contacts');
  if (highRiskContactsKpi) {
    highRiskContactsKpi.textContent = String(
      Number(state.dashboardExposure?.highRiskPatientContactsCount || 0)
    );
  }
}

async function loadCalledPatientAlerts() {
  const highRiskPatients = (Array.isArray(state.patients) ? state.patients : [])
    .filter((patient) => Number(patient?.riskScore || 0) > 50)
    .map((patient) => ({
      id: String(patient?._id || '').trim(),
      name: String(patient?.name || 'Unknown').trim() || 'Unknown',
      ward: String(patient?.ward || 'N/A').trim() || 'N/A',
      riskScore: Number(patient?.riskScore || 0),
    }));

  try {
    await apiRequest('/api/risk/sync-high-risk-patient-alerts', { method: 'POST' });
  } catch {}

  try {
    const response = await apiRequest('/api/risk/alerts');
    const alerts = Array.isArray(response?.alerts)
      ? response.alerts
      : Array.isArray(response)
        ? response
        : [];

    const calledPatientAlerts = alerts.filter(
      (alert) => String(alert?.type || '').toUpperCase() === 'HIGH_RISK_PATIENT'
    );

    const latestAlertByPatient = new Map();
    calledPatientAlerts.forEach((alert) => {
      const patientId = String(alert?.triggeredBy || '').trim();
      if (!patientId) {
        return;
      }

      const current = latestAlertByPatient.get(patientId);
      const alertTime = new Date(alert?.createdAt || 0).getTime();
      if (!current || alertTime >= current.alertTime) {
        latestAlertByPatient.set(patientId, { alert, alertTime });
      }
    });

    const rows = highRiskPatients
      .map((patient) => {
        const latest = latestAlertByPatient.get(patient.id);
        const alert = latest?.alert || null;

        return {
          name: patient.name,
          ward: patient.ward,
          alertType: alert ? formatAlertType(alert.type) : 'Pending Call',
          severity: alert ? String(alert.severity || 'High') : 'High',
          timeLabel: alert ? formatDateTime(alert.createdAt) : '--',
          called: Boolean(alert),
          riskScore: patient.riskScore,
          alertTime: latest?.alertTime || 0,
        };
      })
      .sort((a, b) => {
        if (b.called !== a.called) {
          return Number(b.called) - Number(a.called);
        }
        if (b.alertTime !== a.alertTime) {
          return b.alertTime - a.alertTime;
        }
        return b.riskScore - a.riskScore;
      });

    return { alerts: rows, error: '' };
  } catch (error) {
    const fallbackRows = highRiskPatients
      .map((patient) => ({
        name: patient.name,
        ward: patient.ward,
        alertType: 'Pending Call',
        severity: 'High',
        timeLabel: '--',
        called: false,
        riskScore: patient.riskScore,
        alertTime: 0,
      }))
      .sort((a, b) => b.riskScore - a.riskScore);

    return {
      alerts: fallbackRows,
      error: `Unable to load called patient list: ${getErrorMessage(error)}`,
    };
  }
}

function renderCalledPersonList() {
  const tbody = document.getElementById('called-person-table-body');
  if (!tbody) {
    return;
  }

  const rows = Array.isArray(state.calledPatientAlerts) ? state.calledPatientAlerts : [];
  const visibleRows = rows.slice(0, 50);

  if (!visibleRows.length) {
    tbody.innerHTML = '<tr><td colspan="5">No serious patient call alerts yet.</td></tr>';
    if (state.calledPatientAlertsError) {
      setMessage('called-person-message', state.calledPatientAlertsError, 'error');
    } else {
      setMessage('called-person-message', '', '');
    }
    return;
  }

  tbody.innerHTML = visibleRows
    .map((row) => {
      return `
        <tr>
          <td>${escapeHtml(row.name || 'Unknown')}</td>
          <td>${escapeHtml(row.ward || 'N/A')}</td>
          <td>${escapeHtml(row.alertType || 'Pending Call')}</td>
          <td>${escapeHtml(row.severity || 'High')}</td>
          <td>${escapeHtml(row.timeLabel || '--')}</td>
        </tr>
      `;
    })
    .join('');

  const calledCount = rows.filter((row) => row.called).length;
  const pendingCount = rows.length - calledCount;

  setMessage(
    'called-person-message',
    `Showing ${visibleRows.length} of ${rows.length} serious patients. Called: ${calledCount}, Pending: ${pendingCount}.`,
    'success'
  );
}

function resolveCalledAlertTarget(alert) {
  const triggeredBy = String(alert?.triggeredBy || '').trim();

  if (triggeredBy) {
    const patient = state.patients.find((item) => String(item?._id || '').trim() === triggeredBy);
    if (patient) {
      return {
        name: String(patient.name || 'Unknown').trim() || 'Unknown',
        ward: String(patient.ward || alert?.ward || 'N/A').trim() || 'N/A',
      };
    }

    const staff = state.staff.find((item) => String(item?._id || '').trim() === triggeredBy);
    if (staff) {
      return {
        name: String(staff.name || 'Unknown').trim() || 'Unknown',
        ward: String(staff.assignedWard || staff.ward || alert?.ward || 'N/A').trim() || 'N/A',
      };
    }
  }

  const message = String(alert?.message || '');
  const patientMatch = message.match(/Patient\s+([^.,]+?)(?:\s+exceeded|\s+in\s+ward|\.|$)/i);
  const fallbackName = patientMatch?.[1] ? String(patientMatch[1]).trim() : 'Unknown';

  return {
    name: fallbackName || 'Unknown',
    ward: String(alert?.ward || 'N/A').trim() || 'N/A',
  };
}

function formatAlertType(type) {
  const raw = String(type || '').trim();
  if (!raw) {
    return 'Unknown';
  }

  return raw
    .toLowerCase()
    .split('_')
    .map((part) => capitalize(part))
    .join(' ');
}

function formatDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '--';
  }
  return date.toLocaleString();
}

function renderHighRiskTable() {
  const tbody = document.getElementById('high-risk-table-body');
  const allRows = Array.isArray(state.highRiskPeople) ? state.highRiskPeople : [];
  const rows = filterHighRiskRows(allRows, state.highRiskFilters);

  if (!allRows.length) {
    tbody.innerHTML = '<tr><td colspan="4">No high-risk records found.</td></tr>';
    setMessage('high-risk-message', '', '');
    return;
  }

  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="4">No records match the current filters.</td></tr>';
    setMessage(
      'high-risk-message',
      `Showing 0 of ${allRows.length} records.`,
      ''
    );
    return;
  }

  tbody.innerHTML = rows
    .map((person) => {
      const riskScore = Number(person.riskScore || 0);
      const riskLevel = normalizeRiskLevel(person.riskLevel || getRiskLevelFromScore(riskScore));
      const riskClass = riskLevelToClass(riskLevel);

      return `
        <tr>
          <td>${escapeHtml(person.name || 'Unknown')}</td>
          <td>${escapeHtml(person.role || person.type || 'Unknown')}</td>
          <td>${riskScore.toFixed(2)}</td>
          <td><span class="risk-pill ${riskClass}">${capitalize(riskLevel)}</span></td>
        </tr>
      `;
    })
    .join('');

  setMessage(
    'high-risk-message',
    `Showing ${rows.length} of ${allRows.length} records.`,
    'success'
  );
}

function filterHighRiskRows(rows, filters) {
  const search = String(filters?.search || '').trim().toLowerCase();
  const typeFilter = String(filters?.type || 'all').toLowerCase();
  const levelFilter = String(filters?.level || 'all').toLowerCase();

  return rows.filter((person) => {
    const personName = String(person.name || '').toLowerCase();
    const personRole = String(person.role || person.type || '').toLowerCase();
    const personType = normalizePersonType(person);
    const riskScore = Number(person.riskScore || 0);
    const riskLevel = normalizeRiskLevelForFilter(
      person.riskLevel || getRiskLevelFromScore(riskScore)
    );

    const matchesSearch =
      !search || personName.includes(search) || personRole.includes(search);
    const matchesType = typeFilter === 'all' || personType === typeFilter;
    const matchesLevel = levelFilter === 'all' || riskLevel === levelFilter;

    return matchesSearch && matchesType && matchesLevel;
  });
}

function normalizePersonType(person) {
  const type = String(person?.type || '').toLowerCase().trim();
  if (type === 'staff') return 'staff';
  if (type === 'patient') return 'patient';

  const role = String(person?.role || '').toLowerCase().trim();
  if (role === 'patient') return 'patient';
  return 'staff';
}

function normalizeRiskLevelForFilter(level) {
  const normalized = normalizeRiskLevel(level).trim();
  if (normalized === 'moderate') return 'medium';
  return normalized;
}

function renderRealTimeAlert() {
  const alertBox = document.getElementById('high-risk-alert');
  if (!alertBox) {
    return;
  }

  const hasCriticalRisk = state.highRiskPeople.some((person) => Number(person.riskScore || 0) > 50);

  alertBox.classList.toggle('hidden', !hasCriticalRisk);
  alertBox.classList.toggle('blinking', hasCriticalRisk);
}

async function renderWardStatsPanel() {
  const wardMessageId = 'ward-message';

  try {
    const response = await apiRequest('/api/risk/ward-stats');
    const wardStats = Array.isArray(response?.wards)
      ? response.wards
      : Array.isArray(response)
        ? response
        : [];

    state.wardStats = wardStats.map((row) => normalizeWardStatsRow(row));
    setMessage(wardMessageId, `Loaded ${state.wardStats.length} wards from backend.`, 'success');
  } catch (error) {
    if (error.status === 404) {
      state.wardStats = computeWardStatsFromPatients(state.patients);
      setMessage(
        wardMessageId,
        'GET /api/risk/ward-stats not available. Showing computed stats from /api/patients.',
        ''
      );
    } else {
      setMessage(wardMessageId, getErrorMessage(error), 'error');
      throw error;
    }
  }

  const interactionRows = await getInteractionRowsForAnalytics();
  const infectionCountByWard = computeWardInfectionCounts(interactionRows, state.patients);
  state.wardStats = mergeWardStatsWithStatus(
    state.wardStats,
    infectionCountByWard,
    state.wardStatusRows,
    state.patients
  );

  const tbody = document.getElementById('ward-table-body');
  if (!state.wardStats.length) {
    tbody.innerHTML = '<tr><td colspan="5">No ward data available.</td></tr>';
    return;
  }

  tbody.innerHTML = state.wardStats
    .map((row) => {
      const statusLabel = row.status || deriveWardStatusFromInfectionRate(row.infectionPercent);
      const riskClass = mapWardStatusToClass(statusLabel);

      return `
        <tr>
          <td>${escapeHtml(row.wardName || row.ward)}</td>
          <td>${row.totalPatients}</td>
          <td>${row.infectedCount}</td>
          <td>${row.infectionPercent.toFixed(2)}%</td>
          <td><span class="risk-pill ${riskClass}">${escapeHtml(statusLabel)}</span></td>
        </tr>
      `;
    })
    .join('');
}

async function renderNetworkGraph() {
  const messageId = 'network-message';
  let interactionSource = '/api/interactions';

  const csvRows = await loadInteractionsCsv();
  if (csvRows.length) {
    state.interactionCsvRows = csvRows;
    state.interactions = [];
    interactionSource = 'interactions.csv';
  } else {
    try {
      const interactions = await apiRequest('/api/interactions');
      state.interactions = Array.isArray(interactions) ? interactions : [];
    } catch (error) {
      setMessage(messageId, getErrorMessage(error), 'error');
      return;
    }
  }

  const container = document.getElementById('network-graph');
  const { nodes, edges } = buildNetworkData();
  const apiPatientStaffEdges = buildPatientStaffEdgesFromInteractions(
    state.interactions,
    state.patients,
    state.staff,
    'api-patient-staff'
  );
  applyNetworkNodeShapes(nodes);
  const csvEdges = buildInteractionCsvEdges(state.interactionCsvRows, state.patients, state.staff);
  const mergedWithLegacyEdges = mergeNetworkEdges(apiPatientStaffEdges, edges);
  const mergedEdges = mergeNetworkEdges(mergedWithLegacyEdges, csvEdges);
  cacheNetworkData(nodes, mergedEdges);

  if (!nodes.length) {
    container.innerHTML = '';
    setMessage(messageId, 'No entities available to render graph.', '');
    return;
  }

  if (state.networkInstance) {
    state.networkInstance.destroy();
  }

  const data = {
    nodes: new vis.DataSet(nodes),
    edges: new vis.DataSet(mergedEdges),
  };

  const options = {
    autoResize: true,
    layout: {
      improvedLayout: true,
      randomSeed: 42,
    },
    physics: {
      enabled: true,
      stabilization: {
        enabled: true,
        iterations: 220,
        fit: true,
      },
      barnesHut: {
        gravitationalConstant: -3200,
        springLength: 155,
        springConstant: 0.02,
        damping: 0.25,
      },
    },
    nodes: {
      borderWidth: 2,
      borderWidthSelected: 3,
      mass: 1.2,
      font: {
        size: 12,
        face: 'Manrope',
        color: '#1e293b',
      },
    },
    edges: {
      width: 1.4,
      color: {
        color: '#8ea4be',
        highlight: '#4f81bd',
      },
      smooth: false,
      selectionWidth: 2.8,
    },
    interaction: {
      hover: true,
      hoverConnectedEdges: false,
      tooltipDelay: 90,
      zoomView: true,
      dragView: true,
    },
  };

  state.networkInstance = new vis.Network(container, data, options);
  state.networkInstance.once('stabilizationIterationsDone', () => {
    if (state.networkInstance) {
      state.networkInstance.setOptions({ physics: { enabled: false } });
    }
  });
  const interactionRecordCount = interactionSource === 'interactions.csv'
    ? state.interactionCsvRows.length
    : state.interactions.length;
  setMessage(
    messageId,
    `Rendered ${nodes.length} nodes and ${mergedEdges.length} edges from ${interactionSource} (${interactionRecordCount} interaction records).`,
    'success'
  );

  const activeSearch = String(document.getElementById('network-search-input')?.value || '').trim();
  if (activeSearch) {
    applyNetworkSearch(activeSearch);
  }
}

function buildNetworkData() {
  const nodes = [];
  const edges = [];
  const identityMap = new Map();

  state.patients.forEach((patient) => {
    const id = `patient:${patient._id}`;
    const infected = isPatientInfected(patient);

    nodes.push({
      id,
      label: `${patient.name || 'Patient'}\n${patient.ward || 'Ward N/A'}`,
      shape: 'dot',
      size: 20,
      color: infected
        ? { background: '#e45866', border: '#b72f41' }
        : { background: '#2f7ed8', border: '#1d5fa7' },
      title: `Patient: ${patient.name || ''}\nWard: ${patient.ward || ''}\nInfected: ${infected ? 'Yes' : 'No'}`,
    });

    identityMap.set(String(patient._id), id);
    if (patient.patientId) {
      identityMap.set(String(patient.patientId), id);
    }
  });

  state.staff.forEach((staff) => {
    const id = `staff:${staff._id}`;
    const score = Number(staff.riskScore || 0);
    const highRisk = score > 50;

    nodes.push({
      id,
      label: `${staff.name || 'Staff'}\n${staff.role || 'Role N/A'}`,
      shape: 'box',
      size: 18,
      color: highRisk
        ? { background: '#f0ad4e', border: '#bd7d25' }
        : { background: '#20a46e', border: '#167751' },
      title: `Staff: ${staff.name || ''}\nRole: ${staff.role || ''}\nRisk Score: ${score.toFixed(2)}`,
    });

    identityMap.set(String(staff._id), id);
    if (staff.staffId) {
      identityMap.set(String(staff.staffId), id);
    }
  });

  state.interactions.forEach((interaction, index) => {
    const from = identityMap.get(String(interaction.person1));
    const to = identityMap.get(String(interaction.person2));

    if (!from || !to || from === to) {
      return;
    }

    const duration = Number(interaction.duration || 0);
    edges.push({
      id: `edge:${index}`,
      from,
      to,
      width: Math.min(1 + duration / 8, 7),
      label: `${duration}m`,
      title: `Ward: ${interaction.ward || 'N/A'}\nDuration: ${duration}m`,
    });
  });

  return { nodes, edges };
}

async function loadInteractionsCsv() {
  const rows = await loadCsvFile('interactions.csv');
  return rows.map((row) => ({
    patientId: getCsvValue(row, ['patientId', 'patient_id']),
    staffId: getCsvValue(row, ['staffId', 'staff_id']),
    person1: getCsvValue(row, ['person1']),
    person2: getCsvValue(row, ['person2']),
    duration: Number(getCsvValue(row, ['duration', 'durationMinutes', 'duration_minutes']) || 0),
    ward: getCsvValue(row, ['ward']),
  }));
}

async function loadWardStatusCsv() {
  const rows = await loadCsvFile('ward_status.csv');
  return rows.map((row) => ({
    wardId: getCsvValue(row, ['wardId', 'ward_id']),
    wardName: getCsvValue(row, ['wardName', 'ward_name']),
    totalBeds: Number(getCsvValue(row, ['totalBeds', 'total_beds']) || 0),
    occupiedBeds: Number(getCsvValue(row, ['occupiedBeds', 'occupied_beds']) || 0),
    criticalPatients: Number(getCsvValue(row, ['criticalPatients', 'critical_patients']) || 0),
    staffCount: Number(getCsvValue(row, ['staffCount', 'staff_count']) || 0),
    ventilatorCount: Number(getCsvValue(row, ['ventilatorCount', 'ventilator_count']) || 0),
    status: getCsvValue(row, ['status']),
  }));
}

async function getInteractionRowsForAnalytics() {
  if (state.interactionCsvRows.length) {
    return state.interactionCsvRows;
  }

  const csvRows = await loadInteractionsCsv();
  if (csvRows.length) {
    state.interactionCsvRows = csvRows;
    return csvRows;
  }

  if (state.interactions.length) {
    return state.interactions;
  }

  try {
    const interactions = await apiRequest('/api/interactions');
    state.interactions = Array.isArray(interactions) ? interactions : [];
  } catch {
    state.interactions = [];
  }

  return state.interactions;
}

async function loadCsvFile(fileName) {
  try {
    const response = await fetch(fileName, { cache: 'no-store' });
    if (!response.ok) {
      return [];
    }

    const csvText = await response.text();
    return parseCsv(csvText);
  } catch {
    return [];
  }
}

function parseCsv(csvText) {
  const lines = String(csvText || '')
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);

  if (lines.length < 2) {
    return [];
  }

  const headers = parseCsvLine(lines[0]).map((header) => normalizeCsvHeader(header));
  const rows = [];

  for (let index = 1; index < lines.length; index += 1) {
    const columns = parseCsvLine(lines[index]);
    const row = {};

    headers.forEach((header, headerIndex) => {
      row[header] = String(columns[headerIndex] || '').trim();
    });

    rows.push(row);
  }

  return rows;
}

function parseCsvLine(line) {
  const values = [];
  let current = '';
  let insideQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    const nextCharacter = line[index + 1];

    if (character === '"' && insideQuotes && nextCharacter === '"') {
      current += '"';
      index += 1;
      continue;
    }

    if (character === '"') {
      insideQuotes = !insideQuotes;
      continue;
    }

    if (character === ',' && !insideQuotes) {
      values.push(current);
      current = '';
      continue;
    }

    current += character;
  }

  values.push(current);
  return values;
}

function normalizeCsvHeader(header) {
  return String(header || '').replace(/^\uFEFF/, '').trim();
}

function getCsvValue(row, keys) {
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null && String(row[key]).trim() !== '') {
      return String(row[key]).trim();
    }
  }
  return '';
}

function buildInteractionCsvEdges(interactionRows, patients, staffMembers) {
  if (!interactionRows.length) {
    return [];
  }

  const patientLookup = new Map();
  const staffLookup = new Map();

  patients.forEach((patient) => {
    const nodeId = `patient:${patient._id}`;
    patientLookup.set(String(patient._id), nodeId);
    if (patient.patientId) {
      patientLookup.set(String(patient.patientId), nodeId);
    }
  });

  staffMembers.forEach((staff) => {
    const nodeId = `staff:${staff._id}`;
    staffLookup.set(String(staff._id), nodeId);
    if (staff.staffId) {
      staffLookup.set(String(staff.staffId), nodeId);
    }
  });

  const dedupe = new Set();
  const csvEdges = [];

  interactionRows.forEach((interaction, index) => {
    const patientId = getCsvValue(interaction, ['patientId', 'person1']);
    const staffId = getCsvValue(interaction, ['staffId', 'person2']);
    const from = patientLookup.get(patientId);
    const to = staffLookup.get(staffId);

    if (!from || !to || from === to) {
      return;
    }

    const edgeKey = `${from}->${to}`;
    if (dedupe.has(edgeKey)) {
      return;
    }
    dedupe.add(edgeKey);

    const duration = Number(getCsvValue(interaction, ['duration']) || 0);
    csvEdges.push({
      id: `csv-edge:${index}:${edgeKey}`,
      from,
      to,
      width: Math.min(1 + duration / 8, 7),
      label: duration > 0 ? `${duration}m` : '',
      title: `Ward: ${getCsvValue(interaction, ['ward']) || 'N/A'}\nDuration: ${duration}m`,
    });
  });

  return csvEdges;
}

function buildPatientStaffEdgesFromInteractions(interactions, patients, staffMembers, edgePrefix) {
  if (!Array.isArray(interactions) || !interactions.length) {
    return [];
  }

  const patientLookup = new Map();
  const staffLookup = new Map();

  patients.forEach((patient) => {
    const nodeId = `patient:${patient._id}`;
    patientLookup.set(String(patient._id), nodeId);
    if (patient.patientId) {
      patientLookup.set(String(patient.patientId), nodeId);
    }
  });

  staffMembers.forEach((staff) => {
    const nodeId = `staff:${staff._id}`;
    staffLookup.set(String(staff._id), nodeId);
    if (staff.staffId) {
      staffLookup.set(String(staff.staffId), nodeId);
    }
  });

  const aggregatedEdges = new Map();

  interactions.forEach((interaction) => {
    const candidates = [
      {
        patientId: getCsvValue(interaction, ['patientId', 'person1']),
        staffId: getCsvValue(interaction, ['staffId', 'person2']),
      },
      {
        patientId: getCsvValue(interaction, ['person2']),
        staffId: getCsvValue(interaction, ['person1']),
      },
    ];

    const match = candidates.find((candidate) => {
      const fromNode = patientLookup.get(String(candidate.patientId));
      const toNode = staffLookup.get(String(candidate.staffId));
      return Boolean(fromNode && toNode && fromNode !== toNode);
    });

    if (!match) {
      return;
    }

    const from = patientLookup.get(String(match.patientId));
    const to = staffLookup.get(String(match.staffId));
    const pairKey = `${from}->${to}`;
    const duration = Number(
      getCsvValue(interaction, ['duration', 'durationMinutes', 'duration_minutes']) || 0
    );
    const ward = getCsvValue(interaction, ['ward']);

    const current = aggregatedEdges.get(pairKey) || {
      from,
      to,
      totalDuration: 0,
      interactionCount: 0,
      ward,
    };

    current.totalDuration += duration;
    current.interactionCount += 1;
    if (!current.ward && ward) {
      current.ward = ward;
    }

    aggregatedEdges.set(pairKey, current);
  });

  return Array.from(aggregatedEdges.values()).map((edge, index) => {
    const avgDuration = edge.interactionCount
      ? edge.totalDuration / edge.interactionCount
      : edge.totalDuration;

    return {
      id: `${edgePrefix}:${index}:${edge.from}->${edge.to}`,
      from: edge.from,
      to: edge.to,
      width: Math.min(1 + avgDuration / 8, 7),
      label: edge.interactionCount > 1 ? `${edge.interactionCount}x` : `${Math.round(edge.totalDuration)}m`,
      title: `Ward: ${edge.ward || 'N/A'}\nContacts: ${edge.interactionCount}\nTotal Duration: ${Math.round(edge.totalDuration)}m`,
    };
  });
}

function mergeNetworkEdges(baseEdges, extraEdges) {
  const merged = baseEdges.map((edge) => ({ ...edge }));
  const dedupe = new Set();

  merged.forEach((edge) => {
    dedupe.add(`${edge.from}->${edge.to}`);
  });

  extraEdges.forEach((edge) => {
    const key = `${edge.from}->${edge.to}`;
    if (dedupe.has(key)) {
      return;
    }

    dedupe.add(key);
    merged.push({ ...edge });
  });

  return merged;
}

function applyNetworkNodeShapes(nodes) {
  nodes.forEach((node) => {
    if (String(node.id).startsWith('patient:')) {
      node.shape = 'circle';
      return;
    }

    if (String(node.id).startsWith('staff:')) {
      node.shape = 'square';
    } else {
      node.shape = node.shape || 'dot';
    }
  });
}

function cacheNetworkData(nodes, edges) {
  state.networkCache.nodes = nodes.map((node) => ({ ...node }));
  state.networkCache.edges = edges.map((edge) => ({ ...edge }));
  state.networkCache.adjacency = buildAdjacencyLookup(state.networkCache.edges);
}

function buildAdjacencyLookup(edges) {
  const adjacency = new Map();

  edges.forEach((edge) => {
    const from = String(edge.from);
    const to = String(edge.to);

    if (!adjacency.has(from)) {
      adjacency.set(from, new Set());
    }
    if (!adjacency.has(to)) {
      adjacency.set(to, new Set());
    }

    adjacency.get(from).add(to);
    adjacency.get(to).add(from);
  });

  return adjacency;
}

function applyNetworkSearch(rawQuery) {
  const query = String(rawQuery || '').trim().toLowerCase();
  if (!state.networkInstance || !state.networkCache.nodes.length) {
    return;
  }

  if (!query) {
    resetNetworkSearch();
    return;
  }

  const targetNode = state.networkCache.nodes.find((node) => {
    const nodeName = getNodeNameForSearch(node).toLowerCase();
    return nodeName.includes(query);
  });

  if (!targetNode) {
    resetNetworkSearch();
    setMessage('network-message', `No node found for "${rawQuery}".`, 'error');
    return;
  }

  const connected = state.networkCache.adjacency.get(String(targetNode.id)) || new Set();
  const visibleNodeIds = new Set([String(targetNode.id), ...connected]);

  const visibleNodes = state.networkCache.nodes.filter((node) => visibleNodeIds.has(String(node.id)));
  const visibleEdges = state.networkCache.edges.filter(
    (edge) => visibleNodeIds.has(String(edge.from)) && visibleNodeIds.has(String(edge.to))
  );

  state.networkInstance.setData({
    nodes: new vis.DataSet(visibleNodes),
    edges: new vis.DataSet(visibleEdges),
  });

  focusNetworkNode(String(targetNode.id), Array.from(visibleNodeIds));
  setMessage(
    'network-message',
    `Focused on ${getNodeNameForSearch(targetNode)} with ${visibleNodes.length} connected nodes.`,
    'success'
  );
}

function resetNetworkSearch() {
  if (!state.networkInstance || !state.networkCache.nodes.length) {
    return;
  }

  state.networkInstance.setData({
    nodes: new vis.DataSet(state.networkCache.nodes),
    edges: new vis.DataSet(state.networkCache.edges),
  });
}

function focusNetworkNode(nodeId, scopedNodeIds = []) {
  if (!state.networkInstance) {
    return;
  }

  const nodeSet = scopedNodeIds.length ? scopedNodeIds : [nodeId];
  state.networkInstance.fit({
    nodes: nodeSet,
    animation: {
      duration: 340,
      easingFunction: 'easeInOutQuad',
    },
  });

  state.networkInstance.focus(nodeId, {
    scale: 1.35,
    animation: {
      duration: 340,
      easingFunction: 'easeInOutQuad',
    },
  });
}

function getNodeNameForSearch(node) {
  const label = String(node?.label || '');
  const [primaryLabel] = label.split('\n');
  return primaryLabel || String(node?.id || '');
}

function computeWardInfectionCounts(interactionRows, patients) {
  const patientLookup = new Map();

  patients.forEach((patient) => {
    patientLookup.set(String(patient._id), patient);
    if (patient.patientId) {
      patientLookup.set(String(patient.patientId), patient);
    }
  });

  const countsByWard = new Map();

  interactionRows.forEach((interaction) => {
    const patientIdCandidates = [
      getCsvValue(interaction, ['patientId']),
      getCsvValue(interaction, ['person1']),
      getCsvValue(interaction, ['person2']),
    ];

    const matchedPatient = patientIdCandidates
      .map((candidate) => patientLookup.get(String(candidate)))
      .find(Boolean);

    if (!matchedPatient) {
      return;
    }

    const wardName = String(matchedPatient.ward || 'Unassigned').trim() || 'Unassigned';
    countsByWard.set(wardName, Number(countsByWard.get(wardName) || 0) + 1);
  });

  return countsByWard;
}

function mergeWardStatsWithStatus(baseWardStats, infectionCountByWard, wardStatusRows, patients) {
  const patientTotalsByWard = new Map();
  patients.forEach((patient) => {
    const wardName = String(patient.ward || 'Unassigned').trim() || 'Unassigned';
    const wardKey = normalizeWardKey(wardName);
    patientTotalsByWard.set(wardKey, Number(patientTotalsByWard.get(wardKey) || 0) + 1);
  });

  const baseByWardKey = new Map();
  baseWardStats.forEach((row) => {
    baseByWardKey.set(normalizeWardKey(row.ward), row);
  });

  const statusByWardKey = new Map();
  wardStatusRows.forEach((statusRow) => {
    const wardKey = normalizeWardKey(statusRow.wardName || statusRow.wardId);
    if (!wardKey) {
      return;
    }
      statusByWardKey.set(wardKey, statusRow);
    });

  const infectionByWardKey = new Map();
  const infectionWardNameByKey = new Map();
  infectionCountByWard.forEach((count, wardName) => {
    const wardKey = normalizeWardKey(wardName);
    infectionByWardKey.set(wardKey, Number(infectionByWardKey.get(wardKey) || 0) + Number(count || 0));
    if (!infectionWardNameByKey.has(wardKey)) {
      infectionWardNameByKey.set(wardKey, String(wardName || '').trim());
    }
  });

  const wards = new Set([
    ...Array.from(baseByWardKey.keys()),
    ...Array.from(statusByWardKey.keys()),
    ...Array.from(infectionByWardKey.keys()),
  ]);

  return Array.from(wards)
    .map((wardKey) => {
      const base = baseByWardKey.get(wardKey);
      const statusRow = statusByWardKey.get(wardKey);
      const wardName =
        statusRow?.wardName || base?.wardName || base?.ward || infectionWardNameByKey.get(wardKey) || 'Unassigned';
      const interactionInfections = Number(infectionByWardKey.get(wardKey) || 0);
      const totalPatients = Number(
        base?.totalPatients ?? patientTotalsByWard.get(wardKey) ?? 0
      );
      const infectedCount =
        infectionByWardKey.size > 0 ? interactionInfections : Number(base?.infectedCount || 0);
      const infectionPercent = totalPatients ? (infectedCount / totalPatients) * 100 : 0;
      const status = statusRow?.status || deriveWardStatusFromInfectionRate(infectionPercent);

      return {
        ward: base?.ward || wardName,
        wardName,
        totalPatients,
        infectedCount,
        infectionPercent,
        status,
      };
    })
    .sort((a, b) => b.infectionPercent - a.infectionPercent);
}

function deriveWardStatusFromInfectionRate(infectionPercent) {
  const value = Number(infectionPercent || 0);
  if (value > 35) return 'Critical';
  if (value > 20) return 'High Risk';
  if (value > 10) return 'Moderate';
  return 'Stable';
}

function mapWardStatusToClass(status) {
  const normalized = String(status || '').toLowerCase().trim();
  if (normalized === 'critical') return 'ward-status-critical';
  if (normalized === 'high risk' || normalized === 'high-risk') return 'ward-status-high-risk';
  if (normalized === 'moderate') return 'ward-status-moderate';
  if (normalized === 'stable') return 'ward-status-stable';
  return 'ward-status-stable';
}

function normalizeWardKey(value) {
  return String(value || '').trim().toLowerCase();
}

async function startScanner() {
  if (state.scanner.running) {
    return;
  }

  if (typeof Html5Qrcode === 'undefined') {
    setMessage('visit-message', 'html5-qrcode script failed to load.', 'error');
    return;
  }

  try {
    state.scanner.instance = new Html5Qrcode('qr-reader');
    await state.scanner.instance.start(
      { facingMode: 'environment' },
      { fps: 10, qrbox: { width: 240, height: 240 } },
      (decodedText) => {
        handleQrSuccess(decodedText).catch((error) => {
          setMessage('visit-message', getErrorMessage(error), 'error');
        });
      },
      () => {}
    );

    state.scanner.running = true;
    setMessage('visit-message', 'Scanner started. Scan STAFF and WARD QR codes.', 'success');
    renderScanState();
  } catch (error) {
    setMessage('visit-message', getErrorMessage(error), 'error');
  }
}

async function stopScanner() {
  if (!state.scanner.instance || !state.scanner.running) {
    return;
  }

  try {
    await state.scanner.instance.stop();
    await state.scanner.instance.clear();
  } catch (error) {
    setMessage('visit-message', getErrorMessage(error), 'error');
  } finally {
    state.scanner.running = false;
    state.scanner.instance = null;
    renderScanState();
  }
}

async function handleQrSuccess(rawText) {
  const scanText = String(rawText || '').trim();
  const now = Date.now();

  if (
    scanText &&
    scanText === state.scanner.lastScanText &&
    now - state.scanner.lastScanAt < 2000
  ) {
    return;
  }

  state.scanner.lastScanText = scanText;
  state.scanner.lastScanAt = now;

  const qrFields = extractQrFields(scanText);
  const staffValue =
    qrFields.get('STAFF') || qrFields.get('STAFFID') || qrFields.get('STAFF_ID') || '';
  const wardValue = qrFields.get('WARD') || '';
  const parsedStaff = String(staffValue || '').trim();
  const parsedWard = String(wardValue || '').trim();

  if (!parsedStaff && !parsedWard) {
    if (!scanText.includes(':')) {
      setMessage('visit-message', `Invalid QR format: ${scanText}`, 'error');
      return;
    }

    const [prefixRaw] = scanText.split(':');
    const prefix = String(prefixRaw || '').toUpperCase().trim();
    setMessage('visit-message', `Unsupported QR prefix: ${prefix || scanText}`, 'error');
    return;
  }

  let staffResolved = false;
  let wardResolved = false;

  if (parsedStaff) {
    state.scanner.staffRawId = parsedStaff;
    const resolvedId = await resolveStaffId(parsedStaff);

    if (!resolvedId) {
      setMessage(
        'visit-message',
        `Staff identifier "${parsedStaff}" not found. Verify QR content.`,
        'error'
      );
      renderScanState();
      return;
    }

    state.scanner.resolvedStaffId = resolvedId;
    staffResolved = true;
  }

  if (parsedWard) {
    state.scanner.ward = parsedWard;
    wardResolved = true;
  }

  if (staffResolved && wardResolved) {
    setMessage('visit-message', `Staff and ward scanned: ${parsedStaff} / ${parsedWard}`, 'success');
  } else if (staffResolved) {
    setMessage('visit-message', `Staff scanned: ${parsedStaff}`, 'success');
  } else if (wardResolved) {
    setMessage('visit-message', `Ward scanned: ${parsedWard}`, 'success');
  }

  renderScanState();
  await autoCreateVisitEntryIfReady();
}

function extractQrFields(scanText) {
  const fields = new Map();
  const text = String(scanText || '').trim();
  if (!text) {
    return fields;
  }

  const keyValuePattern = /([A-Za-z_]+)\s*:\s*([^]+?)(?=\s+[A-Za-z_]+\s*:|$)/g;
  let match = keyValuePattern.exec(text);

  while (match) {
    const key = String(match[1] || '').trim().toUpperCase();
    const value = String(match[2] || '').trim();
    if (key && value) {
      fields.set(key, value);
    }
    match = keyValuePattern.exec(text);
  }

  return fields;
}

async function autoCreateVisitEntryIfReady() {
  const hasRequiredScanData = Boolean(state.scanner.resolvedStaffId && state.scanner.ward);
  if (!hasRequiredScanData || state.scanner.entryInFlight || state.scanner.activeVisit) {
    return;
  }

  state.scanner.entryInFlight = true;

  try {
    const createdVisit = await apiRequest('/api/visit/entry', {
      method: 'POST',
      body: {
        staffId: state.scanner.resolvedStaffId,
        ward: state.scanner.ward,
      },
    });

    state.scanner.activeVisit = {
      visitLogId: createdVisit._id,
      staffId: createdVisit.staffId,
      ward: createdVisit.ward,
      entryTime: createdVisit.entryTime,
    };

    persistActiveVisit();
    setMessage('visit-message', `Visit started in ward ${createdVisit.ward}.`, 'success');
  } catch (error) {
    setMessage('visit-message', getErrorMessage(error), 'error');
  } finally {
    state.scanner.entryInFlight = false;
    renderScanState();
  }
}

async function exitCurrentVisit() {
  const activeVisit = state.scanner.activeVisit;
  if (!activeVisit?.visitLogId) {
    setMessage('visit-message', 'No active visit to exit.', 'error');
    return;
  }

  try {
    const result = await apiRequest('/api/visit/exit', {
      method: 'POST',
      body: { visitLogId: activeVisit.visitLogId },
    });

    state.scanner.activeVisit = null;
    clearPersistedVisit();
    clearCurrentScan();
    setMessage(
      'visit-message',
      `Visit exited successfully. Duration: ${Number(result.durationMinutes || 0).toFixed(2)} min.`,
      'success'
    );

    await refreshRiskOnly();
  } catch (error) {
    setMessage('visit-message', getErrorMessage(error), 'error');
  } finally {
    renderScanState();
  }
}

function clearCurrentScan() {
  state.scanner.staffRawId = '';
  state.scanner.resolvedStaffId = '';
  state.scanner.ward = '';
  renderScanState();
}

function renderScanState() {
  document.getElementById('scan-staff').textContent = state.scanner.staffRawId || '--';
  document.getElementById('scan-ward').textContent = state.scanner.ward || '--';

  const activeVisitText = state.scanner.activeVisit
    ? `${state.scanner.activeVisit.ward} (${state.scanner.activeVisit.visitLogId})`
    : 'None';
  document.getElementById('active-visit').textContent = activeVisitText;

  document.getElementById('start-scan-btn').disabled = state.scanner.running;
  document.getElementById('stop-scan-btn').disabled = !state.scanner.running;
  document.getElementById('exit-visit-btn').disabled = !state.scanner.activeVisit;
}

function restoreActiveVisitFromStorage() {
  try {
    const raw = localStorage.getItem('pathotrace_active_visit');
    if (!raw) {
      return;
    }

    const parsed = JSON.parse(raw);
    if (parsed && parsed.visitLogId) {
      state.scanner.activeVisit = parsed;
    }
  } catch (error) {
    clearPersistedVisit();
  }

  renderScanState();
}

function persistActiveVisit() {
  localStorage.setItem('pathotrace_active_visit', JSON.stringify(state.scanner.activeVisit));
}

function clearPersistedVisit() {
  localStorage.removeItem('pathotrace_active_visit');
}

async function resolveStaffId(staffIdentifier) {
  const candidate = String(staffIdentifier || '').trim();
  if (!candidate) {
    return null;
  }

  if (isObjectId(candidate)) {
    return candidate;
  }

  if (!state.staff.length) {
    const staff = await apiRequest('/api/staff');
    state.staff = Array.isArray(staff) ? staff : [];
  }

  const match = state.staff.find(
    (person) =>
      String(person._id) === candidate ||
      String(person.staffId || '').trim() === candidate
  );
  return match ? String(match._id) : null;
}

function isPatientInfected(patient) {
  const infectionStatus = String(patient?.infectionStatus || '').toLowerCase().trim();
  if (infectionStatus === 'yes') {
    return true;
  }

  const pathogen = String(patient?.pathogen || '').toLowerCase().trim();
  if (!pathogen) {
    return false;
  }

  return !['none', 'na', 'n/a', 'negative', 'nil'].includes(pathogen);
}

function normalizeRiskLevel(level) {
  return String(level || '').toLowerCase();
}

function getRiskLevelFromScore(score) {
  const numericScore = Number(score || 0);
  if (numericScore < 20) return 'low';
  if (numericScore <= 50) return 'medium';
  return 'high';
}

function riskLevelToClass(level) {
  if (level === 'high') return 'risk-high';
  if (level === 'medium' || level === 'moderate') return 'risk-medium';
  return 'risk-low';
}

function computeWardStatsFromPatients(patients) {
  const byWard = new Map();

  patients.forEach((patient) => {
    const ward = String(patient.ward || 'Unassigned').trim() || 'Unassigned';
    const current = byWard.get(ward) || { ward, totalPatients: 0, infectedCount: 0 };
    current.totalPatients += 1;
    if (isPatientInfected(patient)) {
      current.infectedCount += 1;
    }
    byWard.set(ward, current);
  });

  return Array.from(byWard.values())
    .map((row) => ({
      ...row,
      infectionPercent: row.totalPatients
        ? (row.infectedCount / row.totalPatients) * 100
        : 0,
    }))
    .sort((a, b) => b.infectionPercent - a.infectionPercent);
}

function normalizeWardStatsRow(row) {
  const totalPatients = Number(row.totalPatients ?? row.total ?? 0);
  const infectedCount = Number(row.infectedCount ?? row.infected ?? 0);
  const infectionPercent =
    row.infectionPercent !== undefined
      ? Number(row.infectionPercent)
      : totalPatients
        ? (infectedCount / totalPatients) * 100
        : 0;

  return {
    ward: String(row.ward || row.wardName || 'Unassigned'),
    wardName: String(row.wardName || row.ward || 'Unassigned'),
    totalPatients,
    infectedCount,
    infectionPercent: Number(infectionPercent),
    status: String(row.status || '').trim(),
  };
}

async function apiRequest(path, options = {}) {
  const fetchOptions = {
    method: options.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  };

  if (options.body !== undefined) {
    fetchOptions.body = JSON.stringify(options.body);
  }

  const response = await fetch(`${API_BASE_URL}${path}`, fetchOptions);
  const text = await response.text();
  let responseBody = null;

  if (text) {
    try {
      responseBody = JSON.parse(text);
    } catch {
      responseBody = text;
    }
  }

  if (!response.ok) {
    const error = new Error(
      responseBody?.message || `Request failed (${response.status}) for ${path}`
    );
    error.status = response.status;
    error.body = responseBody;
    throw error;
  }

  return responseBody;
}

function setMessage(elementId, message, type) {
  const el = document.getElementById(elementId);
  if (!el) {
    return;
  }
  el.textContent = message || '';
  el.className = `inline-message ${type || ''}`.trim();
}

function updateLastUpdatedTimestamp() {
  const timestamp = new Date().toLocaleString();
  document.getElementById('last-updated').textContent = `Last updated: ${timestamp}`;
}

function getErrorMessage(error) {
  if (!error) {
    return 'Unknown error';
  }
  return error.message || String(error);
}

function isObjectId(value) {
  return /^[a-fA-F0-9]{24}$/.test(String(value || '').trim());
}

function capitalize(value) {
  if (!value) {
    return '';
  }
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function escapeHtml(value) {
  const text = String(value ?? '');
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
