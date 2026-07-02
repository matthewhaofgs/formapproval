/**
 * Time-driven follow-up and reminder jobs.
 */

function sendDueActualHoursRequests() {
  ensureReady_();
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    return sendDueActualHoursRequestsInternal_();
  } finally {
    lock.releaseLock();
  }
}

function sendDueActualHoursRequestsInternal_() {
  const today = todayKey_();
  const records = getAllRequests_();
  let sent = 0;

  records.forEach(function (request) {
    if (request.status !== STATUS.PREAPPROVED) {
      return;
    }
    if (request.followUpSentAt) {
      return;
    }
    if (!request.followUpDueDate || request.followUpDueDate > today) {
      return;
    }
    if (!formStageMatchesConditions_(request, 'actual')) {
      return;
    }

    const token = createToken_();
    request.employeeActionTokenHash = hashToken_(token);
    request.status = STATUS.AWAITING_ACTUAL_HOURS;
    request.followUpSentAt = nowIso_();
    request.updatedAt = nowIso_();
    updateRequest_(request);
    const emailInfo = sendActualHoursRequestEmail_(request, token);
    logEvent_(request.requestId, 'system', 'ACTUAL_HOURS_EMAIL_SENT', {
      dueDate: request.followUpDueDate,
      webAppUrl: emailInfo.webAppUrl
    });
    sent += 1;
  });

  return {
    ok: true,
    sent,
    vtrChecklistsClosed: closeDueVtrChecklistsInternal_().closed || 0
  };
}

function installDailyFollowUpTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(function (trigger) {
      return trigger.getHandlerFunction() === 'sendDueActualHoursRequests';
    })
    .forEach(function (trigger) {
      ScriptApp.deleteTrigger(trigger);
    });

  ScriptApp.newTrigger('sendDueActualHoursRequests')
    .timeBased()
    .everyDays(1)
    .atHour(APP_SETTINGS.FOLLOW_UP_CHECK_HOUR)
    .inTimezone(APP_SETTINGS.TIME_ZONE)
    .create();
}

function installWeeklyReminderTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(function (trigger) {
      return trigger.getHandlerFunction() === 'sendWeeklyPendingReminders';
    })
    .forEach(function (trigger) {
      ScriptApp.deleteTrigger(trigger);
    });

  ScriptApp.newTrigger('sendWeeklyPendingReminders')
    .timeBased()
    .onWeekDay(weeklyReminderDay_())
    .atHour(APP_SETTINGS.WEEKLY_REMINDER_CHECK_HOUR)
    .inTimezone(APP_SETTINGS.TIME_ZONE)
    .create();
}

function sendWeeklyPendingReminders() {
  ensureReady_();
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    const dueActualHours = sendDueActualHoursRequestsInternal_();
    const reminders = sendWeeklyPendingRemindersInternal_();
    return {
      ok: true,
      initialActualHoursSent: dueActualHours.sent || 0,
      vtrChecklistsClosed: dueActualHours.vtrChecklistsClosed || 0,
      workflowRemindersSent: reminders.workflowRemindersSent,
      actualHoursRemindersSent: reminders.actualHoursRemindersSent,
      vtrChecklistRemindersSent: reminders.vtrChecklistRemindersSent,
      sent: (dueActualHours.sent || 0) +
        reminders.workflowRemindersSent +
        reminders.actualHoursRemindersSent +
        reminders.vtrChecklistRemindersSent
    };
  } finally {
    lock.releaseLock();
  }
}

function sendWeeklyPendingRemindersInternal_() {
  const today = todayKey_();
  const records = getAllRequests_();
  let workflowRemindersSent = 0;
  let actualHoursRemindersSent = 0;
  let vtrChecklistRemindersSent = 0;

  records.forEach(function (request) {
    if (request.activeApprovalStage && request.activeApprovalStepEmail && isPendingStatus_(request.status)) {
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
      logEvent_(request.requestId, 'system', 'WEEKLY_WORKFLOW_ACTION_REMINDER_SENT', {
        actionOwnerEmail: request.activeApprovalStepEmail,
        stage: request.activeApprovalStage,
        stepType: activeStep ? activeStep.type : 'approval'
      });
      workflowRemindersSent += 1;
      return;
    }

    if (request.status !== STATUS.AWAITING_ACTUAL_HOURS) {
      if (request.status !== STATUS.AWAITING_VTR_CHECKLIST) {
        return;
      }
      if (dateKeyFromIso_(request.followUpSentAt) === today) {
        return;
      }
      if (request.checklistCompletedAt) {
        return;
      }

      const token = createToken_();
      request.employeeActionTokenHash = hashToken_(token);
      request.followUpSentAt = nowIso_();
      request.updatedAt = nowIso_();
      updateRequest_(request);
      const emailInfo = sendVtrChecklistRequestEmail_(request, token, true);
      logEvent_(request.requestId, 'system', 'WEEKLY_VTR_CHECKLIST_REMINDER_SENT', {
        employeeEmail: request.employeeEmail,
        webAppUrl: emailInfo.webAppUrl
      });
      vtrChecklistRemindersSent += 1;
      return;
    }
    if (dateKeyFromIso_(request.followUpSentAt) === today) {
      return;
    }

    const token = createToken_();
    request.employeeActionTokenHash = hashToken_(token);
    request.followUpSentAt = nowIso_();
    request.updatedAt = nowIso_();
    updateRequest_(request);
    const emailInfo = sendActualHoursRequestEmail_(request, token, true);
    logEvent_(request.requestId, 'system', 'WEEKLY_ACTUAL_HOURS_REMINDER_SENT', {
      employeeEmail: request.employeeEmail,
      webAppUrl: emailInfo.webAppUrl
    });
    actualHoursRemindersSent += 1;
  });

  return {
    workflowRemindersSent,
    actualHoursRemindersSent,
    vtrChecklistRemindersSent
  };
}

function weeklyReminderDay_() {
  const day = String(APP_SETTINGS.WEEKLY_REMINDER_DAY || 'MONDAY').toUpperCase();
  const days = {
    SUNDAY: ScriptApp.WeekDay.SUNDAY,
    MONDAY: ScriptApp.WeekDay.MONDAY,
    TUESDAY: ScriptApp.WeekDay.TUESDAY,
    WEDNESDAY: ScriptApp.WeekDay.WEDNESDAY,
    THURSDAY: ScriptApp.WeekDay.THURSDAY,
    FRIDAY: ScriptApp.WeekDay.FRIDAY,
    SATURDAY: ScriptApp.WeekDay.SATURDAY
  };
  if (!days[day]) {
    throw new Error(`APP_SETTINGS.WEEKLY_REMINDER_DAY must be one of ${Object.keys(days).join(', ')}.`);
  }
  return days[day];
}
