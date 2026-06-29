/**
 * Administrative workflow actions.
 */

function adminCancelRequest(payload) {
  ensureReady_();
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    const adminEmail = requireAdminEmail_(payload || {});
    const requestId = requireText_(payload && payload.requestId, 'Request ID');
    const request = getRequestById_(requestId);

    if (!request) {
      throw new Error(`Request ${requestId} was not found.`);
    }
    assertProcessAdminForRequest_(adminEmail, request);
    if (!isRequestCancellable_(request)) {
      throw new Error(`Request ${requestId} cannot be cancelled while it is ${statusLabel_(request.status)}.`);
    }

    return cancelRequest_(request, adminEmail, 'REQUEST_CANCELLED_BY_ADMIN');
  } finally {
    lock.releaseLock();
  }
}

function adminReassignRequest(payload) {
  ensureReady_();
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    const adminEmail = requireAdminEmail_(payload || {});
    const requestId = requireText_(payload && payload.requestId, 'Request ID');
    const newApproverEmail = validateEmail_(payload && payload.newApproverEmail, 'New action owner email');
    const newApproverName = trim_(payload && payload.newApproverName) || newApproverEmail;
    const request = getRequestById_(requestId);

    if (!request) {
      throw new Error(`Request ${requestId} was not found.`);
    }
    assertProcessAdminForRequest_(adminEmail, request);
    if (!request.activeApprovalStage || !request.activeApprovalStepEmail) {
      throw new Error(`Request ${requestId} is not waiting on a workflow step.`);
    }

    const activeStep = getActiveWorkflowStep_(request);
    const previous = {
      name: request.activeApprovalStepName,
      email: request.activeApprovalStepEmail
    };
    const token = createToken_();
    request.activeApprovalTokenHash = hashToken_(token);
    request.activeApprovalStepName = newApproverName;
    request.activeApprovalStepEmail = newApproverEmail;
    request.updatedAt = nowIso_();
    updateRequest_(request);

    logEvent_(request.requestId, adminEmail, 'APPROVAL_REASSIGNED', {
      previous,
      next: {
        name: newApproverName,
        email: newApproverEmail
      },
      stage: request.activeApprovalStage,
      stepType: activeStep ? activeStep.type : 'approval'
    });

    sendWorkflowActionEmail_(request, Object.assign({}, activeStep || {}, {
      name: newApproverName,
      email: newApproverEmail,
      emails: [newApproverEmail]
    }), token, true);

    return {
      ok: true,
      requestId: request.requestId,
      message: `Request ${request.requestId} has been reassigned to ${newApproverName}.`
    };
  } finally {
    lock.releaseLock();
  }
}

function adminSendReminder(payload) {
  ensureReady_();
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    const adminEmail = requireAdminEmail_(payload || {});
    const requestId = requireText_(payload && payload.requestId, 'Request ID');
    const request = getRequestById_(requestId);

    if (!request) {
      throw new Error(`Request ${requestId} was not found.`);
    }
    assertProcessAdminForRequest_(adminEmail, request);

    if (request.activeApprovalStage && request.activeApprovalStepEmail) {
      const activeStep = getActiveWorkflowStep_(request);
      const token = createToken_();
      request.activeApprovalTokenHash = hashToken_(token);
      request.updatedAt = nowIso_();
      updateRequest_(request);
      sendWorkflowActionEmail_(request, Object.assign({}, activeStep || {}, {
        name: request.activeApprovalStepName,
        email: request.activeApprovalStepEmail,
        emails: [request.activeApprovalStepEmail]
      }), token, true);
      logEvent_(request.requestId, adminEmail, 'WORKFLOW_ACTION_REMINDER_SENT', {
        actionOwnerEmail: request.activeApprovalStepEmail,
        stage: request.activeApprovalStage,
        stepType: activeStep ? activeStep.type : 'approval'
      });
      return {
        ok: true,
        requestId: request.requestId,
        message: `Reminder sent to ${request.activeApprovalStepName || request.activeApprovalStepEmail}.`
      };
    }

    if (request.status === STATUS.AWAITING_ACTUAL_HOURS) {
      const token = createToken_();
      request.employeeActionTokenHash = hashToken_(token);
      request.followUpSentAt = nowIso_();
      request.updatedAt = nowIso_();
      updateRequest_(request);
      const emailInfo = sendActualHoursRequestEmail_(request, token);
      logEvent_(request.requestId, adminEmail, 'EMPLOYEE_ACTUAL_HOURS_REMINDER_SENT', {
        employeeEmail: request.employeeEmail,
        webAppUrl: emailInfo.webAppUrl
      });
      return {
        ok: true,
        requestId: request.requestId,
        message: `Reminder sent to ${request.employeeName}.`
      };
    }

    if (request.status === STATUS.AWAITING_VTR_CHECKLIST) {
      const token = createToken_();
      request.employeeActionTokenHash = hashToken_(token);
      request.followUpSentAt = nowIso_();
      request.updatedAt = nowIso_();
      updateRequest_(request);
      const emailInfo = sendVtrChecklistRequestEmail_(request, token, true);
      logEvent_(request.requestId, adminEmail, 'VTR_CHECKLIST_REMINDER_SENT', {
        employeeEmail: request.employeeEmail,
        webAppUrl: emailInfo.webAppUrl
      });
      return {
        ok: true,
        requestId: request.requestId,
        message: `Checklist reminder sent to ${request.employeeName}.`
      };
    }

    if (request.status === STATUS.NEEDS_APPROVAL_CHANGES || request.status === STATUS.NEEDS_ACTUAL_HOURS_CHANGES) {
      const token = createToken_();
      request.employeeActionTokenHash = hashToken_(token);
      request.updatedAt = nowIso_();
      updateRequest_(request);
      sendChangeRequestEmail_(request, token);
      logEvent_(request.requestId, adminEmail, 'CHANGE_REQUEST_REMINDER_SENT', {
        employeeEmail: request.employeeEmail,
        changeStage: request.changeStage
      });
      return {
        ok: true,
        requestId: request.requestId,
        message: `Change reminder sent to ${request.employeeName}.`
      };
    }

    throw new Error(`Request ${requestId} is not currently waiting for a workflow action, actual hours, or checklist.`);
  } finally {
    lock.releaseLock();
  }
}

function getAdminUserManagementData(payload) {
  ensureReady_();
  const adminEmail = requireGlobalAdminEmail_(payload || {});
  return adminUserManagementResponse_(adminEmail, '');
}

function updateAdminUserSettings(payload) {
  ensureReady_();
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    const adminEmail = requireGlobalAdminEmail_(payload || {});
    const settings = normalizeAdminUserSettingsPayload_(payload || {});
    saveAdminUserSettings_(settings);
    return adminUserManagementResponse_(adminEmail, 'User access has been updated.');
  } finally {
    lock.releaseLock();
  }
}

function getAdminWorkflowManagementData(payload) {
  ensureReady_();
  const adminEmail = requireGlobalAdminEmail_(payload || {});
  return adminWorkflowManagementResponse_(adminEmail, '');
}

function updateAdminWorkflowSettings(payload) {
  ensureReady_();
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    const adminEmail = requireGlobalAdminEmail_(payload || {});
    const settings = normalizeAdminWorkflowSettingsPayload_(payload || {});
    saveAdminWorkflowSettings_(settings);
    return adminWorkflowManagementResponse_(adminEmail, 'Workflow configuration has been updated.', settings.processKey);
  } finally {
    lock.releaseLock();
  }
}

function adminUserManagementResponse_(adminEmail, message) {
  return {
    ok: true,
    email: adminEmail,
    message,
    roleAvailability: dashboardRoleAvailabilityFor_(adminEmail),
    userManagement: adminUserManagementData_()
  };
}

function adminUserManagementData_() {
  return {
    globalAdmins: getConfiguredAdminEmails_(),
    processes: getProcessOptions_()
      .filter(function (process) { return process.enabled; })
      .map(function (process) {
        return {
          key: process.key,
          name: process.name,
          description: process.description || '',
          adminEmails: getProcessAdminEmails_(process.key)
        };
      })
  };
}

function adminWorkflowManagementResponse_(adminEmail, message, processKey) {
  return {
    ok: true,
    email: adminEmail,
    message,
    processKey: processKey || '',
    roleAvailability: dashboardRoleAvailabilityFor_(adminEmail),
    workflowManagement: adminWorkflowManagementData_()
  };
}

function adminWorkflowManagementData_() {
  const definitions = getProcessDefinitions_();
  return {
    processes: Object.keys(definitions)
      .map(function (processKey) {
        const definition = definitions[processKey] || {};
        return Object.assign({
          key: definition.key || processKey
        }, definition);
      })
      .filter(function (process) { return process.enabled !== false; })
      .map(function (process) {
        return {
          key: process.key,
          name: process.name,
          description: process.description || '',
          completionMode: process.completionMode || '',
          requestForm: process.requestForm || '',
          conditionFields: adminWorkflowConditionFieldsForProcess_(process),
          recipientFields: adminWorkflowRecipientFieldsForProcess_(process),
          stages: adminWorkflowStagesForProcess_(process)
        };
      })
      .sort(function (a, b) {
        return String(a.name).localeCompare(String(b.name));
      })
  };
}

function adminWorkflowStagesForProcess_(process) {
  const workflows = process.workflows || {};
  const stageKeys = Object.keys(workflows);
  if (stageKeys.indexOf('approval') === -1) {
    stageKeys.unshift('approval');
  }
  if (trim_(process.completionMode || 'actual_hours') !== 'single_stage' && stageKeys.indexOf('final') === -1) {
    stageKeys.push('final');
  }
  stageKeys.sort(function (a, b) {
    const order = { approval: 1, final: 2, checklist: 3 };
    const aOrder = order[a] || 50;
    const bOrder = order[b] || 50;
    if (aOrder !== bOrder) {
      return aOrder - bOrder;
    }
    return String(a).localeCompare(String(b));
  });
  return stageKeys.map(function (stage) {
    return {
      key: stage,
      label: adminWorkflowStageLabel_(stage),
      steps: (workflows[stage] || []).map(function (step, index) {
        return adminWorkflowStepForEditor_(step, index, stage, process);
      })
    };
  });
}

function adminWorkflowStageLabel_(stage) {
  const labels = {
    approval: 'Approval',
    final: 'Final approval',
    checklist: 'Checklist completion'
  };
  return labels[stage] || stage;
}

function adminWorkflowConditionFieldsForProcess_(process) {
  const fields = [];
  [
    { name: 'processType', label: 'Process type' },
    { name: 'requestId', label: 'Request ID' },
    { name: 'employeeEmail', label: 'Employee email' },
    { name: 'requesterEmail', label: 'Requester email' },
    { name: 'lineManagerEmail', label: 'Line manager email' },
    { name: 'isLineManagerRequester', label: 'Line manager is requester', options: ['Yes', 'No'] },
    { name: 'normallyWorks', label: 'Normally works on this date', options: ['Yes', 'No'] }
  ].forEach(function (field) {
    adminWorkflowAddConditionField_(fields, field);
  });

  getAllFormDefinitions_(process).forEach(function (definition) {
    const formLabel = definition.title || definition.heading || definition.key || '';
    flattenFormFields_(definition).forEach(function (field) {
      if (!field || !field.name) {
        return;
      }
      adminWorkflowAddConditionField_(fields, {
        name: field.name,
        label: field.validationLabel || field.label || field.name,
        group: formLabel,
        options: adminWorkflowConditionOptions_(field.options)
      });
    });
    (definition.computedFields || []).forEach(function (field) {
      if (!field || !field.name) {
        return;
      }
      adminWorkflowAddConditionField_(fields, {
        name: field.name,
        label: field.label || field.name,
        group: formLabel,
        options: adminWorkflowConditionOptions_(field.options)
      });
    });
  });

  return fields;
}

function adminWorkflowAddConditionField_(fields, field) {
  const name = trim_(field && field.name);
  if (!name || fields.some(function (candidate) { return candidate.name === name; })) {
    return;
  }
  fields.push({
    name,
    label: trim_(field.label || name),
    group: trim_(field.group || ''),
    options: adminWorkflowConditionOptions_(field.options)
  });
}

function adminWorkflowRecipientFieldsForProcess_(process) {
  const fields = [];
  [
    { name: 'employeeEmail', label: 'Employee email' },
    { name: 'requesterEmail', label: 'Requester email' },
    { name: 'lineManagerEmail', label: 'Line manager email' }
  ].forEach(function (field) {
    adminWorkflowAddRecipientField_(fields, field);
  });

  getAllFormDefinitions_(process).forEach(function (definition) {
    const formLabel = definition.title || definition.heading || definition.key || '';
    flattenFormFields_(definition).forEach(function (field) {
      if (!field || !field.name || !adminWorkflowLooksLikeEmailField_(field)) {
        return;
      }
      adminWorkflowAddRecipientField_(fields, {
        name: field.name,
        label: field.validationLabel || field.label || field.name,
        group: formLabel
      });
    });
    (definition.computedFields || []).forEach(function (field) {
      if (!field || !field.name || !adminWorkflowLooksLikeEmailField_(field)) {
        return;
      }
      adminWorkflowAddRecipientField_(fields, {
        name: field.name,
        label: field.label || field.name,
        group: formLabel
      });
    });
  });

  return fields;
}

function adminWorkflowLooksLikeEmailField_(field) {
  return trim_(field.type).toLowerCase() === 'email' || /email$/i.test(trim_(field.name));
}

function adminWorkflowAddRecipientField_(fields, field) {
  const name = trim_(field && field.name);
  if (!name || fields.some(function (candidate) { return candidate.name === name; })) {
    return;
  }
  fields.push({
    name,
    label: trim_(field.label || name),
    group: trim_(field.group || '')
  });
}

function adminWorkflowConditionOptions_(options) {
  if (!Array.isArray(options)) {
    return [];
  }
  return options
    .map(function (option) {
      if (option && typeof option === 'object') {
        return trim_(option.value || option.label || option.name);
      }
      return trim_(option);
    })
    .filter(Boolean);
}

function adminWorkflowStepForEditor_(step, index, stage, process) {
  const type = normalizeWorkflowStepType_(step.type || 'approval');
  const defaultCopy = adminWorkflowDefaultEmailCopy_(process || {}, stage, type);
  const subject = step.subject || '';
  const message = step.message || '';
  const effectiveSubject = subject || defaultCopy.subject;
  const effectiveMessage = message || defaultCopy.message;
  const waitingLabel = isBlockingWorkflowStepType_(type) ? trim_(step.waitingLabel) : '';
  return {
    id: `step-${index + 1}`,
    type,
    name: step.name || '',
    email: step.email || '',
    emails: cloneArray_(step.emails || []),
    ccEmails: cloneArray_(step.ccEmails || []),
    emailField: step.emailField || '',
    emailFields: cloneArray_(step.emailFields || []),
    subject,
    message,
    waitingLabel,
    defaultSubject: defaultCopy.subject,
    defaultMessage: defaultCopy.message,
    effectiveSubject,
    effectiveMessage,
    effectiveSubjectLine: adminWorkflowSubjectLineExample_(effectiveSubject),
    emailCopyMode: subject && message ? 'custom' : (subject || message ? 'partial' : 'default'),
    whenJson: step.when ? JSON.stringify(step.when, null, 2) : '',
    unlessJson: step.unless ? JSON.stringify(step.unless, null, 2) : '',
    followUpStage: step.followUpStage || '',
    requireComment: Boolean(step.requireComment)
  };
}

function adminWorkflowDefaultEmailCopy_(process, stage, type) {
  const processKey = normalizeProcessKey_(process && process.key);
  const processName = trim_(process && process.name) || processKey || 'Request';
  const normalizedStage = trim_(stage);
  const normalizedType = normalizeWorkflowStepType_(type || 'approval');
  const isFinal = normalizedStage === 'final';
  const isOvertime = processKey === 'overtime';
  const isAcknowledgement = normalizedType === 'acknowledgement';
  const isAction = normalizedType === 'action';
  const isNotification = normalizedType === 'notification';

  if (isNotification) {
    const subject = isFinal ? 'Actual overtime hours notification' : `${processName} notification`;
    const message = isFinal
      ? '{Employee name} has submitted actual overtime hours. This is a notification only; no action is required from you.'
      : (isOvertime
        ? '{Employee name} has requested overtime on {overtime date}. This is a notification only; no action is required from you.'
        : `{Employee name} has submitted ${processName}{ for request date}. This is a notification only; no action is required from you.`);
    return {
      subject,
      message
    };
  }

  const subject = isOvertime
    ? (isAcknowledgement
      ? (isFinal ? 'Actual-hours acknowledgement needed' : 'Overtime acknowledgement needed')
      : (isAction ? 'Overtime action needed' : (isFinal ? 'Final overtime approval needed' : 'Overtime pre-approval needed')))
    : (isAction ? `${processName} action needed` : (isAcknowledgement ? `${processName} acknowledgement needed` : `${processName} approval needed`));
  const message = isFinal
    ? `{Employee name} has submitted actual overtime hours${isAction ? ' and your action is required' : (isAcknowledgement ? ' for acknowledgement' : ' for final approval')}.`
    : (isOvertime
      ? `{Employee name} has requested overtime on {overtime date}${isAction ? ' and your action is required' : (isAcknowledgement ? ' and your acknowledgement is required' : '')}.`
      : `{Employee name} has submitted ${processName}{ for request date}${isAction ? ' and your action is required' : (isAcknowledgement ? ' and your acknowledgement is required' : '')}.`);

  return {
    subject,
    message
  };
}

function adminWorkflowSubjectLineExample_(subject) {
  return subject ? `{Request ID}: ${String(subject).toLowerCase()}` : '';
}

function normalizeAdminWorkflowSettingsPayload_(payload) {
  const processKey = normalizeProcessKey_(requireText_(payload.processKey, 'Process'));
  const process = getProcessDefinition_(processKey);
  if (!process || normalizeProcessKey_(process.key) !== processKey) {
    throw new Error(`Process "${processKey}" was not found.`);
  }
  if (process.enabled === false) {
    throw new Error(`Process "${process.name || processKey}" is not enabled.`);
  }

  const submittedWorkflows = payload.workflows || {};
  if (!submittedWorkflows || typeof submittedWorkflows !== 'object' || Array.isArray(submittedWorkflows)) {
    throw new Error('Workflow settings must include workflow stages.');
  }

  const workflows = {};
  Object.keys(submittedWorkflows).forEach(function (stageKey) {
    const stage = normalizeWorkflowStageKey_(stageKey);
    const steps = submittedWorkflows[stageKey];
    if (!Array.isArray(steps)) {
      throw new Error(`Workflow stage "${stage}" must be a list of steps.`);
    }
    workflows[stage] = steps.map(function (step, index) {
      return normalizeAdminWorkflowStep_(step || {}, stage, index, process);
    });
  });

  if (!Object.prototype.hasOwnProperty.call(workflows, 'approval')) {
    workflows.approval = [];
  }
  if (!workflows.approval.some(function (step) { return isBlockingWorkflowStepType_(step.type); })) {
    throw new Error('The approval workflow must include at least one approval, acknowledgement, or action step.');
  }

  return {
    processKey,
    workflows
  };
}

function normalizeWorkflowStageKey_(value) {
  const stage = trim_(value).toLowerCase();
  if (!/^[a-z][a-z0-9_-]*$/.test(stage)) {
    throw new Error(`Workflow stage "${value}" is not valid.`);
  }
  return stage;
}

function normalizeAdminWorkflowStep_(step, stage, index, process) {
  const label = `${adminWorkflowStageLabel_(stage)} step ${index + 1}`;
  const type = normalizeWorkflowStepType_(step.type || 'approval');
  const name = requireText_(step.name, `${label} name`);
  const email = trim_(step.email);
  const emails = normalizeOptionalWorkflowEmailList_(step.emails, `${label} notification emails`);
  const ccEmails = normalizeOptionalWorkflowEmailList_(step.ccEmails, `${label} CC emails`);
  const emailField = normalizeWorkflowFieldName_(step.emailField, `${label} email field`, false);
  const emailFields = normalizeWorkflowFieldList_(step.emailFields, `${label} email fields`);
  const recipientCount = (email ? 1 : 0) + emails.length + (emailField ? 1 : 0) + emailFields.length;

  if (email) {
    validateEmail_(email, `${label} email`);
  }
  if (!recipientCount) {
    throw new Error(`${label} must have at least one recipient email or recipient field.`);
  }
  if (isBlockingWorkflowStepType_(type) && recipientCount !== 1) {
    throw new Error(`${label} is a blocking step and must have exactly one recipient.`);
  }

  const normalized = {
    type,
    name
  };
  if (email) {
    normalized.email = email;
  }
  if (emails.length) {
    normalized.emails = emails;
  }
  if (type === 'notification' && ccEmails.length) {
    normalized.ccEmails = ccEmails;
  }
  if (emailField) {
    normalized.emailField = emailField;
  }
  if (emailFields.length) {
    normalized.emailFields = emailFields;
  }

  const subject = trim_(step.subject);
  const message = trim_(step.message);
  const waitingLabel = isBlockingWorkflowStepType_(type) ? trim_(step.waitingLabel) : '';
  const followUpStage = trim_(step.followUpStage);
  const when = parseAdminWorkflowCondition_(step.whenJson !== undefined ? step.whenJson : step.when, `${label} when condition`);
  const unless = parseAdminWorkflowCondition_(step.unlessJson !== undefined ? step.unlessJson : step.unless, `${label} unless condition`);

  if (subject) {
    normalized.subject = subject;
  }
  if (message) {
    normalized.message = message;
  }
  if (isBlockingWorkflowStepType_(type) && !waitingLabel) {
    throw new Error(`${label} waiting message is required.`);
  }
  if (waitingLabel) {
    normalized.waitingLabel = waitingLabel;
  }
  if (when) {
    normalized.when = when;
  }
  if (unless) {
    normalized.unless = unless;
  }
  if (followUpStage) {
    normalized.followUpStage = normalizeWorkflowStageKey_(followUpStage);
  }
  if (isBlockingWorkflowStepType_(type) && submittedBoolean_(step.requireComment)) {
    normalized.requireComment = true;
  }

  return normalized;
}

function submittedBoolean_(value) {
  if (value === true) {
    return true;
  }
  return ['true', 'yes', '1', 'on'].indexOf(trim_(value).toLowerCase()) !== -1;
}

function normalizeOptionalWorkflowEmailList_(value, label) {
  if (value === undefined || value === null || value === '') {
    return [];
  }
  return normalizeSubmittedEmailList_(value, label);
}

function normalizeWorkflowFieldList_(value, label) {
  const rawValues = Array.isArray(value)
    ? value
    : String(value || '').split(/[\s,;]+/);
  const fields = rawValues
    .map(function (field) {
      return normalizeWorkflowFieldName_(field, label, false);
    })
    .filter(Boolean);
  const seen = {};
  return fields.filter(function (field) {
    if (seen[field]) {
      return false;
    }
    seen[field] = true;
    return true;
  });
}

function normalizeWorkflowFieldName_(value, label, required) {
  const field = trim_(value);
  if (!field) {
    if (required) {
      throw new Error(`${label} is required.`);
    }
    return '';
  }
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(field)) {
    throw new Error(`${label} must be a request field name.`);
  }
  return field;
}

function parseAdminWorkflowCondition_(value, label) {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  if (typeof value === 'object') {
    if (Array.isArray(value) && !value.length) {
      return null;
    }
    return cloneObject_(value);
  }
  const text = trim_(value);
  if (!text) {
    return null;
  }
  try {
    const parsed = JSON.parse(text);
    if (!parsed || (Array.isArray(parsed) && !parsed.length)) {
      return null;
    }
    if (typeof parsed !== 'object') {
      throw new Error('Condition JSON must be an object or array.');
    }
    return parsed;
  } catch (err) {
    throw new Error(`${label} must contain valid JSON.`);
  }
}

function normalizeAdminUserSettingsPayload_(payload) {
  const globalAdmins = normalizeSubmittedEmailList_(payload.globalAdmins, 'Global admins');
  if (!globalAdmins.length) {
    throw new Error('At least one global admin is required.');
  }

  const submittedProcessAdmins = payload.processAdmins || {};
  const processAdmins = {};
  getProcessOptions_()
    .filter(function (process) { return process.enabled; })
    .forEach(function (process) {
      processAdmins[process.key] = normalizeSubmittedEmailList_(
        submittedProcessAdmins[process.key],
        `${process.name || process.key} admins`
      );
    });

  return {
    globalAdmins,
    processAdmins
  };
}

function normalizeSubmittedEmailList_(value, label) {
  const rawValues = Array.isArray(value)
    ? value
    : String(value || '').split(/[\s,;]+/);
  const emails = rawValues
    .map(trim_)
    .filter(Boolean)
    .map(function (email) {
      return validateEmail_(email, label);
    });
  return uniqueEmailList_(emails);
}

function saveAdminUserSettings_(settings) {
  if (typeof nativeSaveAdminUserSettings_ === 'function') {
    nativeSaveAdminUserSettings_(settings);
    return;
  }
  saveAdminUserSettingsToConfigSheet_(settings);
}

function saveAdminWorkflowSettings_(settings) {
  if (typeof nativeSaveAdminWorkflowSettings_ === 'function') {
    nativeSaveAdminWorkflowSettings_(settings);
    return;
  }
  saveAdminWorkflowSettingsInMemory_(settings);
}

function saveAdminWorkflowSettingsInMemory_(settings) {
  const process = DEFAULT_PROCESS_DEFINITIONS[settings.processKey];
  if (!process) {
    throw new Error(`Process "${settings.processKey}" was not found.`);
  }
  process.workflows = cloneObject_(settings.workflows || {});
  saveAdminWorkflowSettingsToConfigSheet_(settings);
}

function saveAdminWorkflowSettingsToConfigSheet_(settings) {
  const sheet = getConfigSheetIfAvailable_();
  if (!sheet) {
    return;
  }

  const process = getProcessDefinition_(settings.processKey);
  const existingRows = sheet.getLastRow() > 1
    ? sheet.getRange(2, 1, sheet.getLastRow() - 1, CONFIG_HEADERS.length).getValues()
      .map(configRowFromValues_)
      .filter(function (row) {
        return !(
          normalizeProcessKey_(row.processKey) === settings.processKey &&
          row.section === 'workflow'
        );
      })
    : [];
  const workflowRows = [];
  Object.keys(settings.workflows || {}).forEach(function (stage) {
    (settings.workflows[stage] || []).forEach(function (step, index) {
      workflowRows.push(workflowStepToConfigRow_(process, stage, step, index));
    });
  });

  replaceSheetContents_(sheet, CONFIG_HEADERS, existingRows.concat(workflowRows));
  protectConfigSheet_(sheet);
}

function saveAdminUserSettingsToConfigSheet_(settings) {
  const sheet = getConfigSheetIfAvailable_();
  if (!sheet) {
    throw new Error('Config sheet is not available.');
  }

  upsertConfigSettingRow_(
    sheet,
    'global',
    '',
    'ADMIN_EMAILS',
    settings.globalAdmins,
    'Global admin dashboard access list.'
  );

  getProcessOptions_()
    .filter(function (process) { return process.enabled; })
    .forEach(function (process) {
      upsertConfigSettingRow_(
        sheet,
        process.key,
        process.name,
        'adminEmails',
        (settings.processAdmins && settings.processAdmins[process.key]) || [],
        'Process-specific admin dashboard users. Global admins can administer every process.'
      );
    });
}

function upsertConfigSettingRow_(sheet, processKey, processName, setting, value, notes) {
  const row = {};
  CONFIG_HEADERS.forEach(function (header) {
    row[header] = '';
  });
  row.processKey = processKey;
  row.processName = processName || '';
  row.section = 'setting';
  row.setting = setting;
  row.valueJson = JSON.stringify(value);
  row.enabled = 'Yes';
  row.notes = notes || '';

  const values = sheet.getLastRow() > 1
    ? sheet.getRange(2, 1, sheet.getLastRow() - 1, CONFIG_HEADERS.length).getValues()
    : [];
  for (let index = 0; index < values.length; index += 1) {
    const existing = configRowFromValues_(values[index]);
    if (normalizeProcessKey_(existing.processKey) === normalizeProcessKey_(processKey) &&
        existing.section === 'setting' &&
        existing.setting === setting) {
      sheet.getRange(index + 2, 1, 1, CONFIG_HEADERS.length).setValues([CONFIG_HEADERS.map(function (header) {
        return cellValue_(row[header]);
      })]);
      return;
    }
  }

  sheet.appendRow(CONFIG_HEADERS.map(function (header) {
    return cellValue_(row[header]);
  }));
}

function resendActualHoursRequest(requestId) {
  ensureReady_();
  const request = getRequestById_(requestId);
  if (!request) {
    throw new Error(`Request ${requestId} was not found.`);
  }
  if (request.status !== STATUS.PREAPPROVED && request.status !== STATUS.AWAITING_ACTUAL_HOURS) {
    throw new Error(`Request ${requestId} is not ready for actual-hours confirmation.`);
  }

  const token = createToken_();
  request.employeeActionTokenHash = hashToken_(token);
  request.status = STATUS.AWAITING_ACTUAL_HOURS;
  request.followUpSentAt = nowIso_();
  request.updatedAt = nowIso_();
  updateRequest_(request);
  const emailInfo = sendActualHoursRequestEmail_(request, token);
  logEvent_(request.requestId, 'admin', 'ACTUAL_HOURS_EMAIL_RESENT', {
    webAppUrl: emailInfo.webAppUrl
  });
  return {
    ok: true,
    requestId: request.requestId
  };
}
