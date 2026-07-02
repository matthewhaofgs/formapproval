/**
 * Reusable workflow engine for approval, acknowledgement, notification, and change-request flows.
 */

function recordApprovalDecision_(request, decision, comment, actorEmail) {
  const stage = request.activeApprovalStage;
  const actor = actorEmail || request.activeApprovalStepEmail || getCurrentUserEmail_();
  assertRequestAwaitingApprovalFor_(request, actor);
  const step = getActiveWorkflowStep_(request);
  validateWorkflowDecision_(step, decision, comment);
  const stepName = step.name || request.activeApprovalStepName || 'Workflow owner';
  const stepIndex = typeof step.index === 'number' ? step.index : Number(request.activeApprovalStepIndex || 0);
  const historyField = stage === 'final' ? 'finalApprovalHistory' : 'approvalHistory';
  const historyDecision = workflowHistoryDecision_(decision, step);
  appendHistory_(request, historyField, {
    at: nowIso_(),
    stepName,
    stepIndex,
    stepOriginalIndex: step.originalIndex,
    stepType: step.type,
    approverEmail: actor,
    decision: historyDecision,
    comment
  });

  if (decision === 'changes') {
    return requestChanges_(request, stage, actor, stepName, comment);
  }

  if (decision === 'deny') {
    return denyRequest_(request, stage, actor, stepName, comment);
  }

  logEvent_(request.requestId, actor, workflowStepCompletedEvent_(stage, step), {
    stepName,
    stepType: step.type,
    decision
  });
  maybeStartFollowUpStageAfterStep_(request, step, actor);

  return advanceWorkflow_(request, stage, stepIndex, decision === 'acknowledge' ? 'Acknowledged.' : 'Approved.', actor);
}

function requestChanges_(request, stage, actor, stepName, comment) {
  if (!comment) {
    throw new Error('A comment is required when requesting changes.');
  }
  if (stage !== 'approval' && stage !== 'final') {
    throw new Error('Changes can only be requested during approval or final approval.');
  }

  const token = createToken_();
  const now = nowIso_();
  const changeStage = stage === 'final' ? 'actual' : 'approval';
  appendHistory_(request, 'changeHistory', {
    at: now,
    type: 'change_request',
    stage: changeStage,
    requestedByRole: 'approver',
    requestedByEmail: actor,
    requestedByName: stepName,
    comment
  });

  Object.assign(request, {
    status: stage === 'final' ? STATUS.NEEDS_ACTUAL_HOURS_CHANGES : STATUS.NEEDS_APPROVAL_CHANGES,
    updatedAt: now,
    employeeActionTokenHash: hashToken_(token),
    activeApprovalTokenHash: '',
    activeApprovalStage: '',
    activeApprovalStepIndex: '',
    activeApprovalStepName: '',
    activeApprovalStepEmail: '',
    changeRequestedAt: now,
    changeRequestedByEmail: actor,
    changeRequestedByName: stepName,
    changeStage,
    changeComment: comment
  });

  updateRequest_(request);
  logEvent_(request.requestId, actor, stage === 'final' ? 'ACTUAL_HOURS_CHANGES_REQUESTED' : 'APPROVAL_CHANGES_REQUESTED', {
    stepName,
    comment
  });
  sendChangeRequestEmail_(request, token);

  return {
    ok: true,
    requestId: request.requestId,
    message: `Changes have been requested from ${request.employeeName}.`
  };
}

function restartApproval_(request, messagePrefix) {
  return startWorkflow_(request, 'approval', messagePrefix);
}

function restartFinalApproval_(request, messagePrefix) {
  return startWorkflow_(request, 'final', messagePrefix);
}

function startWorkflow_(request, stage, messagePrefix) {
  const steps = refreshWorkflowStepsSnapshot_(request, stage);
  if (stage === 'approval' && !workflowHasBlockingStep_(steps)) {
    throw new Error('No blocking workflow step could be resolved. Check the Config sheet approval workflow for this process.');
  }
  return advanceWorkflow_(request, stage, -1, messagePrefix, 'system', steps);
}

function advanceWorkflow_(request, stage, currentIndex, messagePrefix, actorEmail, resolvedSteps) {
  const steps = resolvedSteps || workflowStepsForStage_(request, stage);
  let sentNotifications = 0;

  for (let index = currentIndex + 1; index < steps.length; index += 1) {
    const step = steps[index];
    if (step.type === 'notification') {
      const notification = sendWorkflowNotificationEmail_(request, step, stage);
      if (!notification) {
        continue;
      }
      recordWorkflowNotificationHistory_(request, stage, step, notification.recipients, notification.ccRecipients);
      logEvent_(request.requestId, actorEmail || 'system', stage === 'final' ? 'FINAL_NOTIFICATION_SENT' : 'APPROVAL_NOTIFICATION_SENT', {
        stepName: step.name,
        recipients: notification.recipients,
        ccRecipients: notification.ccRecipients
      });
      sentNotifications += 1;
      continue;
    }

    const token = createToken_();
    Object.assign(request, {
      updatedAt: nowIso_(),
      activeApprovalTokenHash: hashToken_(token),
      activeApprovalStage: stage,
      activeApprovalStepIndex: step.index,
      activeApprovalStepName: step.name,
      activeApprovalStepEmail: step.email
    });
    updateRequest_(request);
    sendWorkflowActionEmail_(request, step, token, false);

    return {
      ok: true,
      requestId: request.requestId,
      message: `${messagePrefix} Waiting on ${step.name} to ${workflowStepActionVerb_(step)}.`
    };
  }

  return completeWorkflowStage_(request, stage, actorEmail || 'system', sentNotifications);
}

function completeWorkflowStage_(request, stage, actorEmail, sentNotifications) {
  Object.assign(request, {
    updatedAt: nowIso_(),
    activeApprovalTokenHash: '',
    activeApprovalStage: '',
    activeApprovalStepIndex: '',
    activeApprovalStepName: '',
    activeApprovalStepEmail: ''
  });

  if (stage === 'final') {
    request.status = STATUS.FINAL_APPROVED;
    request.finalApprovedAt = nowIso_();
    updateRequest_(request);
    logEvent_(request.requestId, actorEmail, sentNotifications ? 'FINAL_APPROVED_AFTER_NOTIFICATIONS' : 'FINAL_APPROVED', {
      sentNotifications
    });
    sendPaymentNotificationEmail_(request);
    sendEmployeeFinalApprovedEmail_(request);
    return {
      ok: true,
      requestId: request.requestId,
      message: `Request ${request.requestId} has been final approved.`
    };
  }

  if (stage === 'approval' && getProcessCompletionMode_(request) === 'single_stage') {
    if (requestNeedsVtrChecklist_(request)) {
      return startVtrChecklistFollowUp_(request, actorEmail, sentNotifications);
    }

    request.status = STATUS.APPROVED;
    request.approvalCompletedAt = nowIso_();
    request.finalApprovedAt = nowIso_();
    updateRequest_(request);
    logEvent_(request.requestId, actorEmail, sentNotifications ? 'REQUEST_APPROVED_AFTER_NOTIFICATIONS' : 'REQUEST_APPROVED', {
      sentNotifications
    });
    sendEmployeeProcessApprovedEmail_(request);
    return {
      ok: true,
      requestId: request.requestId,
      message: `Request ${request.requestId} has been approved.`
    };
  }

  request.status = STATUS.PREAPPROVED;
  request.approvalCompletedAt = nowIso_();
  updateRequest_(request);
  logEvent_(request.requestId, actorEmail, sentNotifications ? 'PREAPPROVED_AFTER_NOTIFICATIONS' : 'PREAPPROVED', {
    sentNotifications
  });
  sendEmployeePreapprovedEmail_(request);

  if (request.followUpDueDate && request.followUpDueDate <= todayKey_()) {
    sendDueActualHoursRequestsInternal_();
  }

  return {
    ok: true,
    requestId: request.requestId,
    message: `Request ${request.requestId} has been pre-approved.`
  };
}

function startVtrChecklistFollowUp_(request, actorEmail, sentNotifications) {
  const now = nowIso_();
  const emailStarted = ensureVtrChecklistEmailStarted_(request, actorEmail || 'system');
  Object.assign(request, {
    status: STATUS.AWAITING_VTR_CHECKLIST,
    approvalCompletedAt: now,
    finalApprovedAt: now,
    updatedAt: now
  });
  if (vtrChecklistShouldClose_(request)) {
    return closeVtrChecklist_(request, actorEmail || 'system', sentNotifications || 0);
  }
  updateRequest_(request);
  if (!emailStarted) {
    logEvent_(request.requestId, actorEmail || 'system', sentNotifications ? 'VTR_CHECKLIST_AWAITING_AFTER_NOTIFICATIONS' : 'VTR_CHECKLIST_AWAITING', {
      sentNotifications: sentNotifications || 0
    });
  }
  return {
    ok: true,
    requestId: request.requestId,
    message: `Request ${request.requestId} has completed approval. Checklist sent to ${request.employeeName}.`
  };
}

function maybeStartFollowUpStageAfterStep_(request, step, actorEmail) {
  const followUpStage = trim_(step && step.followUpStage);
  if (followUpStage === 'checklist') {
    ensureVtrChecklistEmailStarted_(request, actorEmail || 'system');
  }
}

function ensureVtrChecklistEmailStarted_(request, actorEmail) {
  if (!requestNeedsVtrChecklist_(request) || request.followUpSentAt) {
    return false;
  }
  const token = createToken_();
  request.employeeActionTokenHash = hashToken_(token);
  request.followUpSentAt = nowIso_();
  request.updatedAt = nowIso_();
  updateRequest_(request);
  const emailInfo = sendVtrChecklistRequestEmail_(request, token, false);
  logEvent_(request.requestId, actorEmail || 'system', 'VTR_CHECKLIST_REQUESTED', {
    webAppUrl: emailInfo.webAppUrl
  });
  return true;
}

function denyRequest_(request, stage, actor, stepName, comment) {
  const isFinal = stage === 'final';
  Object.assign(request, {
    status: isFinal ? STATUS.FINAL_DENIED : STATUS.APPROVAL_DENIED,
    updatedAt: nowIso_(),
    activeApprovalTokenHash: '',
    activeApprovalStage: '',
    activeApprovalStepIndex: '',
    activeApprovalStepName: '',
    activeApprovalStepEmail: '',
    denialReason: comment
  });
  updateRequest_(request);
  logEvent_(request.requestId, actor, isFinal ? 'FINAL_DENIED' : 'APPROVAL_DENIED', {
    stepName,
    comment
  });
  sendDeniedEmail_(request, stage, stepName, comment, actor);

  return {
    ok: true,
    requestId: request.requestId,
    message: `Request ${request.requestId} has been denied.`
  };
}

function resolveWorkflowSteps_(configuredSteps, request) {
  const resolved = [];
  (configuredSteps || []).forEach(function (step, originalIndex) {
    if (!workflowStepMatchesConditions_(step, request)) {
      return;
    }
    resolved.push(normalizeWorkflowStep_(step, request, resolved.length, originalIndex));
  });
  return resolved;
}

function normalizeWorkflowStep_(step, request, index, originalIndex) {
  const type = normalizeWorkflowStepType_(step.type);
  const emails = resolveWorkflowStepEmails_(step, request);
  const ccEmails = resolveWorkflowStepCcEmails_(step, request);
  const name = trim_(step.name) || defaultWorkflowStepName_(type);

  if (!emails.length) {
    throw new Error(`Workflow step "${name}" does not resolve to an email address.`);
  }

  emails.forEach(function (email) {
    validateEmail_(email, `${name} email`);
  });
  ccEmails.forEach(function (email) {
    validateEmail_(email, `${name} CC email`);
  });

  if (isBlockingWorkflowStepType_(type) && emails.length !== 1) {
    throw new Error(`Workflow step "${name}" is blocking and must resolve to exactly one email address.`);
  }

  return {
    index,
    originalIndex,
    type,
    name,
    email: emails[0],
    emails,
    ccEmails,
    subject: trim_(step.subject),
    message: trim_(step.message),
    waitingLabel: isBlockingWorkflowStepType_(type) ? (trim_(step.waitingLabel) || defaultWorkflowWaitingLabel_()) : '',
    followUpStage: trim_(step.followUpStage),
    requireComment: isBlockingWorkflowStepType_(type) && step && step.requireComment === true
  };
}

function workflowStepsSnapshotField_(stage) {
  if (stage === 'final') {
    return 'finalWorkflowSteps';
  }
  if (stage === 'checklist') {
    return 'checklistWorkflowSteps';
  }
  return 'approvalWorkflowSteps';
}

function workflowStepSnapshot_(stage, step) {
  return {
    index: step.index,
    originalIndex: step.originalIndex,
    stage,
    type: step.type,
    name: step.name,
    email: step.email,
    emails: [].concat(step.emails || []).map(normalizeEmail_).filter(Boolean),
    ccEmails: [].concat(step.ccEmails || []).map(normalizeEmail_).filter(Boolean),
    subject: trim_(step.subject),
    message: trim_(step.message),
    waitingLabel: trim_(step.waitingLabel),
    followUpStage: trim_(step.followUpStage),
    requireComment: Boolean(step.requireComment)
  };
}

function workflowStepKey_(step) {
  return [
    trim_(step && step.stage),
    String(step && step.originalIndex !== undefined ? step.originalIndex : ''),
    String(step && step.index !== undefined ? step.index : ''),
    trim_(step && step.type).toLowerCase(),
    trim_(step && step.name).toLowerCase(),
    normalizeEmail_(step && step.email)
  ].join('|');
}

function normalizeStoredWorkflowStep_(stage, step, fallbackIndex) {
  const index = Number(step && step.index);
  const originalIndex = Number(step && step.originalIndex);
  const type = normalizeWorkflowStepType_(step && step.type);
  const emails = [].concat((step && step.emails) || [])
    .concat(step && step.email ? [step.email] : [])
    .map(normalizeEmail_)
    .filter(Boolean);
  const ccEmails = [].concat((step && step.ccEmails) || [])
    .map(normalizeEmail_)
    .filter(Boolean);
  const seen = {};
  const uniqueEmails = emails.filter(function (email) {
    if (seen[email]) {
      return false;
    }
    seen[email] = true;
    return true;
  });

  return {
    index: isNaN(index) ? fallbackIndex : index,
    originalIndex: isNaN(originalIndex) ? (isNaN(index) ? fallbackIndex : index) : originalIndex,
    stage: trim_(step && step.stage) || stage,
    type,
    name: trim_(step && step.name) || defaultWorkflowStepName_(type),
    email: uniqueEmails[0] || '',
    emails: uniqueEmails,
    ccEmails: uniqueEmailList_(ccEmails),
    subject: trim_(step && step.subject),
    message: trim_(step && step.message),
    waitingLabel: isBlockingWorkflowStepType_(type) ? (trim_(step && step.waitingLabel) || defaultWorkflowWaitingLabel_()) : '',
    followUpStage: trim_(step && step.followUpStage),
    requireComment: isBlockingWorkflowStepType_(type) && Boolean(step && step.requireComment)
  };
}

function storedWorkflowStepsForStage_(request, stage) {
  const field = workflowStepsSnapshotField_(stage);
  return parseJsonArray_(request && request[field])
    .map(function (step, index) {
      return normalizeStoredWorkflowStep_(stage, step, index);
    })
    .filter(function (step) {
      return step.name || step.email || step.emails.length;
    });
}

function setWorkflowStepsSnapshot_(request, stage, steps) {
  const field = workflowStepsSnapshotField_(stage);
  request[field] = JSON.stringify((steps || []).map(function (step) {
    return workflowStepSnapshot_(stage, step);
  }));
}

function refreshWorkflowStepsSnapshot_(request, stage) {
  const steps = resolveWorkflowSteps_(workflowConfigForStage_(stage, request), request);
  setWorkflowStepsSnapshot_(request, stage, steps);
  return steps;
}

function workflowStepsForStage_(request, stage) {
  const stored = storedWorkflowStepsForStage_(request, stage);
  if (stored.length) {
    return stored;
  }
  return resolveWorkflowSteps_(workflowConfigForStage_(stage, request), request);
}

function workflowStepMatchesConditions_(step, request) {
  return workflowConditionsMatch_(step.when, request) &&
    !workflowConditionsMatch_(step.unless, request, false);
}

function formStageMatchesConditions_(request, formStage) {
  const stage = getFormStageMetadata_(request, formStage);
  return workflowConditionsMatch_(stage.when, request, true) &&
    !workflowConditionsMatch_(stage.unless, request, false);
}

function workflowConditionsMatch_(conditions, request, defaultValue) {
  if (conditions === undefined || conditions === null || conditions === '') {
    return defaultValue === undefined ? true : defaultValue;
  }

  if (Array.isArray(conditions)) {
    return conditions.every(function (condition) {
      return workflowConditionsMatch_(condition, request);
    });
  }

  if (Array.isArray(conditions.any)) {
    return conditions.any.some(function (condition) {
      return workflowConditionsMatch_(condition, request);
    });
  }

  if (Array.isArray(conditions.all)) {
    return conditions.all.every(function (condition) {
      return workflowConditionsMatch_(condition, request);
    });
  }

  if (conditions.field) {
    return workflowConditionMatches_(conditions, request);
  }

  return Object.keys(conditions).every(function (field) {
    return workflowConditionMatches_({
      field,
      equals: conditions[field]
    }, request);
  });
}

function workflowConditionMatches_(condition, request) {
  const field = trim_(condition.field);
  const actual = workflowConditionValue_(request[field]);

  if (condition.exists !== undefined) {
    return Boolean(actual) === Boolean(condition.exists);
  }
  if (condition.equals !== undefined) {
    return workflowConditionEquals_(actual, condition.equals);
  }
  if (condition.is !== undefined) {
    return workflowConditionEquals_(actual, condition.is);
  }
  if (condition.value !== undefined) {
    return workflowConditionEquals_(actual, condition.value);
  }
  if (condition.notEquals !== undefined) {
    return !workflowConditionEquals_(actual, condition.notEquals);
  }
  if (condition.in !== undefined) {
    return [].concat(condition.in).some(function (value) {
      return workflowConditionEquals_(actual, value);
    });
  }
  if (condition.notIn !== undefined) {
    return ![].concat(condition.notIn).some(function (value) {
      return workflowConditionEquals_(actual, value);
    });
  }

  return Boolean(actual);
}

function workflowConditionEquals_(actual, expected) {
  return workflowConditionValue_(actual) === workflowConditionValue_(expected);
}

function workflowConditionValue_(value) {
  return trim_(value).toLowerCase();
}

function resolveWorkflowStepEmails_(step, request) {
  const emails = [];

  if (step.email) {
    emails.push(step.email);
  }
  if (step.emailField && request[step.emailField]) {
    emails.push(request[step.emailField]);
  }
  [].concat(step.emails || []).forEach(function (email) {
    emails.push(email);
  });
  [].concat(step.emailFields || []).forEach(function (field) {
    if (request[field]) {
      emails.push(request[field]);
    }
  });

  const seen = {};
  return emails
    .map(normalizeEmail_)
    .filter(function (email) {
      if (!email || seen[email]) {
        return false;
      }
      seen[email] = true;
      return true;
    });
}

function resolveWorkflowStepCcEmails_(step, request) {
  const emails = [];

  if (step && step.ccEmail) {
    emails.push(step.ccEmail);
  }
  if (step && step.ccEmailField && request[step.ccEmailField]) {
    emails.push(request[step.ccEmailField]);
  }
  [].concat((step && step.ccEmails) || []).forEach(function (email) {
    emails.push(email);
  });
  [].concat((step && step.ccEmailFields) || []).forEach(function (field) {
    if (request[field]) {
      emails.push(request[field]);
    }
  });

  return uniqueEmailList_(emails);
}

function normalizeWorkflowStepType_(type) {
  const normalized = trim_(type || 'approval').toLowerCase();
  if (['approval', 'acknowledgement', 'action', 'notification'].indexOf(normalized) === -1) {
    throw new Error(`Unsupported workflow step type "${type}". Use approval, acknowledgement, action, or notification.`);
  }
  return normalized;
}

function isBlockingWorkflowStepType_(type) {
  return type === 'approval' || type === 'acknowledgement' || type === 'action';
}

function workflowHasBlockingStep_(steps) {
  return steps.some(function (step) {
    return isBlockingWorkflowStepType_(step.type);
  });
}

function defaultWorkflowStepName_(type) {
  if (type === 'acknowledgement') {
    return 'Acknowledgement';
  }
  if (type === 'notification') {
    return 'Notification';
  }
  if (type === 'action') {
    return 'Action';
  }
  return 'Approval';
}

function defaultWorkflowWaitingLabel_() {
  return '{Step name} <{Step email}> to {Action}';
}

function workflowConfigForStage_(stage, request) {
  return getWorkflowConfigForStage_(stage, request);
}

function getActiveWorkflowStep_(request) {
  if (!request.activeApprovalStage || !request.activeApprovalStepEmail) {
    return null;
  }

  const configuredSteps = workflowStepsForStage_(request, request.activeApprovalStage);
  const activeIndex = Number(request.activeApprovalStepIndex);
  const indexedStep = configuredSteps[activeIndex];

  if (indexedStep && isBlockingWorkflowStepType_(indexedStep.type)) {
    return Object.assign({}, indexedStep, {
      name: request.activeApprovalStepName || indexedStep.name,
      email: request.activeApprovalStepEmail,
      emails: [request.activeApprovalStepEmail]
    });
  }

  const matchedStep = configuredSteps.find(function (step) {
    return isBlockingWorkflowStepType_(step.type) && emailsMatch_(step.email, request.activeApprovalStepEmail);
  });
  if (matchedStep) {
    return Object.assign({}, matchedStep, {
      name: request.activeApprovalStepName || matchedStep.name,
      email: request.activeApprovalStepEmail,
      emails: [request.activeApprovalStepEmail]
    });
  }

  return {
    index: isNaN(activeIndex) ? 0 : activeIndex,
    type: 'approval',
    name: request.activeApprovalStepName || 'Workflow owner',
    email: request.activeApprovalStepEmail,
    emails: [request.activeApprovalStepEmail]
  };
}

function workflowStepStageLabel_(stage, step, request) {
  const isActualHoursProcess = request && getProcessCompletionMode_(request) === 'actual_hours';
  if (step && step.type === 'action') {
    return stage === 'final' ? 'Actual-hours action' : 'Action';
  }
  if (step && step.type === 'acknowledgement') {
    return stage === 'final'
      ? 'Actual-hours acknowledgement'
      : (isActualHoursProcess ? 'Pre-approval acknowledgement' : 'Acknowledgement');
  }
  return stage === 'final' ? 'Final approval' : (isActualHoursProcess ? 'Pre-approval' : 'Approval');
}

function workflowStepPrimaryDecision_(step) {
  return step && (step.type === 'acknowledgement' || step.type === 'action') ? 'acknowledge' : 'approve';
}

function workflowStepPrimaryLabel_(step) {
  if (step && step.type === 'action') {
    return 'Complete action';
  }
  return step && step.type === 'acknowledgement' ? 'Acknowledge' : 'Approve';
}

function workflowStepAllowsDecision_(step, decision) {
  if (!step || !isBlockingWorkflowStepType_(step.type)) {
    return false;
  }
  if (decision === 'changes') {
    return true;
  }
  if (step.type === 'acknowledgement' || step.type === 'action') {
    return decision === 'acknowledge';
  }
  return decision === 'approve' || decision === 'deny';
}

function workflowStepActionVerb_(step) {
  if (step && step.type === 'acknowledgement') {
    return 'acknowledge';
  }
  if (step && step.type === 'action') {
    return 'complete action';
  }
  return 'approve';
}

function isSupportedWorkflowDecision_(decision) {
  return ['approve', 'acknowledge', 'deny', 'changes'].indexOf(decision) !== -1;
}

function validateWorkflowDecision_(step, decision, comment) {
  if (!workflowStepAllowsDecision_(step, decision)) {
    const stepLabel = step && step.type === 'acknowledgement'
      ? 'acknowledgement'
      : (step && step.type === 'action' ? 'action' : 'approval');
    throw new Error(`This ${stepLabel} step does not allow "${decision}".`);
  }
  if ((decision === 'changes' || decision === 'deny') && !comment) {
    throw new Error(decision === 'deny'
      ? 'A reason is required when denying a request.'
      : 'A comment is required when requesting changes.');
  }
  if (workflowStepRequiresComment_(step, decision) && !comment) {
    throw new Error('Notes are required for this workflow step.');
  }
}

function workflowStepRequiresComment_(step, decision) {
  if (!step || step.requireComment !== true) {
    return false;
  }
  return decision === workflowStepPrimaryDecision_(step);
}

function workflowHistoryDecision_(decision, step) {
  if (decision === 'changes') {
    return 'changes requested';
  }
  if (decision === 'acknowledge') {
    return step && step.type === 'action' ? 'completed action' : 'acknowledged';
  }
  if (decision === 'approve') {
    return 'approved';
  }
  return decision;
}

function workflowStepCompletedEvent_(stage, step) {
  if (step && step.type === 'action') {
    return stage === 'final' ? 'FINAL_ACTION_COMPLETED_STEP' : 'APPROVAL_ACTION_COMPLETED_STEP';
  }
  if (step && step.type === 'acknowledgement') {
    return stage === 'final' ? 'FINAL_ACKNOWLEDGED_STEP' : 'APPROVAL_ACKNOWLEDGED_STEP';
  }
  return stage === 'final' ? 'FINAL_APPROVED_STEP' : 'APPROVAL_APPROVED_STEP';
}

function appendHistory_(request, field, entry) {
  const history = parseJsonArray_(request[field]);
  history.push(entry);
  request[field] = JSON.stringify(history);
}

function recordWorkflowNotificationHistory_(request, stage, step, recipients, ccRecipients) {
  const historyField = stage === 'final' ? 'finalApprovalHistory' : 'approvalHistory';
  appendHistory_(request, historyField, {
    at: nowIso_(),
    stepName: step.name,
    stepIndex: step.index,
    stepOriginalIndex: step.originalIndex,
    stepType: 'notification',
    approverEmail: '',
    recipients: [].concat(recipients || []).map(normalizeEmail_).filter(Boolean),
    ccRecipients: [].concat(ccRecipients || []).map(normalizeEmail_).filter(Boolean),
    decision: 'notification sent'
  });
}

function snapshotFields_(record, fieldSpecs) {
  const snapshot = {};
  fieldSpecs.forEach(function (spec) {
    snapshot[spec.field] = record[spec.field];
  });
  return snapshot;
}

function adjustmentFieldChanges_(before, after, fieldSpecs) {
  return fieldSpecs
    .map(function (spec) {
      const from = adjustmentValue_(before[spec.field]);
      const to = adjustmentValue_(after[spec.field]);
      if (from === to) {
        return null;
      }
      return {
        field: spec.field,
        label: spec.label,
        from,
        to
      };
    })
    .filter(Boolean);
}

function buildAdjustmentHistoryEntry_(request, stage, actorEmail, actorName, adjustmentComment, fields) {
  const approverRequested = (stage === 'actual' && request.status === STATUS.NEEDS_ACTUAL_HOURS_CHANGES) ||
    (stage === 'approval' && request.status === STATUS.NEEDS_APPROVAL_CHANGES);
  const requestedByRole = approverRequested ? 'approver' : 'requester';
  return {
    at: nowIso_(),
    type: 'adjustment',
    stage,
    requestedByRole,
    requestedByEmail: approverRequested ? request.changeRequestedByEmail : actorEmail,
    requestedByName: approverRequested ? request.changeRequestedByName : actorName,
    requestComment: approverRequested ? request.changeComment : '',
    editedByEmail: actorEmail,
    editedByName: actorName,
    comment: adjustmentComment || '',
    fields: fields || []
  };
}

function adjustmentValue_(value) {
  if (value === null || value === undefined) {
    return '';
  }
  return String(value).trim();
}

function isPendingStatus_(status) {
  return [
    STATUS.PENDING_APPROVAL,
    STATUS.NEEDS_APPROVAL_CHANGES,
    STATUS.PREAPPROVED,
    STATUS.AWAITING_ACTUAL_HOURS,
    STATUS.AWAITING_VTR_CHECKLIST,
    STATUS.NEEDS_ACTUAL_HOURS_CHANGES,
    STATUS.PENDING_FINAL_APPROVAL,
    'PENDING_PREAPPROVAL',
    'NEEDS_PREAPPROVAL_CHANGES',
    'PREAPPROVED_AWAITING_ACTUAL_HOURS'
  ].indexOf(status) !== -1;
}

function isStoppedStatus_(status) {
  return status === STATUS.CANCELLED ||
    status === STATUS.APPROVAL_DENIED ||
    status === STATUS.FINAL_DENIED ||
    status === 'PREAPPROVAL_DENIED';
}

function isRequestCancellable_(request) {
  return isPendingStatus_(request.status);
}
