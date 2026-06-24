const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createAppsScriptHarness,
  defaultActual,
  defaultRequest,
  defaultVtrRequest
} = require('./helpers/appsScriptHarness');

const CANONICAL_URL = 'https://script.google.com/a/example.edu/macros/s/TEST_DEPLOYMENT/exec';

function submit(harness, overrides = {}) {
  return harness.api.submitRequest(defaultRequest(overrides));
}

function currentRequest(harness) {
  const requests = harness.requests;
  assert.equal(requests.length, 1);
  return requests[0];
}

function latestWorkflowToken(harness, recipient) {
  const message = harness.latestMail(mail =>
    (!recipient || mail.to === recipient) &&
    /approval|acknowledgement|pre-approval|action/i.test(mail.subject || '') &&
    /mode=(?:approve|decision)/.test(String(mail.htmlBody || ''))
  );
  const token = harness.tokenFromMail(message, 'decision') || harness.tokenFromMail(message, 'approve');
  assert.ok(token, `Expected approval token in mail to ${recipient || 'latest workflow owner'}`);
  return token;
}

function vtrWorkflowStepNames(harness, overrides = {}, stage = 'approval') {
  const request = harness.api.validateRequestForm_(quietVtrRequest(overrides));
  return Array.from(harness.api
    .resolveWorkflowSteps_(harness.api.getWorkflowConfigForStage_(stage, Object.assign(request, overrides)), Object.assign(request, overrides))
    .map(step => `${step.type}:${step.name}`));
}

function vtrWorkflowEmail(harness, stepName, stage = 'approval') {
  const workflow = (harness.api.getProcessDefinitions_().vtr.workflows[stage] || []);
  const step = workflow.find(candidate => candidate.name === stepName);
  assert.ok(step, `Expected VTR ${stage} workflow step "${stepName}"`);
  assert.ok(step.email, `Expected VTR ${stage} workflow step "${stepName}" to have an email`);
  return step.email;
}

function overtimeWorkflowEmail(harness, stepName, stage = 'approval') {
  const workflow = (harness.api.getProcessDefinitions_().overtime.workflows[stage] || []);
  const step = workflow.find(candidate => candidate.name === stepName);
  assert.ok(step, `Expected overtime ${stage} workflow step "${stepName}"`);
  assert.ok(step.email, `Expected overtime ${stage} workflow step "${stepName}" to have an email`);
  return step.email;
}

function latestActualToken(harness) {
  const message = harness.latestMail(mail =>
    /actual overtime hours|confirm actual/i.test(mail.subject || '') &&
    String(mail.htmlBody || '').includes('mode=actual')
  );
  const token = harness.tokenFromMail(message, 'actual');
  assert.ok(token, 'Expected actual-hours token in employee mail');
  return token;
}

function latestChecklistToken(harness) {
  const message = harness.latestMail(mail =>
    /complete VTR checklist/i.test(mail.subject || '') &&
    String(mail.htmlBody || '').includes('mode=checklist')
  );
  const token = harness.tokenFromMail(message, 'checklist');
  assert.ok(token, 'Expected VTR checklist token in employee mail');
  return token;
}

function latestEditToken(harness) {
  const message = harness.latestMail(mail =>
    /changes requested/i.test(mail.subject || '') &&
    String(mail.htmlBody || '').includes('mode=')
  );
  const token = harness.tokenFromMail(message, 'edit') || harness.tokenFromMail(message, 'actual');
  assert.ok(token, 'Expected edit token in change-request mail');
  return token;
}

function mailIncludesRecipient(mail, email) {
  const expected = String(email || '').toLowerCase();
  return String((mail && mail.to) || '')
    .split(',')
    .map(value => value.trim().toLowerCase())
    .includes(expected);
}

function setOvertimeApprovalWorkflow(harness, steps) {
  harness.api.DEFAULT_PROCESS_DEFINITIONS.overtime.workflows.approval = steps;
}

function setOvertimeFinalWorkflow(harness, steps) {
  harness.api.DEFAULT_PROCESS_DEFINITIONS.overtime.workflows.final = steps;
}

function configureSingleStepWorkflow(harness) {
  setOvertimeApprovalWorkflow(harness, [
    { type: 'approval', name: 'Line Manager', emailField: 'lineManagerEmail' }
  ]);
  setOvertimeFinalWorkflow(harness, [
    { type: 'approval', name: 'Final Approver', email: 'finalapprover@example.edu' }
  ]);
}

function setConfigSetting(harness, processKey, setting, value, enabled = 'Yes') {
  const sheet = harness.spreadsheet.getSheetByName('Config');
  const header = sheet.rows[0];
  const indexes = Object.fromEntries(header.map((name, index) => [name, index]));
  const row = sheet.rows.slice(1).find(candidate =>
    candidate[indexes.processKey] === processKey &&
    candidate[indexes.section] === 'setting' &&
    candidate[indexes.setting] === setting
  );
  assert.ok(row, `Expected ${processKey} ${setting} config row`);
  row[indexes.valueJson] = JSON.stringify(value);
  row[indexes.enabled] = enabled;
}

function setStoredRequestField(harness, requestId, fieldName, value) {
  const request = harness.requests.find(candidate => candidate.requestId === requestId);
  assert.ok(request, `Expected stored request ${requestId}`);
  const sheet = harness.spreadsheet.getSheetByName(request._sheetName);
  assert.ok(sheet, `Expected request sheet ${request._sheetName}`);
  const header = sheet.rows[0];
  const indexes = Object.fromEntries(header.map((name, index) => [name, index]));
  assert.ok(Object.prototype.hasOwnProperty.call(indexes, fieldName), `Expected request field ${fieldName}`);
  const row = sheet.rows.slice(1).find(candidate => candidate[indexes.requestId] === requestId);
  assert.ok(row, `Expected request row ${requestId}`);
  row[indexes[fieldName]] = value;
}

const LEGACY_OVERTIME_HEADERS = [
  'requestId',
  'createdAt',
  'updatedAt',
  'status',
  'employeeEmail',
  'employeeName',
  'lineManagerEmail',
  'isLineManagerRequester',
  'requesterEmail',
  'reason',
  'overtimeDate',
  'normallyWorks',
  'normalStartTime',
  'normalFinishTime',
  'plannedStartTime',
  'plannedFinishTime',
  'plannedHours',
  'mealRulesAcknowledged',
  'compensationMethod',
  'followUpDueDate',
  'followUpSentAt',
  'employeeActionTokenHash',
  'activeApprovalTokenHash',
  'activeApprovalStage',
  'activeApprovalStepIndex',
  'activeApprovalStepName',
  'activeApprovalStepEmail',
  'preapprovalCompletedAt',
  'actualSubmittedAt',
  'overtimeCompleteAcknowledged',
  'mealBreaksAcknowledged',
  'mealAllowance',
  'workedAsApproved',
  'actualStartTime',
  'actualFinishTime',
  'actualHours',
  'variationReason',
  'finalApprovedAt',
  'denialReason',
  'preapprovalHistory',
  'finalApprovalHistory',
  '',
  '',
  '',
  '',
  '',
  '',
  '',
  '',
  'changeRequestedAt',
  'changeRequestedByEmail',
  'changeRequestedByName',
  'changeStage',
  'changeComment',
  'lastEditedAt',
  'lastEditedByEmail',
  'changeHistory'
];

function appendLegacyOvertimeRow(harness, values) {
  const sheet = harness.spreadsheet.getSheetByName('Requests') || harness.spreadsheet.insertSheet('Requests');
  if (!sheet.rows.length) {
    sheet.appendRow(LEGACY_OVERTIME_HEADERS);
  }
  const row = LEGACY_OVERTIME_HEADERS.map((header, index) => {
    if (!header) {
      return values[`blank_${index}`] || '';
    }
    return Object.prototype.hasOwnProperty.call(values, header) ? values[header] : '';
  });
  sheet.appendRow(row);
}

function quietVtrRequest(overrides = {}) {
  return defaultVtrRequest(Object.assign({
    costToStudents: 'No',
    groundsItConsulted: 'N/A',
    groundsAfterHoursNotified: 'N/A',
    sportPdhpeConsulted: 'N/A',
    chaplaincyConsulted: 'N/A',
    canteenNotified: 'N/A',
    parentLetterProvided: 'N/A',
    busesBooked: 'N/A',
    marketingNotified: 'N/A'
  }, overrides));
}

function defaultVtrChecklist(overrides = {}) {
  return Object.assign({
    costToStudents: 'No',
    riskAssessmentCompleted: 'Yes',
    wwccConfirmed: 'N/A',
    budgetSubmitted: 'Yes',
    groundsItConsulted: 'N/A',
    groundsAfterHoursNotified: 'N/A',
    sportPdhpeConsulted: 'N/A',
    chaplaincyConsulted: 'N/A',
    canteenNotified: 'N/A',
    parentLetterChecked: 'Yes',
    parentLetterProvided: 'Yes',
    staffNotified: 'Yes',
    busesBooked: 'N/A',
    marketingNotified: 'N/A'
  }, overrides);
}

function preapproveSingleStepRequest(harness, overrides = {}) {
  configureSingleStepWorkflow(harness);
  const result = submit(harness, overrides);
  assert.equal(result.ok, true);
  const token = latestWorkflowToken(harness, overrides.lineManagerEmail || 'linemanager@example.edu');
  const previousActiveEmail = harness.state.activeEmail;
  harness.setActiveUser(overrides.lineManagerEmail || 'linemanager@example.edu');
  harness.api.submitApprovalDecision({ token, decision: 'approve' });
  harness.setActiveUser(previousActiveEmail);
  return currentRequest(harness);
}

test('setup repairs sheets and installs daily and weekly triggers', () => {
  const harness = createAppsScriptHarness();

  const result = harness.api.setup();

  assert.equal(result.ok, true);
  assert.ok(result.spreadsheetUrl.includes('/spreadsheet-1/'));
  assert.equal(result.webAppUrl, CANONICAL_URL);
  assert.deepEqual(
    harness.state.triggers.map(trigger => trigger.getHandlerFunction()).sort(),
    ['sendDueActualHoursRequests', 'sendWeeklyPendingReminders']
  );
  assert.ok(harness.spreadsheet.getSheetByName('Overtime Requests'));
  assert.ok(harness.spreadsheet.getSheetByName('VTR Requests'));
  assert.ok(harness.spreadsheet.getSheetByName('Events'));
  assert.ok(harness.spreadsheet.getSheetByName('Config'));
});

test('code-configured spreadsheet ID overrides a stale script property', () => {
  const configuredTestSheetId = 'spreadsheet-1';
  const staleTestSheetId = 'stale-spreadsheet-id';
  const harness = createAppsScriptHarness({
    activeEmail: 'admin@example.edu',
    config: {
      SPREADSHEET_ID: configuredTestSheetId
    },
    properties: {
      SPREADSHEET_ID: staleTestSheetId
    }
  });
  harness.api.DEFAULT_ADMIN_EMAILS.push('admin@example.edu');

  harness.api.setup();
  const diagnostic = harness.api.getDatabaseDiagnostic();

  assert.equal(diagnostic.source, 'APP_SETTINGS.SPREADSHEET_ID');
  assert.equal(diagnostic.configuredSpreadsheetId, configuredTestSheetId);
  assert.equal(diagnostic.scriptPropertySpreadsheetId, configuredTestSheetId);
  assert.notEqual(diagnostic.scriptPropertySpreadsheetId, staleTestSheetId);
  assert.ok(diagnostic.sheets.some(sheet => sheet.name === 'Overtime Requests'));
});

test('setup writes DB-loaded process definitions and workflow rows into the protected Config sheet', () => {
  const harness = createAppsScriptHarness();

  harness.api.setup();
  const sheet = harness.spreadsheet.getSheetByName('Config');
  const rows = sheet.rows;
  const header = rows[0];
  const processIndex = header.indexOf('processKey');
  const sectionIndex = header.indexOf('section');
  const stageIndex = header.indexOf('stage');
  const nameIndex = header.indexOf('name');

  assert.ok(rows.some(row => row[processIndex] === 'global' && row[sectionIndex] === 'setting'));
  assert.ok(rows.some(row => row[processIndex] === 'overtime' && row[sectionIndex] === 'workflow' && row[stageIndex] === 'approval' && row[nameIndex] === 'Line Manager'));
  assert.ok(rows.some(row => row[processIndex] === 'overtime' && row[sectionIndex] === 'workflow' && row[stageIndex] === 'final' && row[nameIndex] === 'Head of Operations'));
  assert.ok(rows.some(row => row[processIndex] === 'vtr' && row[sectionIndex] === 'workflow' && row[stageIndex] === 'approval' && row[nameIndex] === 'Senior School Initial Approval'));
  assert.ok(rows.some(row => row[processIndex] === 'vtr' && row[sectionIndex] === 'workflow' && row[stageIndex] === 'approval' && row[nameIndex] === 'Junior School Executive Approval'));
  assert.ok(rows.some(row => row[processIndex] === 'vtr' && row[sectionIndex] === 'workflow' && row[stageIndex] === 'approval' && row[nameIndex] === 'Risk Assessment Acknowledgement'));
  assert.equal(rows.some(row => row[processIndex] === 'vtr' && row[sectionIndex] === 'workflow' && row[nameIndex] === 'Senior School Daily Organisation'), false);
  assert.equal(rows.some(row => row[processIndex] === 'vtr' && row[sectionIndex] === 'workflow' && row[stageIndex] === 'final'), false);
});

test('worksheet Config can be deliberately replaced from DB-loaded definitions', () => {
  const harness = createAppsScriptHarness();
  harness.api.setup();
  const sheet = harness.spreadsheet.getSheetByName('Config');
  const header = sheet.rows[0];
  const indexes = Object.fromEntries(header.map((name, index) => [name, index]));

  sheet.rows.push(header.map(() => ''));
  sheet.rows[sheet.rows.length - 1][indexes.processKey] = 'temporary';
  sheet.rows[sheet.rows.length - 1][indexes.section] = 'setting';
  sheet.rows[sheet.rows.length - 1][indexes.setting] = 'requestIdPrefix';
  sheet.rows[sheet.rows.length - 1][indexes.valueJson] = '"TMP"';

  sheet.rows.slice(1).forEach(row => {
    if (
      row[indexes.processKey] === 'overtime' &&
      row[indexes.section] === 'workflow' &&
      row[indexes.stage] === 'approval' &&
      row[indexes.name] === 'Head of Operations'
    ) {
      row[indexes.name] = 'Edited In Sheet';
      row[indexes.email] = 'edited@example.edu';
    }
  });

  const result = harness.api.replaceWorksheetConfigWithLoadedDefinitions();

  assert.equal(result.ok, true);
  assert.equal(sheet.rows[0][0], 'processKey');
  assert.equal(sheet.rows.some(row => row[indexes.processKey] === 'temporary'), false);
  assert.ok(sheet.rows.some(row =>
    row[indexes.processKey] === 'overtime' &&
    row[indexes.section] === 'workflow' &&
    row[indexes.stage] === 'approval' &&
    row[indexes.name] === 'Head of Operations' &&
    row[indexes.email] !== 'edited@example.edu' &&
    /@example\.edu$/.test(row[indexes.email])
  ));
});

test('worksheet Config can be deliberately replaced from DB-loaded definitions with smtp test aliases', () => {
  const harness = createAppsScriptHarness();
  harness.api.setup();
  const sheet = harness.spreadsheet.getSheetByName('Config');
  const header = sheet.rows[0];
  const indexes = Object.fromEntries(header.map((name, index) => [name, index]));

  const result = harness.api.replaceWorksheetConfigWithTestEmailDefinitions();

  assert.equal(result.ok, true);
  assert.match(result.message, /smtp\+ test email aliases/);

  const headOfOperations = sheet.rows.find(row =>
    row[indexes.processKey] === 'overtime' &&
    row[indexes.section] === 'workflow' &&
    row[indexes.stage] === 'approval' &&
    row[indexes.name] === 'Head of Operations'
  );
  assert.ok(headOfOperations, 'Expected overtime Head of Operations workflow row');
  assert.match(headOfOperations[indexes.email], /^smtp\+user\d+@example\.edu$/);

  const dailyOrganisation = sheet.rows.find(row =>
    row[indexes.processKey] === 'overtime' &&
    row[indexes.section] === 'workflow' &&
    row[indexes.stage] === 'approval' &&
    row[indexes.name] === 'Daily Organisation'
  );
  assert.ok(dailyOrganisation, 'Expected overtime Daily Organisation workflow row');
  assert.match(dailyOrganisation[indexes.email], /^smtp\+user\d+@example\.edu$/);

  const lineManager = sheet.rows.find(row =>
    row[indexes.processKey] === 'overtime' &&
    row[indexes.section] === 'workflow' &&
    row[indexes.stage] === 'approval' &&
    row[indexes.name] === 'Line Manager'
  );
  assert.ok(lineManager, 'Expected overtime Line Manager workflow row');
  assert.equal(lineManager[indexes.email], '');
  assert.equal(lineManager[indexes.emailField], 'lineManagerEmail');

  const globalAdmins = sheet.rows.find(row =>
    row[indexes.processKey] === 'global' &&
    row[indexes.section] === 'setting' &&
    row[indexes.setting] === 'ADMIN_EMAILS'
  );
  assert.ok(globalAdmins, 'Expected global admin email setting row');
  const adminEmails = JSON.parse(globalAdmins[indexes.valueJson]);
  assert.ok(adminEmails.every(email => email.startsWith('smtp+')), 'Expected all global admin addresses to use smtp+ aliases');
  assert.ok(adminEmails.length > 0, 'Expected at least one global admin alias');
  assert.ok(adminEmails.some(email => /^smtp\+[^@]+@example\.edu$/.test(email)));

  assert.equal(sheet.rows.some(row =>
    row[indexes.processKey] === 'vtr' &&
    row[indexes.section] === 'setting' &&
    /initialApprover/.test(row[indexes.setting] || '')
  ), false);
});

test('worksheet Config can be deliberately replaced with VTR-only smtp test aliases', () => {
  const harness = createAppsScriptHarness();
  harness.api.setup();
  const sheet = harness.spreadsheet.getSheetByName('Config');
  const header = sheet.rows[0];
  const indexes = Object.fromEntries(header.map((name, index) => [name, index]));

  const result = harness.api.replaceWorksheetConfigWithVtrTestEmailDefinitions();

  assert.equal(result.ok, true);
  assert.match(result.message, /VTR only/);

  const overtimeHeadOfOperations = sheet.rows.find(row =>
    row[indexes.processKey] === 'overtime' &&
    row[indexes.section] === 'workflow' &&
    row[indexes.stage] === 'approval' &&
    row[indexes.name] === 'Head of Operations'
  );
  assert.ok(overtimeHeadOfOperations, 'Expected overtime Head of Operations workflow row');
  assert.match(overtimeHeadOfOperations[indexes.email], /^user\d+@example\.edu$/);

  const seniorInitialApproval = sheet.rows.find(row =>
    row[indexes.processKey] === 'vtr' &&
    row[indexes.section] === 'workflow' &&
    row[indexes.stage] === 'approval' &&
    row[indexes.name] === 'Senior School Initial Approval'
  );
  assert.ok(seniorInitialApproval, 'Expected VTR Senior School Initial Approval workflow row');
  assert.match(seniorInitialApproval[indexes.email], /^smtp\+user\d+@example\.edu$/);

  const riskAcknowledgement = sheet.rows.find(row =>
    row[indexes.processKey] === 'vtr' &&
    row[indexes.section] === 'workflow' &&
    row[indexes.stage] === 'approval' &&
    row[indexes.name] === 'Risk Assessment Acknowledgement'
  );
  assert.ok(riskAcknowledgement, 'Expected VTR Risk Assessment Acknowledgement workflow row');
  assert.match(riskAcknowledgement[indexes.email], /^smtp\+user\d+@example\.edu$/);

  const globalAdmins = sheet.rows.find(row =>
    row[indexes.processKey] === 'global' &&
    row[indexes.section] === 'setting' &&
    row[indexes.setting] === 'ADMIN_EMAILS'
  );
  assert.ok(globalAdmins, 'Expected global admin email setting row');
  const adminEmails = JSON.parse(globalAdmins[indexes.valueJson]);
  assert.equal(adminEmails.some(email => email.startsWith('smtp+')), false);
});

test('default web app opens a form chooser and process links open the selected form', () => {
  const harness = createAppsScriptHarness();

  const chooser = harness.api.getInitialState_({});
  const direct = harness.api.getInitialState_({ process: 'overtime' });
  const vtrDirect = harness.api.getInitialState_({ process: 'vtr' });

  assert.equal(chooser.mode, 'chooser');
  assert.ok(chooser.processes.some(process => process.key === 'overtime'));
  assert.ok(chooser.processes.some(process => process.key === 'vtr'));
  assert.equal(direct.mode, 'request');
  assert.equal(direct.processType, 'overtime');
  assert.equal(direct.processName, 'Support Staff Overtime');
  assert.equal(vtrDirect.mode, 'request');
  assert.equal(vtrDirect.processType, 'vtr');
  assert.equal(vtrDirect.processName, 'Variations to Routine (VTR)');
  assert.equal(direct.formDefinition.key, 'overtime');
  assert.equal(vtrDirect.formDefinition.key, 'vtr');
});

test('request form definitions drive validation and process-specific defaults', () => {
  const harness = createAppsScriptHarness();
  const overtimeForm = harness.api.getFormDefinition_('overtime');
  const actualHoursForm = harness.api.getFormDefinition_('overtime', 'actual');
  const vtrForm = harness.api.getFormDefinition_('vtr');

  assert.ok(overtimeForm.sections.some(section =>
    section.fields.some(field => field.type === 'choiceCards' && field.name === 'compensationMethod')
  ));
  assert.ok(actualHoursForm.sections.some(section =>
    section.fields.some(field => field.type === 'requestSummary')
  ));
  assert.ok(actualHoursForm.sections.some(section =>
    section.fields.some(field => field.name === 'actualStartTime' && field.defaultFromField === 'plannedStartTime')
  ));
  assert.ok(vtrForm.sections.some(section =>
    section.fields.some(field => field.name === 'eventStartTime' && field.type === 'time')
  ));
  assert.ok(vtrForm.sections.some(section =>
    section.fields.some(field => field.name === 'eventFinishTime' && field.type === 'time')
  ));
  assert.ok(vtrForm.sections.some(section =>
    section.fields.some(field => field.name === 'multiDayEvent' && field.type === 'checkbox')
  ));
  assert.ok(vtrForm.sections.some(section =>
    section.fields.some(field => field.name === 'eventStartDate' && field.type === 'date')
  ));
  assert.ok(vtrForm.sections.some(section =>
    section.fields.some(field => field.name === 'eventEndDate' && field.type === 'date')
  ));
  assert.ok(vtrForm.sections.some(section =>
    section.fields.some(field => field.type === 'checklistChoice' && field.name === 'rollsMarkedReceptionNotified')
  ));

  const vtr = harness.api.validateRequestForm_(defaultVtrRequest({
    offsiteExcursion: 'No',
    attendingStaffBriefed: '',
    medicalNeedsCompiled: '',
    lessonPlansLeft: '',
    rollsMarkedReceptionNotified: ''
  }));

  assert.equal(vtr.eventStartTime, '09:00');
  assert.equal(vtr.eventFinishTime, '14:30');
  assert.equal(vtr.eventTimes, '09:00 to 14:30');
  assert.equal(Object.prototype.hasOwnProperty.call(vtr, 'firstApproverEmail'), false);
  assert.equal(vtr.attendingStaffBriefed, 'N/A');
  assert.equal(vtr.rollsMarkedReceptionNotified, 'N/A');

  const multiDay = harness.api.validateRequestForm_(defaultVtrRequest({
    multiDayEvent: true,
    eventDate: '',
    eventStartDate: '2026-07-10',
    eventEndDate: '2026-07-12'
  }));
  assert.equal(multiDay.multiDayEvent, 'Yes');
  assert.equal(multiDay.eventDate, '');
  assert.equal(multiDay.eventStartDate, '2026-07-10');
  assert.equal(multiDay.eventEndDate, '2026-07-12');

  const singleDay = harness.api.validateRequestForm_(defaultVtrRequest({
    eventDate: '2026-07-11',
    eventStartDate: '2026-07-10',
    eventEndDate: '2026-07-12'
  }));
  assert.equal(singleDay.multiDayEvent, '');
  assert.equal(singleDay.eventDate, '2026-07-11');
  assert.equal(singleDay.eventStartDate, '');
  assert.equal(singleDay.eventEndDate, '');

  assert.throws(
    () => harness.api.validateRequestForm_(defaultVtrRequest({
      multiDayEvent: true,
      eventDate: '',
      eventStartDate: '2026-07-12',
      eventEndDate: '2026-07-10'
    })),
    /Event end date must be on or after the event start date/
  );
});

test('VTR logistics is in the request form and operational checklist is a separate follow-up form', () => {
  const harness = createAppsScriptHarness();
  const vtrForm = harness.api.getFormDefinition_('vtr');
  const checklistForm = harness.api.getFormDefinition_('vtr', 'checklist');
  const eventDetails = vtrForm.sections.find(section => section.title === '2. Event Details');
  const requestFieldNames = vtrForm.sections.flatMap(section => section.fields.map(field => field.name).filter(Boolean));
  const checklistFieldNames = checklistForm.sections.flatMap(section => section.fields.map(field => field.name).filter(Boolean));

  assert.ok(eventDetails.fields.some(field => field.name === 'logisticsNotified'));
  assert.equal(requestFieldNames.includes('costToStudents'), false);
  assert.equal(requestFieldNames.includes('riskAssessmentCompleted'), false);
  assert.ok(checklistFieldNames.includes('costToStudents'));
  assert.ok(checklistFieldNames.includes('riskAssessmentCompleted'));
  assert.equal(checklistFieldNames.includes('logisticsNotified'), false);

  const assessment = harness.api.validateRequestForm_(defaultVtrRequest({
    eventType: 'Assessment',
    logisticsNotified: 'Yes',
    costToStudents: 'Yes',
    riskAssessmentCompleted: 'Yes',
    wwccConfirmed: 'Yes',
    budgetSubmitted: 'Yes',
    groundsItConsulted: 'Yes',
    groundsAfterHoursNotified: 'Yes',
    sportPdhpeConsulted: 'Yes',
    chaplaincyConsulted: 'Yes',
    canteenNotified: 'Yes',
    parentLetterChecked: 'Yes',
    parentLetterProvided: 'Yes',
    staffNotified: 'Yes',
    busesBooked: 'Yes',
    marketingNotified: 'Yes'
  }));

  assert.equal(assessment.logisticsNotified, 'Yes');
  assert.equal(Object.prototype.hasOwnProperty.call(assessment, 'costToStudents'), false);

  const checklist = harness.api.validateVtrChecklistForm_(defaultVtrChecklist({
    costToStudents: 'Yes',
    groundsItConsulted: 'Yes'
  }), Object.assign(defaultVtrRequest(), assessment));
  assert.equal(checklist.costToStudents, 'Yes');
  assert.equal(checklist.groundsItConsulted, 'Yes');
});

test('actual-hours form definition drives validation and defaults from the approved request', () => {
  const harness = createAppsScriptHarness();
  const request = defaultRequest({
    processType: 'overtime',
    plannedStartTime: '14:45',
    plannedFinishTime: '17:15',
    plannedHours: '2.5'
  });

  const actual = harness.api.validateActualHoursForm_(defaultActual({
    actualStartTime: '',
    actualFinishTime: '',
    actualHours: ''
  }), request);

  assert.equal(actual.actualStartTime, '14:45');
  assert.equal(actual.actualFinishTime, '17:15');
  assert.equal(actual.actualHours, '2.5');
  assert.equal(actual.variationReason, '');
});

test('adjust workday hours records planned and actual work times with zero overtime hours', () => {
  const harness = createAppsScriptHarness();
  const compensationMethod = 'Adjust workday hours (no payment required)';
  const request = harness.api.validateRequestForm_(defaultRequest({
    normallyWorks: 'Yes',
    normalStartTime: '08:30',
    normalFinishTime: '16:30',
    plannedStartTime: '10:30',
    plannedFinishTime: '18:30',
    plannedHours: '',
    mealRulesAcknowledged: false,
    compensationMethod
  }));

  assert.equal(request.plannedStartTime, '10:30');
  assert.equal(request.plannedFinishTime, '18:30');
  assert.equal(request.plannedHours, '0');
  assert.equal(request.mealRulesAcknowledged, 'Yes');
  assert.equal(
    harness.api.publicRequest_(Object.assign(defaultRequest(), request)).formOptionVariants.compensationMethod,
    'adjustedWorkday'
  );

  const actual = harness.api.validateActualHoursForm_(defaultActual({
    mealBreaksAcknowledged: false,
    mealAllowance: '',
    actualStartTime: '10:30',
    actualFinishTime: '18:30',
    actualHours: ''
  }), Object.assign(defaultRequest(), request));

  assert.equal(actual.actualStartTime, '10:30');
  assert.equal(actual.actualFinishTime, '18:30');
  assert.equal(actual.actualHours, '0');
  assert.equal(actual.mealBreaksAcknowledged, 'Yes');
  assert.equal(actual.mealAllowance, 'No meal was required');
});

test('adjust workday hours is not a valid compensation option for non-work days', () => {
  const harness = createAppsScriptHarness();

  assert.throws(
    () => harness.api.validateRequestForm_(defaultRequest({
      normallyWorks: 'No',
      normalStartTime: '',
      normalFinishTime: '',
      plannedStartTime: '09:00',
      plannedFinishTime: '12:00',
      plannedHours: '',
      compensationMethod: 'Adjust workday hours (no payment required)'
    })),
    /compensated.*invalid value/i
  );
});

test('workflow can be changed from the Config sheet without editing code', () => {
  const harness = createAppsScriptHarness();
  harness.api.setup();
  const sheet = harness.spreadsheet.getSheetByName('Config');
  const header = sheet.rows[0];
  const indexes = Object.fromEntries(header.map((name, index) => [name, index]));
  let firstApprovalRowUpdated = false;

  sheet.rows.slice(1).forEach(row => {
    const isOvertimeApproval = row[indexes.processKey] === 'overtime' &&
      row[indexes.section] === 'workflow' &&
      row[indexes.stage] === 'approval';
    if (!isOvertimeApproval) {
      return;
    }
    if (!firstApprovalRowUpdated) {
      row[indexes.type] = 'approval';
      row[indexes.name] = 'Sheet Workflow Owner';
      row[indexes.email] = 'sheetowner@example.edu';
      row[indexes.emailField] = '';
      row[indexes.whenJson] = '';
      row[indexes.enabled] = 'Yes';
      firstApprovalRowUpdated = true;
    } else {
      row[indexes.enabled] = 'No';
    }
  });

  submit(harness);
  let request = currentRequest(harness);

  assert.equal(request.activeApprovalStepName, 'Sheet Workflow Owner');
  assert.equal(request.activeApprovalStepEmail, 'sheetowner@example.edu');
});

test('process definitions support additional processes such as VTR', () => {
  const harness = createAppsScriptHarness();

  const definitions = harness.api.getProcessDefinitions_();
  const seniorInitialEmail = vtrWorkflowEmail(harness, 'Senior School Initial Approval');
  assert.equal(definitions.overtime.requestIdPrefix, 'OT');
  assert.equal(definitions.vtr.requestIdPrefix, 'VTR');
  assert.equal(definitions.vtr.requestForm, 'vtr');
  assert.equal(definitions.vtr.completionMode, 'single_stage');
  assert.equal(Object.prototype.hasOwnProperty.call(definitions.vtr.workflows, 'final'), false);

  harness.api.submitRequest(defaultVtrRequest());
  const request = currentRequest(harness);

  assert.equal(request.processType, 'vtr');
  assert.match(request.requestId, /^VTR-\d{8}-/);
  assert.equal(request._sheetName, 'VTR Requests');
  assert.equal(request.eventName, 'Year 8 Museum Visit');
  assert.equal(request.activeApprovalStepName, 'Senior School Initial Approval');
  assert.equal(request.activeApprovalStepEmail, seniorInitialEmail);
});

test('retired VTR first-approver Config rows are ignored', () => {
  const harness = createAppsScriptHarness();
  harness.api.setup();
  const sheet = harness.spreadsheet.getSheetByName('Config');
  const header = sheet.rows[0];
  const indexes = Object.fromEntries(header.map((name, index) => [name, index]));
  const staleFirstApproverRow = header.map(() => '');

  staleFirstApproverRow[indexes.processKey] = 'vtr';
  staleFirstApproverRow[indexes.processName] = 'Variations to Routine (VTR)';
  staleFirstApproverRow[indexes.section] = 'workflow';
  staleFirstApproverRow[indexes.stage] = 'approval';
  staleFirstApproverRow[indexes.stepOrder] = '0';
  staleFirstApproverRow[indexes.type] = 'approval';
  staleFirstApproverRow[indexes.name] = 'HOD / Head of School / Head of Operations';
  staleFirstApproverRow[indexes.emailField] = 'firstApproverEmail';
  staleFirstApproverRow[indexes.enabled] = 'Yes';
  sheet.rows.push(staleFirstApproverRow);

  const seniorInitialEmail = vtrWorkflowEmail(harness, 'Senior School Initial Approval');
  harness.api.submitRequest(defaultVtrRequest({ costToStudents: 'No' }));
  const request = currentRequest(harness);

  assert.equal(request.activeApprovalStepName, 'Senior School Initial Approval');
  assert.equal(request.activeApprovalStepEmail, seniorInitialEmail);
});

test('VTR approval starts the separate checklist follow-up for non-assessment requests', () => {
  const harness = createAppsScriptHarness({ now: '2026-07-11T00:30:00.000Z' });
  harness.api.DEFAULT_PROCESS_DEFINITIONS.vtr.workflows.approval = [
    { type: 'approval', name: 'Configured VTR Step', email: 'hod@example.edu' }
  ];

  harness.api.submitRequest(defaultVtrRequest());
  const token = latestWorkflowToken(harness, 'hod@example.edu');

  harness.setActiveUser('hod@example.edu');
  const result = harness.api.submitApprovalDecision({ token, decision: 'approve' });
  let request = currentRequest(harness);
  harness.setActiveUser('organiser@example.edu');
  const dashboard = harness.api.getDashboardData({ role: 'requester' });

  assert.equal(result.ok, true);
  assert.equal(request.status, harness.api.STATUS.AWAITING_VTR_CHECKLIST);
  assert.equal(request.followUpDueDate, '');
  assert.notEqual(request.employeeActionTokenHash, '');
  assert.equal(dashboard.requests[0].isClosed, false);
  assert.equal(dashboard.requests[0].canEditChecklist, true);
  assert.match(dashboard.requests[0].waitingOnLabel, /submit VTR checklist/);
  assert.ok(harness.events.some(event => event.event === 'VTR_CHECKLIST_REQUESTED'));
  assert.ok(harness.mail.some(mail => mail.to === 'organiser@example.edu' && /complete VTR checklist/i.test(mail.subject || '')));

  const checklistToken = latestChecklistToken(harness);
  const saveResult = harness.api.submitVtrChecklist(Object.assign(defaultVtrChecklist({
    costToStudents: 'Yes',
    groundsItConsulted: 'Yes'
  }), { token: checklistToken }));
  request = currentRequest(harness);

  assert.equal(saveResult.ok, true);
  assert.equal(request.status, harness.api.STATUS.AWAITING_VTR_CHECKLIST);
  assert.notEqual(request.checklistSubmittedAt, '');
  assert.equal(request.checklistCompletedAt, '');
  assert.notEqual(request.employeeActionTokenHash, '');
  assert.equal(request.costToStudents, 'Yes');
  assert.equal(harness.events.some(event => event.event === 'CHECKLIST_NOTIFICATION_SENT'), false);

  const checklistResult = harness.api.submitVtrChecklist(Object.assign(defaultVtrChecklist({
    costToStudents: 'Yes',
    groundsItConsulted: 'Yes'
  }), { token: checklistToken, checklistAction: 'complete' }));
  request = currentRequest(harness);

  assert.equal(checklistResult.ok, true);
  assert.equal(request.status, harness.api.STATUS.AWAITING_VTR_CHECKLIST);
  assert.notEqual(request.employeeActionTokenHash, '');
  assert.notEqual(request.checklistCompletedAt, '');
  assert.equal(request.costToStudents, 'Yes');
  assert.ok(harness.events.some(event => event.event === 'CHECKLIST_NOTIFICATION_SENT' && event.detailsJson.includes('Grounds and IT Notification')));
  assert.ok(harness.events.some(event => event.event === 'CHECKLIST_NOTIFICATION_SENT' && event.detailsJson.includes('Finance Cost Notification')));
  assert.ok(harness.events.some(event => event.event === 'CHECKLIST_NOTIFICATION_SENT' && event.detailsJson.includes('Risk and Compliance Checklist Notification')));

  harness.setActiveUser('organiser@example.edu');
  const postCompleteDashboard = harness.api.getDashboardData({ role: 'requester' });
  assert.equal(postCompleteDashboard.requests[0].canEditChecklist, true);
  assert.equal(postCompleteDashboard.requests[0].statusLabel, 'Checklist submitted');
  assert.equal(postCompleteDashboard.requests[0].waitingOnType, 'closed');
  assert.match(postCompleteDashboard.requests[0].waitingOnLabel, /No further action required/);
  assert.match(postCompleteDashboard.requests[0].waitingOnLabel, /through 11 July 2026/);

  harness.api.sendDueActualHoursRequests();
  request = currentRequest(harness);
  assert.equal(request.status, harness.api.STATUS.AWAITING_VTR_CHECKLIST);

  harness.setNow('2026-07-12T00:30:00.000Z');
  harness.api.sendDueActualHoursRequests();
  request = currentRequest(harness);
  assert.equal(request.status, harness.api.STATUS.APPROVED);
});

test('VTR workflow follows the updated initial approval, final approval, and risk acknowledgement branches', () => {
  const harness = createAppsScriptHarness();

  assert.deepEqual(vtrWorkflowStepNames(harness, {
    schoolArea: 'Senior School',
    eventType: 'Curricular Event',
    costToStudents: 'No'
  }), [
    'approval:Senior School Initial Approval',
    'notification:VTR Initial Approval Confirmation',
    'approval:Senior School Executive Approval',
    'acknowledgement:Risk Assessment Acknowledgement'
  ]);

  assert.deepEqual(vtrWorkflowStepNames(harness, {
    schoolArea: 'Senior School',
    eventType: 'Assessment',
    costToStudents: 'Yes'
  }), [
    'approval:Senior School Initial Approval',
    'notification:VTR Initial Approval Confirmation',
    'notification:Senior School Assessment Notification',
    'acknowledgement:Risk Assessment Acknowledgement'
  ]);

  assert.deepEqual(vtrWorkflowStepNames(harness, {
    schoolArea: 'K-12',
    eventType: 'Curricular Event',
    costToStudents: 'No'
  }), [
    'approval:Senior School Initial Approval',
    'approval:Junior School Initial Approval',
    'notification:VTR Initial Approval Confirmation',
    'approval:Senior School Executive Approval',
    'approval:Junior School Executive Approval',
    'acknowledgement:Risk Assessment Acknowledgement'
  ]);

  assert.deepEqual(vtrWorkflowStepNames(harness, {
    schoolArea: 'Junior School',
    costToStudents: 'No'
  }), [
    'approval:Junior School Initial Approval',
    'notification:VTR Initial Approval Confirmation',
    'approval:Junior School Executive Approval',
    'acknowledgement:Risk Assessment Acknowledgement'
  ]);

  assert.deepEqual(vtrWorkflowStepNames(harness, {
    schoolArea: 'Junior School',
    costToStudents: 'No',
    riskAssessmentRequired: 'No'
  }), [
    'approval:Junior School Initial Approval',
    'notification:VTR Initial Approval Confirmation',
    'approval:Junior School Executive Approval'
  ]);

  assert.deepEqual(vtrWorkflowStepNames(harness, {
    schoolArea: 'Junior School',
    riskAssessmentRequired: 'No',
    groundsItConsulted: 'Yes',
    sportPdhpeConsulted: 'Yes',
    canteenNotified: 'Yes',
    costToStudents: 'Yes'
  }), [
    'approval:Junior School Initial Approval',
    'notification:VTR Initial Approval Confirmation',
    'approval:Junior School Executive Approval'
  ]);

  assert.deepEqual(vtrWorkflowStepNames(harness, {
    groundsItConsulted: 'Yes',
    sportPdhpeConsulted: 'Yes',
    canteenNotified: 'Yes',
    costToStudents: 'Yes',
    riskAssessmentCompleted: 'Yes'
  }, 'checklist'), [
    'notification:Grounds and IT Notification',
    'notification:Sport and PDHPE Notification',
    'notification:Canteen and Cafe Notification',
    'notification:Risk and Compliance Checklist Notification',
    'notification:Finance Cost Notification'
  ]);

  assert.deepEqual(vtrWorkflowStepNames(harness, {
    wwccConfirmed: 'Yes',
    budgetSubmitted: 'Yes'
  }, 'checklist'), [
    'notification:Risk and Compliance Checklist Notification',
    'notification:Finance Cost Notification'
  ]);
});

test('dashboard workflow uses the request snapshot when live VTR workflow names change', () => {
  const harness = createAppsScriptHarness();

  harness.api.submitRequest(defaultVtrRequest({
    schoolArea: 'Junior School',
    riskAssessmentRequired: 'No'
  }));
  let request = currentRequest(harness);
  assert.ok(JSON.parse(request.approvalWorkflowSteps).some(step => step.name === 'Junior School Executive Approval'));

  const juniorExecutive = harness.api.DEFAULT_PROCESS_DEFINITIONS.vtr.workflows.approval
    .find(step => step.name === 'Junior School Executive Approval');
  assert.ok(juniorExecutive, 'Expected Junior School Executive Approval in live workflow defaults');
  juniorExecutive.name = 'Junior School Renamed Executive Approval';

  harness.setActiveUser('organiser@example.edu');
  const requesterDashboard = harness.api.getDashboardData({ role: 'requester' });
  const requesterRequest = requesterDashboard.requests[0];
  assert.ok(requesterRequest.approvalWorkflowSteps.some(step => step.name === 'Junior School Executive Approval'));
  assert.equal(requesterRequest.approvalWorkflowSteps.some(step => step.name === 'Junior School Renamed Executive Approval'), false);

  harness.setActiveUser('admin@example.edu');
  const adminDashboard = harness.api.getDashboardData({ role: 'admin', process: 'vtr' });
  const adminRequest = adminDashboard.requests[0];
  assert.ok(adminRequest.approvalWorkflowSteps.some(step => step.name === 'Junior School Executive Approval'));
  assert.equal(adminRequest.approvalWorkflowSteps.some(step => step.name === 'Junior School Renamed Executive Approval'), false);

  request = currentRequest(harness);
  assert.ok(JSON.parse(request.approvalWorkflowSteps).some(step => step.name === 'Junior School Executive Approval'));
});

test('VTR initial approval emails the requester and then starts final approval for the same logistics owner', () => {
  const harness = createAppsScriptHarness();
  const seniorInitialEmail = vtrWorkflowEmail(harness, 'Senior School Initial Approval');
  const seniorFinalEmail = vtrWorkflowEmail(harness, 'Senior School Executive Approval');
  const riskAcknowledgementEmail = vtrWorkflowEmail(harness, 'Risk Assessment Acknowledgement');

  harness.api.submitRequest(quietVtrRequest({
    schoolArea: 'Senior School',
    eventType: 'Curricular Event'
  }));
  const initialToken = latestWorkflowToken(harness, seniorInitialEmail);

  harness.setActiveUser(seniorInitialEmail);
  const initialResult = harness.api.submitApprovalDecision({ token: initialToken, decision: 'approve' });
  let request = currentRequest(harness);

  assert.equal(initialResult.ok, true);
  assert.equal(request.status, harness.api.STATUS.PENDING_APPROVAL);
  assert.equal(request.activeApprovalStepName, 'Senior School Executive Approval');
  assert.equal(request.activeApprovalStepEmail, seniorFinalEmail);

  const requesterMail = harness.latestMail(mail =>
    mail.to === 'organiser@example.edu' &&
    /initial approval received/i.test(mail.subject || '')
  );
  assert.ok(requesterMail, 'Expected requester to be notified after initial approval');
  assert.match(requesterMail.htmlBody, /coordinate with the relevant executive group/i);

  const finalApprovalMail = harness.latestMail(mail =>
    mail.to === seniorFinalEmail &&
    /final approval after executive coordination/i.test(mail.subject || '')
  );
  assert.ok(finalApprovalMail, 'Expected final approval email after requester notification');
  assert.match(finalApprovalMail.htmlBody, /coordinate with the relevant Senior School executive group/i);

  const finalToken = latestWorkflowToken(harness, seniorFinalEmail);
  harness.api.submitApprovalDecision({ token: finalToken, decision: 'approve' });
  request = currentRequest(harness);

  assert.equal(request.activeApprovalStepName, 'Risk Assessment Acknowledgement');
  assert.equal(request.activeApprovalStepEmail, riskAcknowledgementEmail);
  const checklistToken = latestChecklistToken(harness);
  const checklistState = harness.api.getInitialState_({ mode: 'checklist', token: checklistToken });
  assert.equal(checklistState.mode, 'checklist');
  assert.equal(checklistState.requestId, request.requestId);

  const riskToken = latestWorkflowToken(harness, riskAcknowledgementEmail);
  harness.setActiveUser(riskAcknowledgementEmail);
  harness.api.submitApprovalDecision({ token: riskToken, decision: 'acknowledge' });
  request = currentRequest(harness);

  assert.equal(request.status, harness.api.STATUS.AWAITING_VTR_CHECKLIST);
  assert.ok(harness.mail.some(mail =>
    mail.to === 'organiser@example.edu' &&
    /complete VTR checklist/i.test(mail.subject || '') &&
    /remains editable through/i.test(mail.htmlBody || '')
  ));

  harness.api.submitVtrChecklist(Object.assign(defaultVtrChecklist({
    canteenNotified: 'Yes'
  }), { token: checklistToken }));
  request = currentRequest(harness);

  assert.equal(request.status, harness.api.STATUS.AWAITING_VTR_CHECKLIST);
  assert.equal(request.canteenNotified, 'Yes');
  assert.equal(request.checklistCompletedAt, '');
  assert.equal(harness.events.some(event => event.event === 'CHECKLIST_NOTIFICATION_SENT' && event.detailsJson.includes('Canteen and Cafe Notification')), false);

  harness.api.submitVtrChecklist(Object.assign(defaultVtrChecklist({
    canteenNotified: 'Yes'
  }), { token: checklistToken, checklistAction: 'complete' }));
  request = currentRequest(harness);

  assert.equal(request.status, harness.api.STATUS.AWAITING_VTR_CHECKLIST);
  assert.equal(request.canteenNotified, 'Yes');
  assert.notEqual(request.checklistCompletedAt, '');
  assert.ok(harness.events.some(event => event.event === 'CHECKLIST_NOTIFICATION_SENT' && event.detailsJson.includes('Canteen and Cafe Notification')));

  harness.setActiveUser('organiser@example.edu');
  const completedDashboard = harness.api.getDashboardData({ role: 'requester' });
  assert.equal(completedDashboard.requests[0].canEditChecklist, true);
  assert.equal(completedDashboard.requests[0].statusLabel, 'Checklist submitted');
  assert.equal(completedDashboard.requests[0].waitingOnType, 'closed');
  assert.match(completedDashboard.requests[0].waitingOnLabel, /No further action required/);
  assert.match(completedDashboard.requests[0].waitingOnLabel, /editable by Alex Organiser/);
  assert.match(completedDashboard.requests[0].waitingOnLabel, /through 11 July 2026/);
  assert.ok(completedDashboard.requests[0].checklistWorkflowSteps.some(step => step.name === 'Canteen and Cafe Notification'));
  assert.ok(completedDashboard.requests[0].checklistNotificationHistory.some(entry => entry.stepName === 'Canteen and Cafe Notification'));

  harness.setActiveUser('admin@example.edu');
  const adminDashboard = harness.api.getDashboardData({ role: 'admin', process: 'vtr' });
  assert.ok(adminDashboard.requests[0].checklistWorkflowSteps.some(step => step.name === 'Canteen and Cafe Notification'));
  assert.ok(adminDashboard.requests[0].checklistNotificationHistory.some(entry => entry.stepName === 'Canteen and Cafe Notification'));

  harness.setNow('2026-06-22T00:30:00.000Z');
  const reminders = harness.api.sendWeeklyPendingReminders();
  assert.equal(reminders.vtrChecklistRemindersSent, 0);
  assert.equal(harness.events.some(event => event.event === 'WEEKLY_VTR_CHECKLIST_REMINDER_SENT'), false);

  harness.setNow('2026-07-11T00:30:00.000Z');
  harness.api.sendDueActualHoursRequests();
  request = currentRequest(harness);

  assert.equal(request.status, harness.api.STATUS.AWAITING_VTR_CHECKLIST);

  harness.setNow('2026-07-12T00:30:00.000Z');
  harness.api.sendDueActualHoursRequests();
  request = currentRequest(harness);

  assert.equal(request.status, harness.api.STATUS.APPROVED);
  assert.ok(harness.events.some(event => event.event === 'VTR_CHECKLIST_CLOSED'));
});

test('VTR Senior School assessments skip second approval and send the assessment notification', () => {
  const harness = createAppsScriptHarness();
  const seniorInitialEmail = vtrWorkflowEmail(harness, 'Senior School Initial Approval');
  const seniorFinalEmail = vtrWorkflowEmail(harness, 'Senior School Executive Approval');
  const riskAcknowledgementEmail = vtrWorkflowEmail(harness, 'Risk Assessment Acknowledgement');
  const assessmentNotificationEmail = vtrWorkflowEmail(harness, 'Senior School Assessment Notification');

  harness.api.submitRequest(quietVtrRequest({
    schoolArea: 'Senior School',
    eventType: 'Assessment',
    costToStudents: 'Yes'
  }));
  const initialToken = latestWorkflowToken(harness, seniorInitialEmail);

  harness.setActiveUser(seniorInitialEmail);
  harness.api.submitApprovalDecision({ token: initialToken, decision: 'approve' });
  const request = currentRequest(harness);

  assert.equal(request.activeApprovalStepName, 'Risk Assessment Acknowledgement');
  assert.equal(request.activeApprovalStepEmail, riskAcknowledgementEmail);
  assert.equal(harness.mail.some(mail =>
    mail.to === seniorFinalEmail &&
    /final approval after executive coordination/i.test(mail.subject || '')
  ), false);
  assert.ok(harness.mail.some(mail =>
    mail.to === assessmentNotificationEmail &&
    /assessment VTR notification/i.test(mail.subject || '') &&
    /second logistics approval is skipped/i.test(mail.htmlBody || '')
  ));
  assert.equal(harness.mail.some(mail =>
    mail.to === 'finance@example.edu' &&
    /cost-to-students/i.test(mail.subject || '') &&
    /does not block approval/i.test(mail.htmlBody || '')
  ), false);
});

test('submitted requests are stored on the configured process tab', () => {
  const harness = createAppsScriptHarness();

  submit(harness);

  const overtimeSheet = harness.spreadsheet.getSheetByName('Overtime Requests');
  assert.ok(overtimeSheet);
  assert.equal(overtimeSheet.getLastRow(), 2);
  assert.equal(harness.spreadsheet.getSheetByName('Requests'), null);
  assert.equal(currentRequest(harness)._sheetName, 'Overtime Requests');
});

test('legacy Requests rows can be migrated into the overtime process tab', () => {
  const harness = createAppsScriptHarness({ activeEmail: 'admin@example.edu' });
  harness.api.setup();
  const approvalHistory = JSON.stringify([{ timestamp: '2026-06-16T09:00:00+10:00', stepName: 'Line Manager', approverEmail: 'manager@example.edu' }]);
  const changeHistory = JSON.stringify([{ timestamp: '2026-06-16T09:05:00+10:00', requestedByType: 'approver', comment: 'Please shorten this.' }]);

  appendLegacyOvertimeRow(harness, {
    requestId: 'OT-LEGACY-001',
    createdAt: '2026-06-16T08:00:00+10:00',
    updatedAt: '2026-06-16T09:05:00+10:00',
    status: 'PENDING_PREAPPROVAL',
    employeeEmail: 'employee@example.edu',
    employeeName: 'Legacy Employee',
    lineManagerEmail: 'manager@example.edu',
    isLineManagerRequester: 'Yes',
    reason: 'Legacy overtime row',
    overtimeDate: '2026-06-20',
    normallyWorks: 'Yes',
    normalStartTime: '08:30',
    normalFinishTime: '16:30',
    plannedStartTime: '16:30',
    plannedFinishTime: '18:30',
    plannedHours: '2',
    mealRulesAcknowledged: 'Yes',
    compensationMethod: 'Payment at Casual/Overtime Rates',
    activeApprovalTokenHash: 'legacy-token-hash',
    activeApprovalStage: 'preapproval',
    activeApprovalStepIndex: '2',
    activeApprovalStepName: 'Head of Operations',
    activeApprovalStepEmail: 'ops@example.edu',
    preapprovalCompletedAt: '2026-06-16T09:01:00+10:00',
    preapprovalHistory: approvalHistory,
    changeRequestedAt: '2026-06-16T09:05:00+10:00',
    changeRequestedByEmail: 'manager@example.edu',
    changeRequestedByName: 'Line Manager',
    changeStage: 'approval',
    changeComment: 'Please shorten this.',
    lastEditedAt: '2026-06-16T09:10:00+10:00',
    lastEditedByEmail: 'employee@example.edu',
    changeHistory
  });
  appendLegacyOvertimeRow(harness, {
    requestId: 'OT-LEGACY-002',
    createdAt: '2026-06-16T10:00:00+10:00',
    updatedAt: '2026-06-16T10:05:00+10:00',
    status: 'PREAPPROVAL_DENIED',
    employeeEmail: 'employee2@example.edu',
    employeeName: 'Denied Employee',
    lineManagerEmail: 'manager@example.edu',
    isLineManagerRequester: 'Yes',
    reason: 'Denied legacy overtime row',
    overtimeDate: '2026-06-21',
    normallyWorks: 'No',
    plannedStartTime: '09:00',
    plannedFinishTime: '12:00',
    plannedHours: '3',
    mealRulesAcknowledged: 'Yes',
    compensationMethod: 'Payment at Casual/Overtime Rates',
    activeApprovalTokenHash: 'stale-token-hash',
    activeApprovalStage: 'preapproval',
    activeApprovalStepIndex: '1',
    activeApprovalStepName: 'Head of Operations',
    activeApprovalStepEmail: 'ops@example.edu',
    denialReason: 'No approval.'
  });

  const result = harness.api.migrateLegacyRequestRows();
  const requests = harness.requests;
  const migratedPending = requests.find(request => request.requestId === 'OT-LEGACY-001');
  const migratedDenied = requests.find(request => request.requestId === 'OT-LEGACY-002');
  const overtimeHeaders = harness.spreadsheet.getSheetByName('Overtime Requests').rows[0];

  assert.equal(result.ok, true);
  assert.equal(result.migrated, 2);
  assert.equal(result.skippedExisting, 0);
  assert.equal(result.archivedSheetName, 'Requests Migrated 2026-06-15');
  assert.equal(harness.spreadsheet.getSheetByName('Requests'), null);
  assert.ok(harness.spreadsheet.getSheetByName('Requests Migrated 2026-06-15'));
  assert.equal(requests.length, 2);

  assert.equal(migratedPending._sheetName, 'Overtime Requests');
  assert.equal(migratedPending.processType, 'overtime');
  assert.equal(migratedPending.status, harness.api.STATUS.PENDING_APPROVAL);
  assert.equal(migratedPending.activeApprovalStage, 'approval');
  assert.equal(migratedPending.activeApprovalTokenHash, 'legacy-token-hash');
  assert.equal(migratedPending.approvalCompletedAt, '2026-06-16T09:01:00+10:00');
  assert.equal(migratedPending.approvalHistory, approvalHistory);
  assert.equal(migratedPending.changeRequestedAt, '2026-06-16T09:05:00+10:00');
  assert.equal(migratedPending.changeHistory, changeHistory);

  assert.equal(migratedDenied.status, harness.api.STATUS.APPROVAL_DENIED);
  assert.equal(migratedDenied.activeApprovalStage, '');
  assert.equal(migratedDenied.activeApprovalStepEmail, '');
  assert.equal(migratedDenied.activeApprovalTokenHash, '');
  assert.equal(migratedDenied.denialReason, 'No approval.');
  assert.equal(overtimeHeaders.includes('preapprovalCompletedAt'), false);
  assert.equal(overtimeHeaders.includes('preapprovalHistory'), false);
});

test('legacy migration skips rows that already exist in the target process tab', () => {
  const harness = createAppsScriptHarness();
  harness.api.setup();
  submit(harness);
  const existing = currentRequest(harness);

  appendLegacyOvertimeRow(harness, {
    requestId: existing.requestId,
    createdAt: '2026-06-16T08:00:00+10:00',
    updatedAt: '2026-06-16T08:00:00+10:00',
    status: 'PENDING_PREAPPROVAL',
    employeeEmail: 'duplicate@example.edu',
    employeeName: 'Duplicate Legacy Row'
  });

  const result = harness.api.migrateLegacyRequestRows();

  assert.equal(result.ok, true);
  assert.equal(result.migrated, 0);
  assert.equal(result.skippedExisting, 1);
  assert.equal(harness.requests.length, 1);
  assert.equal(harness.requests[0].employeeEmail, existing.employeeEmail);
  assert.equal(harness.spreadsheet.getSheetByName('Requests'), null);
});

test('process request tabs use process-specific form and operational headers', () => {
  const harness = createAppsScriptHarness();

  harness.api.setup();
  const overtimeHeaders = harness.spreadsheet.getSheetByName('Overtime Requests').rows[0];
  const vtrHeaders = harness.spreadsheet.getSheetByName('VTR Requests').rows[0];

  assert.ok(overtimeHeaders.includes('mealRulesAcknowledged'));
  assert.ok(overtimeHeaders.includes('mealAllowance'));
  assert.ok(overtimeHeaders.includes('actualHours'));
  assert.ok(overtimeHeaders.includes('followUpDueDate'));
  assert.ok(overtimeHeaders.includes('finalApprovalHistory'));

  assert.ok(vtrHeaders.includes('eventStartTime'));
  assert.ok(vtrHeaders.includes('eventFinishTime'));
  assert.ok(vtrHeaders.includes('rollsMarkedReceptionNotified'));
  assert.ok(vtrHeaders.includes('employeeActionTokenHash'));

  [
    'overtimeDate',
    'lineManagerEmail',
    'isLineManagerRequester',
    'requesterEmail',
    'reason',
    'plannedStartTime',
    'plannedHours',
    'mealRulesAcknowledged',
    'mealBreaksAcknowledged',
    'mealAllowance',
    'actualHours',
    'followUpDueDate',
    'finalApprovalHistory',
    'compensationMethod'
  ].forEach(header => {
    assert.equal(vtrHeaders.includes(header), false, `VTR sheet should not include ${header}`);
  });
});

test('request sheet repair removes blank stale columns from the wrong process tab', () => {
  const harness = createAppsScriptHarness();
  const sheet = harness.spreadsheet.insertSheet('VTR Requests');
  sheet.appendRow(['requestId', 'processType', 'mealAllowance', 'plannedHours', 'legacyNote']);
  sheet.appendRow(['VTR-OLD', 'vtr', '', '', 'keep this populated legacy column']);

  harness.api.setup();
  const headers = sheet.rows[0];

  assert.equal(headers.includes('mealAllowance'), false);
  assert.equal(headers.includes('plannedHours'), false);
  assert.ok(headers.includes('eventStartTime'));
  assert.ok(headers.includes('rollsMarkedReceptionNotified'));
  assert.ok(headers.includes('legacyNote'));
});

test('schema-defined fields are added to process request tabs and stored', () => {
  const harness = createAppsScriptHarness();
  harness.api.DEFAULT_PROCESS_DEFINITIONS.transport = {
    key: 'transport',
    name: 'Transport Request',
    description: 'Test transport process',
    requestIdPrefix: 'TR',
    requestSheetName: 'Transport Requests',
    requestForm: 'transport',
    completionMode: 'single_stage',
    workflows: {
      approval: [
        { type: 'approval', name: 'Transport Approval', email: 'transport@example.edu' }
      ]
    },
    adminEmails: ['admin@example.edu'],
    paymentNotificationEmails: []
  };
  harness.api.FORM_DEFINITIONS.transport = {
    forms: {
      request: {
        key: 'transport',
        submitLabel: 'Submit transport request',
        adjustmentFields: ['vehicleNeeded'],
        computedFields: [
          { field: 'reason', from: 'vehicleNeeded' }
        ],
        sections: [
          {
            title: 'Transport details',
            fields: [
              { name: 'employeeName', label: 'Employee name', type: 'text', required: true },
              { name: 'employeeEmail', label: 'Employee email', type: 'email', required: true },
              { name: 'vehicleNeeded', label: 'Vehicle needed', type: 'select', required: true, options: ['Bus', 'Car'] },
              { name: 'departureDate', label: 'Departure date', type: 'date', required: true },
              { name: 'departureTime', label: 'Departure time', type: 'time', required: true }
            ]
          }
        ]
      }
    }
  };

  const result = harness.api.submitRequest({
    processType: 'transport',
    employeeName: 'Taylor Example',
    employeeEmail: 'taylor@example.edu',
    vehicleNeeded: 'Bus',
    departureDate: '2026-07-01',
    departureTime: '06:15'
  });
  const sheet = harness.spreadsheet.getSheetByName('Transport Requests');
  const headers = sheet.rows[0];
  const stored = sheet.rows[1];

  assert.equal(result.ok, true);
  assert.ok(headers.includes('vehicleNeeded'));
  assert.ok(headers.includes('departureDate'));
  assert.ok(headers.includes('departureTime'));
  assert.equal(stored[headers.indexOf('vehicleNeeded')], 'Bus');
  assert.equal(stored[headers.indexOf('departureDate')], '2026-07-01');
  assert.equal(stored[headers.indexOf('departureTime')], '06:15');
  assert.equal(harness.requests[0].reason, 'Bus');
});

test('configured web app URL is preferred over the deployed service URL', () => {
  const harness = createAppsScriptHarness({
    webAppUrl: CANONICAL_URL,
    serviceUrl: 'https://script.google.com/a/example.edu/macros/s/OLD_OR_WRONG/exec'
  });

  assert.equal(harness.api.getWebAppUrl_(), CANONICAL_URL);
});

test('line-manager request starts approval with request details visible from the link', () => {
  const harness = createAppsScriptHarness();

  const result = submit(harness);
  const request = currentRequest(harness);
  const token = latestWorkflowToken(harness, 'linemanager@example.edu');

  assert.equal(result.ok, true);
  assert.equal(request.status, harness.api.STATUS.PENDING_APPROVAL);
  assert.equal(request.activeApprovalStepName, 'Line Manager');
  assert.equal(request.activeApprovalStepEmail, 'linemanager@example.edu');

  harness.setActiveUser('linemanager@example.edu');
  const state = harness.api.getInitialState_({ mode: 'approve', token });
  assert.equal(state.mode, 'approve');
  assert.equal(state.request.requestId, request.requestId);
  assert.equal(state.request.createdAt, request.createdAt);
  assert.equal(state.approval.stepName, 'Line Manager');
  assert.equal(state.approval.canDeny, true);

  const approvalMail = harness.latestMail(mail => mail.to === 'linemanager@example.edu');
  assert.match(approvalMail.htmlBody, /Submitted/);
  assert.match(approvalMail.htmlBody, new RegExp(request.requestId));
});

test('workflow action emails include one-click decision links that record decisions immediately', () => {
  const harness = createAppsScriptHarness();
  submit(harness);

  const approvalMail = harness.latestMail(mail => mail.to === 'linemanager@example.edu');
  const token = latestWorkflowToken(harness, 'linemanager@example.edu');

  assert.match(approvalMail.htmlBody, /mode=decision&amp;token=[^"]+&amp;decision=approve/);
  assert.match(approvalMail.htmlBody, /mode=decision&amp;token=[^"]+&amp;decision=deny/);
  assert.match(approvalMail.htmlBody, />Approve<\/a>/);
  assert.match(approvalMail.htmlBody, />Deny<\/a>/);
  assert.match(approvalMail.htmlBody, /Review details or request changes/);
  assert.match(approvalMail.htmlBody, /mode=dashboard&amp;role=approver/);
  assert.doesNotMatch(approvalMail.htmlBody, /mode=approve/);

  harness.setActiveUser('someoneelse@example.edu');
  const resultState = harness.api.getInitialState_({
    mode: 'decision',
    token,
    decision: 'approve'
  });
  const request = currentRequest(harness);

  assert.equal(resultState.mode, 'closed');
  assert.equal(resultState.title, 'Approval recorded');
  assert.equal(resultState.request.requestId, request.requestId);
  assert.deepEqual(JSON.parse(JSON.stringify(resultState.closedAction)), {
    label: 'Open workflow dashboard',
    mode: 'dashboard',
    role: 'approver'
  });
  assert.equal(request.activeApprovalStepName, 'Head of Operations');
  assert.equal(JSON.parse(request.approvalHistory)[0].approverEmail, 'linemanager@example.edu');

  const reusedState = harness.api.getInitialState_({
    mode: 'decision',
    token,
    decision: 'approve'
  });
  assert.equal(reusedState.mode, 'error');
  assert.match(reusedState.message, /invalid, expired, or has already been used/);
});

test('when the line manager did not request overtime, they are notified and the requester approves', () => {
  const harness = createAppsScriptHarness();

  submit(harness, {
    isLineManagerRequester: 'No',
    requesterEmail: 'requesting@example.edu'
  });

  const request = currentRequest(harness);
  const action = harness.latestMail(mail => mail.to === 'requesting@example.edu' && /pre-approval needed/i.test(mail.subject || ''));

  assert.equal(request.activeApprovalStepName, 'Requesting Staff Member');
  assert.equal(request.activeApprovalStepEmail, 'requesting@example.edu');
  assert.ok(action);
  assert.equal(harness.mail.some(mail => mail.to === 'linemanager@example.edu' && /notification/i.test(mail.subject || '')), false);
  assert.equal(harness.events.some(event => event.event === 'APPROVAL_NOTIFICATION_SENT' && event.detailsJson.includes('linemanager@example.edu')), false);

  const token = latestWorkflowToken(harness, 'requesting@example.edu');
  harness.setActiveUser('requesting@example.edu');
  harness.api.submitApprovalDecision({ token, decision: 'approve' });

  const notification = harness.latestMail(mail => mail.to === 'linemanager@example.edu' && /notification/i.test(mail.subject || ''));
  const events = harness.events;

  assert.equal(currentRequest(harness).activeApprovalStepName, 'Head of Operations');
  assert.ok(notification);
  assert.match(notification.htmlBody, /Requesting staff member/);
  assert.match(notification.htmlBody, /requesting@example\.edu/);
  assert.ok(events.some(event => event.event === 'APPROVAL_NOTIFICATION_SENT' && event.detailsJson.includes('linemanager@example.edu')));
  const history = JSON.parse(currentRequest(harness).approvalHistory);
  const notificationHistory = history.find(entry => entry.stepName === 'Line Manager FYI');
  assert.equal(notificationHistory.decision, 'notification sent');
  assert.deepEqual(Array.from(notificationHistory.recipients), ['linemanager@example.edu']);
});

test('denial by Head of Operations notifies prior approver and line manager FYI recipient', () => {
  const harness = createAppsScriptHarness();

  submit(harness, {
    isLineManagerRequester: 'No',
    requesterEmail: 'requesting@example.edu'
  });

  const requesterToken = latestWorkflowToken(harness, 'requesting@example.edu');
  harness.setActiveUser('requesting@example.edu');
  harness.api.submitApprovalDecision({ token: requesterToken, decision: 'approve' });
  assert.ok(harness.latestMail(mail => mail.to === 'linemanager@example.edu' && /notification/i.test(mail.subject || '')));
  const headOfOperationsEmail = overtimeWorkflowEmail(harness, 'Head of Operations');
  const hooToken = latestWorkflowToken(harness, headOfOperationsEmail);

  harness.clearMail();
  harness.setActiveUser(headOfOperationsEmail);
  harness.api.submitApprovalDecision({ token: hooToken, decision: 'deny', comment: 'Not approved for Saturday' });

  const request = currentRequest(harness);
  const employeeDenied = harness.latestMail(mail => mail.to === 'employee@example.edu' && /request denied/i.test(mail.subject || ''));
  const relatedDenied = harness.latestMail(mail =>
    /request denied/i.test(mail.subject || '') &&
    mailIncludesRecipient(mail, 'requesting@example.edu') &&
    mailIncludesRecipient(mail, 'linemanager@example.edu')
  );

  assert.equal(request.status, harness.api.STATUS.APPROVAL_DENIED);
  assert.ok(employeeDenied);
  assert.ok(relatedDenied);
  assert.match(relatedDenied.htmlBody, /This overtime request was denied/);
  assert.match(relatedDenied.htmlBody, /Not approved for Saturday/);
  assert.equal(mailIncludesRecipient(relatedDenied, headOfOperationsEmail), false);
});

test('normal-work-day conditions choose different workflow steps from non-work-day requests', () => {
  const normalHarness = createAppsScriptHarness();
  const conditionalWorkflow = [
    { type: 'approval', name: 'Normal Work Day Approval', email: 'normal@example.edu', when: { normallyWorks: 'Yes' } },
    { type: 'approval', name: 'Non-Work Day Approval', email: 'nonwork@example.edu', when: { normallyWorks: 'No' } }
  ];
  setOvertimeApprovalWorkflow(normalHarness, conditionalWorkflow);
  submit(normalHarness, { normallyWorks: 'Yes' });
  assert.equal(currentRequest(normalHarness).activeApprovalStepName, 'Normal Work Day Approval');

  const nonWorkHarness = createAppsScriptHarness();
  setOvertimeApprovalWorkflow(nonWorkHarness, conditionalWorkflow);
  submit(nonWorkHarness, {
    normallyWorks: 'No',
    normalStartTime: '',
    normalFinishTime: ''
  });
  assert.equal(currentRequest(nonWorkHarness).activeApprovalStepName, 'Non-Work Day Approval');
});

test('acknowledgement steps block the workflow but cannot deny', () => {
  const harness = createAppsScriptHarness();
  setOvertimeApprovalWorkflow(harness, [
    { type: 'acknowledgement', name: 'Daily Organisation', email: 'dailyorg@example.edu' }
  ]);

  submit(harness);
  const token = latestWorkflowToken(harness, 'dailyorg@example.edu');
  const request = currentRequest(harness);
  const activeStep = harness.api.getActiveWorkflowStep_(request);

  assert.equal(activeStep.type, 'acknowledgement');
  assert.equal(harness.api.workflowStepAllowsDecision_(activeStep, 'deny'), false);
  assert.throws(
    () => harness.api.submitApprovalDecision({ token, decision: 'deny', comment: 'No' }),
    /does not allow "deny"/
  );

  const result = harness.api.submitApprovalDecision({ token, decision: 'acknowledge' });
  assert.equal(result.ok, true);
  assert.equal(currentRequest(harness).status, harness.api.STATUS.PREAPPROVED);
});

test('action steps block the workflow with a complete-action label and cannot deny', () => {
  const harness = createAppsScriptHarness();
  setOvertimeApprovalWorkflow(harness, [
    { type: 'action', name: 'Daily Organisation Action', email: 'dailyorg@example.edu' }
  ]);

  submit(harness);
  const token = latestWorkflowToken(harness, 'dailyorg@example.edu');
  const request = currentRequest(harness);
  const activeStep = harness.api.getActiveWorkflowStep_(request);

  assert.equal(activeStep.type, 'action');
  assert.equal(harness.api.workflowStepPrimaryDecision_(activeStep), 'acknowledge');
  assert.equal(harness.api.workflowStepPrimaryLabel_(activeStep), 'Complete action');
  assert.equal(harness.api.workflowStepAllowsDecision_(activeStep, 'deny'), false);
  assert.throws(
    () => harness.api.submitApprovalDecision({ token, decision: 'deny', comment: 'No' }),
    /action step does not allow "deny"/
  );

  const result = harness.api.submitApprovalDecision({ token, decision: 'acknowledge' });
  const history = JSON.parse(currentRequest(harness).approvalHistory);

  assert.equal(result.ok, true);
  assert.equal(currentRequest(harness).status, harness.api.STATUS.PREAPPROVED);
  assert.equal(history[0].decision, 'completed action');
});

test('notification steps allow many recipients, while blocking steps must resolve to one recipient', () => {
  const harness = createAppsScriptHarness();
  const request = defaultRequest();

  const notificationSteps = harness.api.resolveWorkflowSteps_([
    { type: 'notification', name: 'FYI', emails: ['one@example.edu', 'two@example.edu'] }
  ], request);
  assert.deepEqual(Array.from(notificationSteps[0].emails), ['one@example.edu', 'two@example.edu']);

  assert.throws(
    () => harness.api.resolveWorkflowSteps_([
      { type: 'approval', name: 'Bad Blocking Step', emails: ['one@example.edu', 'two@example.edu'] }
    ], request),
    /must resolve to exactly one email address/
  );
});

test('workflow conditions support any-match groups for related checklist answers', () => {
  const harness = createAppsScriptHarness();
  const request = defaultRequest({ plannedHours: '1' });

  assert.deepEqual(
    Array.from(harness.api.resolveWorkflowSteps_([
      {
        type: 'notification',
        name: 'Any matching notification',
        email: 'one@example.edu',
        when: {
          any: [
            { field: 'plannedHours', equals: '2' },
            { field: 'compensationMethod', equals: 'Payment at Casual/Overtime Rates' }
          ]
        }
      }
    ], request).map(step => step.name)),
    ['Any matching notification']
  );

  assert.deepEqual(
    Array.from(harness.api.resolveWorkflowSteps_([
      {
        type: 'notification',
        name: 'No matching notification',
        email: 'one@example.edu',
        when: {
          any: [
            { field: 'plannedHours', equals: '2' },
            { field: 'compensationMethod', equals: 'Accumulate for later Time Off in Lieu (TOIL)' }
          ]
        }
      }
    ], request)),
    []
  );
});

test('approval links and dashboard actions cannot be used by the wrong current owner', () => {
  const harness = createAppsScriptHarness();
  submit(harness);
  const request = currentRequest(harness);
  const token = latestWorkflowToken(harness, 'linemanager@example.edu');

  harness.setActiveUser('someoneelse@example.edu');
  const state = harness.api.getInitialState_({ mode: 'approve', token });
  assert.equal(state.mode, 'error');
  assert.match(state.message, /currently assigned to Line Manager <linemanager@example\.edu>/);

  assert.throws(
    () => harness.api.submitDashboardApprovalDecision({
      requestId: request.requestId,
      decision: 'approve',
      email: 'someoneelse@example.edu'
    }),
    /not currently assigned/
  );
});

test('stale approval tokens are invalid after a step is completed', () => {
  const harness = createAppsScriptHarness();
  submit(harness);
  const firstToken = latestWorkflowToken(harness, 'linemanager@example.edu');

  harness.api.submitApprovalDecision({ token: firstToken, decision: 'approve' });
  const request = currentRequest(harness);

  assert.equal(request.activeApprovalStepName, 'Head of Operations');
  assert.throws(
    () => harness.api.submitApprovalDecision({ token: firstToken, decision: 'approve' }),
    /invalid, expired, or has already been used/
  );
});

test('full approval workflow records approvals, notifications, and final pre-approved status', () => {
  const harness = createAppsScriptHarness();
  submit(harness);

  const lineManagerToken = latestWorkflowToken(harness, 'linemanager@example.edu');
  harness.api.submitApprovalDecision({ token: lineManagerToken, decision: 'approve' });
  const headToken = latestWorkflowToken(harness, overtimeWorkflowEmail(harness, 'Head of Operations'));
  harness.api.submitApprovalDecision({ token: headToken, decision: 'approve' });

  const request = currentRequest(harness);
  const events = harness.events;
  const history = JSON.parse(request.approvalHistory);

  assert.equal(request.status, harness.api.STATUS.PREAPPROVED);
  assert.equal(request.activeApprovalStepEmail, '');
  assert.equal(history.filter(entry => entry.decision === 'approved').length, 2);
  assert.equal(history.filter(entry => entry.decision === 'notification sent').length, 2);
  assert.equal(events.filter(event => event.event === 'APPROVAL_NOTIFICATION_SENT').length, 2);
  assert.ok(events.some(event => event.event === 'PREAPPROVED_AFTER_NOTIFICATIONS'));
  assert.ok(harness.mail.some(mail => mail.to === 'employee@example.edu' && /pre-approved/i.test(mail.subject || '')));
});

test('day-after actual-hours trigger sends the canonical production URL, not a stale service URL', () => {
  const harness = createAppsScriptHarness({
    webAppUrl: CANONICAL_URL,
    serviceUrl: 'https://script.google.com/a/example.edu/macros/s/STALE_DEPLOYMENT/exec'
  });
  const request = preapproveSingleStepRequest(harness, { overtimeDate: '2026-06-15' });

  assert.equal(request.status, harness.api.STATUS.PREAPPROVED);

  harness.setNow('2026-06-16T00:10:00.000Z');
  harness.clearMail();
  const result = harness.api.sendDueActualHoursRequests();
  const actualMail = harness.latestMail(mail => mail.to === 'employee@example.edu' && /confirm actual overtime hours/i.test(mail.subject || ''));
  const event = harness.events.find(row => row.event === 'ACTUAL_HOURS_EMAIL_SENT');
  const details = JSON.parse(event.detailsJson);

  assert.equal(result.sent, 1);
  assert.ok(actualMail.htmlBody.includes(`${CANONICAL_URL}?mode=actual&amp;token=`));
  assert.ok(!actualMail.htmlBody.includes('STALE_DEPLOYMENT'));
  assert.equal(details.webAppUrl, CANONICAL_URL);
  assert.equal(currentRequest(harness).status, harness.api.STATUS.AWAITING_ACTUAL_HOURS);
});

test('weekly reminders refresh workflow tokens and do not duplicate same-day actual-hours prompts', () => {
  const workflowHarness = createAppsScriptHarness();
  submit(workflowHarness);
  const originalToken = latestWorkflowToken(workflowHarness, 'linemanager@example.edu');

  workflowHarness.clearMail();
  const workflowResult = workflowHarness.api.sendWeeklyPendingReminders();
  const reminderToken = latestWorkflowToken(workflowHarness, 'linemanager@example.edu');

  assert.equal(workflowResult.workflowRemindersSent, 1);
  assert.notEqual(reminderToken, originalToken);
  assert.throws(
    () => workflowHarness.api.submitApprovalDecision({ token: originalToken, decision: 'approve' }),
    /invalid, expired, or has already been used/
  );

  const actualHarness = createAppsScriptHarness({ now: '2026-06-16T00:10:00.000Z' });
  preapproveSingleStepRequest(actualHarness, { overtimeDate: '2026-06-15' });
  actualHarness.api.sendDueActualHoursRequests();
  actualHarness.clearMail();
  const sameDayResult = actualHarness.api.sendWeeklyPendingReminders();
  assert.equal(sameDayResult.actualHoursRemindersSent, 0);

  actualHarness.setNow('2026-06-23T00:10:00.000Z');
  const laterResult = actualHarness.api.sendWeeklyPendingReminders();
  assert.equal(laterResult.actualHoursRemindersSent, 1);
  assert.ok(latestActualToken(actualHarness));
});

test('actual-hours submission starts final approval and final approval completes the request', () => {
  const harness = createAppsScriptHarness({ now: '2026-06-16T00:10:00.000Z' });
  preapproveSingleStepRequest(harness, { overtimeDate: '2026-06-15' });
  harness.api.sendDueActualHoursRequests();
  const actualToken = latestActualToken(harness);

  const submitted = harness.api.submitActualHours(Object.assign(defaultActual(), { token: actualToken }));
  let request = currentRequest(harness);
  assert.equal(submitted.ok, true);
  assert.equal(request.status, harness.api.STATUS.PENDING_FINAL_APPROVAL);
  assert.equal(request.activeApprovalStage, 'final');
  assert.equal(request.activeApprovalStepEmail, 'finalapprover@example.edu');

  const finalToken = latestWorkflowToken(harness, 'finalapprover@example.edu');
  harness.api.submitApprovalDecision({ token: finalToken, decision: 'approve' });
  request = currentRequest(harness);

  assert.equal(request.status, harness.api.STATUS.FINAL_APPROVED);
  assert.ok(request.finalApprovedAt);
  assert.ok(harness.events.some(event => event.event === 'FINAL_APPROVED'));
  assert.ok(harness.mail.some(mail => mail.to === 'employee@example.edu' && /final approved/i.test(mail.subject || '')));
});

test('pre-approval change requests invalidate approval, capture comments, values, and restart pre-approval after edit', () => {
  const harness = createAppsScriptHarness();
  configureSingleStepWorkflow(harness);
  submit(harness);
  const approvalToken = latestWorkflowToken(harness, 'linemanager@example.edu');

  harness.api.submitApprovalDecision({
    token: approvalToken,
    decision: 'changes',
    comment: 'TOO LONG'
  });
  let request = currentRequest(harness);

  assert.equal(request.status, harness.api.STATUS.NEEDS_APPROVAL_CHANGES);
  assert.equal(request.activeApprovalStepEmail, '');
  assert.throws(
    () => harness.api.submitApprovalDecision({ token: approvalToken, decision: 'approve' }),
    /invalid, expired, or has already been used/
  );

  const editToken = latestEditToken(harness);
  harness.api.submitEditedRequest(Object.assign(defaultRequest(), {
    token: editToken,
    plannedFinishTime: '18:00',
    plannedHours: '2.5',
    adjustmentComment: 'Updated finish time'
  }));
  request = currentRequest(harness);

  const changes = JSON.parse(request.changeHistory);
  const adjustment = changes.find(entry => entry.type === 'adjustment');

  assert.equal(request.status, harness.api.STATUS.PENDING_APPROVAL);
  assert.equal(request.activeApprovalStepName, 'Line Manager');
  assert.equal(adjustment.requestedByRole, 'approver');
  assert.equal(adjustment.requestedByEmail, 'linemanager@example.edu');
  assert.equal(adjustment.requestComment, 'TOO LONG');
  assert.equal(adjustment.editedByEmail, 'employee@example.edu');
  assert.deepEqual(
    adjustment.fields.filter(field => ['Planned Finish Time', 'Total Overtime Hours Requested'].includes(field.label)),
    [
      { field: 'plannedFinishTime', label: 'Planned Finish Time', from: '17:30', to: '18:00' },
      { field: 'plannedHours', label: 'Total Overtime Hours Requested', from: '2', to: '2.5' }
    ]
  );
});

test('actual-hours change requests restart only the final workflow and preserve pre-approval history', () => {
  const harness = createAppsScriptHarness({ now: '2026-06-16T00:10:00.000Z' });
  preapproveSingleStepRequest(harness, { overtimeDate: '2026-06-15' });
  harness.api.sendDueActualHoursRequests();
  harness.api.submitActualHours(Object.assign(defaultActual(), { token: latestActualToken(harness) }));

  const originalApprovalHistory = currentRequest(harness).approvalHistory;
  const finalToken = latestWorkflowToken(harness, 'finalapprover@example.edu');
  harness.api.submitApprovalDecision({
    token: finalToken,
    decision: 'changes',
    comment: 'Please check the total'
  });

  const editToken = latestEditToken(harness);
  harness.api.submitActualHours(Object.assign(defaultActual(), {
    token: editToken,
    workedAsApproved: 'No',
    actualFinishTime: '18:00',
    actualHours: '2.5',
    variationReason: 'Event ran late',
    adjustmentComment: 'Corrected actual finish'
  }));

  const request = currentRequest(harness);
  const adjustment = JSON.parse(request.changeHistory).find(entry => entry.type === 'adjustment');

  assert.equal(request.status, harness.api.STATUS.PENDING_FINAL_APPROVAL);
  assert.equal(request.activeApprovalStage, 'final');
  assert.equal(request.approvalHistory, originalApprovalHistory);
  assert.equal(adjustment.stage, 'actual');
  assert.equal(adjustment.requestedByEmail, 'finalapprover@example.edu');
  assert.equal(adjustment.requestComment, 'Please check the total');
  assert.ok(adjustment.fields.some(field =>
    field.label === 'Actual Overtime Hours' &&
    field.from === '2' &&
    field.to === '2.5'
  ));
});

test('admin reassignment invalidates the previous owner and lets the new owner act', () => {
  const harness = createAppsScriptHarness({ activeEmail: 'admin@example.edu' });
  submit(harness);
  const requestId = currentRequest(harness).requestId;

  const result = harness.api.adminReassignRequest({
    requestId,
    newApproverName: 'Delegate',
    newApproverEmail: 'delegate@example.edu'
  });
  assert.equal(result.ok, true);
  assert.equal(currentRequest(harness).activeApprovalStepEmail, 'delegate@example.edu');

  harness.setActiveUser('linemanager@example.edu');
  assert.throws(
    () => harness.api.submitDashboardApprovalDecision({ requestId, decision: 'approve' }),
    /not currently assigned/
  );

  harness.setActiveUser('delegate@example.edu');
  harness.api.submitDashboardApprovalDecision({ requestId, decision: 'approve' });
  const request = currentRequest(harness);
  const history = JSON.parse(request.approvalHistory);
  assert.equal(request.activeApprovalStepName, 'Head of Operations');
  assert.equal(history[0].approverEmail, 'delegate@example.edu');
  assert.ok(harness.events.some(event => event.event === 'APPROVAL_REASSIGNED' && event.detailsJson.includes('delegate@example.edu')));
});

test('requester and admin cancellation stop the workflow and keep requests visible as stopped', () => {
  const requesterHarness = createAppsScriptHarness({ activeEmail: 'employee@example.edu' });
  submit(requesterHarness);
  const requesterRequestId = currentRequest(requesterHarness).requestId;

  requesterHarness.api.requesterCancelRequest({ requestId: requesterRequestId });
  let request = currentRequest(requesterHarness);
  assert.equal(request.status, requesterHarness.api.STATUS.CANCELLED);
  assert.equal(request.activeApprovalStepEmail, '');
  assert.equal(request.activeApprovalTokenHash, '');

  const requesterDashboard = requesterHarness.api.getDashboardData({ role: 'requester' });
  assert.equal(requesterDashboard.requests.length, 1);
  assert.equal(requesterDashboard.requests[0].isStopped, true);
  assert.equal(requesterDashboard.requests[0].canCancel, false);

  const adminHarness = createAppsScriptHarness({ activeEmail: 'admin@example.edu' });
  submit(adminHarness);
  const adminRequestId = currentRequest(adminHarness).requestId;
  adminHarness.api.adminCancelRequest({ requestId: adminRequestId });
  request = currentRequest(adminHarness);
  const adminDashboard = adminHarness.api.getDashboardData({ role: 'admin', process: 'overtime' });

  assert.equal(request.status, adminHarness.api.STATUS.CANCELLED);
  assert.equal(adminDashboard.requests[0].isStopped, true);
  assert.equal(adminDashboard.requests[0].canAdminCancel, false);
});

test('admin dashboard handles legacy preapproval statuses with friendly labels and safe actions', () => {
  const harness = createAppsScriptHarness({ activeEmail: 'admin@example.edu' });
  submit(harness);
  const requestId = currentRequest(harness).requestId;

  setStoredRequestField(harness, requestId, 'status', 'PENDING_PREAPPROVAL');
  let dashboard = harness.api.getDashboardData({ role: 'admin', process: 'overtime' });
  let request = dashboard.requests[0];
  assert.equal(request.statusLabel, 'Pending pre-approval');
  assert.equal(request.isPending, true);
  assert.equal(request.isClosed, false);
  assert.equal(request.statusTone, 'pending');
  assert.equal(request.canRemind, true);
  assert.equal(request.canReassign, true);

  setStoredRequestField(harness, requestId, 'status', 'PREAPPROVAL_DENIED');
  dashboard = harness.api.getDashboardData({ role: 'admin', process: 'overtime' });
  request = dashboard.requests[0];
  assert.equal(request.statusLabel, 'Pre-approval denied');
  assert.equal(request.isStopped, true);
  assert.equal(request.isPending, false);
  assert.equal(request.statusTone, 'stopped');
  assert.equal(request.canRemind, false);
  assert.equal(request.canReassign, false);
  assert.equal(request.canAdminCancel, false);
});

test('requester, approver, notifier, and admin dashboards only expose the right requests', () => {
  const harness = createAppsScriptHarness();
  submit(harness, {
    isLineManagerRequester: 'No',
    requesterEmail: 'requesting@example.edu'
  });
  const requestId = currentRequest(harness).requestId;

  harness.setActiveUser('employee@example.edu');
  assert.equal(harness.api.getDashboardData({ role: 'requester' }).requests[0].requestId, requestId);

  harness.setActiveUser('requesting@example.edu');
  let dashboard = harness.api.getDashboardData({ role: 'approver' });
  assert.equal(dashboard.requests[0].canApprove, true);
  harness.api.submitDashboardApprovalDecision({ requestId, decision: 'approve' });

  harness.setActiveUser('requesting@example.edu');
  dashboard = harness.api.getDashboardData({ role: 'approver' });
  assert.equal(dashboard.requests.length, 1);
  assert.equal(dashboard.requests[0].hasApprovedByMe, true);

  harness.setActiveUser('linemanager@example.edu');
  dashboard = harness.api.getDashboardData({ role: 'approver' });
  assert.equal(dashboard.requests.length, 1);
  assert.equal(dashboard.requests[0].requestId, requestId);

  harness.setActiveUser('unrelated@example.edu');
  assert.equal(harness.api.getDashboardData({ role: 'approver' }).requests.length, 0);

  harness.setActiveUser('admin@example.edu');
  assert.equal(harness.api.getDashboardData({ role: 'admin', process: 'overtime' }).requests[0].requestId, requestId);
});

test('approver dashboard is advertised only to active or historical approvers', () => {
  const harness = createAppsScriptHarness();
  submit(harness, {
    isLineManagerRequester: 'No',
    requesterEmail: 'requesting@example.edu'
  });
  const requestId = currentRequest(harness).requestId;

  harness.setActiveUser('unrelated@example.edu');
  let state = harness.api.getInitialState_({});
  assert.equal(state.roleAvailability.requester, true);
  assert.equal(state.roleAvailability.approver, false);
  assert.equal(state.roleAvailability.admin, false);
  assert.equal(harness.api.getDashboardData({ role: 'approver' }).roleAvailability.approver, false);

  harness.setActiveUser('requesting@example.edu');
  state = harness.api.getInitialState_({});
  assert.equal(state.roleAvailability.approver, true);
  let dashboard = harness.api.getDashboardData({ role: 'approver' });
  assert.equal(dashboard.roleAvailability.approver, true);
  assert.equal(dashboard.requests[0].requestId, requestId);
  assert.equal(dashboard.requests[0].canApprove, true);

  harness.api.submitDashboardApprovalDecision({ requestId, decision: 'approve' });
  state = harness.api.getInitialState_({});
  dashboard = harness.api.getDashboardData({ role: 'approver' });
  assert.equal(state.roleAvailability.approver, true);
  assert.equal(dashboard.roleAvailability.approver, true);
  assert.equal(dashboard.requests[0].hasApprovedByMe, true);
});

test('global admins can manage global and process dashboard admins', () => {
  const harness = createAppsScriptHarness({ activeEmail: 'admin@example.edu' });
  harness.api.setup();

  let chooser = harness.api.getDashboardData({ role: 'admin' });
  assert.equal(chooser.canManageUsers, true);
  assert.ok(chooser.userManagement.globalAdmins.includes('admin@example.edu'));
  assert.ok(chooser.userManagement.processes.some(process => process.key === 'overtime'));

  const result = harness.api.updateAdminUserSettings({
    globalAdmins: ['customglobal@example.edu'],
    processAdmins: {
      overtime: ['overtimeadmin@example.edu'],
      vtr: ['vtradmin@example.edu']
    }
  });
  assert.equal(result.ok, true);
  assert.ok(result.userManagement.globalAdmins.includes('customglobal@example.edu'));
  assert.deepEqual(
    Array.from(result.userManagement.processes.find(process => process.key === 'overtime').adminEmails),
    ['overtimeadmin@example.edu']
  );
  assert.deepEqual(
    Array.from(result.userManagement.processes.find(process => process.key === 'vtr').adminEmails),
    ['vtradmin@example.edu']
  );

  harness.setActiveUser('overtimeadmin@example.edu');
  chooser = harness.api.getDashboardData({ role: 'admin' });
  assert.equal(chooser.canManageUsers, false);
  assert.deepEqual(Array.from(chooser.adminProcesses.map(process => process.key)), ['overtime']);
  assert.throws(
    () => harness.api.updateAdminUserSettings({ globalAdmins: ['other@example.edu'], processAdmins: {} }),
    /not configured as a global admin/
  );

  harness.setActiveUser('customglobal@example.edu');
  chooser = harness.api.getDashboardData({ role: 'admin' });
  assert.equal(chooser.canManageUsers, true);
});

test('global admins can manage process workflow steps from the admin dashboard', () => {
  const harness = createAppsScriptHarness({ activeEmail: 'admin@example.edu' });

  const chooser = harness.api.getDashboardData({ role: 'admin' });
  assert.equal(chooser.canManageUsers, true);
  assert.ok(chooser.workflowManagement.processes.some(process => process.key === 'overtime'));

  const management = harness.api.getAdminWorkflowManagementData({ email: 'admin@example.edu' });
  const overtime = management.workflowManagement.processes.find(process => process.key === 'overtime');
  assert.ok(overtime.stages.some(stage => stage.key === 'approval'));
  assert.ok(overtime.stages.some(stage => stage.key === 'final'));
  assert.ok(overtime.conditionFields.some(field => field.name === 'normallyWorks'));
  const overtimeLineManager = overtime.stages
    .find(stage => stage.key === 'approval')
    .steps.find(step => step.name === 'Line Manager');
  assert.equal(overtimeLineManager.subject, '');
  assert.equal(overtimeLineManager.message, '');
  assert.equal(overtimeLineManager.emailCopyMode, 'default');
  assert.equal(overtimeLineManager.defaultSubject, 'Overtime pre-approval needed');
  assert.equal(overtimeLineManager.effectiveSubject, 'Overtime pre-approval needed');
  assert.match(overtimeLineManager.effectiveSubjectLine, /\{Request ID\}: overtime pre-approval needed/);
  assert.match(overtimeLineManager.defaultMessage, /\{Employee name\} has requested overtime on \{overtime date\}/);
  assert.equal(overtimeLineManager.waitingLabel, '{Step name} <{Step email}> to {Action}');
  assert.deepEqual(
    Array.from(overtime.recipientFields.map(field => field.name)).filter(name => ['employeeEmail', 'lineManagerEmail', 'requesterEmail'].includes(name)).sort(),
    ['employeeEmail', 'lineManagerEmail', 'requesterEmail']
  );
  const vtr = management.workflowManagement.processes.find(process => process.key === 'vtr');
  const vtrCustomStep = vtr.stages
    .flatMap(stage => stage.steps)
    .find(step => step.subject && step.message);
  assert.ok(vtrCustomStep, 'Expected a VTR workflow step with custom email copy');
  assert.equal(vtrCustomStep.emailCopyMode, 'custom');
  assert.equal(vtrCustomStep.effectiveSubject, vtrCustomStep.subject);
  assert.equal(vtrCustomStep.effectiveMessage, vtrCustomStep.message);
  const vtrFields = vtr.conditionFields;
  assert.deepEqual(
    Array.from(vtrFields.find(field => field.name === 'schoolArea').options),
    ['Junior School', 'Senior School', 'K-12']
  );

  assert.throws(
    () => harness.api.updateAdminWorkflowSettings({
      email: 'admin@example.edu',
      processKey: 'overtime',
      workflows: {
        approval: [{ type: 'approval', name: 'Missing waiting text', email: 'missingwaiting@example.edu' }]
      }
    }),
    /waiting message is required/
  );

  const result = harness.api.updateAdminWorkflowSettings({
    email: 'admin@example.edu',
    processKey: 'overtime',
    workflows: {
      approval: [
        {
          type: 'notification',
          name: 'Line manager FYI',
          emails: ['notifyone@example.edu', 'notifytwo@example.edu'],
          subject: 'Overtime visibility',
          whenJson: '{"field":"normallyWorks","equals":"Yes"}'
        },
        {
          type: 'approval',
          name: 'Requester approval',
          emailField: 'requesterEmail',
          waitingLabel: '{Employee name} waiting for {Step name} ({Step email}) to {Action}'
        },
        {
          type: 'approval',
          name: 'Head approval',
          email: 'headofops@example.edu',
          waitingLabel: '{Step name} <{Step email}> to {Action}'
        }
      ],
      final: [
        {
          type: 'acknowledgement',
          name: 'Finance acknowledgement',
          email: 'finance@example.edu',
          message: 'Confirm payroll handling.',
          waitingLabel: '{Step name} <{Step email}> to {Action}'
        }
      ]
    }
  });

  assert.equal(result.ok, true);
  const updatedManagement = result.workflowManagement.processes.find(process => process.key === 'overtime');
  assert.deepEqual(
    Array.from(updatedManagement.stages.find(stage => stage.key === 'approval').steps.map(step => step.name)),
    ['Line manager FYI', 'Requester approval', 'Head approval']
  );
  assert.equal(
    updatedManagement.stages.find(stage => stage.key === 'approval').steps[1].waitingLabel,
    '{Employee name} waiting for {Step name} ({Step email}) to {Action}'
  );
  assert.equal(updatedManagement.stages.find(stage => stage.key === 'approval').steps[0].waitingLabel, '');
  assert.equal(updatedManagement.stages.find(stage => stage.key === 'approval').steps[2].waitingLabel, '{Step name} <{Step email}> to {Action}');
  assert.equal(updatedManagement.stages.find(stage => stage.key === 'final').steps[0].waitingLabel, '{Step name} <{Step email}> to {Action}');

  const definition = harness.api.getProcessDefinition_('overtime');
  assert.deepEqual(
    Array.from(definition.workflows.approval.map(step => step.name)),
    ['Line manager FYI', 'Requester approval', 'Head approval']
  );
  assert.deepEqual(Array.from(definition.workflows.approval[0].emails), ['notifyone@example.edu', 'notifytwo@example.edu']);
  assert.equal(Object.prototype.hasOwnProperty.call(definition.workflows.approval[0], 'waitingLabel'), false);
  assert.equal(definition.workflows.approval[1].waitingLabel, '{Employee name} waiting for {Step name} ({Step email}) to {Action}');
  assert.equal(definition.workflows.approval[2].waitingLabel, '{Step name} <{Step email}> to {Action}');
  assert.equal(definition.workflows.final[0].waitingLabel, '{Step name} <{Step email}> to {Action}');
  assert.deepEqual(
    JSON.parse(JSON.stringify(definition.workflows.approval[0].when)),
    { field: 'normallyWorks', equals: 'Yes' }
  );

  const request = harness.api.validateRequestForm_(defaultRequest({ isLineManagerRequester: 'No' }));
  const resolved = harness.api.resolveWorkflowSteps_(harness.api.getWorkflowConfigForStage_('approval', request), request);
  assert.deepEqual(
    Array.from(resolved.map(step => `${step.type}:${step.name}`)),
    ['notification:Line manager FYI', 'approval:Requester approval', 'approval:Head approval']
  );
  assert.equal(resolved[1].email, 'requesting@example.edu');
  assert.equal(resolved[1].waitingLabel, '{Employee name} waiting for {Step name} ({Step email}) to {Action}');

  harness.api.submitRequest(defaultRequest({ isLineManagerRequester: 'No' }));
  const dashboard = harness.api.getDashboardData({ role: 'admin', process: 'overtime' });
  assert.equal(
    dashboard.requests[0].waitingOnLabel,
    'Christo Willemse waiting for Requester approval (requesting@example.edu) to approve'
  );
});

test('process admins cannot access global workflow management', () => {
  const harness = createAppsScriptHarness({ activeEmail: 'admin@example.edu' });
  harness.api.setup();
  setConfigSetting(harness, 'global', 'ADMIN_EMAILS', ['superadmin@example.edu']);
  setConfigSetting(harness, 'overtime', 'adminEmails', ['overtimeadmin@example.edu']);

  harness.setActiveUser('overtimeadmin@example.edu');
  const chooser = harness.api.getDashboardData({ role: 'admin' });
  assert.equal(chooser.canManageUsers, false);
  assert.equal(chooser.workflowManagement, null);
  assert.throws(
    () => harness.api.getAdminWorkflowManagementData({ email: 'overtimeadmin@example.edu' }),
    /not configured as a global admin/
  );
  assert.throws(
    () => harness.api.updateAdminWorkflowSettings({
      email: 'overtimeadmin@example.edu',
      processKey: 'overtime',
      workflows: {
        approval: [{ type: 'approval', name: 'Line Manager', emailField: 'lineManagerEmail' }]
      }
    }),
    /not configured as a global admin/
  );
});

test('admin dashboard opens a process chooser and supports process-specific admin access', () => {
  const harness = createAppsScriptHarness();
  harness.api.setup();
  setConfigSetting(harness, 'global', 'ADMIN_EMAILS', ['superadmin@example.edu']);
  setConfigSetting(harness, 'overtime', 'adminEmails', ['overtimeadmin@example.edu']);
  submit(harness);
  const requestId = currentRequest(harness).requestId;

  harness.setActiveUser('overtimeadmin@example.edu');
  const initialState = harness.api.getInitialState_({ mode: 'dashboard', role: 'admin' });
  assert.equal(initialState.initialDashboardData, undefined);
  assert.equal(initialState.selectedProcess, '');

  const countsOnly = harness.api.getDashboardData({ role: 'admin' });
  assert.equal(countsOnly.requests.length, 0);
  assert.equal(countsOnly.selectedProcess, '');
  assert.equal(Array.from(countsOnly.adminProcesses.map(process => process.key)).join(','), 'overtime');
  assert.equal(countsOnly.adminProcesses[0].requestCount, 1);
  assert.deepEqual(Object.keys(countsOnly.adminDashboards), []);
  assert.ok(countsOnly.performance.totalMs >= 0);

  const chooser = harness.api.getDashboardData({ role: 'admin', preloadAdminDashboards: true });
  assert.equal(chooser.requests.length, 0);
  assert.equal(chooser.selectedProcess, '');
  assert.equal(Array.from(chooser.adminProcesses.map(process => process.key)).join(','), 'overtime');
  assert.equal(chooser.adminProcesses[0].requestCount, 1);
  assert.equal(chooser.adminDashboards.overtime.requests[0].requestId, requestId);
  assert.equal(chooser.adminDashboards.overtime.requests[0].canAdmin, true);
  assert.ok(chooser.performance.totalMs >= 0);

  const scoped = harness.api.getDashboardData({ role: 'admin', process: 'overtime' });
  assert.equal(scoped.requests[0].requestId, requestId);
  assert.equal(scoped.requests[0].canAdmin, true);
  assert.ok(scoped.performance.totalMs >= 0);
  assert.equal(harness.api.adminCancelRequest({ requestId }).ok, true);

  harness.setActiveUser('unrelated@example.edu');
  assert.throws(
    () => harness.api.getDashboardData({ role: 'admin' }),
    /not configured as an admin/
  );
});

test('global admin can load every dashboard page and process admin section', () => {
  const harness = createAppsScriptHarness({ activeEmail: 'admin@example.edu' });
  harness.api.setup();
  const overtime = submit(harness, {
    employeeName: 'SMTP Admin',
    employeeEmail: 'admin@example.edu',
    lineManagerEmail: 'admin@example.edu'
  });
  const vtr = harness.api.submitRequest(quietVtrRequest({
    employeeName: 'SMTP Admin',
    employeeEmail: 'admin@example.edu'
  }));

  assert.equal(overtime.ok, true);
  assert.equal(vtr.ok, true);

  const requesterState = harness.api.getInitialState_({ mode: 'dashboard', role: 'requester' });
  const requesterDashboard = harness.api.getDashboardData({ role: 'requester' });
  assert.equal(requesterState.role, 'requester');
  assert.equal(requesterDashboard.ok, true);
  assert.equal(requesterDashboard.email, 'admin@example.edu');
  assert.ok(requesterDashboard.requests.some(request => request.requestId === overtime.requestId));
  assert.ok(requesterDashboard.requests.some(request => request.requestId === vtr.requestId));

  const approverState = harness.api.getInitialState_({ mode: 'dashboard', role: 'approver' });
  const approverDashboard = harness.api.getDashboardData({ role: 'approver' });
  assert.equal(approverState.role, 'approver');
  assert.equal(approverDashboard.ok, true);
  assert.equal(approverDashboard.email, 'admin@example.edu');
  assert.ok(approverDashboard.requests.some(request => request.requestId === overtime.requestId));

  const adminState = harness.api.getInitialState_({ mode: 'dashboard', role: 'admin' });
  const chooser = harness.api.getDashboardData({ role: 'admin', preloadAdminDashboards: true });
  const adminProcessKeys = chooser.adminProcesses.map(process => process.key);
  assert.equal(adminState.role, 'admin');
  assert.equal(adminState.selectedProcess, '');
  assert.equal(chooser.ok, true);
  assert.equal(chooser.email, 'admin@example.edu');
  assert.ok(adminProcessKeys.includes('overtime'));
  assert.ok(adminProcessKeys.includes('vtr'));
  adminProcessKeys.forEach(processKey => {
    assert.ok(chooser.adminDashboards[processKey], `Expected cached admin dashboard for ${processKey}`);
  });
  assert.ok(chooser.adminDashboards.overtime.requests.some(request => request.requestId === overtime.requestId));
  assert.ok(chooser.adminDashboards.vtr.requests.some(request => request.requestId === vtr.requestId));

  adminProcessKeys.forEach(processKey => {
    const processState = harness.api.getInitialState_({ mode: 'dashboard', role: 'admin', process: processKey });
    const dashboard = harness.api.getDashboardData({ role: 'admin', process: processKey });
    assert.equal(processState.selectedProcess, processKey);
    assert.equal(dashboard.ok, true);
    assert.equal(dashboard.email, 'admin@example.edu');
    assert.equal(dashboard.selectedProcess, processKey);
    assert.ok(dashboard.requests.every(request => request.canAdmin));
  });
});

test('dashboard pages lazy-load request data for rolling load estimates', () => {
  const harness = createAppsScriptHarness({ activeEmail: 'employee@example.edu' });
  submit(harness);

  const requesterState = harness.api.getInitialState_({ mode: 'dashboard', role: 'requester' });
  const approverState = harness.api.getInitialState_({ mode: 'dashboard', role: 'approver' });
  const adminState = harness.api.getInitialState_({ mode: 'dashboard', role: 'admin' });

  assert.equal(requesterState.initialDashboardData, undefined);
  assert.equal(requesterState.initialDashboardError, undefined);
  assert.equal(approverState.initialDashboardData, undefined);
  assert.equal(approverState.initialDashboardError, undefined);
  assert.equal(adminState.initialDashboardData, undefined);
  assert.equal(adminState.initialDashboardError, undefined);
  assert.equal(harness.api.getDashboardData({ role: 'requester' }).requests.length, 1);
});

test('code-configured global admins are merged with the worksheet ADMIN_EMAILS row', () => {
  const harness = createAppsScriptHarness({ activeEmail: 'codeadmin@example.edu' });
  harness.api.DEFAULT_ADMIN_EMAILS.splice(0, harness.api.DEFAULT_ADMIN_EMAILS.length, 'codeadmin@example.edu', 'security@example.edu');
  harness.api.setup();
  setConfigSetting(harness, 'global', 'ADMIN_EMAILS', ['sheetadmin@example.edu']);
  submit(harness);

  const chooser = harness.api.getDashboardData({ role: 'admin' });
  const scoped = harness.api.getDashboardData({ role: 'admin', process: 'overtime' });

  assert.ok(harness.api.isAdminEmail_('codeadmin@example.edu'));
  assert.ok(harness.api.isAdminEmail_('security@example.edu'));
  assert.ok(harness.api.isAdminEmail_('sheetadmin@example.edu'));
  assert.ok(chooser.adminProcesses.some(process => process.key === 'overtime'));
  assert.equal(scoped.requests[0].requestId, currentRequest(harness).requestId);
});

test('admin reminders are available only for active workflow owners or awaiting actual hours', () => {
  const pendingHarness = createAppsScriptHarness({ activeEmail: 'admin@example.edu' });
  submit(pendingHarness);
  let dashboard = pendingHarness.api.getDashboardData({ role: 'admin', process: 'overtime' });
  assert.equal(dashboard.requests[0].canRemind, true);

  const preapprovedHarness = createAppsScriptHarness({ activeEmail: 'admin@example.edu' });
  preapproveSingleStepRequest(preapprovedHarness, { overtimeDate: '2026-06-20' });
  dashboard = preapprovedHarness.api.getDashboardData({ role: 'admin', process: 'overtime' });
  assert.equal(dashboard.requests[0].status, preapprovedHarness.api.STATUS.PREAPPROVED);
  assert.equal(dashboard.requests[0].canRemind, false);
  assert.throws(
    () => preapprovedHarness.api.adminSendReminder({ requestId: dashboard.requests[0].requestId }),
    /not currently waiting/
  );

  const awaitingHarness = createAppsScriptHarness({
    activeEmail: 'admin@example.edu',
    now: '2026-06-16T00:10:00.000Z'
  });
  preapproveSingleStepRequest(awaitingHarness, { overtimeDate: '2026-06-15' });
  awaitingHarness.api.sendDueActualHoursRequests();
  dashboard = awaitingHarness.api.getDashboardData({ role: 'admin', process: 'overtime' });
  assert.equal(dashboard.requests[0].status, awaitingHarness.api.STATUS.AWAITING_ACTUAL_HOURS);
  assert.equal(dashboard.requests[0].canRemind, true);
  assert.equal(awaitingHarness.api.adminSendReminder({ requestId: dashboard.requests[0].requestId }).ok, true);
});

test('form validation protects required wording-driven fields and actual-hours requirements', () => {
  const harness = createAppsScriptHarness();

  assert.throws(
    () => harness.api.validateRequestForm_(defaultRequest({ mealRulesAcknowledged: false })),
    /Meal break rules must be acknowledged/
  );
  assert.throws(
    () => harness.api.validateRequestForm_(defaultRequest({
      isLineManagerRequester: 'No',
      requesterEmail: ''
    })),
    /Email of requesting staff member is required/
  );
  assert.throws(
    () => harness.api.validateRequestForm_(defaultRequest({ plannedStartTime: '5pm' })),
    /24-hour HH:MM/
  );
  assert.throws(
    () => harness.api.validateRequestForm_(defaultRequest({ processType: 'unknown' })),
    /Unknown request process/
  );
  assert.throws(
    () => harness.api.validateRequestForm_(defaultVtrRequest({ eventName: '' })),
    /Event Name is required/
  );
  assert.throws(
    () => harness.api.validateRequestForm_(defaultVtrRequest({ eventStartTime: '9am' })),
    /Event Start Time must be in 24-hour HH:MM/
  );
  assert.throws(
    () => harness.api.validateRequestForm_(defaultVtrRequest({ schoolArea: 'Business Operations' })),
    /Which school area is this for has an invalid value/
  );
  assert.throws(
    () => harness.api.validateRequestForm_(defaultVtrRequest({
      offsiteExcursion: 'Yes',
      attendingStaffBriefed: ''
    })),
    /Attending staff briefed is required/
  );

  const request = defaultRequest();
  assert.throws(
    () => harness.api.validateActualHoursForm_(defaultActual({ mealBreaksAcknowledged: false }), request),
    /unpaid meal breaks/
  );
  assert.throws(
    () => harness.api.validateActualHoursForm_(defaultActual({
      workedAsApproved: 'No',
      variationReason: ''
    }), request),
    /Reason for different hours is required/
  );
});
