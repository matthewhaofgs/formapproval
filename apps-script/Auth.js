/**
 * Authentication, authorization, and visibility helpers.
 */

function getWebAppUrl_() {
  const configured = APP_SETTINGS.WEB_APP_URL || PropertiesService.getScriptProperties().getProperty('WEB_APP_URL');
  const deployed = ScriptApp.getService().getUrl();
  const url = configured || deployed;
  if (!url) {
    throw new Error('Web app URL is not available yet. Deploy the Apps Script as a web app, or set APP_SETTINGS.WEB_APP_URL in Config.');
  }
  return url;
}

function getCurrentUserEmail_() {
  try {
    return normalizeEmail_(Session.getActiveUser().getEmail() || '');
  } catch (err) {
    return '';
  }
}

function getRequesterVisibleRequest_(requestId, payload) {
  if (!requestId) {
    return null;
  }
  const request = getRequestById_(requestId);
  if (!request) {
    return null;
  }
  const actorEmail = getAuthenticatedEmail_(payload || {});
  if (!requesterCanAccess_(request, actorEmail)) {
    throw new Error(`Request ${requestId} is not linked to ${actorEmail}.`);
  }
  return request;
}

function requesterCanAccess_(request, email) {
  return emailsMatch_(request.employeeEmail, email) || emailsMatch_(request.requesterEmail, email);
}

function canEditApprovalStatus_(status) {
  return status === STATUS.PENDING_APPROVAL ||
    status === STATUS.NEEDS_APPROVAL_CHANGES ||
    status === STATUS.PREAPPROVED;
}

function canEditActualHoursStatus_(status) {
  return status === STATUS.AWAITING_ACTUAL_HOURS ||
    status === STATUS.NEEDS_ACTUAL_HOURS_CHANGES ||
    status === STATUS.PENDING_FINAL_APPROVAL ||
    status === STATUS.PREAPPROVED;
}

function canEditVtrChecklistStatus_(status) {
  return status === STATUS.AWAITING_VTR_CHECKLIST ||
    status === STATUS.PENDING_APPROVAL;
}

function assertRequestAwaitingApprovalFor_(request, actorEmail) {
  if (!request.activeApprovalStage || !request.activeApprovalStepEmail || !request.activeApprovalTokenHash) {
    throw new Error(`Request ${request.requestId} is not currently awaiting a workflow decision.`);
  }
  if (!emailsMatch_(request.activeApprovalStepEmail, actorEmail)) {
    throw new Error(`Request ${request.requestId} is currently assigned to ${request.activeApprovalStepName || 'Workflow owner'} <${request.activeApprovalStepEmail}>, not ${actorEmail}.`);
  }
}

function getAuthenticatedEmail_(payload) {
  const activeEmail = getCurrentUserEmail_();
  if (activeEmail) {
    return activeEmail;
  }

  if (APP_SETTINGS.ALLOW_EMAIL_FALLBACK_FOR_TESTING) {
    return normalizeEmail_(validateEmail_(payload && payload.email, 'Email'));
  }

  if (APP_SETTINGS.REQUIRE_GOOGLE_AUTH) {
    throw new Error('Your Google account email was not available to the app. Deploy the web app for your Google Workspace domain, or temporarily enable APP_SETTINGS.ALLOW_EMAIL_FALLBACK_FOR_TESTING while testing.');
  }

  return normalizeEmail_(validateEmail_(payload && payload.email, 'Email'));
}

function requireAdminEmail_(payload) {
  const email = getAuthenticatedEmail_(payload);
  if (!isAdminEmail_(email)) {
    throw new Error(`${email || 'This account'} is not configured as an admin.`);
  }
  return email;
}

function requireGlobalAdminEmail_(payload) {
  const email = requireAdminEmail_(payload);
  if (!isGlobalAdminEmail_(email)) {
    throw new Error(`${email || 'This account'} is not configured as a global admin.`);
  }
  return email;
}

function requireProcessAdminEmail_(payload, processKey) {
  const email = requireAdminEmail_(payload);
  if (!isProcessAdminEmail_(email, processKey)) {
    const process = getProcessDefinition_(processKey);
    throw new Error(`${email || 'This account'} is not configured as an admin for ${process.name || processKey}.`);
  }
  return email;
}

function assertProcessAdminForRequest_(email, request) {
  if (!isProcessAdminEmail_(email, request.processType)) {
    const process = getProcessDefinition_(request);
    throw new Error(`${email || 'This account'} is not configured as an admin for ${process.name || request.processType}.`);
  }
}

function isAdminEmail_(email) {
  if (isGlobalAdminEmail_(email)) {
    return true;
  }
  return getProcessOptions_().some(function (process) {
    return configuredEmailsContain_(getProcessAdminEmails_(process.key), email);
  });
}

function isGlobalAdminEmail_(email) {
  const normalized = normalizeEmail_(email);
  return configuredEmailsContain_(getConfiguredAdminEmails_(), normalized);
}

function isProcessAdminEmail_(email, processKey) {
  const normalized = normalizeEmail_(email);
  if (!normalized) {
    return false;
  }
  if (isGlobalAdminEmail_(normalized)) {
    return true;
  }
  const process = getProcessDefinition_(processKey);
  if (!process || normalizeProcessKey_(process.key) !== normalizeProcessKey_(processKey)) {
    return false;
  }
  return configuredEmailsContain_(getProcessAdminEmails_(process.key), normalized);
}

function dashboardRoleAvailabilityFor_(email) {
  const normalized = normalizeEmail_(email);
  const availability = {
    requester: true,
    approver: false,
    admin: false
  };
  if (!normalized) {
    return availability;
  }

  availability.admin = isAdminEmail_(normalized);
  availability.approver = hasApproverDashboardAccess_(normalized);
  return availability;
}

function hasApproverDashboardAccess_(email) {
  const normalized = normalizeEmail_(email);
  if (!normalized) {
    return false;
  }
  const eventRequestIds = getApproverEventRequestIdsFor_(normalized);
  return getAllRequests_().some(function (request) {
    return approverCanSeeRequest_(request, normalized, eventRequestIds);
  });
}

function hasApprovalHistoryFor_(request, email) {
  const normalized = normalizeEmail_(email);
  return parseJsonArray_(request.approvalHistory)
    .concat(parseJsonArray_(request.finalApprovalHistory))
    .some(function (entry) {
      return emailsMatch_(entry.approverEmail, normalized);
    });
}

function hasChangeHistoryFor_(request, email) {
  const normalized = normalizeEmail_(email);
  return parseJsonArray_(request.changeHistory)
    .some(function (entry) {
      return emailsMatch_(entry.requestedByEmail, normalized);
    });
}

function approverCanSeeRequest_(request, email, eventRequestIds) {
  return emailsMatch_(request.activeApprovalStepEmail, email) ||
    emailsMatch_(request.lineManagerEmail, email) ||
    emailsMatch_(request.changeRequestedByEmail, email) ||
    hasApprovalHistoryFor_(request, email) ||
    hasChangeHistoryFor_(request, email) ||
    Boolean(eventRequestIds && eventRequestIds[request.requestId]);
}

function getApproverEventRequestIdsFor_(email) {
  const normalized = normalizeEmail_(email);
  const requestIds = {};
  if (!normalized) {
    return requestIds;
  }

  getAllEvents_().forEach(function (eventRecord) {
    if (isApprovalEvent_(eventRecord.event) && emailsMatch_(eventRecord.actorEmail, normalized)) {
      requestIds[eventRecord.requestId] = true;
    } else if (eventIncludesEmail_(eventRecord, normalized)) {
      requestIds[eventRecord.requestId] = true;
    }
  });
  return requestIds;
}

function eventIncludesEmail_(eventRecord, email) {
  const details = parseJsonObject_(eventRecord.detailsJson);
  const emails = [];

  [
    'actionOwnerEmail',
    'approverEmail',
    'stepEmail',
    'activeApprovalStepEmail'
  ].forEach(function (field) {
    if (details[field]) {
      emails.push(details[field]);
    }
  });

  [].concat(details.recipients || []).forEach(function (recipient) {
    emails.push(recipient);
  });
  if (details.previous && details.previous.email) {
    emails.push(details.previous.email);
  }
  if (details.previous && details.previous.activeApprovalStepEmail) {
    emails.push(details.previous.activeApprovalStepEmail);
  }
  if (details.next && details.next.email) {
    emails.push(details.next.email);
  }

  return emails.some(function (candidate) {
    return emailsMatch_(candidate, email);
  });
}

function isApprovalEvent_(eventName) {
  return [
    'APPROVAL_APPROVED_STEP',
    'APPROVAL_ACKNOWLEDGED_STEP',
    'APPROVAL_ACTION_COMPLETED_STEP',
    'PREAPPROVED',
    'REQUEST_APPROVED',
    'REQUEST_APPROVED_AFTER_NOTIFICATIONS',
    'FINAL_APPROVED_STEP',
    'FINAL_ACKNOWLEDGED_STEP',
    'FINAL_ACTION_COMPLETED_STEP',
    'FINAL_APPROVED',
    'APPROVAL_DENIED',
    'FINAL_DENIED',
    'APPROVAL_CHANGES_REQUESTED',
    'ACTUAL_HOURS_CHANGES_REQUESTED'
  ].indexOf(eventName) !== -1;
}

function emailsMatch_(left, right) {
  return normalizeEmail_(left) !== '' && normalizeEmail_(left) === normalizeEmail_(right);
}

function normalizeEmail_(value) {
  return trim_(value).toLowerCase();
}
