const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { loadLiveDefinitionStore } = require('./helpers/liveDefinitionStore');

const ROOT = path.resolve(__dirname, '..');
const js = fs.readFileSync(path.join(ROOT, 'apps-script', 'JavaScript.html'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'apps-script', 'Styles.html'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'apps-script', 'Index.html'), 'utf8');
const admin = fs.readFileSync(path.join(ROOT, 'apps-script', 'Admin.js'), 'utf8');
const config = fs.readFileSync(path.join(ROOT, 'apps-script', 'Config.js'), 'utf8');
const email = fs.readFileSync(path.join(ROOT, 'apps-script', 'Email.js'), 'utf8');
const formDefinitionRuntime = fs.readFileSync(path.join(ROOT, 'apps-script', 'FormDefinitions.js'), 'utf8');
const processDefaults = fs.readFileSync(path.join(ROOT, 'apps-script', 'ProcessDefaults.js'), 'utf8');
const server = fs.readFileSync(path.join(ROOT, 'src', 'server.js'), 'utf8');
const nativeRuntime = fs.readFileSync(path.join(ROOT, 'src', 'nativeRuntime.js'), 'utf8');
const xlsxExport = fs.readFileSync(path.join(ROOT, 'src', 'xlsxExport.js'), 'utf8');
const liveDefinitions = loadLiveDefinitionStore();
const liveForms = liveDefinitions.formDefinitions;
const liveProcesses = liveDefinitions.processDefinitions;

function formDefinition(formKey, stage = 'request') {
  const definition = liveForms[formKey] || {};
  return ((definition.forms || {})[stage]) || {};
}

function formFields(formKey, stage = 'request') {
  const definition = formDefinition(formKey, stage);
  return (definition.sections || []).flatMap(section => section.fields || []);
}

function formField(formKey, stage, name) {
  return formFields(formKey, stage).find(field => field.name === name);
}

function allFormFields() {
  return Object.keys(liveForms).flatMap(formKey => {
    const forms = (liveForms[formKey] || {}).forms || {};
    return Object.keys(forms).flatMap(stage => formFields(formKey, stage));
  });
}

function optionValues(options) {
  return (options || []).map(option => {
    return option && typeof option === 'object' ? option.value : option;
  });
}

test('navigation and dashboard copy use My Requests instead of Requester', () => {
  assert.match(js, /requester:\s*'My Requests'/);
  assert.match(html, />My Requests<\/a>/);
  assert.doesNotMatch(html, />Requester<\/a>/);
  assert.doesNotMatch(js, /Requester dashboard/);
  assert.doesNotMatch(html, /status-pill/);
  assert.doesNotMatch(js, /statusPill/);
  assert.doesNotMatch(css, /\.status-pill/);
  assert.doesNotMatch(server, /status-pill/);
});

test('authenticated users can open and submit site feedback', () => {
  assert.match(html, /data-feedback-open>Feedback<\/button>/);
  assert.match(server, /data-feedback-open>Feedback<\/button>/);
  assert.match(js, /function renderFeedbackDialog\(\)/);
  assert.match(js, /data-feedback-form/);
  assert.match(js, /submitWithContainer\(form, 'submitFeedback'/);
  assert.match(js, /submitFeedback: 'Sending feedback\.\.\.'/);
  assert.match(css, /\.feedback-dialog\s*\{/);
  assert.match(css, /\.topnav button/);
  assert.match(config, /FEEDBACK_EMAIL:\s*'support@ofg\.nsw\.edu\.au'/);
  assert.match(email, /function sendFeedbackEmail_\(feedback\)/);
  assert.match(server, /'submitFeedback'/);
  assert.match(nativeRuntime, /'submitFeedback'/);
});

test('native server requires OAuth for the whole site and API', () => {
  assert.match(server, /const OAUTH_ALLOWED_DOMAIN = String\(process\.env\.OAUTH_ALLOWED_DOMAIN \|\| ''\)/);
  assert.match(server, /'submitRequest'/);
  assert.match(server, /'getDashboardData'/);
  assert.match(server, /app\.get\('\/favicon\.ico'/);
  assert.match(server, /app\.get\('\/favicon\.ico'[\s\S]*?app\.use\(requireOAuthSession\)/);
  assert.match(server, /app\.use\(requireOAuthSession\)/);
  assert.match(server, /app\.get\('\/admin\/export\/:processKey\.xlsx'/);
  assert.match(server, /function requireOAuthSession\(req, res, next\)/);
  assert.match(server, /isPublicTokenDecisionRequest\(req\)/);
  assert.match(server, /function isPublicTokenDecisionRequest\(req\)/);
  assert.match(server, /\['approve', 'acknowledge', 'deny'\]\.indexOf\(decision\) !== -1/);
  assert.match(server, /if \(!oauthConfigured\(\) \|\| req\.auth\.email \|\| isPublicTokenDecisionRequest\(req\)\)/);
  assert.match(server, /String\(req\.path \|\| ''\)\.startsWith\('\/api\/'\)/);
  assert.match(server, /res\.status\(401\)\.json\(\{ ok: false, error: 'Sign in is required\.' \}\)/);
  assert.match(server, /function renderSignInPage\(req\)/);
  assert.match(server, /Sign in with Google/);
  assert.match(server, /res\.status\(200\)\.type\('html'\)\.send\(renderSignInPage\(req\)\)/);
  assert.match(css, /\.topbar\.sign-in-topbar\s*\{/);
  assert.match(css, /\.sign-in-panel\s*\{/);
  assert.doesNotMatch(server, /INTERACTIVE_API_METHODS/);
  assert.doesNotMatch(server, /isDashboardRequest/);
});

test('approver and admin navigation are driven by role availability', () => {
  assert.match(html, /data-nav-role="approver"/);
  assert.match(html, /data-nav-role="admin"/);
  assert.match(js, /roleAvailability: normalizeRoleAvailability\(state\.roleAvailability\)/);
  assert.match(js, /function availableDashboardRoles\(\)/);
  assert.match(js, /dashboardState\.roleAvailability\[role\]/);
  assert.match(js, /function applyTopNavRoleVisibility\(\)/);
  assert.match(js, /link\.hidden = !dashboardState\.roleAvailability\[role\]/);
  assert.match(js, /function renderClosedAction\(action\)/);
  assert.match(js, /state\.closedAction/);
  assert.doesNotMatch(js, /\$\{dashboardTab\('approver'\)\}/);
});

test('admin dashboard exposes global-admin user access management', () => {
  assert.match(js, /function renderAdminSubmenu\(activeView, canManageUsers\)/);
  assert.match(js, /adminSubmenuButton\('users', 'User access', activeView\)/);
  assert.match(js, /adminSubmenuButton\('workflows', 'Approval flows', activeView\)/);
  assert.match(js, /data-admin-view="\$\{escapeHtml\(view\)\}"/);
  assert.match(js, /function renderAdminUserManagement\(userManagement\)/);
  assert.match(js, /data-admin-user-management/);
  assert.match(js, /function renderAdminAddPanel\(processes\)/);
  assert.match(js, /function renderAdminAccessTable\(globalAdmins, processes\)/);
  assert.match(js, /data-admin-list="globalAdmins"/);
  assert.match(js, /data-admin-list="processAdmins"/);
  assert.match(js, /data-admin-scope-select/);
  assert.match(js, /data-add-admin-email/);
  assert.match(js, /data-remove-admin-email/);
  assert.match(js, /function flushPendingAdminEmailInputs\(form\)/);
  assert.match(js, /function adminScopeParts\(select\)/);
  assert.match(js, /function findAdminListForScope\(form, scope, key\)/);
  assert.match(js, /function bindAdminUserManagement\(\)/);
  assert.match(js, /function addAdminEmailFromControl\(form, button\)/);
  assert.match(js, /function collectAdminUserSettings\(form\)/);
  assert.match(js, /submitWithContainer\(form, 'updateAdminUserSettings'/);
  assert.match(js, /function renderAdminWorkflowManagement\(workflowManagement\)/);
  assert.match(js, /data-admin-workflow-management/);
  assert.match(js, /data-workflow-process-select/);
  assert.match(js, /data-workflow-stage-tab/);
  assert.match(js, /data-workflow-stage-panel/);
  assert.match(js, /data-workflow-step>/);
  assert.doesNotMatch(js, /data-workflow-step draggable="true"/);
  assert.match(js, /data-workflow-drag-handle draggable="true"/);
  assert.match(js, /data-add-workflow-step/);
  assert.match(js, /data-remove-workflow-step/);
  assert.match(js, /data-move-workflow-step="up"/);
  assert.match(js, /function renderWorkflowRecipientControls\(step, type, recipientFields\)/);
  assert.match(js, /data-recipient-mode/);
  assert.match(js, /data-recipient-panel/);
  assert.match(js, /data-recipient-field/);
  assert.match(js, /function workflowRecipientFieldOptions\(recipientFields, selected\)/);
  assert.match(js, /function currentWorkflowRecipientFields\(processKey\)/);
  assert.doesNotMatch(js, /data-step-field="emailField" value="\$\{escapeHtml\(normalized\.emailField \|\| ''\)\}"/);
  assert.match(js, /data-workflow-waiting-panel/);
  assert.doesNotMatch(js, /data-workflow-waiting-panel \$\{isBlockingStep \? 'open' : 'hidden'\}/);
  assert.match(js, /data-step-field="waitingLabel"/);
  assert.match(js, /data-workflow-waiting-preview/);
  assert.match(js, /function workflowDefaultWaitingLabelTemplate\(\)/);
  assert.match(js, /function updateWorkflowWaitingPreview\(step\)/);
  assert.match(js, /function workflowSampleEmailForField\(field\)/);
  assert.match(css, /\.workflow-waiting-preview\s*\{/);
  assert.match(js, /data-workflow-copy-panel/);
  assert.doesNotMatch(js, /data-workflow-copy-panel \$\{hasEmailCopy \? 'open' : ''\}/);
  assert.match(js, /data-effective-email-copy/);
  assert.match(js, /function workflowEmailCopyMode\(step\)/);
  assert.match(js, /function renderWorkflowEmailCopyPreview\(step\)/);
  assert.match(js, /normalized\.defaultSubject/);
  assert.match(js, /normalized\.defaultMessage/);
  assert.match(js, /normalized\.effectiveSubjectLine/);
  assert.match(js, /data-workflow-conditions-panel/);
  assert.doesNotMatch(js, /data-workflow-conditions-panel \$\{hasConditions \? 'open' : ''\}/);
  assert.match(js, /type="hidden" data-step-field="followUpStage"/);
  assert.doesNotMatch(js, /data-workflow-follow-up-panel/);
  assert.doesNotMatch(js, /function workflowFollowUpStageOptions/);
  assert.match(js, /function workflowRecipientModeOptions\(type, selected\)/);
  assert.match(js, /function updateWorkflowStepVisibility\(step\)/);
  assert.match(js, /function renderConditionBuilder\(fieldName, label, jsonText, conditionFields\)/);
  assert.match(js, /data-condition-builder="\$\{escapeHtml\(fieldName\)\}"/);
  assert.match(js, /data-condition-field/);
  assert.match(js, /data-condition-operator/);
  assert.match(js, /data-condition-value/);
  assert.match(js, /function conditionJsonFromBuilder\(step, fieldName\)/);
  assert.match(js, /function bindAdminWorkflowManagement\(\)/);
  assert.match(js, /function collectAdminWorkflowSettings\(form\)/);
  assert.match(js, /submitWithContainer\(form, 'updateAdminWorkflowSettings'/);
  assert.match(admin, /function adminWorkflowDefaultEmailCopy_\(process, stage, type\)/);
  assert.match(admin, /defaultSubject/);
  assert.match(admin, /effectiveSubject/);
  assert.match(admin, /emailCopyMode/);
  assert.match(server, /'getAdminWorkflowManagementData'/);
  assert.match(server, /'updateAdminWorkflowSettings'/);
  assert.doesNotMatch(js, /textarea name="globalAdmins"/);
  assert.match(css, /\.admin-submenu\s*\{/);
  assert.match(css, /\.admin-add-grid\s*\{/);
  assert.match(css, /\.admin-access-label\s*\{/);
  assert.match(css, /\.admin-access-table\s*\{/);
  assert.match(css, /\.admin-user-row\s*\{/);
  assert.match(css, /\.admin-workflows\s*\{/);
  assert.match(css, /\.workflow-stage-editor\[hidden\]\s*\{/);
  assert.match(css, /\.workflow-editor-step\s*\{/);
  assert.match(css, /\.workflow-step-grid\s*\{/);
  assert.match(css, /\.workflow-optional-panel\s*\{/);
  assert.match(css, /\.workflow-copy-mode\s*\{/);
  assert.match(css, /\.workflow-email-preview\s*\{/);
  assert.match(css, /\[data-recipient-panel\]\[hidden\]\s*\{/);
  assert.match(css, /\.workflow-condition-row\s*\{/);
});

test('new request opens a chooser, while direct process links open a specific form', () => {
  assert.match(html, /<a href="<\?= webAppUrl \?>">New request<\/a>/);
  assert.match(js, /state\.mode === 'chooser'/);
  assert.match(js, /renderFormChooser/);
  assert.match(js, /appUrl\('request', \{ process: process\.key \}\)/);
  assert.match(js, /name="processType"/);
});

test('request forms are rendered from reusable schema question types', () => {
  assert.deepEqual(Object.keys(liveForms).sort(), ['overtime', 'vtr']);
  assert.match(formDefinitionRuntime, /const FORM_DEFINITIONS = \{\};/);
  assert.match(processDefaults, /const DEFAULT_PROCESS_DEFINITIONS = \{\};/);
  assert.match(nativeRuntime, /nativeRefreshDefinitions\(api\)/);
  assert.doesNotMatch(nativeRuntime, /nativeSeedDefinitionStore/);
  assert.doesNotMatch(nativeRuntime, /code-seed/);
  assert.match(js, /renderConfiguredFormSection/);
  assert.match(js, /renderConfiguredField/);
  assert.match(js, /data-visible-when/);
  assert.match(js, /data-required-condition/);
  assert.match(js, /function choiceCardOption/);
  assert.ok(allFormFields().some(field => field.type === 'choiceCards'));
  assert.ok(allFormFields().some(field => field.type === 'checklistChoice'));
  assert.doesNotMatch(js, /renderVtrRequestForm/);
});

test('actual-hours follow-up form is also rendered from the reusable schema', () => {
  const actual = formDefinition('overtime', 'actual');
  assert.equal(actual.key, 'overtime.actual');
  assert.ok(formFields('overtime', 'actual').some(field => field.type === 'requestSummary'));
  assert.equal(formField('overtime', 'actual', 'actualStartTime').defaultFromField, 'plannedStartTime');
  assert.deepEqual(formField('overtime', 'actual', 'variationReason').visibleWhen, { field: 'workedAsApproved', equals: 'No' });
  assert.match(js, /function renderActualHours\(\)/);
  assert.match(js, /definition\.sections/);
  assert.match(js, /renderConfiguredFormSection\(section, request, isChangeEdit, index\)/);
  assert.match(js, /data-checklist-action="save"/);
  assert.match(js, /data-checklist-action="complete"/);
  assert.match(js, />Submit checklist<\/button>/);
  assert.match(js, /data\.checklistAction = submitter/);
  assert.match(js, /result\.closed/);
  assert.match(js, /Submitting checklist/);
  assert.match(js, /Checklist submitted/);
  assert.match(nativeRuntime, /checklistCompletedAt/);
  assert.doesNotMatch(js, /wireActualToggles/);
  assert.doesNotMatch(js, /variation-wrap/);
  assert.doesNotMatch(js, /MEAL_ALLOWANCE_OPTIONS/);
  assert.equal(liveForms.overtime.actualForm, undefined);
  assert.equal(liveForms.overtime['${stage}Form'], undefined);
});

test('obsolete admin skip and code-level workflow override paths are removed', () => {
  assert.doesNotMatch(admin, /adminSkipWorkflowStep/);
  assert.doesNotMatch(config, /CODE_WORKFLOW_OVERRIDES/);
});

test('generic workflow stage is approval, with pre-approval only as overtime copy', () => {
  assert.match(js, /'approval'/);
  assert.match(js, /approvalWorkflowSteps/);
  assert.match(js, /checklistWorkflowSteps/);
  assert.match(js, /checklistNotificationHistory/);
  assert.match(js, /role === 'admin' \|\| role === 'requester' \? renderRequestWorkflow\(request\) : renderHistory\(request\)/);
  assert.match(js, /function renderChecklistWorkflow\(request\)/);
  assert.match(js, /VTR checklist notifications/);
  assert.match(js, /function workflowHistoryBuckets\(steps, history\)/);
  assert.doesNotMatch(js, /preapprovalWorkflowSteps/);
  assert.doesNotMatch(js, /activeApprovalStage === 'preapproval'/);
  assert.equal(JSON.stringify(liveForms).includes('preapprovalAdjustmentFields'), false);
});

test('adjustment tracking belongs to form definitions, not process workflow defaults', () => {
  assert.ok(formDefinition('overtime', 'request').adjustmentFields);
  assert.match(formDefinitionRuntime, /getFormAdjustmentFields_/);
  assert.doesNotMatch(processDefaults, /AdjustmentFields/);
  assert.doesNotMatch(processDefaults, /adjustmentFields/);
  assert.doesNotMatch(config, /getProcessAdjustmentFields_/);
});

test('VTR form definition has event, checklist, and offsite fields without asking for first approver', () => {
  assert.ok(formField('vtr', 'request', 'eventName'));
  assert.ok(formField('vtr', 'request', 'eventDate'));
  assert.deepEqual(formField('vtr', 'request', 'multiDayEvent'), {
    name: 'multiDayEvent',
    type: 'checkbox',
    label: 'This is a multi-day event',
    layout: 'full',
    help: 'Tick this to enter a start and end date instead of a single event date.'
  });
  assert.deepEqual(formField('vtr', 'request', 'eventDate').visibleWhen, { field: 'multiDayEvent', notEquals: 'Yes' });
  assert.deepEqual(formField('vtr', 'request', 'eventStartDate').visibleWhen, { field: 'multiDayEvent', equals: 'Yes' });
  assert.deepEqual(formField('vtr', 'request', 'eventEndDate').visibleWhen, { field: 'multiDayEvent', equals: 'Yes' });
  assert.equal(formField('vtr', 'request', 'eventStartDate').type, 'date');
  assert.equal(formField('vtr', 'request', 'eventEndDate').type, 'date');
  assert.equal(formField('vtr', 'request', 'eventStartTime').type, 'time');
  assert.equal(formField('vtr', 'request', 'eventFinishTime').type, 'time');
  assert.match(js, /function formatVtrEventDateRange\(request\)/);
  assert.match(js, /request\.eventStartDate/);
  assert.match(js, /request\.eventEndDate/);
  assert.ok(formField('vtr', 'request', 'schoolArea'));
  assert.ok(formField('vtr', 'request', 'eventType'));
  assert.ok(formField('vtr', 'request', 'offsiteExcursion'));
  assert.ok(formField('vtr', 'request', 'rollsMarkedReceptionNotified'));
  assert.deepEqual(formField('vtr', 'request', 'riskAssessmentRequired'), {
    name: 'riskAssessmentRequired',
    type: 'checklistChoice',
    label: 'Is a risk assessment required?',
    layout: 'full',
    options: ['Yes', 'No'],
    required: true
  });
  assert.equal(formField('vtr', 'checklist', 'groundsConsulted').label, 'Grounds consulted and ticket entered where required.');
  assert.equal(formField('vtr', 'checklist', 'itConsulted').label, 'IT consulted and ticket entered where required.');
  assert.equal(formField('vtr', 'checklist', 'groundsAfterHoursNotified').label, 'Grounds notified that this event occurs outside normal school hours.');
  assert.equal(formField('vtr', 'checklist', 'groundsItConsulted'), undefined);
  assert.match(js, /const checklistOptions = fieldSpec\.options \|\| \['Yes', 'No', 'N\/A'\]/);
  assert.equal(JSON.stringify(liveForms).includes('"Business Operations"'), false);
  assert.equal(JSON.stringify(liveForms).includes('firstApprover'), false);
  assert.equal(JSON.stringify(liveForms).includes('initialApprover'), false);
  assert.doesNotMatch(js, /firstApprover/);
});

test('admin dashboard preloads process dashboards with diagnostics and smooth switching', () => {
  assert.match(js, /renderAdminProcessChooser/);
  assert.match(js, /renderAdminDatabaseStatus/);
  assert.match(js, /database\.spreadsheetId/);
  assert.match(js, /performance\.totalMs/);
  assert.match(js, /formatDuration\(performance\.totalMs\)/);
  assert.match(js, /<details class="database-status/);
  assert.match(js, /summaryLabel = mismatch \? 'System details - attention needed' : 'System details'/);
  assert.match(css, /\.database-status summary\s*\{/);
  assert.match(css, /\.database-status-content\s*\{/);
  assert.match(css, /\.database-status\s*\{/);
  assert.match(js, /appUrl\('dashboard', \{ role: 'admin', process: process\.key \}\)/);
  assert.match(js, /data-admin-process="\$\{escapeHtml\(process\.key\)\}"/);
  assert.match(js, /function bindAdminProcessNavigation/);
  assert.match(js, /dashboardState\.adminDashboards\[processKey\]/);
  assert.match(js, /function updateCachedAdminDashboard/);
  assert.match(js, /function renderLoadedDashboardData/);
  assert.match(js, /dashboardState\.adminChooserData\.adminDashboards = dashboardState\.adminDashboards/);
  assert.match(js, /<span>Admin dashboard<\/span>/);
  assert.match(js, /class="dashboard-context-copy"/);
  assert.match(js, /data-admin-export/);
  assert.match(js, /data-admin-export download/);
  assert.match(js, /Download Excel/);
  assert.match(js, /\/admin\/export\/\$\{encodeURIComponent\(selectedKey\)\}\.xlsx/);
  assert.match(css, /\.dashboard-context-copy strong\s*\{[\s\S]*?font-size: 22px;/);
  assert.match(css, /\.dashboard-context-actions\s*\{/);
  assert.match(server, /buildAdminAuditWorkbook/);
  assert.match(server, /loadAdminAuditExportData/);
  assert.match(xlsxExport, /'Requests'/);
  assert.match(xlsxExport, /'Workflow History'/);
  assert.match(xlsxExport, /'Outbound Emails'/);
  assert.match(xlsxExport, /'Definitions'/);
  assert.match(js, /payload\.preloadAdminDashboards = true/);
  assert.match(js, /dashboardLoadTimeoutMs\(payload\)/);
  assert.match(js, /preloadAdminDashboards\) \{\s*return 330000;/);
  assert.match(js, /if \(payload && payload\.role === 'admin'\) \{\s*return 180000;/);
  assert.match(js, /link\.matches\('\[data-admin-process\], \[data-admin-process-chooser\], \[data-admin-export\]'\)/);
  assert.match(js, /event\.preventDefault\(\);[\s\S]*?dashboardState\.selectedProcess = processKey;[\s\S]*?runServer\('getDashboardData'/);
  assert.match(js, /if \(dashboard\) \{[\s\S]*?hideGlobalProgress\(true\);[\s\S]*?renderDashboardData\(dashboard\)/);
  assert.match(js, /event\.preventDefault\(\);\s*hideGlobalProgress\(true\);[\s\S]*?dashboardState\.selectedProcess = ''/);
  assert.match(js, /event\.preventDefault\(\)/);
  assert.match(js, /data-admin-process-chooser/);
  assert.match(js, /dashboardState\.selectedProcess/);
  assert.match(js, /Change form/);
  assert.match(js, /runServer\('getDashboardData'/);
  assert.doesNotMatch(js, /Open admin/);
});

test('worksheet config reset function is not exposed in the dashboard UI', () => {
  assert.doesNotMatch(js, /replaceWorksheetConfigWithFileDefaults/);
  assert.doesNotMatch(js, /replaceWorksheetConfigWithTestEmailDefaults/);
  assert.doesNotMatch(js, /replaceWorksheetConfigWithVtrTestEmailDefaults/);
  assert.doesNotMatch(js, /replaceWorksheetConfigWithLoadedDefinitions/);
  assert.doesNotMatch(js, /replaceWorksheetConfigWithTestEmailDefinitions/);
  assert.doesNotMatch(js, /replaceWorksheetConfigWithVtrTestEmailDefinitions/);
  assert.doesNotMatch(js, /migrateLegacyRequestRows/);
  assert.doesNotMatch(html, /replaceWorksheetConfigWithFileDefaults/);
  assert.doesNotMatch(html, /replaceWorksheetConfigWithTestEmailDefaults/);
  assert.doesNotMatch(html, /replaceWorksheetConfigWithVtrTestEmailDefaults/);
  assert.doesNotMatch(html, /replaceWorksheetConfigWithLoadedDefinitions/);
  assert.doesNotMatch(html, /replaceWorksheetConfigWithTestEmailDefinitions/);
  assert.doesNotMatch(html, /replaceWorksheetConfigWithVtrTestEmailDefinitions/);
  assert.doesNotMatch(html, /migrateLegacyRequestRows/);
});

test('admin row actions include reminder, reassign, and cancel buttons, with no skip-approval button', () => {
  assert.match(js, /data-admin-reminder/);
  assert.match(js, /Send reminder email/);
  assert.match(js, /data-admin-panel-trigger/);
  assert.match(js, /Reassign step/);
  assert.match(js, /data-admin-cancel/);
  assert.match(js, /Cancel request/);
  assert.match(js, /class="admin-action-panel hidden"/);
  assert.match(js, /const item = event\.currentTarget\.closest\('\.request-item'\)/);
  assert.match(js, /item\.open = true;/);
  assert.match(js, /panel\.classList\.remove\('hidden'\);[\s\S]*?target\.classList\.remove\('hidden'\);/);
  assert.match(js, /panel\.scrollIntoView\(\{ block: 'nearest' \}\);/);
  assert.match(js, /panel\.classList\.add\('hidden'\);/);
  assert.doesNotMatch(js, /data-admin-skip/);
  assert.doesNotMatch(js, /Skip approval/);
});

test('admin dashboard request summaries wrap status, waiting text, and actions cleanly', () => {
  assert.match(js, /class="request-summary-id"/);
  assert.match(js, /class="request-summary-person"/);
  assert.match(js, /class="request-summary-status"/);
  assert.match(js, /class="request-summary-waiting"/);
  assert.match(css, /grid-template-areas:\s*"id person status waiting"/);
  assert.match(css, /grid-template-areas:\s*"id person status actions"\s*"waiting waiting waiting actions"/);
  assert.match(css, /\.request-summary-waiting\s*\{[\s\S]*?overflow-wrap: anywhere;/);
  assert.match(css, /\.badge\s*\{[\s\S]*?white-space: normal;[\s\S]*?overflow-wrap: anywhere;/);
  assert.match(css, /\.admin-summary-actions\s*\{[\s\S]*?grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
  assert.match(css, /\.admin-summary-actions \.button\s*\{[\s\S]*?white-space: normal;/);
});

test('approver and admin dashboards split completed from cancelled or denied requests and start collapsed', () => {
  assert.match(js, /renderRequestSection\('Assigned to me', processAssigned, data\.role, \{ collapsible: true, open: false \}\)/);
  assert.match(js, /renderRequestSection\('Completed requests', processCompletedRequests, data\.role, \{ collapsible: true, open: false \}\)/);
  assert.match(js, /renderRequestSection\('Cancelled \/ denied requests', processStoppedRequests, data\.role, \{ collapsible: true, open: false \}\)/);
  assert.match(js, /renderRequestSection\('Incomplete requests', requests\.filter\(request => request\.isPending\), data\.role, \{ collapsible: true, open: false \}\)/);
  assert.match(css, /content: "Expand section";/);
  assert.doesNotMatch(css, /content: "Open section";/);
});

test('requester and approver dashboards group requests by process type', () => {
  assert.match(js, /sections = renderDashboardProcessGroups\(requests, data\.role, processRequests =>/);
  assert.match(js, /function renderDashboardProcessGroups\(requests, role, sectionRenderer\)/);
  assert.match(js, /data-dashboard-process="\$\{escapeHtml\(group\.key\)\}"/);
  assert.match(js, /function dashboardProcessGroups\(requests\)/);
  assert.match(css, /\.dashboard-process-group\s*\{/);
  assert.match(css, /\.dashboard-process-heading\s*\{/);
});

test('request summaries and email summaries include the submitted timestamp once in the detailed table', () => {
  assert.match(js, /\['Submitted', formatDateTime\(request\.createdAt\)\]/);
  assert.doesNotMatch(js, /request-meta">Submitted:/);
});

test('request summaries separate pre-approval details from actual-hours confirmation', () => {
  assert.match(js, /\{ section: 'Pre-approval request' \}/);
  assert.match(js, /\{ section: 'Actual hours confirmation' \}/);
  assert.match(js, /\{ section: 'VTR request details' \}/);
  assert.match(js, /\{ section: 'VTR checklist' \}/);
  assert.match(js, /function renderSummaryRow\(row\)/);
  assert.match(js, /class="summary-section"/);
  assert.match(css, /\.summary \.summary-section th\s*\{/);
});

test('overtime emails include the requesting staff member and notify line manager after requester approval', () => {
  assert.match(email, /\['Requesting staff member', request\.requesterEmail \|\| request\.lineManagerEmail\]/);
  const approvalSteps = (((liveProcesses.overtime || {}).workflows || {}).approval || []);
  assert.ok(approvalSteps.find(step => step.name === 'Requesting Staff Member'));
  assert.ok(approvalSteps.find(step => step.name === 'Line Manager FYI'));
});

test('non-requester staff email fields opt out of personal browser autofill', () => {
  const lineManager = formField('overtime', 'request', 'lineManagerEmail');
  const requester = formField('overtime', 'request', 'requesterEmail');
  [lineManager, requester].forEach(field => {
    assert.equal(field.type, 'email');
    assert.equal(field.htmlType, 'text');
    assert.equal(field.autocomplete, 'off');
    assert.equal(field.inputMode, 'email');
    assert.equal(field.pattern, '[^\\s@]+@[^\\s@]+\\.[^\\s@]+');
  });
  assert.match(js, /fieldSpec\.htmlType \|\| type/);
  assert.match(js, /addAttribute\('autocomplete', fieldSpec\.autocomplete\)/);
  assert.match(js, /addAttribute\('inputmode', fieldSpec\.inputMode \|\| fieldSpec\.inputmode\)/);
});

test('date fields use a popout picker, default to today, and do not show a redundant pick-date button', () => {
  assert.match(js, /type === 'date'/);
  assert.match(js, /todayDateKey\(\)/);
  assert.match(js, /data-date-picker/);
  assert.match(js, /data-date-popover/);
  assert.match(js, /input\.addEventListener\('click'/);
  assert.doesNotMatch(js, /Pick date/i);
});

test('time picker supports manual input, 15-minute options from 5am first, late-night options last, and explicit OK confirmation', () => {
  assert.match(js, /placeholder="HH:MM"/);
  assert.match(js, /inputmode="numeric"/);
  assert.match(js, /for \(let minutes = 5 \* 60; minutes < 24 \* 60; minutes \+= 15\)/);
  assert.match(js, /for \(let minutes = 0; minutes < 5 \* 60; minutes \+= 15\)/);
  assert.match(js, /data-time-confirm/);
  assert.match(js, />OK<\/button>/);
  assert.doesNotMatch(js, /Quick times/i);
  assert.doesNotMatch(js, /15 minute intervals/i);
});

test('overtime adjust-workday compensation captures workday times with zero overtime hours', () => {
  const compensationValue = 'Adjust workday hours (no payment required)';
  const request = formDefinition('overtime', 'request');
  assert.ok((request.sections || []).some(section => section.title === '3. Compensation'));
  assert.ok((request.sections || []).some(section => section.title === '4. Planned Work Hours'));
  const compensation = formField('overtime', 'request', 'compensationMethod');
  const adjustOption = (compensation.options || []).find(option => option.value === compensationValue);
  assert.deepEqual(adjustOption.visibleWhen, { field: 'normallyWorks', equals: 'Yes' });
  assert.equal(adjustOption.summaryVariant, 'adjustedWorkday');
  const plannedWarning = formFields('overtime', 'request').find(field => field.type === 'hoursWarning');
  const actualWarning = formFields('overtime', 'actual').find(field => field.type === 'hoursWarning');
  assert.equal(plannedWarning.startField, 'plannedStartTime');
  assert.equal(plannedWarning.compareModeValue, compensationValue);
  assert.equal(actualWarning.startField, 'actualStartTime');
  assert.equal(actualWarning.compareModeValue, compensationValue);
  assert.equal(formField('overtime', 'request', 'plannedHours').hiddenValue, '0');
  assert.equal(formField('overtime', 'actual', 'actualHours').hiddenValue, '0');
  assert.ok(optionValues(compensation.options).includes(compensationValue));
  assert.match(js, /function hoursWarningAttributes/);
  assert.match(js, /kebabCase\(key\)/);
  assert.match(js, /function getComparisonMinutesForWarning/);
  assert.match(js, /function formInputByName/);
  assert.match(js, /function choiceCardOption\(name, option, selectedValue, inputAttributes, required, request\)/);
  assert.match(js, /option\.visibleWhen/);
  assert.match(js, /function selectChoiceCardInput\(input\) \{[\s\S]*?input\.checked = true;[\s\S]*?updateConfiguredFieldVisibility\(\);[\s\S]*?input\.dispatchEvent\(new Event\('change', \{ bubbles: true \}\)\);[\s\S]*?window\.setTimeout\(updateConfiguredFieldVisibility, 0\);[\s\S]*?\}/);
  assert.match(js, /formOptionVariants && request\.formOptionVariants\.compensationMethod/);
  assert.doesNotMatch(js, /Adjust workday hours \(no payment required\)/);
  assert.match(js, /function setConditionalInputsEnabled/);
  assert.match(js, /conditionalDisabled/);
  assert.match(js, /Planned Work Hours/);
  assert.match(js, /Overtime Hours Requested/);
});

test('hours warnings are red themed and selected compensation is sand themed', () => {
  const hoursWarning = css.match(/\.hours-warning\s*\{[\s\S]*?\}/)[0];
  const selectedCompensation = css.match(/\.compensation-option\.selected\s*\{[\s\S]*?\}/)[0];
  assert.match(hoursWarning, /background: var\(--danger-bg\);/);
  assert.match(hoursWarning, /border-left: 4px solid var\(--red\);/);
  assert.match(selectedCompensation, /background: var\(--warning-bg\);/);
  assert.match(selectedCompensation, /var\(--cream\)/);
});

test('approval history renders adjustments with requester or approver, comments, and old-to-new values', () => {
  assert.match(js, /<h3>Approval History<\/h3>/);
  assert.match(js, /Change requested by/);
  assert.match(js, /Change started by/);
  assert.match(js, /Adjustment comment:/);
  assert.match(js, /field\.from/);
  assert.match(js, /field\.to/);
  assert.match(js, /visibleChangeHistoryEntries\(changeHistory\)/);
});

test('denial actions require a visible reason before notifying request parties', () => {
  assert.match(js, /<span>Reason \/ comment<\/span>/);
  assert.match(js, /data-decision-comment/);
  assert.match(js, /Required when denying or requesting changes/);
  assert.match(js, /function validateDecisionComment\(form, decision\)/);
  assert.match(js, /decision !== 'deny' && decision !== 'changes'/);
  assert.match(js, /Enter a reason before denying this request/);
  assert.match(email, /Deny opens the review page so a reason can be entered/);
  assert.doesNotMatch(email, /workflowDecisionUrl_\(webAppUrl, token, 'deny'\)/);
});

test('approval history binds named entries to their workflow step before falling back to approver email', () => {
  assert.match(js, /function workflowEntryMatchesStep\(entry, step\) \{[\s\S]*?const entryStepName = normalize\(entry\.stepName\);[\s\S]*?if \(entryStepName\) \{[\s\S]*?return entryStepName === normalize\(step\.name\);[\s\S]*?\}[\s\S]*?return normalize\(entry\.approverEmail\) === normalize\(step\.email\);[\s\S]*?\}/);
});

test('sent workflow notifications render as completed notification cards', () => {
  assert.match(js, /step\.type === 'notification'[\s\S]*?label: 'Sent'[\s\S]*?badge: 'closed'[\s\S]*?className: 'complete'/);
  assert.doesNotMatch(css, /\.badge\.sent\s*\{/);
  assert.doesNotMatch(css, /\.workflow-step\.notification-sent\s*\{/);
});

test('brand mark is used for the app favicon and header identity', () => {
  assert.match(html, /<link rel="icon" type="image\/svg\+xml" href="https:\/\/ofg\.nsw\.edu\.au\/wp-content\/uploads\/2020\/12\/OFG_Crest-With-Border-01\.svg">/);
  assert.match(html, /<img class="brand-mark" src="https:\/\/ofg\.nsw\.edu\.au\/wp-content\/uploads\/2020\/12\/OFG_Crest-With-Border-01\.svg"/);
  assert.match(css, /\.brand-lockup\s*\{[\s\S]*?grid-template-columns: 42px minmax\(0, 1fr\);/);
  assert.match(css, /\.brand-mark\s*\{[\s\S]*?width: 42px;[\s\S]*?height: 64px;[\s\S]*?background: transparent;/);
});

test('global progress indicator is available for slow Apps Script actions', () => {
  assert.match(html, /id="global-progress"/);
  assert.match(html, /data-progress-help/);
  assert.match(html, /class="progress-card"/);
  assert.match(css, /\.global-progress/);
  assert.match(css, /position: fixed;/);
  assert.match(css, /pointer-events: auto;/);
  assert.match(css, /\.progress-card/);
  assert.match(css, /\.progress-bar\s*\{[\s\S]*?width: 0;[\s\S]*?transition: width \.35s ease;/);
  assert.match(css, /body\.is-loading/);
  assert.match(js, /function showGlobalProgress/);
  assert.match(js, /function beginServerProgress/);
  assert.match(js, /function startProgressTicker/);
  assert.match(js, /function progressEstimateStorageKey/);
  assert.match(js, /function loadProgressEstimateMs/);
  assert.match(js, /function saveProgressEstimateMs/);
  assert.match(js, /function progressRemainingText/);
  assert.match(js, /preloadAdminDashboards \? 'preload' : 'single'/);
  assert.match(js, /payload\.preloadAdminDashboards \? 60000 : 12000/);
  assert.match(js, /window\.localStorage\.setItem/);
  assert.match(js, /samples\.reduce/);
  assert.match(js, /globalProgressIsVisible/);
  assert.match(js, /event\.stopImmediatePropagation\(\)/);
  assert.match(js, /progressMessageForMethod/);
  assert.match(js, /document\.addEventListener\('click'/);
  assert.match(js, /\[data-admin-process\], \[data-admin-process-chooser\], \[data-admin-export\]/);
  assert.match(js, /link\.hasAttribute\('download'\)/);
  assert.match(js, /showGlobalProgress\('Loading dashboard\.\.\.'\)/);
});
