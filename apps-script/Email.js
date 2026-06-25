/**
 * Email rendering and delivery.
 */

function sendWorkflowActionEmail_(request, step, token, isReminder) {
  const stage = request.activeApprovalStage || 'approval';
  const isFinal = stage === 'final';
  const isAcknowledgement = step && step.type === 'acknowledgement';
  const isAction = step && step.type === 'action';
  const isOvertime = isOvertimeRequest_(request);
  const processName = processNameForEmail_(request);
  const requestDate = requestPrimaryDate_(request);
  const requestDateLabel = requestPrimaryDateLabel_(request);
  const webAppUrl = getWebAppUrl_();
  const dashboardUrl = `${webAppUrl}?mode=dashboard&role=approver`;
  const defaultHeading = isOvertime
    ? (isAcknowledgement
      ? (isFinal ? 'Actual-hours acknowledgement needed' : 'Overtime acknowledgement needed')
      : (isAction ? 'Overtime action needed' : (isFinal ? 'Final overtime approval needed' : 'Overtime pre-approval needed')))
    : (isAction ? `${processName} action needed` : (isAcknowledgement ? `${processName} acknowledgement needed` : `${processName} approval needed`));
  const heading = step.subject || defaultHeading;
  const subject = `${request.requestId}: ${isReminder ? 'reminder - ' : ''}${heading.toLowerCase()}`;
  const defaultIntro = isFinal
    ? `${request.employeeName} has submitted actual overtime hours${isAction ? ' and your action is required' : (isAcknowledgement ? ' for acknowledgement' : ' for final approval')}.`
    : (isOvertime
      ? `${request.employeeName} has requested overtime on ${formatDateForEmail_(request.overtimeDate)}${isAction ? ' and your action is required' : (isAcknowledgement ? ' and your acknowledgement is required' : '')}.`
      : `${request.employeeName} has submitted ${processName}${requestDate ? ` for ${requestDateLabel}` : ''}${isAction ? ' and your action is required' : (isAcknowledgement ? ' and your acknowledgement is required' : '')}.`);
  const intro = step.message || defaultIntro;
  const htmlBody = emailShell_(
    `${isReminder ? 'Reminder: ' : ''}${heading}`,
    `<p>${escapeHtml_(intro)}</p>` +
      summaryTable_(request, isFinal) +
      workflowDecisionButtonsHtml_(webAppUrl, token, step) +
      secondaryLinkHtml_(dashboardUrl, 'Review details or request changes')
  );

  sendEmail_(step.email, subject, htmlBody);
}

function sendWorkflowNotificationEmail_(request, step, stage) {
  const recipientList = [].concat(step.emails || [step.email]).map(normalizeEmail_).filter(Boolean);
  const recipients = recipientList.join(',');
  if (!recipientList.length) {
    return null;
  }

  const isFinal = stage === 'final';
  const isOvertime = isOvertimeRequest_(request);
  const processName = processNameForEmail_(request);
  const requestDate = requestPrimaryDate_(request);
  const requestDateLabel = requestPrimaryDateLabel_(request);
  const heading = step.subject || (isFinal ? 'Actual overtime hours notification' : `${processName} notification`);
  const defaultMessage = isFinal
    ? `${request.employeeName} has submitted actual overtime hours. This is a notification only; no action is required from you.`
    : (isOvertime
      ? `${request.employeeName} has requested overtime on ${formatDateForEmail_(request.overtimeDate)}. This is a notification only; no action is required from you.`
      : `${request.employeeName} has submitted ${processName}${requestDate ? ` for ${requestDateLabel}` : ''}. This is a notification only; no action is required from you.`);
  const htmlBody = emailShell_(
    heading,
    `<p>${escapeHtml_(step.message || defaultMessage)}</p>` +
      summaryTable_(request, isFinal)
  );

  sendEmail_(recipients, `${request.requestId}: ${heading.toLowerCase()}`, htmlBody);
  return {
    recipients: recipientList,
    subject: `${request.requestId}: ${heading.toLowerCase()}`
  };
}

function sendActualHoursRequestEmail_(request, token, isReminder) {
  const webAppUrl = getWebAppUrl_();
  const url = `${webAppUrl}?mode=actual&token=${encodeURIComponent(token)}`;
  const dashboardUrl = `${webAppUrl}?mode=dashboard&role=requester`;
  const subject = `${request.requestId}: ${isReminder ? 'reminder - ' : ''}confirm actual overtime hours`;
  const htmlBody = emailShell_(
    `${isReminder ? 'Reminder: ' : ''}Confirm actual overtime hours`,
    `<p>Your pre-approved overtime date has passed. Confirm the actual hours worked for request ${escapeHtml_(request.requestId)}.</p>` +
      summaryTable_(request, false) +
      buttonHtml_(url, 'Confirm actual hours') +
      secondaryLinkHtml_(dashboardUrl, 'Open My Requests')
  );

  sendEmail_(request.employeeEmail, subject, htmlBody);
  return {
    webAppUrl
  };
}

function sendVtrChecklistRequestEmail_(request, token, isReminder) {
  const webAppUrl = getWebAppUrl_();
  const url = `${webAppUrl}?mode=checklist&token=${encodeURIComponent(token)}`;
  const dashboardUrl = `${webAppUrl}?mode=dashboard&role=requester`;
  const subject = `${request.requestId}: ${isReminder ? 'reminder - ' : ''}complete VTR checklist`;
  const htmlBody = emailShell_(
    `${isReminder ? 'Reminder: ' : ''}Complete VTR checklist`,
    `<p>Your VTR has completed approval. Please complete and update the checklist for request ${escapeHtml_(request.requestId)}. The checklist remains editable through ${vtrChecklistEditableUntilForEmail_(request)} so you can update items as preparation progresses.</p>` +
      summaryTable_(request, false) +
      buttonHtml_(url, 'Open VTR checklist') +
      secondaryLinkHtml_(dashboardUrl, 'Open My Requests')
  );

  sendEmail_(request.employeeEmail, subject, htmlBody);
  return {
    webAppUrl
  };
}

function sendChangeRequestEmail_(request, token) {
  const isActual = request.changeStage === 'actual';
  const isOvertime = isOvertimeRequest_(request);
  const processName = processNameForEmail_(request);
  const url = `${getWebAppUrl_()}?mode=${isActual ? 'actual' : 'edit'}&token=${encodeURIComponent(token)}`;
  const dashboardUrl = `${getWebAppUrl_()}?mode=dashboard&role=requester`;
  const subject = `${request.requestId}: changes requested`;
  const htmlBody = emailShell_(
    'Changes requested',
    `<p>${escapeHtml_(request.changeRequestedByName || 'A workflow reviewer')} has requested changes to ${isActual ? 'your actual overtime hours' : (isOvertime ? 'your overtime request' : `your ${processName} request`)}.</p>` +
      `<p><strong>Comment:</strong> ${escapeHtml_(request.changeComment || '')}</p>` +
      summaryTable_(request, isActual) +
      buttonHtml_(url, isActual ? 'Edit actual hours' : 'Edit request') +
      secondaryLinkHtml_(dashboardUrl, 'Open My Requests')
  );

  const requesterEmail = normalizeEmail_(request.requesterEmail);
  const employeeEmail = normalizeEmail_(request.employeeEmail);
  sendEmail_(request.employeeEmail, subject, htmlBody, requesterEmail && requesterEmail !== employeeEmail ? requesterEmail : '');
}

function sendEmployeeReceiptEmail_(request) {
  const isOvertime = isOvertimeRequest_(request);
  const isVtr = isVtrRequest_(request);
  const processName = processNameForEmail_(request);
  const subject = `${request.requestId}: ${isOvertime ? 'overtime' : processName.toLowerCase()} request received`;
  const dashboardUrl = `${getWebAppUrl_()}?mode=dashboard&role=requester`;
  const message = isVtr
    ? 'Your VTR has been received and sent to the relevant logistics owner for initial approval.'
    : `Your ${isOvertime ? 'overtime' : processName} request has been sent for approval.`;
  const htmlBody = emailShell_(
    `${processName} request received`,
    `<p>${escapeHtml_(message)}</p>` +
      summaryTable_(request, false) +
      secondaryLinkHtml_(dashboardUrl, 'Open My Requests')
  );

  sendEmail_(request.employeeEmail, subject, htmlBody);
}

function sendEmployeePreapprovedEmail_(request) {
  const subject = `${request.requestId}: overtime pre-approved`;
  const dashboardUrl = `${getWebAppUrl_()}?mode=dashboard&role=requester`;
  const htmlBody = emailShell_(
    'Overtime pre-approved',
    `<p>Your overtime request has been pre-approved. The system will email you the day after ${formatDateForEmail_(request.overtimeDate)} to confirm actual hours worked.</p>` +
      summaryTable_(request, false) +
      secondaryLinkHtml_(dashboardUrl, 'Open My Requests')
  );

  sendEmail_(request.employeeEmail, subject, htmlBody);
}

function sendEmployeeFinalApprovedEmail_(request) {
  const subject = `${request.requestId}: overtime final approved`;
  const dashboardUrl = `${getWebAppUrl_()}?mode=dashboard&role=requester`;
  const htmlBody = emailShell_(
    'Overtime final approved',
    `<p>Your completed overtime has been final approved.</p>` +
      summaryTable_(request, true) +
      secondaryLinkHtml_(dashboardUrl, 'Open My Requests')
  );

  sendEmail_(request.employeeEmail, subject, htmlBody);
}

function sendEmployeeProcessApprovedEmail_(request) {
  const processName = processNameForEmail_(request);
  const subject = `${request.requestId}: ${processName.toLowerCase()} approved`;
  const dashboardUrl = `${getWebAppUrl_()}?mode=dashboard&role=requester`;
  const message = isVtrRequest_(request)
    ? 'Your VTR has completed the approval workflow. Any required risk assessment acknowledgement has been recorded. You can now proceed with the approved arrangements.'
    : `Your ${processName} request has completed approval.`;
  const htmlBody = emailShell_(
    `${processName} approved`,
    `<p>${escapeHtml_(message)}</p>` +
      summaryTable_(request, false) +
      secondaryLinkHtml_(dashboardUrl, 'Open My Requests')
  );

  sendEmail_(request.employeeEmail, subject, htmlBody);
}

function sendPaymentNotificationEmail_(request) {
  const recipients = getPaymentNotificationEmails_(request).filter(Boolean).join(',');
  if (!recipients) {
    return;
  }

  const subject = `${request.requestId}: overtime approved for payment/action`;
  const htmlBody = emailShell_(
    'Overtime approved for payment/action',
    `<p>This overtime request has completed final approval.</p>` +
      summaryTable_(request, true)
  );

  sendEmail_(recipients, subject, htmlBody);
}

function sendDeniedEmail_(request, stage, stepName, comment, actorEmail) {
  const isOvertime = isOvertimeRequest_(request);
  const processName = processNameForEmail_(request);
  const subject = `${request.requestId}: ${isOvertime ? 'overtime' : processName.toLowerCase()} request denied`;
  const stageLabel = stage === 'final' ? 'final approval' : (isOvertime ? 'pre-approval' : 'approval');
  const htmlBody = emailShell_(
    `${processName} request denied`,
    `<p>Your ${isOvertime ? 'overtime' : processName} request was denied during ${escapeHtml_(stageLabel)} by ${escapeHtml_(stepName)}.</p>` +
      (comment ? `<p><strong>Reason:</strong> ${escapeHtml_(comment)}</p>` : '') +
      summaryTable_(request, stage === 'final')
  );

  sendEmail_(request.employeeEmail, subject, htmlBody);
  sendRelatedDeniedEmail_(request, stage, stepName, comment, actorEmail);
}

function sendRelatedDeniedEmail_(request, stage, stepName, comment, actorEmail) {
  const recipients = deniedRelatedRecipientEmails_(request, actorEmail);
  if (!recipients.length) {
    return;
  }

  const processName = processNameForEmail_(request);
  const isOvertime = isOvertimeRequest_(request);
  const stageLabel = stage === 'final' ? 'final approval' : (isOvertime ? 'pre-approval' : 'approval');
  const subject = `${request.requestId}: ${isOvertime ? 'overtime' : processName.toLowerCase()} request denied`;
  const htmlBody = emailShell_(
    `${processName} request denied`,
    `<p>This ${isOvertime ? 'overtime' : processName} request was denied during ${escapeHtml_(stageLabel)} by ${escapeHtml_(stepName)}.</p>` +
      (comment ? `<p><strong>Reason:</strong> ${escapeHtml_(comment)}</p>` : '') +
      summaryTable_(request, stage === 'final')
  );

  sendEmail_(recipients.join(','), subject, htmlBody);
}

function sendFeedbackEmail_(feedback) {
  const sender = normalizeEmail_(feedback && feedback.email);
  const message = trim_(feedback && feedback.message);
  const pageUrl = trim_(feedback && feedback.pageUrl);
  const submittedAt = feedback && feedback.submittedAt ? feedback.submittedAt : nowIso_();
  const recipient = APP_SETTINGS.FEEDBACK_EMAIL || 'support@ofg.nsw.edu.au';
  const subject = 'OFG Forms feedback';
  const rows = [
    ['Submitted', formatDateTimeForEmail_(submittedAt)],
    ['From', sender],
    ['Page', pageUrl]
  ].filter(function (row) {
    return row[1];
  });
  const htmlBody = emailShell_(
    'OFG Forms feedback',
    processSummaryTable_(rows) +
      '<p><strong>Feedback</strong></p>' +
      `<p>${escapeHtml_(message).replace(/\n/g, '<br>')}</p>`
  );

  sendEmail_(recipient, subject, htmlBody);
  return {
    recipient,
    subject
  };
}

function deniedRelatedRecipientEmails_(request, actorEmail) {
  const emails = [];
  emails.push(request.requesterEmail);
  emails.push(request.lineManagerEmail);

  parseJsonArray_(request.approvalHistory)
    .concat(parseJsonArray_(request.finalApprovalHistory))
    .forEach(function (entry) {
      emails.push(entry.approverEmail);
    });

  getNotificationRecipientsForRequest_(request.requestId).forEach(function (email) {
    emails.push(email);
  });

  return uniqueEmailRecipients_(emails, [request.employeeEmail, actorEmail]);
}

function getNotificationRecipientsForRequest_(requestId) {
  const recipients = [];
  getAllEvents_().forEach(function (eventRecord) {
    if (eventRecord.requestId !== requestId || ['APPROVAL_NOTIFICATION_SENT', 'FINAL_NOTIFICATION_SENT'].indexOf(eventRecord.event) === -1) {
      return;
    }
    const details = parseJsonObject_(eventRecord.detailsJson);
    [].concat(details.recipients || []).forEach(function (recipient) {
      recipients.push(recipient);
    });
  });
  return recipients;
}

function uniqueEmailRecipients_(emails, exclusions) {
  const excluded = {};
  (exclusions || []).forEach(function (email) {
    const normalized = normalizeEmail_(email);
    if (normalized) {
      excluded[normalized] = true;
    }
  });

  const seen = {};
  return (emails || []).map(normalizeEmail_).filter(function (email) {
    if (!email || excluded[email] || seen[email]) {
      return false;
    }
    seen[email] = true;
    return true;
  });
}

function sendEmail_(to, subject, htmlBody, cc) {
  const options = {
    to,
    subject,
    htmlBody,
    body: stripHtml_(htmlBody),
    name: APP_SETTINGS.MAIL_FROM_NAME
  };
  if (cc) {
    options.cc = cc;
  }
  MailApp.sendEmail(options);
}

function summaryTable_(request, includeActual) {
  if (!isOvertimeRequest_(request)) {
    return processSummaryTable_(vtrSummaryRows_(request));
  }

  const isWorkdayAdjustment = isWorkdayAdjustmentRequest_(request);
  const plannedTimeLabel = isWorkdayAdjustment ? 'Planned work hours' : 'Planned overtime';
  const plannedHoursLabel = isWorkdayAdjustment ? 'Overtime hours requested' : 'Planned hours';
  const rows = [
    ['Request ID', request.requestId],
    ['Submitted', formatDateTimeForEmail_(request.createdAt)],
    ['Employee', `${request.employeeName} <${request.employeeEmail}>`],
    ['Line manager', request.lineManagerEmail],
    ['Requesting staff member', request.requesterEmail || request.lineManagerEmail],
    ['Overtime date', formatDateForEmail_(request.overtimeDate)],
    ['Reason', request.reason],
    [plannedTimeLabel, `${request.plannedStartTime} to ${request.plannedFinishTime}`],
    [plannedHoursLabel, request.plannedHours],
    ['Compensation', request.compensationMethod]
  ];

  if (includeActual) {
    rows.push([isWorkdayAdjustment ? 'Actual work hours' : 'Actual time', `${request.actualStartTime} to ${request.actualFinishTime}`]);
    rows.push([isWorkdayAdjustment ? 'Actual overtime hours' : 'Actual hours', request.actualHours]);
    rows.push(['Meal allowance', request.mealAllowance]);
    if (request.workedAsApproved === 'No') {
      rows.push(['Variation reason', request.variationReason]);
    }
  }

  return processSummaryTable_(rows);
}

function processSummaryTable_(rows) {
  return `<table role="presentation" style="border-collapse:collapse;margin:18px 0;width:100%;max-width:760px;border:1px solid #ded7c7;">${rows.filter(function (row) {
    return row[1] !== undefined && row[1] !== null && row[1] !== '';
  }).map(function (row) {
    return `<tr><th style="text-align:left;border:1px solid #ded7c7;background:#f8f4e7;color:#021d49;padding:9px 11px;width:190px;font-weight:800;">${escapeHtml_(row[0])}</th><td style="border:1px solid #ded7c7;background:#ffffff;color:#162033;padding:9px 11px;">${escapeHtml_(row[1] || '')}</td></tr>`;
  }).join('')}</table>`;
}

function vtrSummaryRows_(request) {
  const rows = [
    ['Request ID', request.requestId],
    ['Submitted', formatDateTimeForEmail_(request.createdAt)],
    ['Organiser', `${request.employeeName} <${request.employeeEmail}>`],
    ['Event name', request.eventName],
    ['Event date(s)', vtrEventDateRangeForEmail_(request)],
    ['School area', request.schoolArea],
    ['Event type', request.eventType],
    ['Location', request.eventLocation],
    ['Event times', request.eventTimes],
    ['Students involved', request.studentsInvolved],
    ['Staff required', request.staffRequired],
    ['Risk assessment required', request.riskAssessmentRequired],
    ['Logistics notified', request.logisticsNotified],
    ['Cost to students', request.costToStudents],
    ['Offsite excursion', request.offsiteExcursion],
    ['Checklist last saved', formatDateTimeForEmail_(request.checklistSubmittedAt)],
    ['Checklist completed', formatDateTimeForEmail_(request.checklistCompletedAt)]
  ];

  if (request.changeComment) {
    rows.push(['Change request', request.changeComment]);
  }

  return rows;
}

function isOvertimeRequest_(request) {
  return processKeyForRequest_(request) === 'overtime';
}

function isWorkdayAdjustmentRequest_(request) {
  return trim_(request && request.compensationMethod).toLowerCase() === 'adjust workday hours (no payment required)';
}

function isVtrRequest_(request) {
  return processKeyForRequest_(request) === 'vtr';
}

function processNameForEmail_(request) {
  const process = getProcessDefinition_(request);
  return (process && process.name) || request.processName || request.processType || 'Request';
}

function requestPrimaryDate_(request) {
  if (isVtrRequest_(request)) {
    return vtrEventStartDate_(request);
  }
  return request.eventDate || request.overtimeDate || '';
}

function requestPrimaryDateLabel_(request) {
  if (isVtrRequest_(request)) {
    return vtrEventDateRangeForEmail_(request);
  }
  return formatDateForEmail_(requestPrimaryDate_(request));
}

function vtrEventStartDate_(request) {
  return request.eventStartDate || request.eventDate || '';
}

function vtrEventEndDate_(request) {
  return request.eventEndDate || request.eventDate || request.eventStartDate || '';
}

function vtrChecklistEditableUntilDate_(request) {
  const endDate = vtrEventEndDate_(request);
  return endDate ? addDaysKey_(endDate, 1) : '';
}

function vtrChecklistEditableUntilForEmail_(request) {
  return formatDateForEmail_(vtrChecklistEditableUntilDate_(request));
}

function vtrEventDateRangeForEmail_(request) {
  const start = vtrEventStartDate_(request);
  const end = vtrEventEndDate_(request);
  if (start && end && start !== end) {
    return `${formatDateForEmail_(start)} to ${formatDateForEmail_(end)}`;
  }
  return formatDateForEmail_(start || end);
}

function emailShell_(heading, bodyHtml) {
  return [
    '<div style="margin:0;padding:0;background:#f8f4e7;">',
    '<table role="presentation" style="border-collapse:collapse;width:100%;background:#f8f4e7;margin:0;padding:0;">',
    '<tr><td style="padding:24px 12px;">',
    '<table role="presentation" style="border-collapse:separate;border-spacing:0;width:100%;max-width:780px;margin:0 auto;background:#ffffff;border:1px solid #ded7c7;border-top:4px solid #021d49;border-radius:8px;overflow:hidden;">',
    '<tr><td style="background:#021d49;color:#ffffff;padding:18px 22px;border-bottom:4px solid #ce0e2d;">',
    `<div style="font:800 12px/1.4 Arial,sans-serif;letter-spacing:.04em;text-transform:uppercase;color:#eadfb5;margin:0 0 6px;">${escapeHtml_(APP_SETTINGS.ORGANISATION_NAME)}</div>`,
    `<h1 style="font:800 22px/1.25 Arial,sans-serif;color:#ffffff;margin:0;">${escapeHtml_(heading)}</h1>`,
    '</td></tr>',
    '<tr><td style="font:14px/1.55 Arial,sans-serif;color:#162033;padding:20px 22px;">',
    bodyHtml,
    '</td></tr>',
    '<tr><td style="background:#f8f4e7;border-top:1px solid #ded7c7;color:#626a76;font:12px/1.45 Arial,sans-serif;padding:13px 22px;">',
    `${escapeHtml_(APP_SETTINGS.APP_NAME)} | ${escapeHtml_(APP_SETTINGS.ORGANISATION_NAME)}`,
    '</td></tr>',
    '</table>',
    '</td></tr>',
    '</table>',
    '</div>'
  ].join('');
}

function buttonHtml_(url, label) {
  return `<p style="margin:22px 0;"><a href="${escapeHtml_(url)}" style="display:inline-block;background:#192a5e;color:#ffffff;text-decoration:none;padding:11px 16px;border-radius:6px;font-weight:800;border:1px solid #192a5e;">${escapeHtml_(label)}</a></p>`;
}

function workflowDecisionButtonsHtml_(webAppUrl, token, step) {
  const primaryDecision = workflowStepPrimaryDecision_(step);
  const buttons = [
    inlineButtonHtml_(workflowDecisionUrl_(webAppUrl, token, primaryDecision), workflowStepPrimaryLabel_(step), '#192a5e')
  ];

  if (workflowStepAllowsDecision_(step, 'deny')) {
    buttons.push(inlineButtonHtml_(workflowDecisionUrl_(webAppUrl, token, 'deny'), 'Deny', '#ce0e2d'));
  }

  return [
    '<div style="margin:22px 0 10px;">',
    buttons.join(''),
    '</div>',
    '<p style="margin:0 0 10px;color:#626a76;font-size:12px;">These email buttons record the decision immediately. Use the review link if you need to request changes or add a comment.</p>'
  ].join('');
}

function workflowDecisionUrl_(webAppUrl, token, decision) {
  return `${webAppUrl}?mode=decision&token=${encodeURIComponent(token)}&decision=${encodeURIComponent(decision)}`;
}

function inlineButtonHtml_(url, label, background) {
  return `<a href="${escapeHtml_(url)}" style="display:inline-block;background:${escapeHtml_(background)};color:#ffffff;text-decoration:none;padding:11px 16px;border-radius:6px;font-weight:800;border:1px solid ${escapeHtml_(background)};margin:0 8px 8px 0;">${escapeHtml_(label)}</a>`;
}

function secondaryLinkHtml_(url, label) {
  return `<p style="margin:10px 0 0;"><a href="${escapeHtml_(url)}" style="color:#ce0e2d;font-weight:800;">${escapeHtml_(label)}</a></p>`;
}

function formatDateForEmail_(dateKey) {
  if (!dateKey) {
    return '';
  }
  const parts = String(dateKey).split('-').map(Number);
  const date = new Date(parts[0], parts[1] - 1, parts[2]);
  return Utilities.formatDate(date, APP_SETTINGS.TIME_ZONE, 'd MMMM yyyy');
}

function formatDateTimeForEmail_(value) {
  if (!value) {
    return '';
  }
  const date = new Date(value);
  if (isNaN(date.getTime())) {
    return String(value);
  }
  return Utilities.formatDate(date, APP_SETTINGS.TIME_ZONE, 'd MMMM yyyy h:mm a');
}

function escapeHtml_(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function stripHtml_(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
