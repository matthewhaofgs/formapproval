const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const vm = require('node:vm');

const ROOT_DIR = path.resolve(__dirname, '..');
const APPS_SCRIPT_DIR = path.join(ROOT_DIR, 'apps-script');

const SCRIPT_LOAD_ORDER = [
  'Config.js',
  'ProcessDefaults.js',
  'FormDefinitions.js',
  'Auth.js',
  'Email.js',
  'WorkflowEngine.js',
  'Requests.js',
  'Admin.js',
  'Triggers.js'
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
  'getDatabaseDiagnostic',
  'getEnabledRequestFormOptions_',
  'getAdminProcessOptionsFor_',
  'isAdminEmail_',
  'isProcessAdminEmail_',
  'getWebAppUrl_',
  'hashToken_',
  'publicRequest_',
  'statusLabel_',
  'nowIso_',
  'todayKey_'
];

let activeContext = null;
const scheduledEmailIds = new Set();
let queuedEmailDrainScheduled = false;

function createNativeRuntime(options = {}) {
  const state = {
    activeEmail: '',
    serviceUrl: options.webAppUrl || process.env.APP_BASE_URL || 'http://localhost:3000',
    uuidCounter: 1,
    mailOutbox: [],
    definitionsLoadedAt: 0
  };
  let api = null;

  const context = {
    console,
    Buffer,
    setTimeout,
    clearTimeout,
    Date,
    PropertiesService: makePropertiesService(),
    SpreadsheetApp: makeUnavailableSpreadsheetApp(),
    LockService: makeLockService(),
    ScriptApp: makeScriptApp(state),
    Session: makeSession(state),
    Utilities: makeUtilities(),
    MailApp: makeMailApp(state),
    HtmlService: {},
    ensureReady_: nativeEnsureReady,
    getDatabaseDiagnostic: nativeDatabaseDiagnostic,
    databaseDiagnostic_: nativeDatabaseDiagnostic,
    getAllRequests_: nativeGetAllRequests,
    getRequestsForProcess_: nativeGetRequestsForProcess,
    getAllEvents_: nativeGetAllEvents,
    getRequestById_: nativeGetRequestById,
    findRequestByToken_: nativeFindRequestByToken,
    appendRequest_: nativeAppendRequest,
    updateRequest_: nativeUpdateRequest,
    logEvent_: nativeLogEvent,
    emptyRequestRecord_: nativeEmptyRequestRecord,
    normalizeRequestRecord_: nativeNormalizeRequestRecord,
    getRequestHeaders_: nativeGetRequestHeaders,
    getProcessOperationalRequestHeaders_: nativeGetProcessOperationalRequestHeaders,
    getSchemaRequestFieldNames_: nativeGetSchemaRequestFieldNames,
    getSchemaRequestFieldNamesByType_: nativeGetSchemaRequestFieldNamesByType,
    uniqueFieldNames_: uniqueFieldNames,
    parseJsonArray_: parseJsonArray,
    parseJsonObject_: parseJsonObject,
    cellValue_: cellValue,
    dateCellValue_: dateCellValue,
    timeCellValue_: timeCellValue,
    dateTimeCellValue_: dateTimeCellValue,
    isDateObject_: isDateObject,
    nativeSaveAdminUserSettings_: settings => nativeSaveAdminUserSettings(api, state, settings),
    nativeSaveAdminWorkflowSettings_: settings => nativeSaveAdminWorkflowSettings(api, state, settings),
    __nativeState: state
  };
  context.globalThis = context;
  activeContext = context;

  const source = SCRIPT_LOAD_ORDER
    .map(file => `\n// ${file}\n${fs.readFileSync(path.join(APPS_SCRIPT_DIR, file), 'utf8')}`)
    .join('\n');
  const exportSource = `\nglobalThis.__exports = { ${EXPORTED_NAMES.join(', ')} };\n`;
  vm.createContext(context);
  vm.runInContext(source + exportSource, context, { filename: path.join(APPS_SCRIPT_DIR, 'native-combined.js') });

  api = context.__exports;
  Object.assign(api.APP_SETTINGS, {
    SPREADSHEET_ID: '',
    WEB_APP_URL: state.serviceUrl,
    REQUIRE_GOOGLE_AUTH: false,
    ALLOW_EMAIL_FALLBACK_FOR_TESTING: true,
    APP_VERSION: 'native-node-postgres'
  });

  return {
    api,
    state,
    setActiveUser(email) {
      state.activeEmail = normalizeEmail(email);
    },
    async init() {
      nativeEnsureReady();
      nativeRefreshDefinitions(api);
      state.definitionsLoadedAt = Date.now();
    },
    call(method, payload, email) {
      if (!Object.prototype.hasOwnProperty.call(api, method) || typeof api[method] !== 'function') {
        throw new Error(`Unsupported API method: ${method}`);
      }
      nativeRefreshDefinitionsIfStale(api, state);
      const preparedPayload = Object.assign({}, payload || {});
      const regression = createRegressionContext(method, preparedPayload);
      if (regression) {
        applyRegressionRecipientOverrides(preparedPayload, regression.alias);
      }
      state.activeEmail = normalizeEmail(email || preparedPayload.email || '');
      state.currentRegression = regression;
      try {
        return api[method](preparedPayload);
      } finally {
        state.currentRegression = null;
      }
    },
    initialState(params, email) {
      nativeRefreshDefinitionsIfStale(api, state);
      state.activeEmail = normalizeEmail(email || (params && params.email) || '');
      return api.getInitialState_(params || {});
    }
  };
}

function nativeEnsureReady() {
  psql(`
    CREATE TABLE IF NOT EXISTS app_requests (
      request_id text PRIMARY KEY,
      process_type text NOT NULL,
      data jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS app_requests_process_type_idx
      ON app_requests (process_type);

    CREATE INDEX IF NOT EXISTS app_requests_status_idx
      ON app_requests ((data->>'status'));

    CREATE TABLE IF NOT EXISTS app_events (
      id bigserial PRIMARY KEY,
      timestamp timestamptz NOT NULL DEFAULT now(),
      request_id text NOT NULL,
      actor_email text NOT NULL DEFAULT '',
      event text NOT NULL,
      details jsonb NOT NULL DEFAULT '{}'::jsonb
    );

    CREATE INDEX IF NOT EXISTS app_events_request_id_idx
      ON app_events (request_id);

    CREATE TABLE IF NOT EXISTS outbound_emails (
      id bigserial PRIMARY KEY,
      created_at timestamptz NOT NULL DEFAULT now(),
      to_email text NOT NULL,
      cc_email text NOT NULL DEFAULT '',
      subject text NOT NULL,
      body text NOT NULL DEFAULT '',
      html_body text NOT NULL DEFAULT '',
      provider_result jsonb NOT NULL DEFAULT '{}'::jsonb
    );

    CREATE TABLE IF NOT EXISTS app_definitions (
      category text NOT NULL,
      definition_key text NOT NULL,
      data jsonb NOT NULL,
      enabled boolean NOT NULL DEFAULT true,
      source text NOT NULL DEFAULT 'database',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (category, definition_key)
    );

    ALTER TABLE app_definitions
      ALTER COLUMN source SET DEFAULT 'database';
  `);
  scheduleQueuedEmailDrain();
}

function nativeRefreshDefinitions(api) {
  const rows = psqlJsonRows(`
    SELECT jsonb_build_object(
      'category', category,
      'key', definition_key,
      'data', data
    )
    FROM app_definitions
    WHERE enabled = true
    ORDER BY category, definition_key;
  `);
  const formDefinitions = {};
  const processDefinitions = {};
  let globalAdminEmails = null;
  rows.forEach(row => {
    if (row.category === 'form_definition') {
      formDefinitions[row.key] = row.data || {};
    }
    if (row.category === 'process_definition') {
      processDefinitions[row.key] = row.data || {};
    }
    if (row.category === 'global_setting' && row.key === 'admin_emails') {
      const data = row.data || {};
      globalAdminEmails = Array.isArray(data) ? data : data.emails;
    }
  });
  nativeAssertDefinitionsAvailable(formDefinitions, processDefinitions);
  replaceObjectContents(api.FORM_DEFINITIONS, formDefinitions);
  replaceObjectContents(api.DEFAULT_PROCESS_DEFINITIONS, processDefinitions);
  if (Array.isArray(globalAdminEmails) && api.DEFAULT_ADMIN_EMAILS) {
    replaceArrayContents(api.DEFAULT_ADMIN_EMAILS, globalAdminEmails.map(normalizeEmail).filter(Boolean));
  }
}

function nativeAssertDefinitionsAvailable(formDefinitions, processDefinitions) {
  if (!Object.keys(formDefinitions || {}).length) {
    throw new Error('No enabled form_definition rows found in app_definitions.');
  }
  if (!Object.keys(processDefinitions || {}).length) {
    throw new Error('No enabled process_definition rows found in app_definitions.');
  }
}

function nativeRefreshDefinitionsIfStale(api, state) {
  const ttlMs = Number(process.env.DEFINITION_CACHE_TTL_MS || 5000);
  if (state.definitionsLoadedAt && Date.now() - state.definitionsLoadedAt < ttlMs) {
    return;
  }
  nativeRefreshDefinitions(api);
  state.definitionsLoadedAt = Date.now();
}

function replaceObjectContents(target, source) {
  Object.keys(target || {}).forEach(key => {
    delete target[key];
  });
  Object.keys(source || {}).forEach(key => {
    target[key] = source[key];
  });
}

function replaceArrayContents(target, source) {
  target.splice(0, target.length, ...(source || []));
}

function nativeSaveAdminUserSettings(api, state, settings) {
  if (!api) {
    throw new Error('Native runtime is not initialized.');
  }

  const processAdmins = settings && settings.processAdmins ? settings.processAdmins : {};
  const statements = [
    'BEGIN;',
    `
      INSERT INTO app_definitions (category, definition_key, data, source, updated_at)
      VALUES ('global_setting', 'admin_emails', ${sqlJson({ emails: settings.globalAdmins || [] })}, 'web-admin', now())
      ON CONFLICT (category, definition_key) DO UPDATE SET
        data = EXCLUDED.data,
        source = 'web-admin',
        updated_at = now();
    `
  ];

  Object.keys(processAdmins).forEach(key => {
    statements.push(`
      UPDATE app_definitions
      SET data = jsonb_set(data, '{adminEmails}', ${sqlJson(processAdmins[key])}, true),
          source = 'web-admin',
          updated_at = now()
      WHERE category = 'process_definition'
        AND definition_key = ${sqlText(key)};
    `);
  });
  statements.push('COMMIT;');
  psql(statements.join('\n'));
  nativeRefreshDefinitions(api);
  state.definitionsLoadedAt = Date.now();
}

function nativeSaveAdminWorkflowSettings(api, state, settings) {
  if (!api) {
    throw new Error('Native runtime is not initialized.');
  }

  psql(`
    UPDATE app_definitions
    SET data = jsonb_set(data, '{workflows}', ${sqlJson(settings.workflows || {})}, true),
        source = 'web-admin',
        updated_at = now()
    WHERE category = 'process_definition'
      AND definition_key = ${sqlText(settings.processKey)};
  `);
  nativeRefreshDefinitions(api);
  state.definitionsLoadedAt = Date.now();
}

function nativeDatabaseDiagnostic() {
  nativeEnsureReady();
  const counts = psqlRows(`
    SELECT 'requests' AS name, count(*)::text AS rows FROM app_requests
    UNION ALL
    SELECT 'events' AS name, count(*)::text AS rows FROM app_events
    UNION ALL
    SELECT 'outbound_emails' AS name, count(*)::text AS rows FROM outbound_emails
    UNION ALL
    SELECT 'definitions' AS name, count(*)::text AS rows FROM app_definitions
    ORDER BY name;
  `);
  return {
    ok: true,
    appVersion: 'native-node-postgres',
    source: 'PostgreSQL',
    databaseUrl: redactDatabaseUrl(process.env.DATABASE_URL || ''),
    tables: counts.map(row => ({ name: row.name, rows: Number(row.rows || 0) }))
  };
}

function nativeAppendRequest(record) {
  const state = getContext().__nativeState || {};
  const withNativeFields = Object.assign({}, record);
  if (state.currentRegression) {
    withNativeFields._regressionTestRunId = state.currentRegression.runId;
    withNativeFields._regressionEmailAlias = state.currentRegression.alias;
    withNativeFields._regressionCreatedAt = new Date().toISOString();
  }
  const normalized = nativeNormalizeRequestRecord(withNativeFields);
  const requestId = normalized.requestId;
  if (!requestId) {
    throw new Error('Cannot append request without requestId.');
  }
  const processType = normalized.processType || 'overtime';
  normalized._rowNumber = 1;
  normalized._sheetName = processType;
  psql(`
    INSERT INTO app_requests (request_id, process_type, data)
    VALUES (${sqlText(requestId)}, ${sqlText(processType)}, ${sqlJson(normalized)})
    ON CONFLICT (request_id) DO UPDATE SET
      process_type = EXCLUDED.process_type,
      data = EXCLUDED.data,
      updated_at = now();
  `);
  Object.assign(record, normalized);
}

function nativeUpdateRequest(record) {
  const normalized = nativeNormalizeRequestRecord(Object.assign({}, record));
  const requestId = normalized.requestId;
  if (!requestId) {
    throw new Error('Cannot update request without requestId.');
  }
  const processType = normalized.processType || 'overtime';
  normalized._rowNumber = record._rowNumber || 1;
  normalized._sheetName = record._sheetName || processType;
  psql(`
    UPDATE app_requests
    SET process_type = ${sqlText(processType)},
        data = ${sqlJson(normalized)},
        updated_at = now()
    WHERE request_id = ${sqlText(requestId)};
  `);
  Object.assign(record, normalized);
}

function nativeGetAllRequests() {
  nativeEnsureReady();
  return psqlJsonRows("SELECT jsonb_build_object('data', data) FROM app_requests ORDER BY created_at, request_id;")
    .map(row => nativeNormalizeRequestRecord(row.data || {}));
}

function nativeGetRequestsForProcess(processKey) {
  const requested = normalizeEmail(processKey || 'overtime');
  return nativeGetAllRequests().filter(record => normalizeEmail(record.processType || 'overtime') === requested);
}

function nativeGetRequestById(requestId) {
  const rows = psqlJsonRows(`SELECT jsonb_build_object('data', data) FROM app_requests WHERE request_id = ${sqlText(requestId)} LIMIT 1;`);
  return rows.length ? nativeNormalizeRequestRecord(rows[0].data || {}) : null;
}

function nativeFindRequestByToken(token, tokenType) {
  const context = getContext();
  const hash = context.hashToken_ ? context.hashToken_(token) : '';
  const field = tokenType === 'employee' ? 'employeeActionTokenHash' : 'activeApprovalTokenHash';
  const rows = psqlJsonRows(`
    SELECT jsonb_build_object('data', data)
    FROM app_requests
    WHERE data->>${sqlText(field)} = ${sqlText(hash)}
    LIMIT 1;
  `);
  return rows.length ? nativeNormalizeRequestRecord(rows[0].data || {}) : null;
}

function nativeLogEvent(requestId, actorEmail, event, details) {
  psql(`
    INSERT INTO app_events (timestamp, request_id, actor_email, event, details)
    VALUES (now(), ${sqlText(requestId)}, ${sqlText(actorEmail || '')}, ${sqlText(event)}, ${sqlJson(details || {})});
  `);
}

function nativeGetAllEvents() {
  nativeEnsureReady();
  return psqlJsonRows(`
    SELECT jsonb_build_object(
      'timestamp', to_char(timestamp AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"+00:00"'),
      'requestId', request_id,
      'actorEmail', actor_email,
      'event', event,
      'detailsJson', details::text
    ) AS data
    FROM app_events
    ORDER BY id;
  `).map(row => row.data || row);
}

function nativeEmptyRequestRecord(processOrRequest) {
  const record = {};
  nativeGetRequestHeaders(processOrRequest || 'overtime').forEach(header => {
    record[header] = '';
  });
  return record;
}

function nativeNormalizeRequestRecord(record) {
  record.processType = record.processType || 'overtime';
  uniqueFieldNames([
    'createdAt',
    'updatedAt',
    'approvalCompletedAt',
    'actualSubmittedAt',
    'checklistSubmittedAt',
    'checklistCompletedAt',
    'finalApprovedAt',
    'followUpSentAt',
    'changeRequestedAt',
    'lastEditedAt'
  ]).forEach(field => {
    record[field] = dateTimeCellValue(record[field]);
  });
  uniqueFieldNames([
    'overtimeDate',
    'eventDate',
    'followUpDueDate'
  ].concat(nativeGetSchemaRequestFieldNamesByType(record, 'date'))).forEach(field => {
    record[field] = dateCellValue(record[field]);
  });
  uniqueFieldNames([
    'normalStartTime',
    'normalFinishTime',
    'plannedStartTime',
    'plannedFinishTime',
    'actualStartTime',
    'actualFinishTime'
  ].concat(nativeGetSchemaRequestFieldNamesByType(record, 'time'))).forEach(field => {
    record[field] = timeCellValue(record[field]);
  });
  record._rowNumber = record._rowNumber || 1;
  record._sheetName = record._sheetName || record.processType;
  return record;
}

function nativeGetRequestHeaders(processOrRequest) {
  const context = getContext();
  const headers = (context.REQUEST_HEADERS || []).slice();
  nativeGetProcessOperationalRequestHeaders(processOrRequest).forEach(fieldName => {
    if (!headers.includes(fieldName)) headers.push(fieldName);
  });
  nativeGetSchemaRequestFieldNames(processOrRequest).forEach(fieldName => {
    if (!headers.includes(fieldName)) headers.push(fieldName);
  });
  return headers;
}

function nativeGetProcessOperationalRequestHeaders(processOrRequest) {
  const context = getContext();
  const mode = context.getProcessCompletionMode_
    ? context.getProcessCompletionMode_(processOrRequest || 'overtime')
    : 'actual_hours';
  if (mode === 'actual_hours') {
    return ['followUpDueDate', 'followUpSentAt', 'actualSubmittedAt', 'finalApprovedAt', 'finalApprovalHistory'];
  }
  const checklistDefinition = context.getFormDefinition_
    ? context.getFormDefinition_(processOrRequest || 'overtime', 'checklist')
    : null;
  if (checklistDefinition && checklistDefinition.key) {
    return ['followUpSentAt', 'checklistSubmittedAt', 'checklistCompletedAt', 'finalApprovedAt'];
  }
  return [];
}

function nativeGetSchemaRequestFieldNames(processOrRequest) {
  const context = getContext();
  const fieldNames = [];
  try {
    context.getAllFormDefinitions_(processOrRequest || 'overtime').forEach(definition => {
      context.flattenFormFields_(definition).forEach(field => {
        if (field.name) fieldNames.push(field.name);
      });
      (definition.computedFields || []).forEach(field => {
        if (field.field) fieldNames.push(field.field);
      });
    });
  } catch (err) {
    return [];
  }
  return uniqueFieldNames(fieldNames);
}

function nativeGetSchemaRequestFieldNamesByType(processOrRequest, type) {
  const context = getContext();
  const fieldNames = [];
  try {
    context.getAllFormDefinitions_(processOrRequest || 'overtime').forEach(definition => {
      context.flattenFormFields_(definition).forEach(field => {
        if (field.name && field.type === type) fieldNames.push(field.name);
      });
    });
  } catch (err) {
    return [];
  }
  return uniqueFieldNames(fieldNames);
}

function getContext() {
  if (!activeContext) {
    throw new Error('Native runtime context has not been initialized.');
  }
  return activeContext;
}

function makeMailApp(state) {
  return {
    sendEmail(message) {
      const regression = state.currentRegression;
      const record = {
        to: regression ? regression.alias : String(message.to || ''),
        cc: regression ? '' : String(message.cc || ''),
        subject: String(message.subject || ''),
        body: String(message.body || ''),
        htmlBody: String(message.htmlBody || '')
      };
      if (regression) {
        record.htmlBody += `\n<!-- regressionTestRunId:${regression.runId} originalTo:${escapeCommentText(message.to || '')} originalCc:${escapeCommentText(message.cc || '')} -->`;
        record.body += `\n\nRegression test run: ${regression.runId}`;
      }
      state.mailOutbox.push(record);
      const inserted = psqlJsonRows(`
        INSERT INTO outbound_emails (to_email, cc_email, subject, body, html_body, provider_result)
        VALUES (
          ${sqlText(record.to)},
          ${sqlText(record.cc)},
          ${sqlText(record.subject)},
          ${sqlText(record.body)},
          ${sqlText(record.htmlBody)},
          ${sqlJson({ mode: 'queued', queuedAt: new Date().toISOString() })}
        )
        RETURNING jsonb_build_object('id', id) AS data;
      `);
      const emailId = inserted.length ? Number(inserted[0].id) : 0;
      if (emailId) {
        enqueueEmailDelivery(emailId, record);
      }
    }
  };
}

function createRegressionContext(method, payload) {
  const runId = normalizeRegressionRunId(payload && payload.__regressionTestRunId);
  if (!runId) {
    return null;
  }
  if (method !== 'submitRequest') {
    throw new Error('Regression test marker is only supported for new request submissions.');
  }
  const expectedSecret = process.env.REGRESSION_TEST_SECRET || '';
  if (!expectedSecret || String(payload.__regressionTestSecret || '') !== expectedSecret) {
    throw new Error('Regression test marker was supplied without a valid secret.');
  }
  const alias = normalizeEmail(payload.__regressionEmailAlias);
  if (!isAllowedRegressionAlias(alias)) {
    throw new Error('Regression test email alias must target the configured SMTP mailbox.');
  }
  return { runId, alias };
}

function normalizeRegressionRunId(value) {
  const text = String(value || '').trim();
  if (!text) {
    return '';
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{2,80}$/.test(text)) {
    throw new Error('Regression test run id contains unsupported characters.');
  }
  return text;
}

function isAllowedRegressionAlias(alias) {
  const smtpUser = normalizeEmail(process.env.SMTP_USER);
  const match = smtpUser.match(/^([^@]+)@(.+)$/);
  if (!alias || !match) {
    return false;
  }
  const local = match[1].replace(/\+.*/, '');
  const domain = match[2];
  return new RegExp(`^${escapeRegExp(local)}\\+[a-z0-9][a-z0-9._-]{2,80}@${escapeRegExp(domain)}$`).test(alias);
}

function applyRegressionRecipientOverrides(payload, alias) {
  [
    'email',
    'employeeEmail',
    'lineManagerEmail',
    'requesterEmail',
    'activeApprovalStepEmail',
    'newApproverEmail'
  ].forEach(field => {
    if (Object.prototype.hasOwnProperty.call(payload, field)) {
      payload[field] = alias;
    }
  });
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function escapeCommentText(value) {
  return String(value || '').replace(/-->/g, '--&gt;').slice(0, 500);
}

function scheduleQueuedEmailDrain() {
  if (queuedEmailDrainScheduled) {
    return;
  }
  queuedEmailDrainScheduled = true;
  setImmediate(() => {
    try {
      const rows = psqlJsonRows(`
        SELECT jsonb_build_object(
          'id', id,
          'to', to_email,
          'cc', cc_email,
          'subject', subject,
          'body', body,
          'htmlBody', html_body
        ) AS data
        FROM outbound_emails
        WHERE provider_result->>'mode' = 'queued'
        ORDER BY id
        LIMIT 50;
      `);
      rows.forEach(email => {
        enqueueEmailDelivery(Number(email.id), email);
      });
    } catch (err) {
      console.error(err);
    }
  });
}

function enqueueEmailDelivery(emailId, record) {
  if (!emailId || scheduledEmailIds.has(emailId)) {
    return;
  }
  scheduledEmailIds.add(emailId);
  setImmediate(() => {
    const started = Date.now();
    try {
      const providerResult = Object.assign(deliverEmail(record), {
        elapsedMs: Date.now() - started,
        deliveredAt: new Date().toISOString()
      });
      psql(`
        UPDATE outbound_emails
        SET provider_result = ${sqlJson(providerResult)}
        WHERE id = ${sqlText(emailId)};
      `);
    } catch (err) {
      psql(`
        UPDATE outbound_emails
        SET provider_result = ${sqlJson({
          mode: 'smtp_error',
          error: err.message || String(err),
          elapsedMs: Date.now() - started,
          attemptedAt: new Date().toISOString()
        })}
        WHERE id = ${sqlText(emailId)};
      `);
      console.error(err);
    } finally {
      scheduledEmailIds.delete(emailId);
    }
  });
}

function deliverEmail(record) {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
    return { mode: 'logged', reason: 'smtp_not_configured' };
  }

  const script = `
    const nodemailer = require('nodemailer');
    const chunks = [];
    process.stdin.on('data', chunk => chunks.push(chunk));
    process.stdin.on('end', async () => {
      try {
        const record = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const transporter = nodemailer.createTransport({
          host: process.env.SMTP_HOST,
          port: Number(process.env.SMTP_PORT || 465),
          secure: String(process.env.SMTP_SECURE || 'true') === 'true',
          auth: {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS
          }
        });
        const info = await transporter.sendMail({
          from: {
            name: process.env.MAIL_FROM_NAME || 'Workflow Approvals',
            address: process.env.MAIL_FROM_ADDRESS || process.env.SMTP_USER
          },
          to: record.to,
          cc: record.cc || undefined,
          subject: record.subject,
          text: record.body || undefined,
          html: record.htmlBody || undefined
        });
        process.stdout.write(JSON.stringify({
          mode: 'smtp',
          accepted: info.accepted || [],
          rejected: info.rejected || [],
          messageId: info.messageId || ''
        }));
      } catch (err) {
        process.stderr.write(err && err.stack ? err.stack : String(err));
        process.exit(1);
      }
    });
  `;
  const result = spawnSync(process.execPath, ['-e', script], {
    input: JSON.stringify(record),
    encoding: 'utf8',
    env: process.env,
    timeout: 30000
  });
  if (result.status !== 0) {
    throw new Error(`SMTP delivery failed: ${result.stderr || result.stdout}`);
  }
  try {
    return JSON.parse(result.stdout || '{}');
  } catch (err) {
    return { mode: 'smtp', raw: result.stdout || '' };
  }
}

function makePropertiesService() {
  const properties = new Map();
  return {
    getScriptProperties() {
      return {
        getProperty(key) {
          return properties.has(key) ? properties.get(key) : null;
        },
        setProperty(key, value) {
          properties.set(key, String(value));
        }
      };
    }
  };
}

function makeUnavailableSpreadsheetApp() {
  return {
    getActiveSpreadsheet() {
      return null;
    },
    openById() {
      throw new Error('SpreadsheetApp is not available in the native server runtime.');
    },
    create() {
      throw new Error('SpreadsheetApp is not available in the native server runtime.');
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
      return [];
    },
    deleteTrigger() {},
    newTrigger() {
      const builder = {
        timeBased() { return builder; },
        everyDays() { return builder; },
        onWeekDay() { return builder; },
        atHour() { return builder; },
        inTimezone() { return builder; },
        create() { return {}; }
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

function makeUtilities() {
  return {
    DigestAlgorithm: {
      SHA_256: 'SHA_256'
    },
    getUuid() {
      return crypto.randomUUID();
    },
    computeDigest(algorithm, value) {
      if (algorithm !== 'SHA_256') {
        throw new Error(`Unsupported digest algorithm: ${algorithm}`);
      }
      return Array.from(crypto.createHash('sha256').update(String(value)).digest());
    },
    base64EncodeWebSafe(bytes) {
      const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
      return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
    },
    formatDate(value, timeZone, pattern) {
      return formatDatePattern(value, timeZone || 'UTC', pattern);
    }
  };
}

function formatDatePattern(value, timeZone, pattern) {
  const date = value instanceof Date ? value : new Date(value);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'longOffset'
  }).formatToParts(date).reduce((acc, part) => {
    acc[part.type] = part.value;
    return acc;
  }, {});
  const offset = (parts.timeZoneName || 'GMT+00:00').replace('GMT', '');
  if (pattern === 'yyyyMMdd') {
    return `${parts.year}${parts.month}${parts.day}`;
  }
  if (pattern === 'yyyy-MM-dd') {
    return `${parts.year}-${parts.month}-${parts.day}`;
  }
  if (pattern === 'HH:mm') {
    return `${parts.hour}:${parts.minute}`;
  }
  if (pattern === "yyyy-MM-dd'T'HH:mm:ssXXX") {
    return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${offset}`;
  }
  if (pattern === 'd MMMM yyyy' || pattern === 'd MMMM yyyy h:mm a') {
    const friendlyParts = new Intl.DateTimeFormat('en-AU', {
      timeZone,
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: pattern.includes('h:mm') ? 'numeric' : undefined,
      minute: pattern.includes('h:mm') ? '2-digit' : undefined,
      hour12: pattern.includes('h:mm') ? true : undefined
    }).formatToParts(date).reduce((acc, part) => {
      acc[part.type] = part.value;
      return acc;
    }, {});
    const dateText = `${friendlyParts.day} ${friendlyParts.month} ${friendlyParts.year}`;
    if (pattern === 'd MMMM yyyy') {
      return dateText;
    }
    return `${dateText} ${friendlyParts.hour}:${friendlyParts.minute} ${String(friendlyParts.dayPeriod || '').toUpperCase()}`;
  }
  return date.toISOString();
}

function psql(sql) {
  const result = spawnSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', process.env.DATABASE_URL || ''], {
    input: sql,
    encoding: 'utf8',
    env: process.env
  });
  if (result.status !== 0) {
    throw new Error(`psql failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

function psqlRows(sql) {
  const output = psql(`\\pset format unaligned\n\\pset tuples_only on\n\\pset fieldsep '\\t'\n${sql}`);
  return output.split(/\r?\n/).filter(Boolean).map(line => {
    const [name, rows] = line.split('\t');
    return { name, rows };
  });
}

function psqlJsonRows(sql) {
  const output = psql(`\\pset format unaligned\n\\pset tuples_only on\n${sql}`);
  return output.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
}

function sqlText(value) {
  return dollarQuote(String(value === null || value === undefined ? '' : value));
}

function sqlJson(value) {
  return `${dollarQuote(JSON.stringify(value || {}))}::jsonb`;
}

function dollarQuote(value) {
  let tag = `codex_${crypto.randomBytes(8).toString('hex')}`;
  while (String(value).includes(`$${tag}$`)) {
    tag = `codex_${crypto.randomBytes(8).toString('hex')}`;
  }
  return `$${tag}$${value}$${tag}$`;
}

function uniqueFieldNames(fieldNames) {
  return (fieldNames || []).filter((fieldName, index) => fieldNames.indexOf(fieldName) === index);
}

function parseJsonArray(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    return [];
  }
}

function parseJsonObject(value) {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (err) {
    return {};
  }
}

function cellValue(value) {
  return value === null || value === undefined ? '' : value;
}

function dateCellValue(value) {
  if (isDateObject(value)) {
    return formatDatePattern(value, 'Australia/Sydney', 'yyyy-MM-dd');
  }
  return String(value === null || value === undefined ? '' : value).trim();
}

function timeCellValue(value) {
  if (isDateObject(value)) {
    return formatDatePattern(value, 'Australia/Sydney', 'HH:mm');
  }
  return String(value === null || value === undefined ? '' : value).trim();
}

function dateTimeCellValue(value) {
  if (isDateObject(value)) {
    return formatDatePattern(value, 'Australia/Sydney', "yyyy-MM-dd'T'HH:mm:ssXXX");
  }
  return String(value === null || value === undefined ? '' : value).trim();
}

function isDateObject(value) {
  return Object.prototype.toString.call(value) === '[object Date]' && !Number.isNaN(value.getTime());
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function redactDatabaseUrl(value) {
  return String(value || '').replace(/:\/\/([^:]+):([^@]+)@/, '://$1:***@');
}

module.exports = {
  createNativeRuntime
};
