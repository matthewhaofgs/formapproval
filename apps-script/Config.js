/**
 * Configuration map.
 *
 * Edit this file for app/deployment settings only:
 * - app name and organisation name
 * - production/test WEB_APP_URL
 * - timezone
 * - trigger schedule
 * - authentication behaviour
 *
 * Live form, process, workflow, admin, and email-routing definitions live in
 * PostgreSQL app_definitions for the native deployment.
 */

const APP_SETTINGS = {
  APP_NAME: 'OFG Forms',
  ORGANISATION_NAME: 'OFG',
  APP_VERSION: '2026-06-19 database routing',
  TIME_ZONE: 'Australia/Sydney',
  DATABASE_NAME: 'OFG Workflow Approval Requests',
  SPREADSHEET_ID: '',
  WEB_APP_URL: '',
  MAIL_FROM_NAME: 'OFG Workflow Approvals',
  FOLLOW_UP_CHECK_HOUR: 7,
  WEEKLY_REMINDER_DAY: 'MONDAY',
  WEEKLY_REMINDER_CHECK_HOUR: 8,
  REQUIRE_GOOGLE_AUTH: true,
  ALLOW_EMAIL_FALLBACK_FOR_TESTING: false,
  DEFAULT_PROCESS_KEY: 'overtime'
};

// Deployment-specific admin lists belong in PostgreSQL app_definitions or Apps Script Config rows.
const DEFAULT_ADMIN_EMAILS = [];

const SHEETS = {
  LEGACY_REQUESTS: 'Requests',
  EVENTS: 'Events',
  CONFIG: 'Config'
};

const STATUS = {
  PENDING_APPROVAL: 'PENDING_APPROVAL',
  NEEDS_APPROVAL_CHANGES: 'NEEDS_APPROVAL_CHANGES',
  PREAPPROVED: 'PREAPPROVED',
  AWAITING_ACTUAL_HOURS: 'AWAITING_ACTUAL_HOURS',
  AWAITING_VTR_CHECKLIST: 'AWAITING_VTR_CHECKLIST',
  NEEDS_ACTUAL_HOURS_CHANGES: 'NEEDS_ACTUAL_HOURS_CHANGES',
  PENDING_FINAL_APPROVAL: 'PENDING_FINAL_APPROVAL',
  FINAL_APPROVED: 'FINAL_APPROVED',
  APPROVED: 'APPROVED',
  APPROVAL_DENIED: 'APPROVAL_DENIED',
  FINAL_DENIED: 'FINAL_DENIED',
  CANCELLED: 'CANCELLED'
};

const REQUEST_HEADERS = [
  'requestId',
  'createdAt',
  'updatedAt',
  'status',
  'employeeActionTokenHash',
  'activeApprovalTokenHash',
  'activeApprovalStage',
  'activeApprovalStepIndex',
  'activeApprovalStepName',
  'activeApprovalStepEmail',
  'approvalCompletedAt',
  'denialReason',
  'changeRequestedAt',
  'changeRequestedByEmail',
  'changeRequestedByName',
  'changeStage',
  'changeComment',
  'lastEditedAt',
  'lastEditedByEmail',
  'approvalHistory',
  'approvalWorkflowSteps',
  'finalWorkflowSteps',
  'checklistWorkflowSteps',
  'checklistNotificationHistory',
  'changeHistory',
  'processType'
];

const EVENT_HEADERS = [
  'timestamp',
  'requestId',
  'actorEmail',
  'event',
  'detailsJson'
];

const CONFIG_HEADERS = [
  'processKey',
  'processName',
  'section',
  'stage',
  'stepOrder',
  'type',
  'name',
  'email',
  'emails',
  'emailField',
  'emailFields',
  'subject',
  'message',
  'waitingLabel',
  'whenJson',
  'unlessJson',
  'followUpStage',
  'setting',
  'valueJson',
  'enabled',
  'notes'
];

function getDefaultProcessKey_() {
  return normalizeProcessKey_(APP_SETTINGS.DEFAULT_PROCESS_KEY || 'overtime');
}

function normalizeProcessKey_(value) {
  return trim_(value || 'overtime').toLowerCase();
}

function processKeyForRequest_(request) {
  return normalizeProcessKey_((request && request.processType) || getDefaultProcessKey_());
}

function cloneObject_(value) {
  return JSON.parse(JSON.stringify(value || {}));
}

function cloneArray_(value) {
  return JSON.parse(JSON.stringify(value || []));
}

function getProcessDefinitions_() {
  const definitions = getDefaultProcessDefinitions_();
  const sheetDefinitions = readProcessDefinitionsFromConfigSheet_();

  Object.keys(sheetDefinitions).forEach(function (processKey) {
    const current = definitions[processKey] || {};
    const currentWorkflows = current.workflows || {};
    definitions[processKey] = Object.assign(current, sheetDefinitions[processKey]);
    definitions[processKey].workflows = Object.assign(
      {},
      currentWorkflows,
      sheetDefinitions[processKey].workflows || {}
    );
  });

  return definitions;
}

function getProcessDefinition_(processOrRequest) {
  const processKey = typeof processOrRequest === 'string'
    ? normalizeProcessKey_(processOrRequest)
    : processKeyForRequest_(processOrRequest || {});
  const definitions = getProcessDefinitions_();
  const defaultKey = getDefaultProcessKey_();
  return definitions[processKey] || definitions[defaultKey] || definitions.overtime;
}

function getProcessOptions_() {
  const definitions = getProcessDefinitions_();
  return Object.keys(definitions)
    .map(function (processKey) {
      const process = definitions[processKey];
      return {
        key: process.key || processKey,
        name: process.name || processKey,
        description: process.description || '',
        requestForm: process.requestForm || '',
        requestSheetName: getProcessRequestSheetName_(process),
        enabled: process.enabled !== false
      };
    })
    .sort(function (a, b) {
      return String(a.name).localeCompare(String(b.name));
    });
}

function getProcessOption_(processKey) {
  const requested = normalizeProcessKey_(processKey || getDefaultProcessKey_());
  return getProcessOptions_().find(function (process) {
    return normalizeProcessKey_(process.key) === requested;
  }) || null;
}

function getEnabledRequestFormOptions_() {
  return getProcessOptions_().filter(function (process) {
    return process.enabled && process.requestForm;
  });
}

function getRequestFormProcess_(processKey) {
  const requested = normalizeProcessKey_(processKey || getDefaultProcessKey_());
  const process = getProcessDefinition_(requested);
  if (!process || normalizeProcessKey_(process.key) !== requested) {
    return null;
  }
  if (process.enabled === false || !process.requestForm) {
    return null;
  }
  return process;
}

function getWorkflowConfigForStage_(stage, request) {
  const process = getProcessDefinition_(request);
  return cloneArray_((process.workflows && process.workflows[stage]) || []);
}

function getProcessCompletionMode_(request) {
  const process = getProcessDefinition_(request);
  return trim_(process.completionMode || 'actual_hours');
}

function getPaymentNotificationEmails_(request) {
  const process = getProcessDefinition_(request);
  return cloneArray_(process.paymentNotificationEmails || []);
}

function getProcessAdminEmails_(processOrRequest) {
  const process = getProcessDefinition_(processOrRequest);
  return cloneArray_(process.adminEmails || []);
}

function getAdminProcessOptionsFor_(email) {
  const normalized = normalizeEmail_(email);
  const globalAdmin = configuredEmailsContain_(getConfiguredAdminEmails_(), normalized);
  return getProcessOptions_()
    .filter(function (process) {
      if (!process.enabled) {
        return false;
      }
      return globalAdmin || configuredEmailsContain_(getProcessAdminEmails_(process.key), normalized);
    })
    .map(function (process) {
      return {
        key: process.key,
        name: process.name,
        description: process.description,
        requestForm: process.requestForm,
        requestSheetName: process.requestSheetName,
        enabled: process.enabled
      };
    });
}

function configuredEmailsContain_(emails, email) {
  const normalized = normalizeEmail_(email);
  if (!normalized) {
    return false;
  }
  return (emails || [])
    .map(normalizeEmail_)
    .filter(Boolean)
    .indexOf(normalized) !== -1;
}

function getProcessRequestSheetName_(processOrRequest) {
  const process = processOrRequest && processOrRequest.key
    ? processOrRequest
    : getProcessDefinition_(processOrRequest);
  const defaultName = `${process.name || process.key || getDefaultProcessKey_()} Requests`;
  return sanitizeSheetName_(process.requestSheetName || defaultName);
}

function sanitizeSheetName_(value) {
  const sanitized = trim_(value)
    .replace(/[\[\]\*\/\\\?:]/g, '-')
    .slice(0, 99);
  return sanitized || 'Requests';
}

function getConfiguredAdminEmails_() {
  const configured = getGlobalConfigValue_('ADMIN_EMAILS');
  return uniqueEmailList_(DEFAULT_ADMIN_EMAILS.concat(Array.isArray(configured) ? configured : []));
}

function uniqueEmailList_(emails) {
  const seen = {};
  return (emails || []).map(normalizeEmail_).filter(function (email) {
    if (!email || seen[email]) {
      return false;
    }
    seen[email] = true;
    return true;
  });
}

function getGlobalConfigValue_(setting) {
  const sheet = getConfigSheetIfAvailable_();
  if (!sheet || sheet.getLastRow() < 2) {
    return null;
  }

  const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, CONFIG_HEADERS.length).getValues();
  for (let index = 0; index < values.length; index += 1) {
    const row = configRowFromValues_(values[index]);
    if (normalizeProcessKey_(row.processKey) === 'global' && row.setting === setting) {
      return parseJsonValue_(row.valueJson, null);
    }
  }
  return null;
}

function readProcessDefinitionsFromConfigSheet_() {
  const sheet = getConfigSheetIfAvailable_();
  const definitions = {};
  if (!sheet || sheet.getLastRow() < 2) {
    return definitions;
  }

  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, CONFIG_HEADERS.length)
    .getValues()
    .map(configRowFromValues_)
    .filter(function (row) {
      return row.enabled !== 'No';
    });

  rows.forEach(function (row) {
    const processKey = normalizeProcessKey_(row.processKey);
    if (!processKey || processKey === 'global') {
      return;
    }
    definitions[processKey] = definitions[processKey] || {
      key: processKey,
      name: row.processName || processKey,
      workflows: {}
    };
    if (row.processName) {
      definitions[processKey].name = row.processName;
    }

    if (row.section === 'setting') {
      applyProcessSettingRow_(definitions[processKey], row);
      return;
    }

    if (row.section === 'workflow') {
      if (configWorkflowRowIsRetired_(processKey, row)) {
        return;
      }
      const stage = trim_(row.stage);
      if (!stage) {
        return;
      }
      definitions[processKey].workflows[stage] = definitions[processKey].workflows[stage] || [];
      definitions[processKey].workflows[stage].push(configRowToWorkflowStep_(row));
    }
  });

  Object.keys(definitions).forEach(function (processKey) {
    Object.keys(definitions[processKey].workflows || {}).forEach(function (stage) {
      definitions[processKey].workflows[stage].sort(function (a, b) {
        return Number(a.stepOrder || 0) - Number(b.stepOrder || 0);
      });
      definitions[processKey].workflows[stage].forEach(function (step) {
        delete step.stepOrder;
      });
    });
  });

  return definitions;
}

function configWorkflowRowIsRetired_(processKey, row) {
  return processKey === 'vtr' && trim_(row.emailField) === 'firstApproverEmail';
}

function getConfigSheetIfAvailable_() {
  try {
    const ss = getDatabase_();
    return ss ? ss.getSheetByName(SHEETS.CONFIG) : null;
  } catch (err) {
    return null;
  }
}

function configRowFromValues_(values) {
  const row = {};
  CONFIG_HEADERS.forEach(function (header, index) {
    row[header] = trim_(values[index]);
  });
  return row;
}

function applyProcessSettingRow_(definition, row) {
  const value = parseJsonValue_(row.valueJson, row.valueJson);
  if (row.setting === 'paymentNotificationEmails') {
    definition.paymentNotificationEmails = Array.isArray(value) ? value : splitList_(value);
  } else if (row.setting === 'requestIdPrefix') {
    definition.requestIdPrefix = trim_(value);
  } else if (row.setting === 'requestSheetName') {
    definition.requestSheetName = trim_(value);
  } else if (row.setting === 'requestForm') {
    definition.requestForm = trim_(value);
  } else if (row.setting === 'completionMode') {
    definition.completionMode = trim_(value) || 'actual_hours';
  } else if (row.setting === 'description') {
    definition.description = trim_(value);
  } else if (row.setting === 'adminEmails') {
    definition.adminEmails = Array.isArray(value) ? value : splitList_(value);
  } else if (row.setting === 'enabled') {
    definition.enabled = value === true || String(value).toLowerCase() === 'true';
  }
}

function configRowToWorkflowStep_(row) {
  const type = normalizeWorkflowStepType_(row.type || 'approval');
  const step = {
    stepOrder: Number(row.stepOrder || 0),
    type,
    name: row.name,
    email: row.email,
    emails: splitList_(row.emails),
    emailField: row.emailField,
    emailFields: splitList_(row.emailFields),
    subject: row.subject,
    message: row.message,
    waitingLabel: isBlockingWorkflowStepType_(type) ? (row.waitingLabel || defaultWorkflowWaitingLabel_()) : '',
    when: parseJsonValue_(row.whenJson, ''),
    unless: parseJsonValue_(row.unlessJson, ''),
    followUpStage: row.followUpStage
  };

  Object.keys(step).forEach(function (key) {
    if (step[key] === '' || (Array.isArray(step[key]) && !step[key].length)) {
      delete step[key];
    }
  });
  return step;
}

function splitList_(value) {
  if (Array.isArray(value)) {
    return value.map(trim_).filter(Boolean);
  }
  return String(value || '')
    .split(',')
    .map(trim_)
    .filter(Boolean);
}

function parseJsonValue_(value, defaultValue) {
  if (!value) {
    return defaultValue;
  }
  try {
    return JSON.parse(value);
  } catch (err) {
    return defaultValue;
  }
}

function makeRequestId_(processKey) {
  const process = getProcessDefinition_(processKey || getDefaultProcessKey_());
  const prefix = trim_(process.requestIdPrefix) || 'OT';
  const stamp = Utilities.formatDate(new Date(), APP_SETTINGS.TIME_ZONE, 'yyyyMMdd');
  const suffix = Utilities.getUuid().replace(/-/g, '').slice(0, 6).toUpperCase();
  return `${prefix}-${stamp}-${suffix}`;
}

function createToken_() {
  const seed = `${Utilities.getUuid()}:${Utilities.getUuid()}:${Date.now()}`;
  return Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, seed))
    .replace(/=+$/g, '');
}

function hashToken_(token) {
  return Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(token)))
    .replace(/=+$/g, '');
}

function nowIso_() {
  return Utilities.formatDate(new Date(), APP_SETTINGS.TIME_ZONE, "yyyy-MM-dd'T'HH:mm:ssXXX");
}

function dateKeyFromIso_(value) {
  const text = String(value || '');
  const match = text.match(/^\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : '';
}

function todayKey_() {
  return Utilities.formatDate(new Date(), APP_SETTINGS.TIME_ZONE, 'yyyy-MM-dd');
}

function addDaysKey_(dateKey, days) {
  const parts = String(dateKey).split('-').map(Number);
  const date = new Date(parts[0], parts[1] - 1, parts[2]);
  date.setDate(date.getDate() + days);
  return Utilities.formatDate(date, APP_SETTINGS.TIME_ZONE, 'yyyy-MM-dd');
}

function statusLabel_(status) {
  const labels = {};
  labels[STATUS.PENDING_APPROVAL] = 'Pending approval';
  labels[STATUS.NEEDS_APPROVAL_CHANGES] = 'Needs request changes';
  labels[STATUS.PREAPPROVED] = 'Pre-approved';
  labels[STATUS.AWAITING_ACTUAL_HOURS] = 'Awaiting actual hours';
  labels[STATUS.AWAITING_VTR_CHECKLIST] = 'Awaiting VTR checklist';
  labels[STATUS.NEEDS_ACTUAL_HOURS_CHANGES] = 'Needs actual-hours changes';
  labels[STATUS.PENDING_FINAL_APPROVAL] = 'Pending final approval';
  labels[STATUS.FINAL_APPROVED] = 'Final approved';
  labels[STATUS.APPROVED] = 'Approved';
  labels[STATUS.APPROVAL_DENIED] = 'Denied';
  labels[STATUS.FINAL_DENIED] = 'Final denied';
  labels[STATUS.CANCELLED] = 'Cancelled';
  labels.PENDING_PREAPPROVAL = 'Pending pre-approval';
  labels.NEEDS_PREAPPROVAL_CHANGES = 'Needs request changes';
  labels.PREAPPROVED_AWAITING_ACTUAL_HOURS = 'Pre-approved';
  labels.PREAPPROVAL_DENIED = 'Pre-approval denied';
  return labels[status] || status || 'Unknown';
}

function validateEmail_(value, label) {
  const text = requireText_(value, label);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(text)) {
    throw new Error(`${label} must be a valid email address.`);
  }
  return text;
}

function requireText_(value, label) {
  const text = trim_(value);
  if (!text) {
    throw new Error(`${label} is required.`);
  }
  return text;
}

function requireChoice_(value, choices, label) {
  const text = requireText_(value, label);
  if (choices.indexOf(text) === -1) {
    throw new Error(`${label} has an invalid value.`);
  }
  return text;
}

function validateDateKey_(value, label) {
  const text = requireText_(value, label);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw new Error(`${label} must be a valid date.`);
  }
  return text;
}

function validateTime_(value, label) {
  const text = requireText_(value, label);
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(text)) {
    throw new Error(`${label} must be in 24-hour HH:MM format.`);
  }
  return text;
}

function validatePositiveNumber_(value, label) {
  const text = requireText_(value, label);
  const number = Number(text);
  if (!isFinite(number) || number <= 0) {
    throw new Error(`${label} must be a number greater than zero.`);
  }
  return String(number);
}

function trim_(value) {
  return String(value === null || value === undefined ? '' : value).trim();
}

function jsonForTemplate_(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

function errorState_(message) {
  return {
    mode: 'error',
    title: 'Link unavailable',
    message
  };
}
