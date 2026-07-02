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

function getAdminFormManagementData(payload) {
  ensureReady_();
  const adminEmail = requireGlobalAdminEmail_(payload || {});
  return adminFormManagementResponse_(adminEmail, '');
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

function updateAdminFormSettings(payload) {
  ensureReady_();
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    const adminEmail = requireGlobalAdminEmail_(payload || {});
    const settings = normalizeAdminFormSettingsPayload_(payload || {});
    saveAdminFormSettings_(settings);
    return adminFormManagementResponse_(adminEmail, 'Form definition has been updated.', settings.definitionKey);
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

function adminFormManagementResponse_(adminEmail, message, definitionKey) {
  return {
    ok: true,
    email: adminEmail,
    message,
    definitionKey: definitionKey || '',
    roleAvailability: dashboardRoleAvailabilityFor_(adminEmail),
    formManagement: adminFormManagementData_()
  };
}

function adminFormManagementData_() {
  const processes = getProcessDefinitions_();
  const usages = {};
  Object.keys(processes).forEach(function (processKey) {
    const process = processes[processKey] || {};
    const formKey = trim_(process.requestForm || process.key);
    if (!formKey) {
      return;
    }
    usages[formKey] = usages[formKey] || [];
    usages[formKey].push({
      key: process.key || processKey,
      name: process.name || processKey
    });
  });

  return {
    fieldTypes: adminFormFieldTypes_(),
    stageTypes: adminFormStageTypes_(),
    forms: Object.keys(FORM_DEFINITIONS)
      .map(function (definitionKey) {
        const definition = cloneObject_(FORM_DEFINITIONS[definitionKey] || {});
        return {
          key: definitionKey,
          name: trim_(definition.name) || definitionKey,
          description: trim_(definition.description),
          processUsage: usages[definitionKey] || [],
          definition
        };
      })
      .sort(function (a, b) {
        return String(a.name || a.key).localeCompare(String(b.name || b.key));
      })
  };
}

function adminFormFieldTypes_() {
  return [
    { value: 'text', label: 'Text', description: 'Single-line free text answer.' },
    { value: 'email', label: 'Email', description: 'Email address answer with email-friendly browser input.' },
    { value: 'textarea', label: 'Long text', description: 'Multi-line free text answer for longer responses.' },
    { value: 'date', label: 'Date', description: 'Calendar date answer.' },
    { value: 'time', label: 'Time', description: 'Time answer using the app time picker.' },
    { value: 'number', label: 'Number', description: 'Numeric answer.' },
    { value: 'radio', label: 'Radio choices', description: 'One choice from a short visible list.' },
    { value: 'select', label: 'Dropdown', description: 'One choice from a compact dropdown menu.' },
    { value: 'checkbox', label: 'Checkbox', description: 'Single yes or no tick box. Use Must be checked for acknowledgements.' },
    { value: 'choiceCards', label: 'Choice cards', description: 'One choice shown as larger selectable cards.' },
    { value: 'checklistChoice', label: 'Checklist choice', description: 'Checklist-style choice group used for final checklist questions.' },
    { value: 'content', label: 'Content block', description: 'Display-only rich text that does not collect an answer.' },
    { value: 'divider', label: 'Divider', description: 'Visual separator between groups of questions.' },
    { value: 'requestSummary', label: 'Request summary', description: 'Display-only summary of answers from an earlier request stage.' },
    { value: 'mealRules', label: 'Meal rules', description: 'Overtime-specific calculated meal allowance guidance.' },
    { value: 'hoursWarning', label: 'Hours warning', description: 'Overtime-specific warning based on entered hours.' }
  ];
}

function adminFormStageTypes_() {
  return [
    {
      key: 'request',
      label: 'Initial request',
      description: 'The first form a requester completes. Code owns the public request entry point and request creation flow.',
      required: true,
      defaultTriggerMode: 'initial',
      triggerSummary: 'Available when a requester starts a new request.'
    },
    {
      key: 'actual',
      label: 'Actual-hours confirmation',
      description: 'Uses the existing actual-hours token, reminder, validation, and final approval flow.',
      required: false,
      defaultTriggerMode: 'scheduled',
      triggerSummary: 'Available when an actual-hours process asks the requester to confirm final hours.'
    },
    {
      key: 'checklist',
      label: 'Checklist follow-up',
      description: 'Uses the existing checklist token, save, submit, and checklist notification flow.',
      required: false,
      defaultTriggerMode: 'workflow',
      triggerSummary: 'Available when a process starts a checklist follow-up.'
    },
    {
      key: 'generic',
      label: 'Generic follow-up',
      description: 'Stores a configurable follow-up stage schema for future or process-specific runtime integrations.',
      required: false,
      defaultTriggerMode: 'workflow',
      triggerSummary: 'Configured in the database; runtime support depends on the process workflow.'
    }
  ];
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
          formStages: adminWorkflowFormStagesForProcess_(process),
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

function adminWorkflowFormStagesForProcess_(process) {
  return getFormStages_(process)
    .filter(function (stage) {
      return stage && stage.key && stage.key !== 'request';
    })
    .map(function (stage) {
      return {
        key: stage.key,
        label: stage.label || stage.key,
        runtimeType: stage.runtimeType || '',
        triggerMode: stage.triggerMode || '',
        description: stage.description || stage.triggerSummary || '',
        canBeFollowUp: adminWorkflowFormStageCanBeFollowUp_(stage)
      };
    });
}

function adminWorkflowFormStageCanBeFollowUp_(stage) {
  const runtimeType = trim_(stage && stage.runtimeType);
  const triggerMode = trim_(stage && stage.triggerMode);
  return runtimeType === 'checklist' && triggerMode === 'workflow';
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

function normalizeAdminFormSettingsPayload_(payload) {
  const definitionKey = normalizeDefinitionKey_(requireText_(payload.definitionKey, 'Form key'));
  const definition = normalizeAdminFormDefinition_(payload.definition || {}, definitionKey);
  return {
    definitionKey,
    definition
  };
}

function normalizeDefinitionKey_(value) {
  const key = trim_(value).toLowerCase();
  if (!/^[a-z][a-z0-9_-]*$/.test(key)) {
    throw new Error('Form key must start with a letter and contain only lowercase letters, numbers, hyphens, or underscores.');
  }
  return key;
}

function normalizeAdminFormDefinition_(definition, definitionKey) {
  if (!definition || typeof definition !== 'object' || Array.isArray(definition)) {
    throw new Error('Form definition must be an object.');
  }

  const forms = definition.forms || {};
  if (!forms || typeof forms !== 'object' || Array.isArray(forms)) {
    throw new Error('Form definition must include form stages.');
  }

  const normalized = cloneObject_(definition);
  normalized.forms = {};
  normalized.stages = [];
  const name = trim_(definition.name);
  const description = trim_(definition.description);
  if (name) {
    normalized.name = name;
  } else {
    delete normalized.name;
  }
  if (description) {
    normalized.description = description;
  } else {
    delete normalized.description;
  }

  Object.keys(forms).forEach(function (stageKey) {
    const stage = normalizeWorkflowStageKey_(stageKey);
    normalized.forms[stage] = normalizeAdminFormStage_(forms[stage] || {}, stage, definitionKey);
  });
  if (Array.isArray(definition.stages)) {
    definition.stages.forEach(function (stage) {
      const stageKey = stage && stage.key ? normalizeWorkflowStageKey_(stage.key) : '';
      if (stageKey && !normalized.forms[stageKey]) {
        normalized.forms[stageKey] = normalizeAdminFormStage_({ key: stageKey === 'request' ? definitionKey : `${definitionKey}.${stageKey}`, sections: [] }, stageKey, definitionKey);
      }
    });
  }

  if (!Object.keys(normalized.forms).length) {
    normalized.forms.request = normalizeAdminFormStage_({ key: definitionKey, sections: [] }, 'request', definitionKey);
  }
  if (!normalized.forms.request) {
    throw new Error('A request form stage is required.');
  }
  normalized.stages = normalizeAdminFormStageMetadataList_(definition.stages, normalized.forms, definitionKey);

  return normalized;
}

function normalizeAdminFormStageMetadataList_(stages, forms, definitionKey) {
  const submitted = Array.isArray(stages) ? stages : [];
  const metadataByKey = {};
  const orderedKeys = [];

  submitted.forEach(function (stage, index) {
    if (!stage || typeof stage !== 'object' || Array.isArray(stage)) {
      throw new Error(`Stage ${index + 1} metadata must be an object.`);
    }
    const key = normalizeWorkflowStageKey_(stage.key);
    if (metadataByKey[key]) {
      throw new Error(`Stage "${key}" is configured more than once.`);
    }
    metadataByKey[key] = stage;
    orderedKeys.push(key);
  });

  Object.keys(forms || {}).forEach(function (stageKey) {
    const key = normalizeWorkflowStageKey_(stageKey);
    if (orderedKeys.indexOf(key) === -1) {
      orderedKeys.push(key);
    }
  });
  if (orderedKeys.indexOf('request') === -1) {
    orderedKeys.unshift('request');
  }

  const sortedKeys = ['request'].concat(orderedKeys.filter(function (key) {
    return key !== 'request';
  }));
  const seen = {};
  return sortedKeys.filter(function (key) {
    if (seen[key]) {
      return false;
    }
    seen[key] = true;
    return true;
  }).map(function (stageKey, index) {
    return normalizeAdminFormStageMetadata_(metadataByKey[stageKey] || {}, stageKey, forms[stageKey] || {}, definitionKey, index);
  });
}

function normalizeAdminFormStageMetadata_(stage, stageKey, formStage, definitionKey, index) {
  const runtimeType = normalizeAdminFormStageRuntimeType_(stage.runtimeType || stage.type || defaultAdminFormStageRuntimeType_(stageKey));
  const triggerMode = normalizeAdminFormStageTriggerMode_(stage.triggerMode || defaultAdminFormStageTriggerMode_(runtimeType));
  const label = trim_(stage.label) || trim_(formStage.title) || adminFormStageRuntimeLabel_(runtimeType) || stageKey;
  const normalized = {
    key: stageKey,
    label,
    runtimeType,
    triggerMode
  };
  if (stageKey === 'request' || submittedBoolean_(stage.required)) {
    normalized.required = true;
  }
  const description = trim_(stage.description);
  if (description) {
    normalized.description = description;
  }
  const triggerSummary = trim_(stage.triggerSummary);
  if (triggerSummary) {
    normalized.triggerSummary = triggerSummary;
  }
  const when = parseAdminWorkflowCondition_(stage.whenJson !== undefined ? stage.whenJson : stage.when, `Stage ${index + 1} start condition`);
  const unless = parseAdminWorkflowCondition_(stage.unlessJson !== undefined ? stage.unlessJson : stage.unless, `Stage ${index + 1} skip condition`);
  if (when) {
    normalized.when = when;
  }
  if (unless) {
    normalized.unless = unless;
  }
  return normalized;
}

function normalizeAdminFormStageRuntimeType_(value) {
  const type = trim_(value || 'generic').toLowerCase();
  const allowed = adminFormStageTypes_().map(function (item) { return item.key; });
  if (allowed.indexOf(type) === -1) {
    throw new Error(`Stage runtime type "${value}" is not supported.`);
  }
  return type;
}

function defaultAdminFormStageRuntimeType_(stageKey) {
  if (stageKey === 'request' || stageKey === 'actual' || stageKey === 'checklist') {
    return stageKey;
  }
  return 'generic';
}

function adminFormStageRuntimeLabel_(runtimeType) {
  const match = adminFormStageTypes_().find(function (item) {
    return item.key === runtimeType;
  });
  return match ? match.label : '';
}

function normalizeAdminFormStageTriggerMode_(value) {
  const mode = trim_(value || 'workflow').toLowerCase();
  const allowed = ['initial', 'workflow', 'scheduled', 'manual'];
  if (allowed.indexOf(mode) === -1) {
    throw new Error(`Stage trigger mode "${value}" is not supported.`);
  }
  return mode;
}

function defaultAdminFormStageTriggerMode_(runtimeType) {
  const match = adminFormStageTypes_().find(function (item) {
    return item.key === runtimeType;
  });
  return match ? match.defaultTriggerMode || 'workflow' : 'workflow';
}

function normalizeAdminFormStage_(stage, stageKey, definitionKey) {
  if (!stage || typeof stage !== 'object' || Array.isArray(stage)) {
    throw new Error(`Form stage "${stageKey}" must be an object.`);
  }
  const normalized = cloneObject_(stage);
  normalized.key = trim_(stage.key) || (stageKey === 'request' ? definitionKey : `${definitionKey}.${stageKey}`);
  normalized.sections = [].concat(stage.sections || []).map(function (section, sectionIndex) {
    return normalizeAdminFormSection_(section || {}, stageKey, sectionIndex);
  });
  normalized.adjustmentFields = normalizeAdminFormFieldList_(stage.adjustmentFields);
  ['title', 'description', 'introHtml', 'submitLabel', 'editSubmitLabel'].forEach(function (key) {
    const value = trim_(stage[key]);
    if (value) {
      normalized[key] = value;
    } else {
      delete normalized[key];
    }
  });
  return normalized;
}

function normalizeAdminFormSection_(section, stageKey, sectionIndex) {
  if (!section || typeof section !== 'object' || Array.isArray(section)) {
    throw new Error(`Section ${sectionIndex + 1} in ${stageKey} must be an object.`);
  }
  const normalized = cloneObject_(section);
  normalized.fields = [].concat(section.fields || []).map(function (field, fieldIndex) {
    return normalizeAdminFormField_(field || {}, stageKey, sectionIndex, fieldIndex);
  });
  ['title', 'description', 'editTitle', 'editDescription', 'layout'].forEach(function (key) {
    const value = trim_(section[key]);
    if (value) {
      normalized[key] = value;
    } else {
      delete normalized[key];
    }
  });
  return normalized;
}

function normalizeAdminFormField_(field, stageKey, sectionIndex, fieldIndex) {
  if (!field || typeof field !== 'object' || Array.isArray(field)) {
    throw new Error(`Field ${fieldIndex + 1} in ${stageKey} section ${sectionIndex + 1} must be an object.`);
  }
  const normalized = cloneObject_(field);
  const type = trim_(field.type || 'text');
  const allowedTypes = adminFormFieldTypes_().map(function (item) { return item.value; });
  if (allowedTypes.indexOf(type) === -1) {
    throw new Error(`Unsupported form field type "${type}".`);
  }
  normalized.type = type;
  if (adminFormFieldRequiresName_(type)) {
    normalized.name = normalizeWorkflowFieldName_(field.name, `Field ${fieldIndex + 1} name`, true);
  } else if (trim_(field.name)) {
    normalized.name = normalizeWorkflowFieldName_(field.name, `Field ${fieldIndex + 1} name`, false);
  } else {
    delete normalized.name;
  }

  ['label', 'help', 'layout', 'html', 'htmlType', 'hiddenValue', 'defaultValue', 'defaultFrom', 'defaultFromField', 'validation', 'validationLabel', 'errorMessage', 'pattern', 'inputMode', 'autocomplete', 'spellcheck', 'autocapitalize', 'className', 'kind', 'modeField', 'hoursField', 'startField', 'finishField', 'compareModeValue', 'compareStartField', 'compareFinishField', 'compareWarningTitle', 'compareWorkdayField', 'compareWarningMessage'].forEach(function (key) {
    if (field[key] === undefined || field[key] === null) {
      delete normalized[key];
      return;
    }
    const value = String(field[key]);
    if (trim_(value)) {
      normalized[key] = value;
    } else {
      delete normalized[key];
    }
  });
  ['required', 'mustBeChecked', 'planned', 'includeActual'].forEach(function (key) {
    if (field[key] === undefined || field[key] === null || field[key] === '') {
      delete normalized[key];
      return;
    }
    normalized[key] = submittedBoolean_(field[key]);
  });
  if (field.options !== undefined) {
    normalized.options = normalizeAdminFormOptions_(field.options);
  }
  ['visibleWhen', 'requiredWhen'].forEach(function (key) {
    if (field[key] && typeof field[key] === 'object' && !Array.isArray(field[key])) {
      normalized[key] = cloneObject_(field[key]);
    } else {
      delete normalized[key];
    }
  });
  return normalized;
}

function adminFormFieldRequiresName_(type) {
  return ['content', 'divider', 'requestSummary', 'mealRules', 'hoursWarning'].indexOf(type) === -1;
}

function normalizeAdminFormOptions_(options) {
  if (!Array.isArray(options)) {
    throw new Error('Field options must be a list.');
  }
  return options.map(function (option) {
    if (option && typeof option === 'object') {
      return cloneObject_(option);
    }
    return trim_(option);
  }).filter(function (option) {
    return typeof option === 'object' || trim_(option);
  });
}

function normalizeAdminFormFieldList_(value) {
  const rawValues = Array.isArray(value)
    ? value
    : String(value || '').split(/[\s,;]+/);
  const fields = rawValues
    .map(function (field) {
      return normalizeWorkflowFieldName_(field, 'Adjustment field', false);
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
    const followUpStageKey = normalizeWorkflowStageKey_(followUpStage);
    const configuredStage = getFormStages_(process).find(function (stage) {
      return trim_(stage && stage.key) === followUpStageKey;
    });
    if (!configuredStage || followUpStageKey === 'request') {
      throw new Error(`${label} follow-up stage "${followUpStageKey}" is not configured on this process form.`);
    }
    if (!adminWorkflowFormStageCanBeFollowUp_(configuredStage)) {
      throw new Error(`${label} follow-up stage "${followUpStageKey}" is not a workflow-triggerable form stage.`);
    }
    normalized.followUpStage = followUpStageKey;
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

function saveAdminFormSettings_(settings) {
  if (typeof nativeSaveAdminFormSettings_ === 'function') {
    nativeSaveAdminFormSettings_(settings);
    return;
  }
  FORM_DEFINITIONS[settings.definitionKey] = cloneObject_(settings.definition || {});
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
