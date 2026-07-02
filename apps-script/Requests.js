/**
 * Request submission, editing, dashboards, validation, and public DTOs.
 */

function getInitialState_(params) {
  params = params || {};
  const requestedProcess = processKeyFromParams_(params);
  const mode = params.mode || params.page || (requestedProcess ? 'request' : 'chooser');
  const token = params.token || '';
  const currentUserEmail = getCurrentUserEmail_();
  const baseState = initialStateBase_(currentUserEmail);

  if (mode === 'dashboard') {
    const dashboardRole = params.role || 'requester';
    const state = Object.assign({}, baseState, {
      mode: 'dashboard',
      role: dashboardRole,
      selectedProcess: requestedProcess,
      adminView: trim_(params.adminView || ''),
      formBuilderKey: trim_(params.formKey || ''),
      formBuilderStage: trim_(params.formStage || ''),
      requireGoogleAuth: APP_SETTINGS.REQUIRE_GOOGLE_AUTH,
      allowEmailFallbackForTesting: APP_SETTINGS.ALLOW_EMAIL_FALLBACK_FOR_TESTING
    });
    return state;
  }

  if (mode === 'chooser') {
    return Object.assign({}, baseState, {
      mode: 'chooser',
      processes: getEnabledRequestFormOptions_()
    });
  }

  if (mode === 'approve') {
    if (!token) {
      return errorState_('Approval link is missing its token.');
    }

    const request = findRequestByToken_(token, 'approval');
    if (!request) {
      return errorState_('This approval link is invalid, expired, or has already been used.');
    }
    const activeStep = getActiveWorkflowStep_(request);
    if (currentUserEmail && !emailsMatch_(request.activeApprovalStepEmail, currentUserEmail)) {
      const stepLabel = activeStep && activeStep.type === 'acknowledgement'
        ? 'acknowledgement'
        : (activeStep && activeStep.type === 'action' ? 'action' : 'approval');
      return errorState_(`This ${stepLabel} is currently assigned to ${request.activeApprovalStepName || 'Workflow owner'} <${request.activeApprovalStepEmail}>. You are signed in as ${currentUserEmail}.`);
    }

    return Object.assign({}, baseState, {
      mode: 'approve',
      token,
      request: publicRequest_(request),
      approval: {
        stage: request.activeApprovalStage,
        stageLabel: workflowStepStageLabel_(request.activeApprovalStage, activeStep, request),
        stepType: activeStep ? activeStep.type : 'approval',
        stepName: request.activeApprovalStepName,
        stepEmail: request.activeApprovalStepEmail,
        primaryDecision: workflowStepPrimaryDecision_(activeStep),
        primaryActionLabel: workflowStepPrimaryLabel_(activeStep),
        requiresComment: workflowStepRequiresComment_(activeStep, workflowStepPrimaryDecision_(activeStep)),
        canDeny: workflowStepAllowsDecision_(activeStep, 'deny')
      }
    });
  }

  if (mode === 'decision') {
    if (!token) {
      return errorState_('Approval decision link is missing its token.');
    }

    const decision = String(params.decision || '').toLowerCase();
    if (decision === 'deny') {
      return getInitialState_(Object.assign({}, params, { mode: 'approve' }));
    }
    if (decision === 'changes') {
      return errorState_('Request changes cannot be completed from an email link because a comment is required.');
    }

    try {
      const result = submitApprovalDecision({
        token,
        decision,
        trustTokenIdentity: true
      });
      const request = result && result.requestId ? getRequestById_(result.requestId) : null;
      return Object.assign({}, baseState, {
        mode: 'closed',
        title: workflowDecisionResultTitle_(decision),
        message: result && result.message ? result.message : 'The workflow decision has been recorded.',
        request: request ? publicRequest_(request) : null,
        closedAction: {
          label: 'Open workflow dashboard',
          mode: 'dashboard',
          role: 'approver'
        }
      });
    } catch (err) {
      return errorState_(err.message);
    }
  }

  if (mode === 'actual') {
    let request = null;
    try {
      request = token
        ? findRequestByToken_(token, 'employee')
        : getRequesterVisibleRequest_(params.requestId);
    } catch (err) {
      return errorState_(err.message);
    }
    if (!request) {
      return errorState_('This actual-hours link is invalid or has expired.');
    }

    if (!canEditActualHoursStatus_(request.status)) {
      return {
        mode: 'closed',
        title: 'Actual hours cannot be edited',
        message: `Request ${request.requestId} is currently ${statusLabel_(request.status)}.`,
        request: publicRequest_(request)
      };
    }

    return Object.assign({}, baseState, {
      mode: 'actual',
      token,
      requestId: request.requestId,
      request: publicRequest_(request),
      formDefinition: publicFormDefinition_(request, 'actual')
    });
  }

  if (mode === 'checklist') {
    let request = null;
    try {
      request = token
        ? findRequestByToken_(token, 'employee')
        : getRequesterVisibleRequest_(params.requestId);
    } catch (err) {
      return errorState_(err.message);
    }
    if (!request) {
      return errorState_('This checklist link is invalid or has expired.');
    }

    if (!request.followUpSentAt) {
      return errorState_('The VTR checklist is not available yet.');
    }

    if (!canEditVtrChecklistStatus_(request.status)) {
      return Object.assign({}, baseState, {
        mode: 'closed',
        title: 'Checklist cannot be edited',
        message: `Request ${request.requestId} is currently ${statusLabel_(request.status)}.`,
        request: publicRequest_(request)
      });
    }

    return Object.assign({}, baseState, {
      mode: 'checklist',
      token,
      requestId: request.requestId,
      request: publicRequest_(request),
      formDefinition: publicFormDefinition_(request, 'checklist')
    });
  }

  if (mode === 'edit') {
    let request = null;
    try {
      request = token
        ? findRequestByToken_(token, 'employee')
        : getRequesterVisibleRequest_(params.requestId);
    } catch (err) {
      return errorState_(err.message);
    }
    if (!request) {
      return errorState_('This edit link is invalid or has expired.');
    }
    if (!canEditApprovalStatus_(request.status)) {
      return Object.assign({}, baseState, {
        mode: 'closed',
        title: 'Request cannot be edited',
        message: `Request ${request.requestId} is currently ${statusLabel_(request.status)}.`,
        request: publicRequest_(request)
      });
    }

    return Object.assign({}, baseState, {
      mode: 'edit',
      editStage: 'approval',
      token,
      requestId: request.requestId,
      request: publicRequest_(request),
      formDefinition: publicFormDefinition_(request)
    });
  }

  const process = getRequestFormProcess_(requestedProcess || getDefaultProcessKey_());
  if (!process) {
    return errorState_('This request form is not available.');
  }

  return Object.assign({}, baseState, {
    mode: 'request',
    processType: process.key,
    processName: process.name,
    processDescription: process.description || '',
    formDefinition: publicFormDefinition_(process.key)
  });
}

function initialStateBase_(currentUserEmail) {
  return {
    appName: APP_SETTINGS.APP_NAME,
    organisationName: APP_SETTINGS.ORGANISATION_NAME,
    webAppUrl: getWebAppUrl_(),
    currentUserEmail,
    roleAvailability: dashboardRoleAvailabilityFor_(currentUserEmail)
  };
}

function workflowDecisionResultTitle_(decision) {
  if (decision === 'approve') {
    return 'Approval recorded';
  }
  if (decision === 'deny') {
    return 'Denial recorded';
  }
  if (decision === 'acknowledge') {
    return 'Acknowledgement recorded';
  }
  return 'Decision recorded';
}

function processKeyFromParams_(params) {
  return trim_((params && (params.process || params.form || params.type || params.processType)) || '').toLowerCase();
}

function submitFeedback(payload) {
  ensureReady_();
  const actorEmail = getAuthenticatedEmail_(payload || {});
  const message = trim_(payload && payload.message);
  if (!message) {
    throw new Error('Feedback message is required.');
  }
  if (message.length > 4000) {
    throw new Error('Feedback message must be 4000 characters or fewer.');
  }

  const pageUrl = trim_(payload && payload.pageUrl).slice(0, 500);
  const result = sendFeedbackEmail_({
    email: actorEmail,
    message,
    pageUrl,
    submittedAt: nowIso_()
  });
  return {
    ok: true,
    message: 'Feedback sent.',
    recipient: result.recipient
  };
}

function submitRequest(form) {
  ensureReady_();
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    const cleaned = validateRequestForm_(form || {});
    const processType = cleaned.processType || getDefaultProcessKey_();
    const requestId = makeRequestId_(processType);
    const now = nowIso_();
    const workflowSteps = resolveWorkflowSteps_(getWorkflowConfigForStage_('approval', cleaned), cleaned);

    if (!workflowHasBlockingStep_(workflowSteps)) {
      throw new Error('No blocking workflow step could be resolved. Check the Config sheet approval workflow for this process.');
    }

    const record = Object.assign(emptyRequestRecord_(processType), cleaned, {
      requestId,
      processType,
      createdAt: now,
      updatedAt: now,
      status: STATUS.PENDING_APPROVAL,
      followUpDueDate: cleaned.overtimeDate ? addDaysKey_(cleaned.overtimeDate, 1) : '',
      approvalHistory: '[]',
      finalApprovalHistory: '[]'
    });

    appendRequest_(record);
    logEvent_(requestId, cleaned.employeeEmail, 'REQUEST_SUBMITTED', {
      plannedDate: cleaned.overtimeDate || requestPrimaryDate_(cleaned),
      plannedHours: cleaned.plannedHours,
      eventName: cleaned.eventName
    });
    const startResult = startWorkflow_(
      record,
      'approval',
      getProcessCompletionMode_(record) === 'single_stage'
        ? 'Request has been sent for approval.'
        : 'Request has been sent for pre-approval.'
    );
    sendEmployeeReceiptEmail_(record);

    return {
      ok: true,
      requestId,
      message: startResult.message
    };
  } finally {
    lock.releaseLock();
  }
}

function submitApprovalDecision(payload) {
  ensureReady_();
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    const token = String((payload && payload.token) || '');
    const decision = String((payload && payload.decision) || '').toLowerCase();
    const comment = trim_((payload && payload.comment) || '');

    if (!token) {
      throw new Error('Missing approval token.');
    }
    if (!isSupportedWorkflowDecision_(decision)) {
      throw new Error('Choose approve, acknowledge, deny, or request changes.');
    }

    const request = findRequestByToken_(token, 'approval');
    if (!request) {
      throw new Error('This approval link is invalid, expired, or has already been used.');
    }

    const actorEmail = payload && payload.trustTokenIdentity
      ? request.activeApprovalStepEmail
      : (getCurrentUserEmail_() || request.activeApprovalStepEmail);
    return recordApprovalDecision_(request, decision, comment, actorEmail);
  } finally {
    lock.releaseLock();
  }
}

function submitDashboardApprovalDecision(payload) {
  ensureReady_();
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    const actorEmail = getAuthenticatedEmail_(payload || {});
    const requestId = requireText_(payload && payload.requestId, 'Request ID');
    const decision = String((payload && payload.decision) || '').toLowerCase();
    const comment = trim_((payload && payload.comment) || '');

    if (!isSupportedWorkflowDecision_(decision)) {
      throw new Error('Choose approve, acknowledge, deny, or request changes.');
    }

    const request = getRequestById_(requestId);
    if (!request) {
      throw new Error(`Request ${requestId} was not found.`);
    }
    if (!emailsMatch_(request.activeApprovalStepEmail, actorEmail)) {
      throw new Error(`Request ${requestId} is not currently assigned to ${actorEmail}.`);
    }

    return recordApprovalDecision_(request, decision, comment, actorEmail);
  } finally {
    lock.releaseLock();
  }
}

function requesterCancelRequest(payload) {
  ensureReady_();
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    const actorEmail = getAuthenticatedEmail_(payload || {});
    const requestId = requireText_(payload && payload.requestId, 'Request ID');
    const request = getRequestById_(requestId);

    if (!request) {
      throw new Error(`Request ${requestId} was not found.`);
    }
    if (!requesterCanAccess_(request, actorEmail)) {
      throw new Error(`Request ${requestId} is not linked to ${actorEmail}.`);
    }
    if (!isRequestCancellable_(request)) {
      throw new Error(`Request ${requestId} cannot be cancelled while it is ${statusLabel_(request.status)}.`);
    }

    return cancelRequest_(request, actorEmail, 'REQUEST_CANCELLED');
  } finally {
    lock.releaseLock();
  }
}

function cancelRequest_(request, actorEmail, eventName) {
  const previous = {
    status: request.status,
    activeApprovalStage: request.activeApprovalStage,
    activeApprovalStepName: request.activeApprovalStepName,
    activeApprovalStepEmail: request.activeApprovalStepEmail,
    changeStage: request.changeStage,
    changeRequestedByEmail: request.changeRequestedByEmail
  };

  Object.assign(request, {
    status: STATUS.CANCELLED,
    updatedAt: nowIso_(),
    employeeActionTokenHash: '',
    activeApprovalTokenHash: '',
    activeApprovalStage: '',
    activeApprovalStepIndex: '',
    activeApprovalStepName: '',
    activeApprovalStepEmail: '',
    changeRequestedAt: '',
    changeRequestedByEmail: '',
    changeRequestedByName: '',
    changeStage: '',
    changeComment: '',
    denialReason: `Cancelled by ${actorEmail}`
  });
  updateRequest_(request);
  logEvent_(request.requestId, actorEmail, eventName || 'REQUEST_CANCELLED', previous);

  return {
    ok: true,
    requestId: request.requestId,
    message: `Request ${request.requestId} has been cancelled.`
  };
}

function submitActualHours(payload) {
  ensureReady_();
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    const token = String((payload && payload.token) || '');
    const requestId = trim_(payload && payload.requestId);
    const request = token
      ? findRequestByToken_(token, 'employee')
      : getRequesterVisibleRequest_(requestId, payload || {});
    if (!request) {
      throw new Error('This actual-hours link is invalid or has expired.');
    }
    if (!canEditActualHoursStatus_(request.status)) {
      throw new Error(`Request ${request.requestId} is not awaiting actual hours.`);
    }

    const actual = validateActualHoursForm_(payload || {}, request);
    const actualFields = getFormAdjustmentFields_('actual', request);
    const previousActual = snapshotFields_(request, actualFields);
    const wasAdjustment = Boolean(request.actualSubmittedAt) ||
      request.status === STATUS.NEEDS_ACTUAL_HOURS_CHANGES ||
      request.status === STATUS.PENDING_FINAL_APPROVAL;
    const actorEmail = token ? request.employeeEmail : getAuthenticatedEmail_(payload || {});
    const actorName = request.employeeName || actorEmail;
    const adjustmentEntry = wasAdjustment
      ? buildAdjustmentHistoryEntry_(
        request,
        'actual',
        actorEmail,
        actorName,
        trim_((payload && payload.adjustmentComment) || ''),
        adjustmentFieldChanges_(previousActual, actual, actualFields)
      )
      : null;
    Object.assign(request, actual, {
      status: STATUS.PENDING_FINAL_APPROVAL,
      updatedAt: nowIso_(),
      actualSubmittedAt: nowIso_(),
      finalWorkflowSteps: '[]',
      employeeActionTokenHash: '',
      activeApprovalTokenHash: '',
      activeApprovalStage: '',
      activeApprovalStepIndex: '',
      activeApprovalStepName: '',
      activeApprovalStepEmail: '',
      changeRequestedAt: '',
      changeRequestedByEmail: '',
      changeRequestedByName: '',
      changeStage: '',
      changeComment: '',
      lastEditedAt: nowIso_(),
      lastEditedByEmail: actorEmail
    });
    if (adjustmentEntry) {
      appendHistory_(request, 'changeHistory', adjustmentEntry);
    }

    logEvent_(request.requestId, actorEmail, 'ACTUAL_HOURS_SUBMITTED', {
      actualHours: actual.actualHours,
      workedAsApproved: actual.workedAsApproved,
      adjustment: Boolean(adjustmentEntry),
      fieldChanges: adjustmentEntry ? adjustmentEntry.fields : []
    });

    return restartFinalApproval_(request, 'Actual hours have been sent for final approval.');
  } finally {
    lock.releaseLock();
  }
}

function submitVtrChecklist(payload) {
  ensureReady_();
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    const token = String((payload && payload.token) || '');
    const requestId = trim_(payload && payload.requestId);
    const request = token
      ? findRequestByToken_(token, 'employee')
      : getRequesterVisibleRequest_(requestId, payload || {});
    if (!request) {
      throw new Error('This checklist link is invalid or has expired.');
    }
    if (!canEditVtrChecklistStatus_(request.status)) {
      throw new Error(`Request ${request.requestId} is not awaiting a VTR checklist.`);
    }
    if (!request.followUpSentAt) {
      throw new Error(`Request ${request.requestId} is not ready for the VTR checklist.`);
    }
    if (!requestNeedsVtrChecklist_(request)) {
      throw new Error(`Request ${request.requestId} does not require a separate checklist.`);
    }

    const checklistAction = normalizeVtrChecklistAction_(payload && payload.checklistAction);
    const checklist = validateVtrChecklistForm_(payload || {}, request);
    const checklistFields = getFormAdjustmentFields_('checklist', request);
    const previousChecklist = snapshotFields_(request, checklistFields);
    const actorEmail = token ? request.employeeEmail : getAuthenticatedEmail_(payload || {});
    const now = nowIso_();

    Object.assign(request, checklist, {
      updatedAt: now,
      checklistSubmittedAt: now,
      lastEditedAt: now,
      lastEditedByEmail: actorEmail
    });
    if (checklistAction === 'complete') {
      request.checklistCompletedAt = now;
    }

    const fieldChanges = adjustmentFieldChanges_(previousChecklist, checklist, checklistFields);
    const notificationsSent = checklistAction === 'complete'
      ? sendChecklistWorkflowNotifications_(request, actorEmail)
      : 0;
    logEvent_(request.requestId, actorEmail, checklistAction === 'complete' ? 'VTR_CHECKLIST_COMPLETED' : 'VTR_CHECKLIST_SAVED', {
      fieldChanges,
      notificationsSent
    });

    if (request.activeApprovalStage && request.activeApprovalStepEmail) {
      updateRequest_(request);
      return {
        ok: true,
        requestId: request.requestId,
        request: publicRequest_(request),
        message: checklistAction === 'complete'
          ? `Checklist submitted for request ${request.requestId}. It remains open while the approval workflow finishes.`
          : `Checklist saved for request ${request.requestId}. It remains editable while the approval workflow finishes.`
      };
    }

    if (vtrChecklistShouldClose_(request)) {
      return closeVtrChecklist_(request, actorEmail, notificationsSent);
    }

    updateRequest_(request);
    return {
      ok: true,
      requestId: request.requestId,
      request: publicRequest_(request),
      message: checklistAction === 'complete'
        ? `Checklist submitted for request ${request.requestId}. No further action is required. It remains editable through ${vtrChecklistEditableUntilForEmail_(request)}.`
        : `Checklist saved for request ${request.requestId}. It remains editable through ${vtrChecklistEditableUntilForEmail_(request)}.`
    };
  } finally {
    lock.releaseLock();
  }
}

function submitEditedRequest(payload) {
  ensureReady_();
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    const token = String((payload && payload.token) || '');
    const requestId = trim_(payload && payload.requestId);
    const request = token
      ? findRequestByToken_(token, 'employee')
      : getRequesterVisibleRequest_(requestId, payload || {});
    if (!request) {
      throw new Error('This edit link is invalid or has expired.');
    }
    if (!canEditApprovalStatus_(request.status)) {
      throw new Error(`Request ${request.requestId} cannot be edited while it is ${statusLabel_(request.status)}.`);
    }

    const cleaned = validateRequestForm_(payload || {});
    cleaned.processType = request.processType || cleaned.processType || getDefaultProcessKey_();
    const workflowSteps = resolveWorkflowSteps_(getWorkflowConfigForStage_('approval', cleaned), cleaned);
    if (!workflowHasBlockingStep_(workflowSteps)) {
      throw new Error('No blocking workflow step could be resolved. Check the Config sheet approval workflow for this process.');
    }

    const approvalFields = getFormAdjustmentFields_('approval', request);
    const previousApproval = snapshotFields_(request, approvalFields);
    const actorEmail = token ? request.employeeEmail : getAuthenticatedEmail_(payload || {});
    const actorName = request.employeeName || cleaned.employeeName || actorEmail;
    const adjustmentEntry = buildAdjustmentHistoryEntry_(
      request,
      'approval',
      actorEmail,
      actorName,
      trim_((payload && payload.adjustmentComment) || ''),
      adjustmentFieldChanges_(previousApproval, cleaned, approvalFields)
    );

    Object.assign(request, cleaned, {
      status: STATUS.PENDING_APPROVAL,
      processType: cleaned.processType,
      updatedAt: nowIso_(),
      followUpDueDate: cleaned.overtimeDate ? addDaysKey_(cleaned.overtimeDate, 1) : '',
      followUpSentAt: '',
      approvalWorkflowSteps: '[]',
      finalWorkflowSteps: '[]',
      checklistWorkflowSteps: '[]',
      checklistNotificationHistory: '[]',
      employeeActionTokenHash: '',
      approvalCompletedAt: '',
      actualSubmittedAt: '',
      overtimeCompleteAcknowledged: '',
      mealBreaksAcknowledged: '',
      mealAllowance: '',
      workedAsApproved: '',
      actualStartTime: '',
      actualFinishTime: '',
      actualHours: '',
      variationReason: '',
      finalApprovedAt: '',
      denialReason: '',
      changeRequestedAt: '',
      changeRequestedByEmail: '',
      changeRequestedByName: '',
      changeStage: '',
      changeComment: '',
      lastEditedAt: nowIso_(),
      lastEditedByEmail: actorEmail
    });
    appendHistory_(request, 'changeHistory', adjustmentEntry);

    logEvent_(request.requestId, actorEmail, 'APPROVAL_REQUEST_EDITED', {
      plannedDate: cleaned.overtimeDate || requestPrimaryDate_(cleaned),
      plannedHours: cleaned.plannedHours,
      eventName: cleaned.eventName,
      requestedByRole: adjustmentEntry.requestedByRole,
      requestedByEmail: adjustmentEntry.requestedByEmail,
      editedByEmail: adjustmentEntry.editedByEmail,
      fieldChanges: adjustmentEntry.fields
    });

    return restartApproval_(
      request,
      getProcessCompletionMode_(request) === 'single_stage'
        ? 'Edited request has been sent for approval.'
        : 'Edited request has been sent for pre-approval.'
    );
  } finally {
    lock.releaseLock();
  }
}

function getDashboardData(payload) {
  const timing = startDashboardTiming_();
  ensureReady_();
  markDashboardTiming_(timing, 'setup and sheet repair');
  const role = requireChoice_((payload && payload.role) || 'requester', ['requester', 'approver', 'admin'], 'Dashboard role');
  const actorEmail = role === 'admin'
    ? requireAdminEmail_(payload || {})
    : getAuthenticatedEmail_(payload || {});
  const selectedProcess = role === 'admin' ? processKeyFromParams_(payload || {}) : '';
  const preloadAdminDashboards = role === 'admin' && !selectedProcess && Boolean(payload && payload.preloadAdminDashboards);
  markDashboardTiming_(timing, 'authentication and config');
  let preloadedAdmin = null;
  let adminProcesses = [];
  const canManageUsers = role === 'admin' && isGlobalAdminEmail_(actorEmail);
  if (role === 'admin' && !selectedProcess) {
    if (preloadAdminDashboards) {
      preloadedAdmin = adminDashboardBundle_(actorEmail);
      adminProcesses = preloadedAdmin.adminProcesses;
      markDashboardTiming_(timing, 'admin dashboard preload');
    } else {
      adminProcesses = adminProcessesWithCounts_(actorEmail);
      markDashboardTiming_(timing, 'admin process counts');
    }
  } else {
    markDashboardTiming_(timing, 'admin process counts');
  }
  const database = role === 'admin'
    ? (preloadedAdmin ? preloadedAdmin.database : databaseDiagnostic_())
    : null;
  const workflowManagement = role === 'admin' && !selectedProcess && canManageUsers
    ? adminWorkflowManagementData_()
    : null;
  const formManagement = role === 'admin' && !selectedProcess && canManageUsers
    ? adminFormManagementData_()
    : null;
  markDashboardTiming_(timing, 'database diagnostic');
  const allRequests = role === 'admin'
    ? (selectedProcess ? getRequestsForProcess_(selectedProcess) : [])
    : getAllRequests_();
  markDashboardTiming_(timing, 'request sheet read');
  let requests = [];
  let approverEventRequestIds = {};

  if (role === 'requester') {
    requests = allRequests.filter(function (request) {
      return emailsMatch_(request.employeeEmail, actorEmail) || emailsMatch_(request.requesterEmail, actorEmail);
    });
  } else if (role === 'approver') {
    approverEventRequestIds = getApproverEventRequestIdsFor_(actorEmail);
    requests = allRequests.filter(function (request) {
      return approverCanSeeRequest_(request, actorEmail, approverEventRequestIds);
    });
  } else {
    if (!selectedProcess) {
      return {
        ok: true,
        role,
        email: actorEmail,
        roleAvailability: dashboardRoleAvailabilityFor_(actorEmail),
        isAdmin: isAdminEmail_(actorEmail),
        selectedProcess: '',
        selectedProcessName: '',
        canManageUsers,
        userManagement: canManageUsers ? adminUserManagementData_() : null,
        formManagement,
        workflowManagement,
        adminProcesses,
        adminDashboards: preloadedAdmin ? preloadedAdmin.adminDashboards : {},
        database,
        performance: finishDashboardTiming_(timing),
        requests: [],
        counts: emptyDashboardCounts_()
      };
    }
    if (!isProcessAdminEmail_(actorEmail, selectedProcess)) {
      const process = getProcessDefinition_(selectedProcess);
      throw new Error(`${actorEmail} is not configured as an admin for ${process.name || selectedProcess}.`);
    }
    requests = allRequests;
  }
  markDashboardTiming_(timing, 'visibility filtering');

  const checklistNotificationsByRequest = checklistNotificationHistoryByRequest_(requests);
  const records = dashboardRecords_(requests, role, actorEmail, approverEventRequestIds, checklistNotificationsByRequest);
  markDashboardTiming_(timing, 'dashboard rendering data');

  return {
    ok: true,
    role,
    email: actorEmail,
    roleAvailability: dashboardRoleAvailabilityFor_(actorEmail),
    isAdmin: isAdminEmail_(actorEmail),
    selectedProcess: selectedProcess,
    selectedProcessName: selectedProcess ? ((getProcessOption_(selectedProcess) || {}).name || selectedProcess) : '',
    canManageUsers,
    userManagement: role === 'admin' && !selectedProcess && canManageUsers ? adminUserManagementData_() : null,
    formManagement: role === 'admin' && !selectedProcess && canManageUsers ? formManagement : null,
    workflowManagement,
    adminProcesses,
    adminDashboards: {},
    database,
    performance: finishDashboardTiming_(timing),
    requests: records,
    counts: dashboardCounts_(records)
  };
}

function adminDashboardBundle_(email) {
  const adminProcesses = [];
  const adminDashboards = {};
  const database = databaseDiagnostic_();

  getAdminProcessOptionsFor_(email).forEach(function (process) {
    const requests = getRequestsForProcess_(process.key);
    const records = dashboardRecords_(requests, 'admin', email, {}, checklistNotificationHistoryByRequest_(requests));
    adminProcesses.push(Object.assign({}, process, {
      requestCount: requests.length,
      pendingCount: requests.filter(function (request) { return isPendingStatus_(request.status); }).length,
      stoppedCount: requests.filter(function (request) { return isStoppedStatus_(request.status); }).length
    }));
    adminDashboards[process.key] = {
      ok: true,
      role: 'admin',
      email,
      isAdmin: isAdminEmail_(email),
      selectedProcess: process.key,
      selectedProcessName: process.name || process.key,
      adminProcesses: [],
      adminDashboards: {},
      database,
      requests: records,
      counts: dashboardCounts_(records)
    };
  });

  return {
    adminProcesses,
    adminDashboards,
    database
  };
}

function dashboardRecords_(requests, role, actorEmail, approverEventRequestIds, checklistNotificationsByRequest) {
  return requests
    .map(function (request) {
      return dashboardRequest_(
        request,
        role,
        actorEmail,
        approverEventRequestIds || {},
        checklistNotificationsByRequest || {}
      );
    })
    .sort(function (a, b) {
      return String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || ''));
    });
}

function checklistNotificationHistoryByRequest_(requests) {
  const requestIds = {};
  (requests || []).forEach(function (request) {
    if (request && request.requestId) {
      requestIds[request.requestId] = true;
    }
  });
  if (!Object.keys(requestIds).length) {
    return {};
  }

  const byRequest = {};
  getAllEvents_().forEach(function (eventRecord) {
    if (eventRecord.event !== 'CHECKLIST_NOTIFICATION_SENT' || !requestIds[eventRecord.requestId]) {
      return;
    }
    const details = parseJsonObject_(eventRecord.detailsJson);
    const entry = {
      at: dateTimeCellValue_(eventRecord.timestamp),
      stepName: details.stepName || 'Checklist notification',
      stepType: 'notification',
      approverEmail: '',
      recipients: [].concat(details.recipients || []).map(normalizeEmail_).filter(Boolean),
      decision: 'notification sent'
    };
    byRequest[eventRecord.requestId] = byRequest[eventRecord.requestId] || [];
    byRequest[eventRecord.requestId].push(entry);
  });
  return byRequest;
}

function adminProcessesWithCounts_(email) {
  const recordsByProcess = {};
  getAllRequests_().forEach(function (request) {
    const key = processKeyForRequest_(request);
    recordsByProcess[key] = recordsByProcess[key] || [];
    recordsByProcess[key].push(request);
  });

  return getAdminProcessOptionsFor_(email).map(function (process) {
    const records = recordsByProcess[normalizeProcessKey_(process.key)] || [];
    return Object.assign({}, process, {
      requestCount: records.length,
      pendingCount: records.filter(function (request) { return isPendingStatus_(request.status); }).length,
      stoppedCount: records.filter(function (request) { return isStoppedStatus_(request.status); }).length
    });
  });
}

function startDashboardTiming_() {
  return {
    startedAt: Date.now(),
    lastAt: Date.now(),
    phases: []
  };
}

function markDashboardTiming_(timing, label) {
  if (!timing) {
    return;
  }
  const now = Date.now();
  timing.phases.push({
    label,
    durationMs: now - timing.lastAt,
    elapsedMs: now - timing.startedAt
  });
  timing.lastAt = now;
}

function finishDashboardTiming_(timing) {
  if (!timing) {
    return null;
  }
  return {
    totalMs: Date.now() - timing.startedAt,
    phases: timing.phases
  };
}

function dashboardCounts_(records) {
  return {
    total: records.length,
    waitingForMe: records.filter(function (request) { return request.canApprove; }).length,
    waitingForEmployee: records.filter(function (request) { return request.waitingOnType === 'employee'; }).length,
    pending: records.filter(function (request) { return request.isPending; }).length,
    closed: records.filter(function (request) { return request.isClosed; }).length
  };
}

function emptyDashboardCounts_() {
  return {
    total: 0,
    waitingForMe: 0,
    waitingForEmployee: 0,
    pending: 0,
    closed: 0
  };
}

function validateRequestForm_(form) {
  const processType = normalizeProcessKey_(form.processType || getDefaultProcessKey_());
  if (!getProcessOption_(processType)) {
    throw new Error(`Unknown request process "${processType}".`);
  }

  const definition = getFormDefinition_(processType);
  if (!definition || !definition.key) {
    throw new Error(`No form definition is configured for "${processType}".`);
  }

  const record = validateConfiguredForm_(form || {}, processType, definition);
  if (processType === 'vtr') {
    validateVtrEventDateRange_(record);
  }
  return record;
}

function validateConfiguredForm_(form, processType, definition, options) {
  options = options || {};
  const process = getProcessDefinition_(processType);
  const record = { processType };
  const values = Object.assign({}, options.sourceRecord || {}, form);

  flattenFormFields_(definition).forEach(function (field) {
    if (!field.name || formFieldIsDisplayOnly_(field)) {
      return;
    }

    const visible = formFieldConditionMatches_(field.visibleWhen, values);
    const required = visible && formFieldIsRequired_(field, values);
    const value = visible
      ? validateConfiguredFormField_(field, formFieldValue_(field, values), required, values)
      : cellValue_(field.hiddenValue);

    record[field.name] = value;
    values[field.name] = value;
  });

  (definition.computedFields || []).forEach(function (field) {
    const value = computedFormFieldValue_(field, values, process);
    record[field.field] = value;
    values[field.field] = value;
  });

  return record;
}

function formFieldValue_(field, values) {
  let value = values[field.name];
  if ((value === undefined || value === null || value === '') && field.defaultFromField) {
    value = values[field.defaultFromField];
  }
  if ((value === undefined || value === null || value === '') && field.defaultValue !== undefined) {
    value = field.defaultValue;
  }
  return value;
}

function formFieldIsDisplayOnly_(field) {
  return ['content', 'mealRules', 'hoursWarning', 'divider', 'requestSummary'].indexOf(field.type) !== -1;
}

function formFieldIsRequired_(field, values) {
  if (field.requiredWhen) {
    return formFieldConditionMatches_(field.requiredWhen, values);
  }
  return Boolean(field.required || field.mustBeChecked);
}

function formFieldConditionMatches_(condition, values) {
  return workflowConditionsMatch_(condition, values, true);
}

function validateConfiguredFormField_(field, value, required, values) {
  const label = formFieldValidationLabel_(field);
  const type = field.type || 'text';
  const text = trim_(value);

  if (type === 'checkbox') {
    const checked = value === true || value === 'true' || value === 'Yes' || value === 'on';
    if ((field.mustBeChecked || required) && !checked) {
      throw new Error(field.errorMessage || `${label} must be acknowledged.`);
    }
    return checked ? 'Yes' : '';
  }

  if (!required && !text) {
    return '';
  }

  if (type === 'email') {
    return required ? validateEmail_(value, label) : validateEmail_(text, label);
  }
  if (type === 'date') {
    return validateDateKey_(value, label);
  }
  if (type === 'time') {
    return validateTime_(value, label);
  }
  if (type === 'number') {
    return field.validation === 'positiveNumber'
      ? validatePositiveNumber_(value, label)
      : validateNumber_(value, label);
  }
  if (['radio', 'select', 'choiceCards', 'checklistChoice'].indexOf(type) !== -1) {
    return requireChoice_(value, formFieldChoices_(field, values), label);
  }

  return required ? requireText_(value, label) : text;
}

function formFieldValidationLabel_(field) {
  return String(field.validationLabel || field.label || field.name || 'Field').replace(/[.:?]+$/, '');
}

function formFieldChoices_(field, values) {
  if (field.type === 'checklistChoice') {
    return ['Yes', 'No', 'N/A'];
  }
  return (field.options || []).filter(function (option) {
    return formFieldOptionVisible_(option, values || {});
  }).map(function (option) {
    return typeof option === 'string' ? option : option.value;
  }).filter(Boolean);
}

function formFieldOptionVisible_(option, values) {
  if (!option || typeof option !== 'object' || !option.visibleWhen) {
    return true;
  }
  return formFieldConditionMatches_(option.visibleWhen, values || {});
}

function formOptionVariants_(request) {
  const variants = {};
  try {
    getAllFormDefinitions_(request).forEach(function (definition) {
      flattenFormFields_(definition).forEach(function (field) {
        if (!field.name || !field.options || variants[field.name]) {
          return;
        }
        const selected = cellValue_(request[field.name]);
        const matched = field.options.find(function (option) {
          return option && typeof option === 'object' &&
            option.summaryVariant &&
            cellValue_(option.value) === selected;
        });
        if (matched) {
          variants[field.name] = matched.summaryVariant;
        }
      });
    });
  } catch (err) {
    return {};
  }
  return variants;
}

function validateNumber_(value, label) {
  const text = requireText_(value, label);
  const number = Number(text);
  if (!isFinite(number)) {
    throw new Error(`${label} must be a valid number.`);
  }
  return String(number);
}

function validateVtrEventDateRange_(record) {
  if (record.multiDayEvent !== 'Yes') {
    record.eventStartDate = '';
    record.eventEndDate = '';
    return;
  }

  const start = validateDateKey_(record.eventStartDate, 'Event start date');
  const end = validateDateKey_(record.eventEndDate, 'Event end date');
  if (end < start) {
    throw new Error('Event end date must be on or after the event start date.');
  }
  record.eventStartDate = start;
  record.eventEndDate = end;
  record.eventDate = '';
}

function computedFormFieldValue_(field, values, process) {
  if (field.from) {
    return cellValue_(values[field.from]);
  }
  if (field.fromFields) {
    return field.fromFields.map(function (sourceField) {
      return cellValue_(values[sourceField]);
    }).filter(Boolean).join(field.separator || ' ');
  }

  let value = field.value;
  if (field.processSetting) {
    value = process[field.processSetting];
  }
  if (field.validation === 'email') {
    return validateEmail_(value, field.label || field.field || 'Configured email');
  }
  if (field.validation === 'required') {
    return requireText_(value, field.label || field.field || 'Configured value');
  }
  return cellValue_(value);
}

function validateActualHoursForm_(payload, request) {
  const definition = getFormDefinition_(request, 'actual');
  if (!definition || !definition.key) {
    throw new Error(`No actual-hours form definition is configured for "${request.processType || getDefaultProcessKey_()}".`);
  }
  return validateConfiguredForm_(payload || {}, request.processType || getDefaultProcessKey_(), definition, {
    sourceRecord: request
  });
}

function validateVtrChecklistForm_(payload, request) {
  const definition = getFormDefinition_(request, 'checklist');
  if (!definition || !definition.key) {
    throw new Error(`No VTR checklist form definition is configured for "${request.processType || getDefaultProcessKey_()}".`);
  }
  return validateConfiguredForm_(payload || {}, request.processType || getDefaultProcessKey_(), definition, {
    sourceRecord: request
  });
}

function requestNeedsVtrChecklist_(request) {
  const definition = getFormDefinition_(request, 'checklist');
  return isVtrRequest_(request) &&
    Boolean(definition && definition.key) &&
    !workflowConditionEquals_(request.eventType, 'Assessment');
}

function normalizeVtrChecklistAction_(value) {
  return String(value || '').toLowerCase() === 'complete' ? 'complete' : 'save';
}

function vtrChecklistShouldClose_(request) {
  const editableUntilDate = vtrChecklistEditableUntilDate_(request);
  return requestNeedsVtrChecklist_(request) &&
    Boolean(request.checklistCompletedAt) &&
    !request.activeApprovalStage &&
    !request.activeApprovalStepEmail &&
    Boolean(editableUntilDate) &&
    editableUntilDate < todayKey_();
}

function closeVtrChecklist_(request, actorEmail, notificationsSent) {
  Object.assign(request, {
    status: STATUS.APPROVED,
    updatedAt: nowIso_(),
    employeeActionTokenHash: ''
  });
  updateRequest_(request);
  logEvent_(request.requestId, actorEmail || 'system', 'VTR_CHECKLIST_CLOSED', {
    eventDate: request.eventDate,
    eventStartDate: request.eventStartDate,
    eventEndDate: request.eventEndDate,
    notificationsSent: notificationsSent || 0
  });
  sendEmployeeProcessApprovedEmail_(request);
  return {
    ok: true,
    requestId: request.requestId,
    closed: true,
    request: publicRequest_(request),
    message: `Checklist submitted and request ${request.requestId} is now complete.`
  };
}

function closeDueVtrChecklistsInternal_() {
  let closed = 0;
  getAllRequests_().forEach(function (request) {
    if (request.status !== STATUS.AWAITING_VTR_CHECKLIST || !vtrChecklistShouldClose_(request)) {
      return;
    }
    closeVtrChecklist_(request, 'system', 0);
    closed += 1;
  });
  return {
    closed
  };
}

function sendChecklistWorkflowNotifications_(request, actorEmail) {
  const steps = refreshWorkflowStepsSnapshot_(request, 'checklist')
    .filter(function (step) {
      return step.type === 'notification' && !checklistNotificationAlreadySent_(request, step.name);
    });
  let sent = 0;

  steps.forEach(function (step) {
    const notification = sendWorkflowNotificationEmail_(request, step, 'checklist');
    if (!notification) {
      return;
    }
    appendHistory_(request, 'checklistNotificationHistory', {
      at: nowIso_(),
      stepName: step.name,
      stepIndex: step.index,
      stepOriginalIndex: step.originalIndex,
      stepType: 'notification',
      approverEmail: '',
      recipients: notification.recipients,
      decision: 'notification sent'
    });
    logEvent_(request.requestId, actorEmail || 'system', 'CHECKLIST_NOTIFICATION_SENT', {
      stepName: step.name,
      recipients: notification.recipients
    });
    sent += 1;
  });

  return sent;
}

function checklistNotificationAlreadySent_(request, stepName) {
  if (parseJsonArray_(request.checklistNotificationHistory).some(function (entry) {
    return trim_(entry.stepName).toLowerCase() === trim_(stepName).toLowerCase();
  })) {
    return true;
  }
  const requestId = request.requestId;
  return getAllEvents_().some(function (eventRecord) {
    if (eventRecord.requestId !== requestId || eventRecord.event !== 'CHECKLIST_NOTIFICATION_SENT') {
      return false;
    }
    const details = parseJsonObject_(eventRecord.detailsJson);
    return details.stepName === stepName;
  });
}

function mergeChecklistNotificationHistory_(storedHistory, eventHistory) {
  const seen = {};
  return []
    .concat(storedHistory || [])
    .concat(eventHistory || [])
    .filter(function (entry) {
      const recipients = [].concat(entry.recipients || []).map(normalizeEmail_).filter(Boolean).sort().join(',');
      const key = [
        trim_(entry.stepName).toLowerCase(),
        trim_(entry.decision).toLowerCase(),
        trim_(entry.at),
        recipients
      ].join('|');
      if (seen[key]) {
        return false;
      }
      seen[key] = true;
      return true;
    })
    .sort(function (a, b) {
      return String(a.at || '').localeCompare(String(b.at || ''));
    });
}

function publicRequest_(request) {
  request = normalizeRequestRecord_(request);
  const process = getProcessDefinition_(request);
  const activeStep = getActiveWorkflowStep_(request);
  const stopped = isStoppedStatus_(request.status);
  return {
    requestId: request.requestId,
    processType: request.processType,
    processName: process.name || request.processType,
    completionMode: getProcessCompletionMode_(request),
    createdAt: request.createdAt,
    updatedAt: request.updatedAt,
    status: request.status,
    statusLabel: processStatusLabel_(request),
    statusTone: stopped ? 'stopped' : (isPendingStatus_(request.status) ? 'pending' : 'closed'),
    employeeEmail: request.employeeEmail,
    employeeName: request.employeeName,
    lineManagerEmail: request.lineManagerEmail,
    isLineManagerRequester: request.isLineManagerRequester,
    requesterEmail: request.requesterEmail,
    reason: request.reason,
    overtimeDate: request.overtimeDate,
    normallyWorks: request.normallyWorks,
    normalStartTime: request.normalStartTime,
    normalFinishTime: request.normalFinishTime,
    plannedStartTime: request.plannedStartTime,
    plannedFinishTime: request.plannedFinishTime,
    plannedHours: request.plannedHours,
    compensationMethod: request.compensationMethod,
    followUpDueDate: request.followUpDueDate,
    followUpSentAt: request.followUpSentAt,
    mealRulesAcknowledged: request.mealRulesAcknowledged,
    activeApprovalStage: request.activeApprovalStage,
    activeApprovalStepIndex: request.activeApprovalStepIndex,
    activeApprovalStepName: request.activeApprovalStepName,
    activeApprovalStepEmail: request.activeApprovalStepEmail,
    activeWorkflowStepType: activeStep ? activeStep.type : '',
    activeWorkflowStageLabel: activeStep ? workflowStepStageLabel_(request.activeApprovalStage, activeStep, request) : '',
    activeWorkflowPrimaryDecision: activeStep ? workflowStepPrimaryDecision_(activeStep) : '',
    activeWorkflowPrimaryActionLabel: activeStep ? workflowStepPrimaryLabel_(activeStep) : '',
    activeWorkflowRequiresComment: activeStep ? workflowStepRequiresComment_(activeStep, workflowStepPrimaryDecision_(activeStep)) : false,
    activeWorkflowCanDeny: activeStep ? workflowStepAllowsDecision_(activeStep, 'deny') : false,
    waitingOnType: waitingOnType_(request),
    waitingOnLabel: waitingOnLabel_(request),
    formOptionVariants: formOptionVariants_(request),
    actualSubmittedAt: request.actualSubmittedAt,
    checklistSubmittedAt: request.checklistSubmittedAt,
    checklistCompletedAt: request.checklistCompletedAt,
    overtimeCompleteAcknowledged: request.overtimeCompleteAcknowledged,
    mealBreaksAcknowledged: request.mealBreaksAcknowledged,
    mealAllowance: request.mealAllowance,
    workedAsApproved: request.workedAsApproved,
    actualStartTime: request.actualStartTime,
    actualFinishTime: request.actualFinishTime,
    actualHours: request.actualHours,
    variationReason: request.variationReason,
    changeRequestedAt: request.changeRequestedAt,
    changeRequestedByEmail: request.changeRequestedByEmail,
    changeRequestedByName: request.changeRequestedByName,
    changeStage: request.changeStage,
    changeComment: request.changeComment,
    lastEditedAt: request.lastEditedAt,
    lastEditedByEmail: request.lastEditedByEmail,
    approvalWorkflowSteps: publicWorkflowSteps_('approval', request),
    finalWorkflowSteps: publicWorkflowSteps_('final', request),
    checklistWorkflowSteps: publicWorkflowSteps_('checklist', request),
    approvalHistory: parseJsonArray_(request.approvalHistory),
    finalApprovalHistory: parseJsonArray_(request.finalApprovalHistory),
    checklistNotificationHistory: parseJsonArray_(request.checklistNotificationHistory),
    changeHistory: parseJsonArray_(request.changeHistory),
    eventName: request.eventName,
    multiDayEvent: request.multiDayEvent,
    eventDate: request.eventDate,
    eventStartDate: request.eventStartDate,
    eventEndDate: request.eventEndDate,
    schoolArea: request.schoolArea,
    eventType: request.eventType,
    eventLocation: request.eventLocation,
    eventStartTime: request.eventStartTime,
    eventFinishTime: request.eventFinishTime,
    eventTimes: request.eventTimes,
    studentsInvolved: request.studentsInvolved,
    staffRequired: request.staffRequired,
    riskAssessmentRequired: request.riskAssessmentRequired,
    logisticsNotified: request.logisticsNotified,
    costToStudents: request.costToStudents,
    riskAssessmentCompleted: request.riskAssessmentCompleted,
    wwccConfirmed: request.wwccConfirmed,
    budgetSubmitted: request.budgetSubmitted,
    groundsConsulted: request.groundsConsulted,
    itConsulted: request.itConsulted,
    groundsAfterHoursNotified: request.groundsAfterHoursNotified,
    sportPdhpeConsulted: request.sportPdhpeConsulted,
    chaplaincyConsulted: request.chaplaincyConsulted,
    canteenNotified: request.canteenNotified,
    parentLetterChecked: request.parentLetterChecked,
    parentLetterProvided: request.parentLetterProvided,
    staffNotified: request.staffNotified,
    busesBooked: request.busesBooked,
    marketingNotified: request.marketingNotified,
    offsiteExcursion: request.offsiteExcursion,
    attendingStaffBriefed: request.attendingStaffBriefed,
    medicalNeedsCompiled: request.medicalNeedsCompiled,
    lessonPlansLeft: request.lessonPlansLeft,
    rollsMarkedReceptionNotified: request.rollsMarkedReceptionNotified
  };
}

function publicWorkflowSteps_(stage, request) {
  try {
    return workflowStepsForStage_(request, stage)
      .map(function (step) {
        return {
          index: step.index,
          originalIndex: step.originalIndex,
          stage,
          type: step.type,
          name: step.name,
          email: step.email,
          emails: step.emails,
          ccEmails: step.ccEmails || [],
          requireComment: Boolean(step.requireComment),
          stepKey: workflowStepKey_(step)
        };
      });
  } catch (err) {
    return [{
      index: 0,
      originalIndex: 0,
      stage,
      type: 'configuration',
      name: 'Workflow configuration issue',
      email: '',
      emails: [],
      error: err.message
    }];
  }
}

function dashboardRequest_(request, role, actorEmail, approverEventRequestIds, checklistNotificationsByRequest) {
  const record = publicRequest_(request);
  const activeStep = getActiveWorkflowStep_(request);
  const isApproverRole = role === 'approver';
  const pending = isPendingStatus_(request.status);
  const stopped = isStoppedStatus_(request.status);
  record.canApprove = role === 'approver' && pending && emailsMatch_(request.activeApprovalStepEmail, actorEmail);
  record.canDeny = record.canApprove && workflowStepAllowsDecision_(activeStep, 'deny');
  record.canRequestChanges = record.canApprove && workflowStepAllowsDecision_(activeStep, 'changes');
  record.primaryDecision = activeStep ? workflowStepPrimaryDecision_(activeStep) : 'approve';
  record.primaryActionLabel = activeStep ? workflowStepPrimaryLabel_(activeStep) : 'Approve';
  record.requiresComment = activeStep ? workflowStepRequiresComment_(activeStep, record.primaryDecision) : false;
  record.canAdmin = role === 'admin' && isProcessAdminEmail_(actorEmail, request.processType);
  record.canEditApproval = role === 'requester' && requesterCanAccess_(request, actorEmail) && canEditApprovalStatus_(request.status);
  record.canEditActual = getProcessCompletionMode_(request) === 'actual_hours' &&
    role === 'requester' &&
    requesterCanAccess_(request, actorEmail) &&
    canEditActualHoursStatus_(request.status) &&
    request.status !== STATUS.PREAPPROVED;
  record.canEditChecklist = requestNeedsVtrChecklist_(request) &&
    Boolean(request.followUpSentAt) &&
    role === 'requester' &&
    requesterCanAccess_(request, actorEmail) &&
    canEditVtrChecklistStatus_(request.status);
  record.canCancel = role === 'requester' && requesterCanAccess_(request, actorEmail) && isRequestCancellable_(request);
  record.canReassign = record.canAdmin && pending && Boolean(request.activeApprovalStage && request.activeApprovalStepEmail);
  record.canAdminCancel = record.canAdmin && isRequestCancellable_(request);
  record.canRemind = record.canAdmin && pending && (
    Boolean(request.activeApprovalStage && request.activeApprovalStepEmail) ||
    request.status === STATUS.AWAITING_ACTUAL_HOURS ||
    request.status === STATUS.AWAITING_VTR_CHECKLIST
  );
  record.hasApprovedByMe = hasApprovalHistoryFor_(request, actorEmail) ||
    Boolean(approverEventRequestIds && approverEventRequestIds[request.requestId]);
  record.hasRequestedChangesByMe = hasChangeHistoryFor_(request, actorEmail) || emailsMatch_(request.changeRequestedByEmail, actorEmail);
  record.checklistNotificationHistory = mergeChecklistNotificationHistory_(
    record.checklistNotificationHistory || [],
    (checklistNotificationsByRequest || {})[request.requestId] || []
  );
  record.isManagedByMe = emailsMatch_(request.lineManagerEmail, actorEmail);
  record.isRelatedToMe = isApproverRole && (
    record.canApprove ||
    record.hasApprovedByMe ||
    record.hasRequestedChangesByMe ||
    record.isManagedByMe
  );
  record.isPending = pending;
  record.isClosed = !record.isPending;
  record.isStopped = stopped;
  return record;
}

function waitingOnType_(request) {
  if (request.activeApprovalStage && request.activeApprovalStepEmail) {
    return 'approver';
  }
  if (request.status === STATUS.AWAITING_VTR_CHECKLIST && request.checklistCompletedAt) {
    return 'closed';
  }
  if (request.status === STATUS.NEEDS_APPROVAL_CHANGES || request.status === STATUS.NEEDS_ACTUAL_HOURS_CHANGES) {
    return 'employee';
  }
  if (request.status === STATUS.PREAPPROVED ||
      request.status === STATUS.AWAITING_ACTUAL_HOURS ||
      request.status === STATUS.AWAITING_VTR_CHECKLIST) {
    return 'employee';
  }
  return request.status === STATUS.FINAL_APPROVED || request.status === STATUS.APPROVED || isStoppedStatus_(request.status)
    ? 'closed'
    : '';
}

function waitingOnLabel_(request) {
  if (request.activeApprovalStage && request.activeApprovalStepEmail) {
    const activeStep = getActiveWorkflowStep_(request);
    const customLabel = renderWorkflowWaitingLabel_(activeStep, request);
    if (customLabel) {
      return customLabel;
    }
    const action = workflowStepActionVerb_(activeStep);
    return `${request.activeApprovalStepName || 'Workflow owner'} <${request.activeApprovalStepEmail}> to ${action}`;
  }
  if (request.status === STATUS.NEEDS_APPROVAL_CHANGES) {
    return `${request.employeeName} to edit request details`;
  }
  if (request.status === STATUS.NEEDS_ACTUAL_HOURS_CHANGES) {
    return `${request.employeeName} to edit actual hours`;
  }
  if (request.status === STATUS.PREAPPROVED) {
    return `Employee actual-hours confirmation after ${formatDateForEmail_(request.overtimeDate)}`;
  }
  if (request.status === STATUS.AWAITING_ACTUAL_HOURS) {
    return `${request.employeeName} <${request.employeeEmail}>`;
  }
  if (request.status === STATUS.AWAITING_VTR_CHECKLIST) {
    if (request.checklistCompletedAt) {
      return `No further action required; VTR checklist remains editable by ${request.employeeName} <${request.employeeEmail}> through ${vtrChecklistEditableUntilForEmail_(request)}`;
    }
    return `${request.employeeName} <${request.employeeEmail}> to submit VTR checklist`;
  }
  if (request.status === STATUS.FINAL_APPROVED || request.status === STATUS.APPROVED) {
    return 'Complete';
  }
  if (request.status === STATUS.APPROVAL_DENIED || request.status === STATUS.FINAL_DENIED) {
    return 'Denied';
  }
  if (request.status === STATUS.CANCELLED) {
    return 'Cancelled';
  }
  return '';
}

function renderWorkflowWaitingLabel_(step, request) {
  const template = trim_(step && step.waitingLabel) || defaultWorkflowWaitingLabel_();
  if (!template) {
    return '';
  }

  const action = workflowStepActionVerb_(step);
  const values = {
    'Step name': request.activeApprovalStepName || (step && step.name) || 'Workflow owner',
    'Step email': request.activeApprovalStepEmail || (step && step.email) || '',
    Action: action,
    'Employee name': request.employeeName || '',
    'Employee email': request.employeeEmail || '',
    'Request ID': request.requestId || ''
  };

  return template.replace(/\{(Step name|Step email|Action|Employee name|Employee email|Request ID)\}/g, function (match, key) {
    return values[key] || '';
  });
}

function processStatusLabel_(request) {
  if (request.status === STATUS.AWAITING_VTR_CHECKLIST && request.checklistCompletedAt) {
    return 'Checklist submitted';
  }
  if (getProcessCompletionMode_(request) === 'actual_hours') {
    if (request.status === STATUS.PENDING_APPROVAL) {
      return 'Pending pre-approval';
    }
    if (request.status === STATUS.NEEDS_APPROVAL_CHANGES) {
      return 'Needs request changes';
    }
    if (request.status === STATUS.APPROVAL_DENIED) {
      return 'Pre-approval denied';
    }
  }
  return statusLabel_(request.status);
}
