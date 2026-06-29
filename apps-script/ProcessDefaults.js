/**
 * Runtime helpers for database-backed process definitions.
 *
 * The source of truth for process settings, workflow routing, admin access,
 * and email routing is PostgreSQL app_definitions where category =
 * "process_definition". Do not add live process definitions here.
 * Native runtime and regression tests populate DEFAULT_PROCESS_DEFINITIONS from
 * the live database before these helpers are used.
 */

const DEFAULT_PROCESS_DEFINITIONS = {};

function getDefaultProcessDefinitions_() {
  return cloneObject_(DEFAULT_PROCESS_DEFINITIONS);
}

function buildDefaultConfigRows_() {
  const rows = [{
    processKey: 'global',
    section: 'setting',
    setting: 'ADMIN_EMAILS',
    valueJson: JSON.stringify(DEFAULT_ADMIN_EMAILS),
    enabled: 'Yes',
    notes: 'Global admin dashboard access list.'
  }];

  Object.keys(DEFAULT_PROCESS_DEFINITIONS).forEach(function (processKey) {
    const definition = DEFAULT_PROCESS_DEFINITIONS[processKey];
    rows.push({
      processKey,
      processName: definition.name,
      section: 'setting',
      setting: 'requestIdPrefix',
      valueJson: JSON.stringify(definition.requestIdPrefix),
      enabled: definition.enabled === false ? 'No' : 'Yes',
      notes: 'Prefix used when new request IDs are generated for this process.'
    });
    rows.push({
      processKey,
      processName: definition.name,
      section: 'setting',
      setting: 'requestSheetName',
      valueJson: JSON.stringify(definition.requestSheetName || getProcessRequestSheetName_(definition)),
      enabled: definition.enabled === false ? 'No' : 'Yes',
      notes: 'Request rows for this process are stored in this tab.'
    });
    rows.push({
      processKey,
      processName: definition.name,
      section: 'setting',
      setting: 'requestForm',
      valueJson: JSON.stringify(definition.requestForm || ''),
      enabled: definition.enabled === false ? 'No' : 'Yes',
      notes: 'Frontend form key. Leave blank until a form UI exists.'
    });
    rows.push({
      processKey,
      processName: definition.name,
      section: 'setting',
      setting: 'completionMode',
      valueJson: JSON.stringify(definition.completionMode || 'actual_hours'),
      enabled: definition.enabled === false ? 'No' : 'Yes',
      notes: 'actual_hours runs a final employee confirmation stage; single_stage closes the request when approval workflow completes.'
    });
    rows.push({
      processKey,
      processName: definition.name,
      section: 'setting',
      setting: 'description',
      valueJson: JSON.stringify(definition.description || ''),
      enabled: definition.enabled === false ? 'No' : 'Yes',
      notes: 'Shown on the form chooser page.'
    });
    rows.push({
      processKey,
      processName: definition.name,
      section: 'setting',
      setting: 'adminEmails',
      valueJson: JSON.stringify(definition.adminEmails || []),
      enabled: definition.enabled === false ? 'No' : 'Yes',
      notes: 'Process-specific admin dashboard users. Global admins can administer every process.'
    });
    rows.push({
      processKey,
      processName: definition.name,
      section: 'setting',
      setting: 'paymentNotificationEmails',
      valueJson: JSON.stringify(definition.paymentNotificationEmails || []),
      enabled: definition.enabled === false ? 'No' : 'Yes',
      notes: 'Final payment/action notification recipients.'
    });
    Object.keys(definition.workflows || {}).forEach(function (stage) {
      (definition.workflows[stage] || []).forEach(function (step, index) {
        rows.push(workflowStepToConfigRow_(definition, stage, step, index));
      });
    });
  });

  return rows;
}

function buildDefaultConfigRowsWithTestEmails_(processKeys) {
  const processKeySet = testModeProcessKeySet_(processKeys);
  return buildDefaultConfigRows_().map(function (row) {
    if (processKeySet && !processKeySet[row.processKey]) {
      return Object.assign({}, row);
    }
    const testRow = Object.assign({}, row);
    testRow.email = testModeEmail_(testRow.email);
    testRow.emails = testModeEmailList_(testRow.emails);
    testRow.valueJson = testModeValueJson_(testRow.valueJson);
    return testRow;
  });
}

function testModeProcessKeySet_(processKeys) {
  if (!processKeys || !processKeys.length) {
    return null;
  }

  const set = {};
  processKeys.forEach(function (processKey) {
    const key = trim_(processKey).toLowerCase();
    if (key) {
      set[key] = true;
    }
  });
  return Object.keys(set).length ? set : null;
}

function testModeEmail_(email) {
  const value = trim_(email);
  if (!value || value.indexOf('@') === -1) {
    return value;
  }

  const match = value.match(/^([^@\s]+)@([^@\s]+)$/);
  if (!match) {
    return value;
  }

  if (match[1].toLowerCase().indexOf('smtp+') === 0) {
    return value;
  }

  return `smtp+${match[1]}@${match[2]}`;
}

function testModeEmailList_(emails) {
  return trim_(emails)
    .split(',')
    .map(function (email) {
      return testModeEmail_(email);
    })
    .filter(Boolean)
    .join(', ');
}

function testModeValueJson_(valueJson) {
  const value = trim_(valueJson);
  if (!value) {
    return '';
  }

  try {
    return JSON.stringify(testModeValue_(JSON.parse(value)));
  } catch (err) {
    return testModeEmail_(value);
  }
}

function testModeValue_(value) {
  if (Array.isArray(value)) {
    return value.map(function (item) {
      return testModeValue_(item);
    });
  }

  if (value && typeof value === 'object') {
    const copy = {};
    Object.keys(value).forEach(function (key) {
      copy[key] = testModeValue_(value[key]);
    });
    return copy;
  }

  if (typeof value === 'string') {
    return testModeEmail_(value);
  }

  return value;
}

function workflowStepToConfigRow_(definition, stage, step, index) {
  return {
    processKey: definition.key,
    processName: definition.name,
    section: 'workflow',
    stage,
    stepOrder: index + 1,
    type: step.type || 'approval',
    name: step.name || '',
    email: step.email || '',
    emails: (step.emails || []).join(', '),
    emailField: step.emailField || '',
    emailFields: (step.emailFields || []).join(', '),
    ccEmails: (step.ccEmails || []).join(', '),
    subject: step.subject || '',
    message: step.message || '',
    waitingLabel: isBlockingWorkflowStepType_(step.type || 'approval') ? (step.waitingLabel || defaultWorkflowWaitingLabel_()) : '',
    whenJson: step.when ? JSON.stringify(step.when) : '',
    unlessJson: step.unless ? JSON.stringify(step.unless) : '',
    followUpStage: step.followUpStage || '',
    requireComment: step.requireComment ? 'Yes' : '',
    enabled: definition.enabled === false ? 'No' : 'Yes',
    notes: 'Workflow steps run in stage/order sequence. Types: approval, acknowledgement, action, notification. Optional followUpStage starts an employee follow-up form after the step completes.'
  };
}

/**
 * Replace the spreadsheet Config tab with the currently loaded process definitions.
 *
 * This is intentionally not connected to the web UI. Run it manually from the
 * Apps Script editor only in legacy spreadsheet harness contexts. Native
 * production reads live definitions from PostgreSQL app_definitions.
 */
function replaceWorksheetConfigWithLoadedDefinitions() {
  const ss = getDatabase_();
  const sheet = ss.getSheetByName(SHEETS.CONFIG) || ss.insertSheet(SHEETS.CONFIG);
  const rows = buildDefaultConfigRows_();

  replaceSheetContents_(sheet, CONFIG_HEADERS, rows);
  protectConfigSheet_(sheet);
  ensureProcessRequestSheets_(ss);

  return {
    ok: true,
    sheetName: SHEETS.CONFIG,
    rowsWritten: rows.length,
    message: `Replaced ${SHEETS.CONFIG} with ${rows.length} loaded definition Config rows.`
  };
}

/**
 * Replace the spreadsheet Config tab with loaded definitions and test recipients.
 *
 * This is the same operation as replaceWorksheetConfigWithLoadedDefinitions(), but
 * literal configured email addresses are rewritten to smtp+ aliases. Dynamic
 * email fields such as lineManagerEmail remain as field references.
 */
function replaceWorksheetConfigWithTestEmailDefinitions() {
  const ss = getDatabase_();
  const sheet = ss.getSheetByName(SHEETS.CONFIG) || ss.insertSheet(SHEETS.CONFIG);
  const rows = buildDefaultConfigRowsWithTestEmails_();

  replaceSheetContents_(sheet, CONFIG_HEADERS, rows);
  protectConfigSheet_(sheet);
  ensureProcessRequestSheets_(ss);

  return {
    ok: true,
    sheetName: SHEETS.CONFIG,
    rowsWritten: rows.length,
    message: `Replaced ${SHEETS.CONFIG} with ${rows.length} loaded definition Config rows using smtp+ test email aliases.`
  };
}

/**
 * Replace the spreadsheet Config tab with VTR-only test-recipient routing.
 *
 * Overtime and global settings keep their loaded email addresses.
 * Only literal configured email addresses on VTR rows are rewritten to smtp+
 * aliases. Dynamic email fields remain as field references.
 */
function replaceWorksheetConfigWithVtrTestEmailDefinitions() {
  const ss = getDatabase_();
  const sheet = ss.getSheetByName(SHEETS.CONFIG) || ss.insertSheet(SHEETS.CONFIG);
  const rows = buildDefaultConfigRowsWithTestEmails_(['vtr']);

  replaceSheetContents_(sheet, CONFIG_HEADERS, rows);
  protectConfigSheet_(sheet);
  ensureProcessRequestSheets_(ss);

  return {
    ok: true,
    sheetName: SHEETS.CONFIG,
    rowsWritten: rows.length,
    message: `Replaced ${SHEETS.CONFIG} with ${rows.length} loaded definition Config rows using smtp+ test email aliases for VTR only.`
  };
}

function replaceSheetContents_(sheet, headers, rows) {
  if (typeof sheet.clearContents === 'function') {
    sheet.clearContents();
  } else if (sheet.getLastRow() > 0 && typeof sheet.getRange === 'function') {
    const columnCount = Math.max(sheet.getLastColumn(), headers.length);
    sheet.getRange(1, 1, sheet.getLastRow(), columnCount).clearContent();
  }

  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  if (rows.length) {
    sheet.getRange(2, 1, rows.length, headers.length).setValues(rows.map(function (row) {
      return headers.map(function (header) {
        return cellValue_(row[header]);
      });
    }));
  }
  sheet.setFrozenRows(1);
}
