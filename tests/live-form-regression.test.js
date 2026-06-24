const assert = require('node:assert/strict');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const tls = require('node:tls');
const test = require('node:test');
const { chromium } = require('playwright');

loadEnvFile('/etc/formapproval/formapproval.env');

const RUN_LIVE = process.env.LIVE_FORM_TESTS === '1';
const BASE_URL = (process.env.LIVE_FORM_URL || 'http://localhost:3000').replace(/\/$/, '');
const SHOULD_SUBMIT = process.env.LIVE_FORM_SUBMIT === '1';
const LIVE_FORM_SESSION_COOKIE = process.env.LIVE_FORM_SESSION_COOKIE || '';
const ADJUST_WORKDAY = 'Adjust workday hours (no payment required)';
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const REGRESSION_TEST_SECRET = process.env.REGRESSION_TEST_SECRET || '';

let browser;

test.before(async () => {
  if (!RUN_LIVE) {
    return;
  }
  browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox']
  });
});

test.after(async () => {
  if (browser) {
    await browser.close();
  }
});

function liveTest(name, optionsOrFn, maybeFn) {
  const options = typeof optionsOrFn === 'function' ? {} : optionsOrFn;
  const fn = typeof optionsOrFn === 'function' ? optionsOrFn : maybeFn;
  test(name, Object.assign({ skip: RUN_LIVE ? false : 'Set LIVE_FORM_TESTS=1 to run against the public form.' }, options), fn);
}

async function newPage(options = {}) {
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  if (options.authenticated !== false && LIVE_FORM_SESSION_COOKIE) {
    const url = new URL(BASE_URL);
    await context.addCookies([{
      name: 'formapproval_session',
      value: LIVE_FORM_SESSION_COOKIE,
      domain: url.hostname,
      path: '/',
      httpOnly: true,
      secure: url.protocol === 'https:',
      sameSite: 'Lax'
    }]);
  }
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error));
  page.on('console', message => {
    if (message.type() === 'error') {
      pageErrors.push(new Error(message.text()));
    }
  });
  page.assertNoPageErrors = () => {
    assert.deepEqual(pageErrors.map(error => error.message), []);
  };
  return page;
}

function authRequiredSkip() {
  return RUN_LIVE && LIVE_FORM_SESSION_COOKIE
    ? false
    : 'Set LIVE_FORM_TESTS=1 and LIVE_FORM_SESSION_COOKIE to run authenticated live form checks.';
}

async function expectOauthRedirect(page, targetUrl) {
  await page.goto(targetUrl, {
    waitUntil: 'domcontentloaded',
    timeout: 30000
  });
  await page.waitForURL(url =>
    url.href.startsWith(`${BASE_URL}/auth/login`) || url.hostname === 'accounts.google.com',
    { timeout: 20000 }
  );
  const currentUrl = page.url();
  assert.ok(
    currentUrl.startsWith(`${BASE_URL}/auth/login`) || currentUrl.includes('accounts.google.com'),
    `Expected OAuth redirect, got ${currentUrl}`
  );
}

async function expectSignInSplash(page, targetUrl) {
  await page.goto(targetUrl, {
    waitUntil: 'domcontentloaded',
    timeout: 30000
  });
  const signIn = page.locator('a.button.primary[href^="/auth/login"]').first();
  await signIn.waitFor({ timeout: 20000 });
  await expectPageText(page, /Sign in with Google/i);
  const href = await signIn.getAttribute('href');
  assert.ok(href && href.includes('next='), `Expected sign-in link to preserve next target, got ${href}`);
}

async function expectPageText(page, pattern) {
  const text = await page.locator('body').innerText({ timeout: 20000 });
  assert.match(text, pattern);
}

async function gotoForm(page, processKey) {
  await page.goto(`${BASE_URL}/?process=${processKey}`, {
    waitUntil: 'domcontentloaded',
    timeout: 30000
  });
  await page.waitForSelector('#request-form', { timeout: 20000 });
}

function byName(page, name) {
  return page.locator(`[name="${name}"]`).first();
}

async function setField(page, name, value) {
  await byName(page, name).evaluate((input, nextValue) => {
    input.value = nextValue;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}

async function chooseRadio(page, name, value) {
  await page.locator(`input[name="${name}"][value="${value}"]`).first().check({ force: true });
}

async function chooseChecklist(page, name, value = 'Yes') {
  await chooseRadio(page, name, value);
}

async function selectField(page, name, value) {
  await byName(page, name).selectOption(value);
}

async function isVisible(page, selector) {
  const locator = page.locator(selector).first();
  if (await locator.count() === 0) {
    return false;
  }
  return locator.evaluate(element => {
    const box = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  });
}

async function fieldIsVisible(page, name) {
  return isVisible(page, `[name="${name}"]`);
}

async function formValidity(page) {
  return page.locator('#request-form').evaluate(form => ({
    valid: form.checkValidity(),
    invalidNames: Array.from(form.elements)
      .filter(element => element.willValidate && !element.checkValidity())
      .map(element => element.name || element.id || element.tagName)
  }));
}

async function fillRealisticOvertimeRequest(page, overrides = {}) {
  const recipient = overrides.recipient || 'line.manager@example.test';
  await setField(page, 'employeeName', 'Regression Test Staff');
  await setField(page, 'employeeEmail', 'regression.staff@example.test');
  await setField(page, 'lineManagerEmail', recipient);
  await chooseRadio(page, 'isLineManagerRequester', 'No');
  await setField(page, 'requesterEmail', recipient);
  await setField(page, 'reason', 'Coverage for a realistic live regression test of the overtime form.');
  await setField(page, 'overtimeDate', '2026-07-15');
  await chooseRadio(page, 'normallyWorks', 'Yes');
  await setField(page, 'normalStartTime', '08:00');
  await setField(page, 'normalFinishTime', '16:00');
  await chooseRadio(page, 'compensationMethod', 'Payment at Casual/Overtime Rates');
  await setField(page, 'plannedStartTime', '16:00');
  await setField(page, 'plannedFinishTime', '18:30');
  await setField(page, 'plannedHours', '2.5');
  await byName(page, 'mealRulesAcknowledged').check({ force: true });
}

async function addRegressionHiddenFields(page, runId, alias) {
  await page.locator('#request-form').evaluate((form, values) => {
    Object.entries(values).forEach(([name, value]) => {
      let input = form.querySelector(`input[name="${name}"]`);
      if (!input) {
        input = document.createElement('input');
        input.type = 'hidden';
        input.name = name;
        form.appendChild(input);
      }
      input.value = value;
    });
  }, {
    __regressionTestRunId: runId,
    __regressionEmailAlias: alias,
    __regressionTestSecret: REGRESSION_TEST_SECRET
  });
}

function loadEnvFile(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    content.split(/\r?\n/).forEach(line => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) {
        return;
      }
      const index = trimmed.indexOf('=');
      const key = trimmed.slice(0, index).trim();
      let value = trimmed.slice(index + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (key && process.env[key] === undefined) {
        process.env[key] = value;
      }
    });
  } catch (err) {
    // Non-server environments can still run the non-submit live checks.
  }
}

function regressionAlias(runId) {
  const match = String(SMTP_USER).toLowerCase().match(/^([^@]+)@(.+)$/);
  assert.ok(match, 'SMTP_USER must be available for live email regression tests.');
  return `${match[1].replace(/\+.*/, '')}+${runId}@${match[2]}`;
}

function sqlLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function runPsql(sql) {
  assert.ok(process.env.DATABASE_URL, 'DATABASE_URL must be available for live cleanup checks.');
  const result = spawnSync('psql', ['-X', '-q', '-tAc', sql, process.env.DATABASE_URL], {
    encoding: 'utf8',
    env: process.env
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || 'psql failed');
  }
  return result.stdout.trim();
}

async function poll(fn, timeoutMs, intervalMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await fn();
      if (result) {
        return result;
      }
    } catch (err) {
      lastError = err;
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  if (lastError) {
    throw lastError;
  }
  throw new Error(`Timed out after ${timeoutMs}ms`);
}

async function waitForDeliveredEmailRows(requestId) {
  return poll(() => {
    const json = runPsql(`
      SELECT coalesce(json_agg(json_build_object(
        'to', to_email,
        'subject', subject,
        'mode', provider_result->>'mode',
        'accepted', provider_result->'accepted'
      ) ORDER BY id), '[]'::json)
      FROM outbound_emails
      WHERE subject LIKE ${sqlLiteral(`${requestId}:%`)};
    `);
    const rows = JSON.parse(json || '[]');
    if (
      rows.length >= 2 &&
      rows.every(row => row.mode === 'smtp') &&
      rows.some(row => /pre-approval needed/i.test(row.subject)) &&
      rows.some(row => /request received/i.test(row.subject))
    ) {
      return rows;
    }
    return null;
  }, 60000, 1500);
}

function imapCommand(socket, tag, command) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const onData = chunk => {
      buffer += chunk.toString('utf8');
      if (new RegExp(`${tag} (OK|NO|BAD)`).test(buffer)) {
        socket.off('data', onData);
        resolve(buffer);
      }
    };
    socket.on('data', onData);
    socket.write(`${tag} ${command}\r\n`);
    socket.setTimeout(20000, () => {
      socket.off('data', onData);
      reject(new Error(`IMAP command timed out: ${command}`));
    });
  });
}

async function imapConnect() {
  assert.ok(SMTP_USER && SMTP_PASS, 'SMTP_USER and SMTP_PASS must be available for inbox regression tests.');
  const socket = tls.connect(993, 'imap.gmail.com', { servername: 'imap.gmail.com' });
  await new Promise((resolve, reject) => {
    let greeting = '';
    socket.setTimeout(20000, () => reject(new Error('IMAP greeting timed out')));
    socket.once('error', reject);
    socket.on('data', chunk => {
      greeting += chunk.toString('utf8');
      if (/^\* OK/m.test(greeting)) {
        socket.off('error', reject);
        resolve();
      }
    });
  });
  const escapedUser = SMTP_USER.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const escapedPass = SMTP_PASS.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const login = await imapCommand(socket, 'a1', `LOGIN "${escapedUser}" "${escapedPass}"`);
  assert.match(login, /a1 OK/i);
  const select = await imapCommand(socket, 'a2', 'SELECT INBOX');
  assert.match(select, /a2 OK/i);
  return socket;
}

async function imapSubjectExists(subject, alias) {
  const socket = await imapConnect();
  try {
    const escapedSubject = subject.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const escapedAlias = alias.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const search = await imapCommand(socket, 'a3', `UID SEARCH TO "${escapedAlias}" SUBJECT "${escapedSubject}"`);
    assert.match(search, /a3 OK/i);
    return /\* SEARCH\s+\d+/i.test(search);
  } finally {
    socket.end('a4 LOGOUT\r\n');
  }
}

async function waitForInboxMessages(requestId, alias) {
  const expectedSubjects = [
    `${requestId}: overtime pre-approval needed`,
    `${requestId}: overtime request received`
  ];
  return poll(async () => {
    const results = [];
    for (const subject of expectedSubjects) {
      results.push(await imapSubjectExists(subject, alias));
    }
    return results.every(Boolean) ? true : null;
  }, 90000, 5000);
}

function cleanupRegressionRun(runId, requestId) {
  if (!requestId) {
    return;
  }
  runPsql(`
    DELETE FROM outbound_emails WHERE subject LIKE ${sqlLiteral(`${requestId}:%`)};
    DELETE FROM app_events WHERE request_id = ${sqlLiteral(requestId)};
    DELETE FROM app_requests
    WHERE request_id = ${sqlLiteral(requestId)}
       OR data->>'_regressionTestRunId' = ${sqlLiteral(runId)};
  `);
}

async function fillRealisticVtrRequest(page) {
  await setField(page, 'employeeName', 'Regression Test Organiser');
  await setField(page, 'employeeEmail', 'regression.organiser@example.test');
  await setField(page, 'eventName', 'Year 8 Museum Learning Visit');
  await setField(page, 'eventDate', '2026-08-12');
  await selectField(page, 'schoolArea', 'Senior School');
  await selectField(page, 'eventType', 'Curricular Event');
  await setField(page, 'eventLocation', 'Australian Museum, Sydney');
  await setField(page, 'eventStartTime', '09:15');
  await setField(page, 'eventFinishTime', '14:45');
  await setField(page, 'studentsInvolved', 'Year 8 History students, approximately 42 students.');
  await setField(page, 'staffRequired', 'Two teaching staff and one support staff member.');
  await chooseChecklist(page, 'logisticsNotified', 'Yes');
  await chooseRadio(page, 'riskAssessmentRequired', 'Yes');
  await chooseRadio(page, 'offsiteExcursion', 'Yes');
  await chooseChecklist(page, 'attendingStaffBriefed', 'Yes');
  await chooseChecklist(page, 'medicalNeedsCompiled', 'Yes');
  await chooseChecklist(page, 'lessonPlansLeft', 'Yes');
  await chooseChecklist(page, 'rollsMarkedReceptionNotified', 'Yes');
}

liveTest('site pages are protected by OAuth', async () => {
  const page = await newPage({ authenticated: false });
  await expectSignInSplash(page, BASE_URL);
  await page.close();

  const directFormPage = await newPage({ authenticated: false });
  await expectSignInSplash(directFormPage, `${BASE_URL}/?process=overtime`);
  await directFormPage.close();

  const faviconPage = await newPage({ authenticated: false });
  const iconResponse = await faviconPage.goto(`${BASE_URL}/favicon.ico`, {
    waitUntil: 'domcontentloaded',
    timeout: 30000
  });
  assert.equal(iconResponse.ok(), true);
  await faviconPage.close();
});

liveTest('overtime form supports realistic entry, conditional requester fields, and validation', {
  skip: authRequiredSkip()
}, async () => {
  const page = await newPage();
  await gotoForm(page, 'overtime');

  assert.equal(await byName(page, 'processType').inputValue(), 'overtime');
  assert.equal(await fieldIsVisible(page, 'requesterEmail'), false);

  await chooseRadio(page, 'isLineManagerRequester', 'No');
  assert.equal(await fieldIsVisible(page, 'requesterEmail'), true);

  let validity = await formValidity(page);
  assert.equal(validity.valid, false);
  assert.ok(validity.invalidNames.includes('employeeName'));
  assert.ok(validity.invalidNames.includes('requesterEmail'));

  await chooseRadio(page, 'normallyWorks', 'No');
  assert.equal(await fieldIsVisible(page, 'normalStartTime'), false);
  assert.equal(await fieldIsVisible(page, 'normalFinishTime'), false);
  const visibleCompensationOptions = await page.locator('input[name="compensationMethod"]:not(:disabled)').evaluateAll(inputs =>
    inputs.map(input => input.value)
  );
  assert.deepEqual(visibleCompensationOptions, [
    'Payment at Casual/Overtime Rates',
    'Accumulate for later Time Off in Lieu (TOIL)'
  ]);

  await chooseRadio(page, 'normallyWorks', 'Yes');
  assert.equal(await fieldIsVisible(page, 'normalStartTime'), true);
  assert.equal(await fieldIsVisible(page, 'normalFinishTime'), true);
  await chooseRadio(page, 'compensationMethod', ADJUST_WORKDAY);
  assert.equal(await fieldIsVisible(page, 'plannedHours'), false);
  assert.equal(await fieldIsVisible(page, 'mealRulesAcknowledged'), false);

  await fillRealisticOvertimeRequest(page);
  validity = await formValidity(page);
  assert.deepEqual(validity, { valid: true, invalidNames: [] });
  page.assertNoPageErrors();
  await page.close();
});

liveTest('VTR form supports realistic offsite excursion entry and checklist validation', {
  skip: authRequiredSkip()
}, async () => {
  const page = await newPage();
  await gotoForm(page, 'vtr');

  assert.equal(await byName(page, 'processType').inputValue(), 'vtr');
  assert.equal(await fieldIsVisible(page, 'attendingStaffBriefed'), false);

  let validity = await formValidity(page);
  assert.equal(validity.valid, false);
  assert.ok(validity.invalidNames.includes('employeeName'));
  assert.ok(validity.invalidNames.includes('eventName'));

  await chooseRadio(page, 'offsiteExcursion', 'Yes');
  assert.equal(await fieldIsVisible(page, 'attendingStaffBriefed'), true);
  assert.equal(await fieldIsVisible(page, 'medicalNeedsCompiled'), true);
  assert.equal(await fieldIsVisible(page, 'lessonPlansLeft'), true);
  assert.equal(await fieldIsVisible(page, 'rollsMarkedReceptionNotified'), true);

  await fillRealisticVtrRequest(page);
  validity = await formValidity(page);
  assert.deepEqual(validity, { valid: true, invalidNames: [] });
  page.assertNoPageErrors();
  await page.close();
});

liveTest('admin dashboard route is protected by OAuth', async () => {
  const page = await newPage({ authenticated: false });
  await expectOauthRedirect(page, `${BASE_URL}/?mode=dashboard&role=admin`);
  await page.close();
});

liveTest('optional overtime submit sends and receives email through the SMTP inbox', {
  skip: RUN_LIVE && SHOULD_SUBMIT && LIVE_FORM_SESSION_COOKIE && SMTP_USER && SMTP_PASS && REGRESSION_TEST_SECRET
    ? false
    : 'Set LIVE_FORM_TESTS=1 LIVE_FORM_SUBMIT=1 LIVE_FORM_SESSION_COOKIE and configure SMTP_USER/SMTP_PASS/REGRESSION_TEST_SECRET to send and receive mail.'
}, async () => {
  const runId = `codex-${Date.now().toString(36)}`;
  const alias = regressionAlias(runId);
  let requestId = '';
  const page = await newPage();
  try {
    await gotoForm(page, 'overtime');
    await fillRealisticOvertimeRequest(page, { recipient: alias });
    await addRegressionHiddenFields(page, runId, alias);

    const [response] = await Promise.all([
      page.waitForResponse(candidate =>
        candidate.url().includes('/api/submitRequest') && candidate.request().method() === 'POST',
        { timeout: 30000 }
      ),
      page.locator('#request-form button[type="submit"]').click()
    ]);
    const responseBody = await response.json();
    assert.equal(response.ok(), true);
    assert.equal(responseBody.ok, true);
    requestId = responseBody.requestId;
    assert.match(requestId, /^OT-/);

    const bodyText = await page.locator('body').innerText({ timeout: 30000 });
    assert.match(bodyText, /submitted|received|request/i);
    page.assertNoPageErrors();

    const emailRows = await waitForDeliveredEmailRows(requestId);
    assert.equal(emailRows.every(row => row.to === alias), true);
    await waitForInboxMessages(requestId, alias);
  } finally {
    await page.close();
    cleanupRegressionRun(runId, requestId);
  }
});
