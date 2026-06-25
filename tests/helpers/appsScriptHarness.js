const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { applyLiveDefinitionStore } = require('./liveDefinitionStore');

const APPS_SCRIPT_DIR = path.resolve(__dirname, '..', '..', 'apps-script');
const SCRIPT_LOAD_ORDER = [
  'Config.js',
  'ProcessDefaults.js',
  'FormDefinitions.js',
  'Storage.js',
  'Auth.js',
  'Migrations.js',
  'Email.js',
  'WorkflowEngine.js',
  'Requests.js',
  'Admin.js',
  'Triggers.js',
  'Code.js'
];

const EXPORTED_NAMES = [
  'APP_SETTINGS',
  'SHEETS',
  'STATUS',
  'DEFAULT_ADMIN_EMAILS',
  'REQUEST_HEADERS',
  'EVENT_HEADERS',
  'CONFIG_HEADERS',
  'DEFAULT_PROCESS_DEFINITIONS',
  'FORM_DEFINITIONS',
  'replaceWorksheetConfigWithLoadedDefinitions',
  'replaceWorksheetConfigWithTestEmailDefinitions',
  'replaceWorksheetConfigWithVtrTestEmailDefinitions',
  'migrateLegacyRequestRows',
  'getDatabaseDiagnostic',
  'setup',
  'getInitialState_',
  'submitFeedback',
  'submitRequest',
  'submitApprovalDecision',
  'submitDashboardApprovalDecision',
  'requesterCancelRequest',
  'adminCancelRequest',
  'submitActualHours',
  'submitVtrChecklist',
  'submitEditedRequest',
  'sendDueActualHoursRequests',
  'sendWeeklyPendingReminders',
  'getDashboardData',
  'getAdminUserManagementData',
  'updateAdminUserSettings',
  'getAdminWorkflowManagementData',
  'updateAdminWorkflowSettings',
  'adminReassignRequest',
  'adminSendReminder',
  'getAllRequests_',
  'getAllEvents_',
  'getRequestById_',
  'resolveWorkflowSteps_',
  'getActiveWorkflowStep_',
  'getProcessDefinition_',
  'getProcessDefinitions_',
  'getWorkflowConfigForStage_',
  'getFormDefinition_',
  'publicFormDefinition_',
  'getAllFormDefinitions_',
  'getFormAdjustmentFields_',
  'getEnabledRequestFormOptions_',
  'getAdminProcessOptionsFor_',
  'isAdminEmail_',
  'isProcessAdminEmail_',
  'getWebAppUrl_',
  'hashToken_',
  'publicRequest_',
  'validateRequestForm_',
  'validateActualHoursForm_',
  'validateVtrChecklistForm_',
  'workflowStepAllowsDecision_',
  'workflowStepPrimaryDecision_',
  'workflowStepPrimaryLabel_',
  'normalizeWorkflowStepType_',
  'statusLabel_',
  'nowIso_',
  'todayKey_'
];

function createAppsScriptHarness(options = {}) {
  const state = {
    activeEmail: options.activeEmail || '',
    now: new Date(options.now || '2026-06-15T04:47:00.000Z'),
    properties: new Map(Object.entries(options.properties || {})),
    serviceUrl: options.serviceUrl || 'https://script.google.com/a/example.edu/macros/s/TEST_DEPLOYMENT/exec',
    sentMail: [],
    triggers: [],
    uuidCounter: 1,
    spreadsheets: new Map()
  };

  const spreadsheet = new MockSpreadsheet('spreadsheet-1');
  state.activeSpreadsheet = spreadsheet;
  state.spreadsheets.set(spreadsheet.id, spreadsheet);

  const context = {
    console,
    Buffer,
    setTimeout,
    clearTimeout,
    Date: makeMockDate(state),
    PropertiesService: makePropertiesService(state),
    SpreadsheetApp: makeSpreadsheetApp(state),
    LockService: makeLockService(),
    ScriptApp: makeScriptApp(state),
    Session: makeSession(state),
    Utilities: makeUtilities(state),
    MailApp: {
      sendEmail(message) {
        state.sentMail.push(Object.assign({}, message));
      }
    },
    HtmlService: makeHtmlService()
  };
  context.globalThis = context;

  const source = SCRIPT_LOAD_ORDER
    .map(file => {
      const scriptPath = path.join(APPS_SCRIPT_DIR, file);
      return `\n// ${file}\n${fs.readFileSync(scriptPath, 'utf8')}`;
    })
    .join('\n');
  const exportSource = `\nglobalThis.__exports = { ${EXPORTED_NAMES.join(', ')} };\n`;
  vm.createContext(context);
  vm.runInContext(source + exportSource, context, { filename: path.join(APPS_SCRIPT_DIR, 'combined.gs') });

  const api = context.__exports;
  applyLiveDefinitionStore(api);
  const globalAdmins = options.globalAdmins || ['admin@example.edu'];
  if (Array.isArray(api.DEFAULT_ADMIN_EMAILS)) {
    api.DEFAULT_ADMIN_EMAILS.splice(0, api.DEFAULT_ADMIN_EMAILS.length, ...globalAdmins);
  }
  if (options.config) {
    Object.assign(api.APP_SETTINGS, options.config);
  }
  if (Object.prototype.hasOwnProperty.call(options, 'webAppUrl')) {
    api.APP_SETTINGS.WEB_APP_URL = options.webAppUrl;
  }
  if (Object.prototype.hasOwnProperty.call(options, 'allowEmailFallbackForTesting')) {
    api.APP_SETTINGS.ALLOW_EMAIL_FALLBACK_FOR_TESTING = Boolean(options.allowEmailFallbackForTesting);
  }
  if (api.APP_SETTINGS.SPREADSHEET_ID && !state.spreadsheets.has(api.APP_SETTINGS.SPREADSHEET_ID)) {
    state.spreadsheets.set(api.APP_SETTINGS.SPREADSHEET_ID, spreadsheet);
  }

  return {
    api,
    state,
    spreadsheet,
    setActiveUser(email) {
      state.activeEmail = String(email || '').toLowerCase();
    },
    setNow(value) {
      state.now = new Date(value);
    },
    get requests() {
      return api.getAllRequests_();
    },
    get events() {
      return api.getAllEvents_();
    },
    get mail() {
      return state.sentMail;
    },
    clearMail() {
      state.sentMail.length = 0;
    },
    latestMail(predicate) {
      const matches = predicate ? state.sentMail.filter(predicate) : state.sentMail;
      return matches[matches.length - 1] || null;
    },
    tokenFromMail(message, mode) {
      return extractTokenFromMail(message, mode);
    }
  };
}

function defaultRequest(overrides = {}) {
  const normallyWorks = overrides.normallyWorks || 'Yes';
  const isLineManagerRequester = overrides.isLineManagerRequester || 'Yes';
  return Object.assign({
    employeeName: 'Christo Willemse',
    employeeEmail: 'employee@example.edu',
    lineManagerEmail: 'linemanager@example.edu',
    isLineManagerRequester,
    requesterEmail: isLineManagerRequester === 'No' ? 'requesting@example.edu' : '',
    reason: 'Cover school event',
    overtimeDate: '2026-06-20',
    normallyWorks,
    normalStartTime: normallyWorks === 'Yes' ? '08:00' : '',
    normalFinishTime: normallyWorks === 'Yes' ? '15:30' : '',
    plannedStartTime: '15:30',
    plannedFinishTime: '17:30',
    plannedHours: '2',
    mealRulesAcknowledged: true,
    compensationMethod: 'Payment at Casual/Overtime Rates'
  }, overrides);
}

function defaultActual(overrides = {}) {
  return Object.assign({
    overtimeCompleteAcknowledged: true,
    mealBreaksAcknowledged: true,
    mealAllowance: 'No meal was required',
    workedAsApproved: 'Yes',
    actualStartTime: '15:30',
    actualFinishTime: '17:30',
    actualHours: '2',
    variationReason: ''
  }, overrides);
}

function defaultVtrRequest(overrides = {}) {
  return Object.assign({
    processType: 'vtr',
    employeeName: 'Alex Organiser',
    employeeEmail: 'organiser@example.edu',
    eventName: 'Year 8 Museum Visit',
    eventDate: '2026-07-10',
    schoolArea: 'Senior School',
    eventType: 'Curricular Event',
    eventLocation: 'Australian Museum',
    eventStartTime: '09:00',
    eventFinishTime: '14:30',
    studentsInvolved: 'Year 8 History students',
    staffRequired: 'History staff and support staff',
    riskAssessmentRequired: 'Yes',
    logisticsNotified: 'Yes',
    costToStudents: 'Yes',
    riskAssessmentCompleted: 'Yes',
    wwccConfirmed: 'N/A',
    budgetSubmitted: 'Yes',
    groundsConsulted: 'N/A',
    itConsulted: 'N/A',
    groundsAfterHoursNotified: 'N/A',
    sportPdhpeConsulted: 'N/A',
    chaplaincyConsulted: 'N/A',
    canteenNotified: 'Yes',
    parentLetterChecked: 'Yes',
    parentLetterProvided: 'Yes',
    staffNotified: 'Yes',
    busesBooked: 'Yes',
    marketingNotified: 'No',
    offsiteExcursion: 'Yes',
    attendingStaffBriefed: 'Yes',
    medicalNeedsCompiled: 'Yes',
    lessonPlansLeft: 'Yes',
    rollsMarkedReceptionNotified: 'Yes'
  }, overrides);
}

function extractTokenFromMail(message, mode) {
  if (!message) {
    return '';
  }
  const text = `${message.htmlBody || ''}\n${message.body || ''}`;
  const pattern = new RegExp(`mode=${mode}(?:&amp;|&)token=([^"'\\s&<>]+)`);
  const match = text.match(pattern);
  return match ? decodeURIComponent(match[1]) : '';
}

class MockSpreadsheet {
  constructor(id) {
    this.id = id;
    this.sheets = new Map();
  }

  getId() {
    return this.id;
  }

  getUrl() {
    return `https://docs.google.com/spreadsheets/d/${this.id}/edit`;
  }

  getSheetByName(name) {
    return this.sheets.get(name) || null;
  }

  getSheets() {
    return Array.from(this.sheets.values());
  }

  insertSheet(name) {
    const sheet = new MockSheet(name);
    sheet.parent = this;
    this.sheets.set(name, sheet);
    return sheet;
  }
}

class MockSheet {
  constructor(name) {
    this.name = name;
    this.rows = [];
    this.frozenRows = 0;
  }

  appendRow(row) {
    this.rows.push(row.slice());
  }

  getLastRow() {
    return this.rows.length;
  }

  getLastColumn() {
    return this.rows.reduce((max, row) => Math.max(max, row.length), 0);
  }

  getName() {
    return this.name;
  }

  setName(name) {
    if (this.parent) {
      this.parent.sheets.delete(this.name);
      this.parent.sheets.set(name, this);
    }
    this.name = name;
    return this;
  }

  getRange(row, column, numRows, numColumns) {
    return new MockRange(this, row, column, numRows, numColumns);
  }

  setFrozenRows(count) {
    this.frozenRows = count;
  }

  clearContents() {
    this.rows = [];
  }

  deleteColumn(columnPosition) {
    const index = columnPosition - 1;
    this.rows.forEach(row => {
      row.splice(index, 1);
    });
  }
}

class MockRange {
  constructor(sheet, row, column, numRows, numColumns) {
    this.sheet = sheet;
    this.row = row;
    this.column = column;
    this.numRows = numRows;
    this.numColumns = numColumns;
  }

  getValues() {
    const values = [];
    for (let r = 0; r < this.numRows; r += 1) {
      const sourceRow = this.sheet.rows[this.row - 1 + r] || [];
      const outputRow = [];
      for (let c = 0; c < this.numColumns; c += 1) {
        outputRow.push(sourceRow[this.column - 1 + c] ?? '');
      }
      values.push(outputRow);
    }
    return values;
  }

  setValues(values) {
    for (let r = 0; r < this.numRows; r += 1) {
      const targetIndex = this.row - 1 + r;
      if (!this.sheet.rows[targetIndex]) {
        this.sheet.rows[targetIndex] = [];
      }
      for (let c = 0; c < this.numColumns; c += 1) {
        this.sheet.rows[targetIndex][this.column - 1 + c] = values[r][c];
      }
    }
  }

  clearContent() {
    for (let r = 0; r < this.numRows; r += 1) {
      const targetIndex = this.row - 1 + r;
      if (!this.sheet.rows[targetIndex]) {
        continue;
      }
      for (let c = 0; c < this.numColumns; c += 1) {
        this.sheet.rows[targetIndex][this.column - 1 + c] = '';
      }
    }
  }
}

function makePropertiesService(state) {
  return {
    getScriptProperties() {
      return {
        getProperty(key) {
          return state.properties.has(key) ? state.properties.get(key) : null;
        },
        setProperty(key, value) {
          state.properties.set(key, String(value));
        }
      };
    }
  };
}

function makeSpreadsheetApp(state) {
  return {
    getActiveSpreadsheet() {
      return state.activeSpreadsheet;
    },
    openById(id) {
      const spreadsheet = state.spreadsheets.get(id);
      if (!spreadsheet) {
        throw new Error(`Spreadsheet ${id} was not found.`);
      }
      return spreadsheet;
    },
    create(name) {
      const id = `spreadsheet-${state.spreadsheets.size + 1}`;
      const spreadsheet = new MockSpreadsheet(id);
      spreadsheet.name = name;
      state.spreadsheets.set(id, spreadsheet);
      return spreadsheet;
    }
  };
}

function makeLockService() {
  return {
    getScriptLock() {
      return {
        waitLock() {},
        releaseLock() {}
      };
    }
  };
}

function makeScriptApp(state) {
  return {
    WeekDay: {
      SUNDAY: 'SUNDAY',
      MONDAY: 'MONDAY',
      TUESDAY: 'TUESDAY',
      WEDNESDAY: 'WEDNESDAY',
      THURSDAY: 'THURSDAY',
      FRIDAY: 'FRIDAY',
      SATURDAY: 'SATURDAY'
    },
    getService() {
      return {
        getUrl() {
          return state.serviceUrl;
        }
      };
    },
    getProjectTriggers() {
      return state.triggers.slice();
    },
    deleteTrigger(trigger) {
      state.triggers = state.triggers.filter(existing => existing !== trigger);
    },
    newTrigger(handlerFunction) {
      const trigger = {
        handlerFunction,
        schedule: {},
        getHandlerFunction() {
          return handlerFunction;
        }
      };
      const builder = {
        timeBased() {
          return builder;
        },
        everyDays(days) {
          trigger.schedule.everyDays = days;
          return builder;
        },
        onWeekDay(day) {
          trigger.schedule.weekDay = day;
          return builder;
        },
        atHour(hour) {
          trigger.schedule.hour = hour;
          return builder;
        },
        inTimezone(timeZone) {
          trigger.schedule.timeZone = timeZone;
          return builder;
        },
        create() {
          state.triggers.push(trigger);
          return trigger;
        }
      };
      return builder;
    }
  };
}

function makeSession(state) {
  return {
    getActiveUser() {
      return {
        getEmail() {
          return state.activeEmail || '';
        }
      };
    }
  };
}

function makeUtilities(state) {
  return {
    DigestAlgorithm: {
      SHA_256: 'SHA_256'
    },
    getUuid() {
      const counter = state.uuidCounter;
      state.uuidCounter += 1;
      const first = `${counter.toString(16).padStart(6, '0')}00`;
      const last = counter.toString(16).padStart(12, '0');
      return `${first}-0000-4000-8000-${last}`;
    },
    computeDigest(algorithm, value) {
      if (algorithm !== 'SHA_256') {
        throw new Error(`Unsupported digest algorithm ${algorithm}`);
      }
      return crypto.createHash('sha256').update(String(value)).digest();
    },
    base64EncodeWebSafe(value) {
      return Buffer.from(value)
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_');
    },
    formatDate(value, timeZone, pattern) {
      return formatDate(value, timeZone, pattern);
    }
  };
}

function makeHtmlService() {
  return {
    XFrameOptionsMode: {
      ALLOWALL: 'ALLOWALL'
    },
    createTemplateFromFile() {
      return {
        evaluate() {
          return {
            setTitle() {
              return this;
            },
            setXFrameOptionsMode() {
              return this;
            }
          };
        }
      };
    },
    createHtmlOutputFromFile() {
      return {
        getContent() {
          return '';
        }
      };
    }
  };
}

function makeMockDate(state) {
  return class MockDate extends Date {
    constructor(...args) {
      if (args.length === 0) {
        super(state.now.getTime());
      } else {
        super(...args);
      }
    }

    static now() {
      return state.now.getTime();
    }
  };
}

function formatDate(value, timeZone, pattern) {
  const date = value instanceof Date ? value : new Date(value);
  const parts = zonedParts(date, timeZone);
  const pad = number => String(number).padStart(2, '0');

  if (pattern === 'yyyyMMdd') {
    return `${parts.year}${pad(parts.month)}${pad(parts.day)}`;
  }
  if (pattern === 'yyyy-MM-dd') {
    return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
  }
  if (pattern === 'HH:mm') {
    return `${pad(parts.hour)}:${pad(parts.minute)}`;
  }
  if (pattern === "yyyy-MM-dd'T'HH:mm:ssXXX") {
    return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}${timeZoneOffset(date, timeZone)}`;
  }
  if (pattern === 'd MMMM yyyy') {
    return `${parts.day} ${monthName(date, timeZone)} ${parts.year}`;
  }
  if (pattern === 'd MMMM yyyy h:mm a') {
    const hour = parts.hour % 12 || 12;
    const meridiem = parts.hour < 12 ? 'AM' : 'PM';
    return `${parts.day} ${monthName(date, timeZone)} ${parts.year} ${hour}:${pad(parts.minute)} ${meridiem}`;
  }

  return date.toISOString();
}

function zonedParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-AU', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  });
  const parts = {};
  formatter.formatToParts(date).forEach(part => {
    if (part.type !== 'literal') {
      parts[part.type] = Number(part.value);
    }
  });
  return parts;
}

function monthName(date, timeZone) {
  return new Intl.DateTimeFormat('en-AU', {
    timeZone,
    month: 'long'
  }).format(date);
}

function timeZoneOffset(date, timeZone) {
  const parts = zonedParts(date, timeZone);
  const zonedAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  const offsetMinutes = Math.round((zonedAsUtc - date.getTime()) / 60000);
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

module.exports = {
  createAppsScriptHarness,
  defaultActual,
  defaultRequest,
  defaultVtrRequest
};
