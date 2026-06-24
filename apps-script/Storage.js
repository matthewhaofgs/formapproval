/**
 * Spreadsheet persistence and audit logging.
 */

function getDatabase_() {
  const props = PropertiesService.getScriptProperties();
  const configuredSpreadsheetId = trim_(APP_SETTINGS.SPREADSHEET_ID);
  const propertySpreadsheetId = trim_(props.getProperty('SPREADSHEET_ID'));
  let spreadsheetId = configuredSpreadsheetId || propertySpreadsheetId;

  if (spreadsheetId) {
    const spreadsheet = SpreadsheetApp.openById(spreadsheetId);
    if (configuredSpreadsheetId && configuredSpreadsheetId !== propertySpreadsheetId) {
      props.setProperty('SPREADSHEET_ID', configuredSpreadsheetId);
    }
    return spreadsheet;
  }

  const active = SpreadsheetApp.getActiveSpreadsheet();
  if (active) {
    spreadsheetId = active.getId();
    props.setProperty('SPREADSHEET_ID', spreadsheetId);
    return active;
  }

  const created = SpreadsheetApp.create(APP_SETTINGS.DATABASE_NAME);
  props.setProperty('SPREADSHEET_ID', created.getId());
  return created;
}

function getDatabaseDiagnostic(payload) {
  requireAdminEmail_(payload || {});
  return databaseDiagnostic_();
}

function databaseDiagnostic_() {
  const props = PropertiesService.getScriptProperties();
  const configuredSpreadsheetId = trim_(APP_SETTINGS.SPREADSHEET_ID);
  const propertySpreadsheetId = trim_(props.getProperty('SPREADSHEET_ID'));
  const spreadsheet = getDatabase_();
  const sheets = typeof spreadsheet.getSheets === 'function'
    ? spreadsheet.getSheets().map(function (sheet) {
      return {
        name: sheet.getName(),
        rows: sheet.getLastRow(),
        columns: sheet.getLastColumn()
      };
    })
    : [];

  return {
    ok: true,
    appVersion: APP_SETTINGS.APP_VERSION || '',
    spreadsheetId: spreadsheet.getId(),
    spreadsheetUrl: spreadsheet.getUrl(),
    source: configuredSpreadsheetId
      ? 'APP_SETTINGS.SPREADSHEET_ID'
      : (propertySpreadsheetId ? 'Script Property SPREADSHEET_ID' : 'fallback'),
    configuredSpreadsheetId,
    scriptPropertySpreadsheetId: trim_(props.getProperty('SPREADSHEET_ID')),
    sheets
  };
}

function ensureReady_(options) {
  const ss = getDatabase_();
  ensureSheet_(ss, SHEETS.EVENTS, EVENT_HEADERS);
  ensureConfigSheet_(ss, options || {});
  ensureProcessRequestSheets_(ss);
}

function ensureProcessRequestSheets_(ss) {
  getProcessOptions_().forEach(function (process) {
    ensureRequestSheet_(ss, process.requestSheetName, getRequestHeaders_(process.key));
  });
}

function ensureConfigSheet_(ss, options) {
  const sheet = ensureSheet_(ss, SHEETS.CONFIG, CONFIG_HEADERS);
  let seeded = false;
  if (sheet.getLastRow() < 2) {
    buildDefaultConfigRows_().forEach(function (row) {
      sheet.appendRow(CONFIG_HEADERS.map(function (header) {
        return cellValue_(row[header]);
      }));
    });
    seeded = true;
  }
  if ((options && options.protectConfig) || seeded) {
    protectConfigSheet_(sheet);
  }
  return sheet;
}

function protectConfigSheet_(sheet) {
  try {
    if (!sheet || typeof sheet.protect !== 'function') {
      return;
    }
    const protection = sheet.protect().setDescription('Workflow and process configuration');
    protection.setWarningOnly(false);
  } catch (err) {
    // Sheet protection can fail under limited test or delegated contexts; setup should continue.
  }
}

function ensureSheet_(ss, sheetName, headers) {
  let sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    sheet = ss.insertSheet(sheetName);
  }

  if (sheet.getLastRow() === 0) {
    sheet.appendRow(headers);
    sheet.setFrozenRows(1);
    return sheet;
  }

  const existing = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), headers.length)).getValues()[0];
  const existingSet = {};
  existing.forEach(function (header) {
    if (header) {
      existingSet[header] = true;
    }
  });

  const missing = headers.filter(function (header) {
    return !existingSet[header];
  });

  if (missing.length) {
    sheet.getRange(1, existing.length + 1, 1, missing.length).setValues([missing]);
  }

  sheet.setFrozenRows(1);
  return sheet;
}

function ensureRequestSheet_(ss, sheetName, headers) {
  const sheet = ensureSheet_(ss, sheetName, headers);
  pruneBlankNonHeaderColumns_(sheet, headers);
  return sheet;
}

function pruneBlankNonHeaderColumns_(sheet, desiredHeaders) {
  if (!sheet || typeof sheet.deleteColumn !== 'function' || sheet.getLastRow() < 1) {
    return;
  }

  const desired = {};
  desiredHeaders.forEach(function (header) {
    desired[header] = true;
  });

  const lastColumn = sheet.getLastColumn();
  const existingHeaders = sheet.getRange(1, 1, 1, lastColumn).getValues()[0];
  for (let column = existingHeaders.length; column >= 1; column -= 1) {
    const header = trim_(existingHeaders[column - 1]);
    if (!header || desired[header]) {
      continue;
    }
    if (requestSheetColumnHasData_(sheet, column)) {
      continue;
    }
    sheet.deleteColumn(column);
  }
}

function requestSheetColumnHasData_(sheet, column) {
  if (sheet.getLastRow() < 2) {
    return false;
  }
  return sheet.getRange(2, column, sheet.getLastRow() - 1, 1).getValues().some(function (row) {
    return trim_(row[0]) !== '';
  });
}

function getRequestHeaders_(processOrRequest) {
  const headers = REQUEST_HEADERS.slice();
  getProcessOperationalRequestHeaders_(processOrRequest).forEach(function (fieldName) {
    if (headers.indexOf(fieldName) === -1) {
      headers.push(fieldName);
    }
  });
  getSchemaRequestFieldNames_(processOrRequest).forEach(function (fieldName) {
    if (headers.indexOf(fieldName) === -1) {
      headers.push(fieldName);
    }
  });
  return headers;
}

function getProcessOperationalRequestHeaders_(processOrRequest) {
  const process = processOrRequest || getDefaultProcessKey_();
  if (getProcessCompletionMode_(process) === 'actual_hours') {
    return [
      'followUpDueDate',
      'followUpSentAt',
      'actualSubmittedAt',
      'finalApprovedAt',
      'finalApprovalHistory'
    ];
  }
  const checklistDefinition = getFormDefinition_(process, 'checklist');
  if (checklistDefinition && checklistDefinition.key) {
    return [
      'followUpSentAt',
      'checklistSubmittedAt',
      'checklistCompletedAt',
      'finalApprovedAt'
    ];
  }
  return [];
}

function getSchemaRequestFieldNames_(processOrRequest) {
  const fieldNames = [];
  try {
    getAllFormDefinitions_(processOrRequest || getDefaultProcessKey_()).forEach(function (definition) {
      flattenFormFields_(definition).forEach(function (field) {
        if (field.name) {
          fieldNames.push(field.name);
        }
      });
      (definition.computedFields || []).forEach(function (field) {
        if (field.field) {
          fieldNames.push(field.field);
        }
      });
    });
  } catch (err) {
    return [];
  }
  return fieldNames.filter(function (fieldName, index) {
    return fieldNames.indexOf(fieldName) === index;
  });
}

function getSchemaRequestFieldNamesByType_(processOrRequest, type) {
  const fieldNames = [];
  try {
    getAllFormDefinitions_(processOrRequest || getDefaultProcessKey_()).forEach(function (definition) {
      flattenFormFields_(definition).forEach(function (field) {
        if (field.name && field.type === type) {
          fieldNames.push(field.name);
        }
      });
    });
  } catch (err) {
    return [];
  }
  return fieldNames.filter(function (fieldName, index) {
    return fieldNames.indexOf(fieldName) === index;
  });
}

function getSheetHeaders_(sheet, defaultHeaders) {
  const headers = defaultHeaders || REQUEST_HEADERS;
  if (!sheet || sheet.getLastRow() === 0) {
    return headers.slice();
  }
  const lastColumn = Math.max(sheet.getLastColumn(), headers.length);
  const existing = sheet.getRange(1, 1, 1, lastColumn).getValues()[0]
    .map(trim_)
    .filter(Boolean);
  return existing.length ? existing : headers.slice();
}

function uniqueFieldNames_(fieldNames) {
  return fieldNames.filter(function (fieldName, index) {
    return fieldNames.indexOf(fieldName) === index;
  });
}

function getRequestSheet_(processOrRequest) {
  const ss = getDatabase_();
  const sheetName = getProcessRequestSheetName_(processOrRequest || getDefaultProcessKey_());
  return ensureRequestSheet_(ss, sheetName, getRequestHeaders_(processOrRequest || getDefaultProcessKey_()));
}

function getRequestSheetForRecord_(record) {
  const ss = getDatabase_();
  if (record && record._sheetName) {
    const existing = ss.getSheetByName(record._sheetName);
    if (existing) {
      return ensureRequestSheet_(ss, record._sheetName, getRequestHeaders_(record));
    }
  }
  return getRequestSheet_(record);
}

function getAllRequestSheets_() {
  const ss = getDatabase_();
  const seen = {};
  const sheets = [];

  getProcessOptions_().forEach(function (process) {
    const sheet = ss.getSheetByName(process.requestSheetName);
    if (sheet && !seen[process.requestSheetName]) {
      sheets.push(sheet);
      seen[process.requestSheetName] = true;
    }
  });

  const legacy = ss.getSheetByName(SHEETS.LEGACY_REQUESTS);
  if (legacy && !seen[SHEETS.LEGACY_REQUESTS]) {
    sheets.push(legacy);
  }

  return sheets;
}

function appendRequest_(record) {
  const sheet = getRequestSheet_(record);
  const headers = getSheetHeaders_(sheet, getRequestHeaders_(record));
  const row = headers.map(function (header) {
    return cellValue_(record[header]);
  });
  sheet.appendRow(row);
  record._rowNumber = sheet.getLastRow();
  record._sheetName = sheet.getName ? sheet.getName() : getProcessRequestSheetName_(record);
}

function updateRequest_(record) {
  if (!record._rowNumber) {
    throw new Error('Cannot update a request without a row number.');
  }

  const sheet = getRequestSheetForRecord_(record);
  const headers = getSheetHeaders_(sheet, getRequestHeaders_(record));
  const row = headers.map(function (header) {
    return cellValue_(record[header]);
  });
  sheet.getRange(record._rowNumber, 1, 1, headers.length).setValues([row]);
}

function getAllRequests_() {
  return getAllRequestSheets_().reduce(function (records, sheet) {
    return records.concat(getRequestsFromSheet_(sheet));
  }, []);
}

function getRequestsForProcess_(processKey) {
  const requested = normalizeProcessKey_(processKey || getDefaultProcessKey_());
  const ss = getDatabase_();
  const records = [];
  const sheetName = getProcessRequestSheetName_(requested);
  const sheet = ss.getSheetByName(sheetName);
  if (sheet) {
    records.push.apply(records, getRequestsFromSheet_(sheet));
  }

  const legacy = ss.getSheetByName(SHEETS.LEGACY_REQUESTS);
  if (legacy && sheetName !== SHEETS.LEGACY_REQUESTS) {
    getRequestsFromSheet_(legacy).forEach(function (record) {
      if (processKeyForRequest_(record) === requested) {
        records.push(record);
      }
    });
  }

  return records;
}

function getRequestsFromSheet_(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return [];
  }

  const headers = getSheetHeaders_(sheet, REQUEST_HEADERS);
  const values = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
  return values.map(function (row, index) {
    return rowToRequest_(row, index + 2, sheet.getName ? sheet.getName() : '', headers);
  });
}

function getAllEvents_() {
  const sheet = getDatabase_().getSheetByName(SHEETS.EVENTS);
  if (!sheet) {
    return [];
  }

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return [];
  }

  const values = sheet.getRange(2, 1, lastRow - 1, EVENT_HEADERS.length).getValues();
  return values.map(function (row) {
    const record = {};
    EVENT_HEADERS.forEach(function (header, index) {
      record[header] = row[index];
    });
    record.timestamp = dateTimeCellValue_(record.timestamp);
    return record;
  });
}

function rowToRequest_(row, rowNumber, sheetName, headers) {
  const record = {
    _rowNumber: rowNumber,
    _sheetName: sheetName || ''
  };
  (headers || REQUEST_HEADERS).forEach(function (header, index) {
    record[header] = row[index];
  });
  return normalizeRequestRecord_(record);
}

function getRequestById_(requestId) {
  return getAllRequests_().find(function (record) {
    return record.requestId === requestId;
  }) || null;
}

function findRequestByToken_(token, tokenType) {
  const hash = hashToken_(token);
  const field = tokenType === 'employee' ? 'employeeActionTokenHash' : 'activeApprovalTokenHash';
  return getAllRequests_().find(function (record) {
    return record[field] && record[field] === hash;
  }) || null;
}

function logEvent_(requestId, actorEmail, event, details) {
  const sheet = getDatabase_().getSheetByName(SHEETS.EVENTS);
  sheet.appendRow([
    nowIso_(),
    requestId,
    actorEmail || '',
    event,
    JSON.stringify(details || {})
  ]);
}

function emptyRequestRecord_(processOrRequest) {
  const record = {};
  getRequestHeaders_(processOrRequest || getDefaultProcessKey_()).forEach(function (header) {
    record[header] = '';
  });
  return record;
}

function normalizeRequestRecord_(record) {
  record.processType = processKeyForRequest_(record);
  uniqueFieldNames_([
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
  ]).forEach(function (field) {
    record[field] = dateTimeCellValue_(record[field]);
  });
  uniqueFieldNames_([
    'overtimeDate',
    'eventDate',
    'followUpDueDate'
  ].concat(getSchemaRequestFieldNamesByType_(record, 'date'))).forEach(function (field) {
    record[field] = dateCellValue_(record[field]);
  });
  uniqueFieldNames_([
    'normalStartTime',
    'normalFinishTime',
    'plannedStartTime',
    'plannedFinishTime',
    'actualStartTime',
    'actualFinishTime'
  ].concat(getSchemaRequestFieldNamesByType_(record, 'time'))).forEach(function (field) {
    record[field] = timeCellValue_(record[field]);
  });
  return record;
}

function dateCellValue_(value) {
  if (isDateObject_(value)) {
    return Utilities.formatDate(value, APP_SETTINGS.TIME_ZONE, 'yyyy-MM-dd');
  }
  return trim_(value);
}

function timeCellValue_(value) {
  if (isDateObject_(value)) {
    return Utilities.formatDate(value, APP_SETTINGS.TIME_ZONE, 'HH:mm');
  }
  return trim_(value);
}

function dateTimeCellValue_(value) {
  if (isDateObject_(value)) {
    return Utilities.formatDate(value, APP_SETTINGS.TIME_ZONE, "yyyy-MM-dd'T'HH:mm:ssXXX");
  }
  return trim_(value);
}

function isDateObject_(value) {
  return Object.prototype.toString.call(value) === '[object Date]' && !isNaN(value.getTime());
}

function parseJsonArray_(value) {
  if (!value) {
    return [];
  }

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    return [];
  }
}

function parseJsonObject_(value) {
  if (!value) {
    return {};
  }

  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (err) {
    return {};
  }
}

function cellValue_(value) {
  return value === null || value === undefined ? '' : value;
}
