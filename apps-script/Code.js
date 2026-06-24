/**
 * Apps Script web app entry points.
 */

function setup() {
  const ss = getDatabase_();
  ensureReady_({ protectConfig: true });
  installDailyFollowUpTrigger();
  installWeeklyReminderTrigger();
  let webAppUrl = '';
  try {
    webAppUrl = getWebAppUrl_();
  } catch (err) {
    webAppUrl = 'Deploy this project as a web app to generate the URL.';
  }
  return {
    ok: true,
    spreadsheetUrl: ss.getUrl(),
    webAppUrl
  };
}

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('OFG Workflow Approvals')
    .addItem('Setup / repair sheets and triggers', 'setup')
    .addItem('Send due actual-hours follow-ups now', 'sendDueActualHoursRequests')
    .addItem('Send weekly pending reminders now', 'sendWeeklyPendingReminders')
    .addToUi();
}

function doGet(e) {
  ensureReady_();
  const params = e && e.parameter ? e.parameter : {};
  const template = HtmlService.createTemplateFromFile('Index');
  template.stateJson = jsonForTemplate_(getInitialState_(params));
  template.appName = APP_SETTINGS.APP_NAME;
  template.webAppUrl = getWebAppUrl_();
  return template
    .evaluate()
    .setTitle(APP_SETTINGS.APP_NAME)
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}
