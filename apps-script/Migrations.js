/**
 * One-time data migration helpers.
 *
 * These functions are intentionally not exposed in the web dashboard. Run them
 * manually from the Apps Script editor when upgrading an older spreadsheet.
 */

function migrateLegacyRequestRows() {
  ensureReady_();

  const ss = getDatabase_();
  const legacySheet = ss.getSheetByName(SHEETS.LEGACY_REQUESTS);
  if (!legacySheet || legacySheet.getLastRow() < 2) {
    return {
      ok: true,
      migrated: 0,
      skippedExisting: 0,
      skippedInvalid: 0,
      archivedSheetName: '',
      message: 'No legacy Requests rows were found to migrate.'
    };
  }

  const legacyRows = getLegacyRequestsFromSheet_(legacySheet);
  const summary = {
    ok: true,
    migrated: 0,
    skippedExisting: 0,
    skippedInvalid: 0,
    archivedSheetName: '',
    statusChanges: {},
    stageChanges: {}
  };

  legacyRows.forEach(function (legacyRecord) {
    if (!legacyRecord.requestId) {
      summary.skippedInvalid += 1;
      return;
    }

    const migrated = migrateLegacyRequestRecord_(legacyRecord);
    if (targetRequestExists_(migrated)) {
      summary.skippedExisting += 1;
      return;
    }

    recordMigrationChange_(summary.statusChanges, legacyRecord.status, migrated.status);
    recordMigrationChange_(summary.stageChanges, legacyRecord.activeApprovalStage, migrated.activeApprovalStage);
    appendRequest_(migrated);
    summary.migrated += 1;
  });

  if (summary.skippedInvalid === 0 && legacyRows.length) {
    summary.archivedSheetName = archiveLegacyRequestSheet_(ss, legacySheet);
  }

  logEvent_('', getCurrentUserEmail_() || 'script', 'LEGACY_REQUESTS_MIGRATED', summary);
  summary.message = `Migrated ${summary.migrated} legacy request row(s), skipped ${summary.skippedExisting} existing row(s), and archived the legacy Requests tab as ${summary.archivedSheetName || 'not archived'}.`;
  return summary;
}

function migrateLegacyRequestRecord_(legacyRecord) {
  const processKey = legacyProcessKey_(legacyRecord);
  const migrated = emptyRequestRecord_(processKey);

  Object.keys(legacyRecord).forEach(function (fieldName) {
    if (fieldName.charAt(0) === '_') {
      return;
    }
    if (Object.prototype.hasOwnProperty.call(migrated, fieldName)) {
      migrated[fieldName] = legacyRecord[fieldName];
    }
  });

  migrated.processType = processKey;
  migrated.status = migrateLegacyStatus_(legacyRecord.status, legacyRecord);
  migrated.activeApprovalStage = migrateLegacyStage_(legacyRecord.activeApprovalStage);
  migrated.approvalCompletedAt = legacyRecord.approvalCompletedAt || legacyRecord.preapprovalCompletedAt || '';
  migrated.approvalHistory = migrationHistoryJson_(legacyRecord.approvalHistory || legacyRecord.preapprovalHistory);
  migrated.finalApprovalHistory = migrationHistoryJson_(legacyRecord.finalApprovalHistory);
  migrated.changeHistory = migrationHistoryJson_(legacyRecord.changeHistory);

  if (!isPendingStatus_(migrated.status)) {
    migrated.activeApprovalTokenHash = '';
    migrated.activeApprovalStage = '';
    migrated.activeApprovalStepIndex = '';
    migrated.activeApprovalStepName = '';
    migrated.activeApprovalStepEmail = '';
  }

  return migrated;
}

function getLegacyRequestsFromSheet_(sheet) {
  const lastRow = sheet.getLastRow();
  const lastColumn = sheet.getLastColumn();
  if (lastRow < 2 || lastColumn < 1) {
    return [];
  }

  const headers = sheet.getRange(1, 1, 1, lastColumn).getValues()[0]
    .map(function (header, index) {
      return trim_(header) || `__legacyBlankColumn${index + 1}`;
    });
  const values = sheet.getRange(2, 1, lastRow - 1, lastColumn).getValues();
  return values.map(function (row, index) {
    return rowToRequest_(row, index + 2, sheet.getName ? sheet.getName() : '', headers);
  });
}

function legacyProcessKey_(record) {
  const explicit = trim_(record.processType);
  if (explicit) {
    return normalizeProcessKey_(explicit);
  }

  const requestId = trim_(record.requestId).toUpperCase();
  if (requestId.indexOf('VTR-') === 0) {
    return 'vtr';
  }

  return 'overtime';
}

function migrateLegacyStatus_(status, record) {
  const value = trim_(status);
  const mappings = {};
  mappings.PENDING_PREAPPROVAL = STATUS.PENDING_APPROVAL;
  mappings.NEEDS_PREAPPROVAL_CHANGES = STATUS.NEEDS_APPROVAL_CHANGES;
  mappings.PREAPPROVAL_DENIED = STATUS.APPROVAL_DENIED;
  mappings.PREAPPROVED_AWAITING_ACTUAL_HOURS = record && record.followUpSentAt
    ? STATUS.AWAITING_ACTUAL_HOURS
    : STATUS.PREAPPROVED;
  return mappings[value] || value;
}

function migrateLegacyStage_(stage) {
  const value = trim_(stage);
  return value === 'preapproval' ? 'approval' : value;
}

function migrationHistoryJson_(value) {
  const parsed = parseJsonArray_(value);
  return JSON.stringify(parsed);
}

function targetRequestExists_(record) {
  const targetSheet = getRequestSheet_(record);
  return getRequestsFromSheet_(targetSheet).some(function (existing) {
    return existing.requestId === record.requestId;
  });
}

function recordMigrationChange_(changes, fromValue, toValue) {
  const from = trim_(fromValue);
  const to = trim_(toValue);
  if (from === to) {
    return;
  }
  const key = `${from || '(blank)'} -> ${to || '(blank)'}`;
  changes[key] = (changes[key] || 0) + 1;
}

function archiveLegacyRequestSheet_(ss, sheet) {
  const archiveName = uniqueSheetName_(ss, `${SHEETS.LEGACY_REQUESTS} Migrated ${todayKey_()}`);
  if (typeof sheet.setName === 'function') {
    sheet.setName(archiveName);
    return archiveName;
  }
  return '';
}

function uniqueSheetName_(ss, baseName) {
  let name = baseName;
  let counter = 2;
  while (ss.getSheetByName(name)) {
    name = `${baseName} ${counter}`;
    counter += 1;
  }
  return name;
}
