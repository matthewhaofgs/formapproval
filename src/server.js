const express = require('express');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createNativeRuntime } = require('./nativeRuntime');
const { buildAdminAuditWorkbook } = require('./xlsxExport');

loadEnv('/etc/formapproval/formapproval.env');

const ROOT_DIR = path.resolve(__dirname, '..');
const APPS_SCRIPT_DIR = path.join(ROOT_DIR, 'apps-script');
const PORT = Number(process.env.PORT || 3000);
const APP_BASE_URL = process.env.APP_BASE_URL || 'http://localhost:3000';
const OAUTH_REDIRECT_URI = process.env.OAUTH_REDIRECT_URI || `${APP_BASE_URL}/auth/callback`;
const OAUTH_ALLOWED_DOMAIN = String(process.env.OAUTH_ALLOWED_DOMAIN || '').trim().toLowerCase();
const OAUTH_SESSION_MAX_AGE_SECONDS = Number(process.env.OAUTH_SESSION_MAX_AGE_SECONDS || 28800);
const OFG_FAVICON_32 = 'https://ofg.nsw.edu.au/wp-content/uploads/2020/10/cropped-Navy-Crest-Full-School-Name-1-32x32.png';
const OFG_FAVICON_192 = 'https://ofg.nsw.edu.au/wp-content/uploads/2020/10/cropped-Navy-Crest-Full-School-Name-1-192x192.png';
const OFG_APPLE_TOUCH_ICON = 'https://ofg.nsw.edu.au/wp-content/uploads/2020/10/cropped-Navy-Crest-Full-School-Name-1-180x180.png';
const OFG_TILE_IMAGE = 'https://ofg.nsw.edu.au/wp-content/uploads/2020/10/cropped-Navy-Crest-Full-School-Name-1-270x270.png';
const OFG_CREST = 'https://ofg.nsw.edu.au/wp-content/uploads/2020/12/OFG_Crest-With-Border-01.svg';

const runtime = createNativeRuntime({ webAppUrl: APP_BASE_URL });

const API_METHODS = new Set([
  'submitRequest',
  'submitApprovalDecision',
  'submitDashboardApprovalDecision',
  'requesterCancelRequest',
  'adminCancelRequest',
  'submitActualHours',
  'submitVtrChecklist',
  'submitEditedRequest',
  'sendDueActualHoursRequests',
  'sendWeeklyPendingReminders',
  'getDashboardData',
  'getAdminUserManagementData',
  'updateAdminUserSettings',
  'getAdminWorkflowManagementData',
  'updateAdminWorkflowSettings',
  'adminReassignRequest',
  'adminSendReminder',
  'getDatabaseDiagnostic'
]);

async function main() {
  await runtime.init();

  const app = express();
  app.set('trust proxy', true);
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: true }));
  app.use(loadAuthSession);

  app.get('/healthz', (req, res) => {
    res.type('text/plain').send('ok\n');
  });

  app.get('/favicon.ico', (req, res) => {
    res.redirect(302, OFG_FAVICON_32);
  });

  app.get('/auth/login', (req, res) => {
    if (!oauthConfigured()) {
      res.status(503).type('text/plain').send('OAuth is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.\n');
      return;
    }

    const state = crypto.randomBytes(24).toString('base64url');
    const target = safeLocalTarget(req.query.next || req.get('referer') || '/');
    setCookie(res, 'oauth_state', signCookie(JSON.stringify({ state, target })), {
      maxAge: 600,
      httpOnly: true,
      sameSite: 'Lax',
      secure: true
    });

    const params = new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      redirect_uri: OAUTH_REDIRECT_URI,
      response_type: 'code',
      scope: 'openid email profile',
      access_type: 'offline',
      prompt: 'select_account',
      state
    });
    if (OAUTH_ALLOWED_DOMAIN) {
      params.set('hd', OAUTH_ALLOWED_DOMAIN);
    }
    res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
  });

  app.get('/auth/callback', async (req, res) => {
    try {
      if (!oauthConfigured()) {
        throw new Error('OAuth is not configured.');
      }
      const statePayload = verifyCookie(req.cookies.oauth_state || '');
      clearCookie(res, 'oauth_state');
      if (!statePayload || statePayload.state !== req.query.state) {
        throw new Error('OAuth state did not match. Please try signing in again.');
      }
      if (!req.query.code) {
        throw new Error('OAuth callback did not include an authorization code.');
      }

      const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code: String(req.query.code),
          client_id: process.env.GOOGLE_CLIENT_ID,
          client_secret: process.env.GOOGLE_CLIENT_SECRET,
          redirect_uri: OAUTH_REDIRECT_URI,
          grant_type: 'authorization_code'
        })
      });
      const tokenBody = await tokenResponse.json();
      if (!tokenResponse.ok) {
        throw new Error(tokenBody.error_description || tokenBody.error || 'OAuth token exchange failed.');
      }

      const userResponse = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
        headers: { Authorization: `Bearer ${tokenBody.access_token}` }
      });
      const user = await userResponse.json();
      if (!userResponse.ok) {
        throw new Error(user.error_description || user.error || 'OAuth userinfo lookup failed.');
      }

      const email = String(user.email || '').toLowerCase();
      if (!email || user.email_verified === false) {
        throw new Error('Google account email was not verified.');
      }
      if (OAUTH_ALLOWED_DOMAIN && !email.endsWith(`@${OAUTH_ALLOWED_DOMAIN}`)) {
        throw new Error(`Only ${OAUTH_ALLOWED_DOMAIN} accounts can sign in.`);
      }

      setCookie(res, 'formapproval_session', signCookie(JSON.stringify({
        email,
        name: user.name || '',
        picture: user.picture || '',
        exp: Math.floor(Date.now() / 1000) + OAUTH_SESSION_MAX_AGE_SECONDS
      })), {
        maxAge: OAUTH_SESSION_MAX_AGE_SECONDS,
        httpOnly: true,
        sameSite: 'Lax',
        secure: true
      });

      res.redirect(safeLocalTarget(statePayload.target || '/'));
    } catch (err) {
      console.error(err);
      res.status(400).type('html').send(renderIndex({
        mode: 'error',
        title: 'Sign-in failed',
        message: err.message || String(err)
      }, null));
    }
  });

  app.get('/auth/logout', (req, res) => {
    clearCookie(res, 'formapproval_session');
    res.redirect('/');
  });

  app.use(requireOAuthSession);

  app.post('/api/:method', (req, res) => {
    const method = req.params.method;
    if (!API_METHODS.has(method)) {
      res.status(404).json({ ok: false, error: `Unknown API method: ${method}` });
      return;
    }
    try {
      const actorEmail = requestEmail(req, req.body || {});
      const result = runtime.call(method, req.body || {}, actorEmail);
      res.json(result === undefined ? { ok: true } : result);
    } catch (err) {
      console.error(err);
      res.status(400).json({ ok: false, error: err.message || String(err) });
    }
  });

  app.get('/admin/export/:processKey.xlsx', (req, res) => {
    try {
      const actorEmail = requestEmail(req, req.query || {});
      const processKey = String(req.params.processKey || '').trim().toLowerCase();
      if (!processKey) {
        throw new Error('Process is required.');
      }
      const dashboard = runtime.call('getDashboardData', {
        role: 'admin',
        email: actorEmail,
        process: processKey
      }, actorEmail);
      const exportData = loadAdminAuditExportData(dashboard.selectedProcess || processKey);
      const workbook = buildAdminAuditWorkbook(exportData, {
        actorEmail,
        processKey: dashboard.selectedProcess || processKey,
        processName: dashboard.selectedProcessName || processKey
      });
      const filename = `${safeDownloadFileName(dashboard.selectedProcessName || processKey)}-${todayKey()}-audit-export.xlsx`;
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', contentDispositionAttachment(filename));
      res.setHeader('Cache-Control', 'no-store');
      res.send(workbook);
    } catch (err) {
      console.error(err);
      res.status(400).type('text/plain').send(`${err.message || String(err)}\n`);
    }
  });

  app.use((req, res) => {
    try {
      const actorEmail = requestEmail(req, req.query || {});
      const state = runtime.initialState(req.query || {}, actorEmail);
      res.type('html').send(renderIndex(state, req.auth));
    } catch (err) {
      console.error(err);
      res.status(500).type('html').send(renderIndex({
        mode: 'error',
        title: 'Server error',
        message: err.message || String(err)
      }));
    }
  });

  app.listen(PORT, '127.0.0.1', () => {
    console.log(`formapproval server listening on 127.0.0.1:${PORT}`);
  });
}

function renderIndex(state, auth) {
  const appName = state.appName || runtime.api.APP_SETTINGS.APP_NAME || 'OFG Forms';
  const authLink = auth && auth.email
    ? `<a href="/auth/logout">Sign out</a>`
    : (oauthConfigured() ? `<a href="/auth/login?next=${encodeURIComponent('/')}">Sign in</a>` : '');
  const styles = fs.readFileSync(path.join(APPS_SCRIPT_DIR, 'Styles.html'), 'utf8');
  const clientScript = transformClientScript(fs.readFileSync(path.join(APPS_SCRIPT_DIR, 'JavaScript.html'), 'utf8'));
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(appName)}</title>
    <link rel="icon" href="${OFG_FAVICON_32}" sizes="32x32">
    <link rel="icon" href="${OFG_FAVICON_192}" sizes="192x192">
    <link rel="apple-touch-icon" href="${OFG_APPLE_TOUCH_ICON}">
    <meta name="msapplication-TileImage" content="${OFG_TILE_IMAGE}">
    ${styles}
  </head>
  <body>
    <main class="shell">
      <header class="topbar">
        <div class="brand-lockup">
          <img class="brand-mark" src="${OFG_CREST}" alt="Oxford Falls Grammar">
          <div>
            <p class="eyebrow">Oxford Falls Grammar</p>
            <h1>${escapeHtml(appName)}</h1>
          </div>
        </div>
        ${renderTopNav(state, authLink)}
      </header>
      <div id="global-progress" class="global-progress" role="status" aria-live="polite" aria-hidden="true" hidden>
        <div class="progress-card">
          <span class="progress-track"><span class="progress-bar"></span></span>
          <strong data-progress-label>Loading...</strong>
          <span class="progress-help" data-progress-help></span>
        </div>
      </div>
      <div id="notice" class="notice" hidden></div>
      <section id="app" class="workspace" aria-live="polite"></section>
    </main>
    <script>
      window.INITIAL_STATE = ${JSON.stringify(state).replace(/</g, '\\u003c')};
      window.WEB_APP_URL = ${JSON.stringify(APP_BASE_URL)};
      window.API_BASE_URL = '/api';
    </script>
    ${clientScript}
  </body>
</html>`;
}

function renderSignInPage(req) {
  const appName = runtime.api.APP_SETTINGS.APP_NAME || 'OFG Forms';
  const target = safeLocalTarget(req.originalUrl || '/');
  const signInHref = `/auth/login?next=${encodeURIComponent(target)}`;
  const styles = fs.readFileSync(path.join(APPS_SCRIPT_DIR, 'Styles.html'), 'utf8');
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(appName)}</title>
    <link rel="icon" href="${OFG_FAVICON_32}" sizes="32x32">
    <link rel="icon" href="${OFG_FAVICON_192}" sizes="192x192">
    <link rel="apple-touch-icon" href="${OFG_APPLE_TOUCH_ICON}">
    <meta name="msapplication-TileImage" content="${OFG_TILE_IMAGE}">
    ${styles}
  </head>
  <body>
    <main class="shell">
      <header class="topbar sign-in-topbar">
        <div class="brand-lockup">
          <img class="brand-mark" src="${OFG_CREST}" alt="Oxford Falls Grammar">
          <div>
            <p class="eyebrow">Oxford Falls Grammar</p>
            <h1>${escapeHtml(appName)}</h1>
          </div>
        </div>
      </header>
      <section class="panel sign-in-panel">
        <div class="sign-in-copy">
          <h2>Sign in</h2>
          <p>Use your Google account to access OFG Forms.</p>
        </div>
        <div class="actions inline">
          <a class="button primary" href="${escapeHtml(signInHref)}">Sign in with Google</a>
        </div>
      </section>
    </main>
  </body>
</html>`;
}

function renderTopNav(state, authLink) {
  const links = [
    `<a href="${escapeHtml(APP_BASE_URL)}">New request</a>`,
    `<a href="${escapeHtml(APP_BASE_URL)}?mode=dashboard&role=requester" data-nav-role="requester">My Requests</a>`
  ];
  if (dashboardRoleAvailable(state, 'approver')) {
    links.push(`<a href="${escapeHtml(APP_BASE_URL)}?mode=dashboard&role=approver" data-nav-role="approver">Approver</a>`);
  }
  if (dashboardRoleAvailable(state, 'admin')) {
    links.push(`<a href="${escapeHtml(APP_BASE_URL)}?mode=dashboard&role=admin" data-nav-role="admin">Admin</a>`);
  }
  if (authLink) {
    links.push(authLink);
  }
  return `<nav class="topnav" aria-label="Primary">
          ${links.join('\n          ')}
        </nav>`;
}

function dashboardRoleAvailable(state, role) {
  if (role === 'requester') {
    return true;
  }
  if (!state || !state.roleAvailability) {
    return true;
  }
  return Boolean(state.roleAvailability[role]);
}

function transformClientScript(source) {
  return source.replace(
    /function runServer\(method, payload, timeoutMs\) \{[\s\S]*?\n  function beginServerProgress\(method, payload\) \{/,
    `${nativeRunServerSource()}\n\n  function beginServerProgress(method, payload) {`
  );
}

function nativeRunServerSource() {
  return `function runServer(method, payload, timeoutMs) {
    const body = Object.assign({}, payload || {});
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timeout = setTimeout(() => {
      if (controller) controller.abort();
    }, timeoutMs || 30000);
    return fetch((window.API_BASE_URL || '/api') + '/' + encodeURIComponent(method), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body),
      signal: controller ? controller.signal : undefined
    })
      .then(async response => {
        const text = await response.text();
        let data = {};
        try {
          data = text ? JSON.parse(text) : {};
        } catch (err) {
          throw new Error(text || 'Server returned an invalid response.');
        }
        if (!response.ok || data.ok === false) {
          throw new Error(data.error || data.message || 'Server request failed.');
        }
        return data;
      })
      .finally(() => clearTimeout(timeout));
  }`;
}

function loadAdminAuditExportData(processKey) {
  const processSql = sqlText(processKey);
  return psqlJson(`
    WITH selected_requests AS (
      SELECT request_id, process_type, created_at, updated_at, data
      FROM app_requests
      WHERE process_type = ${processSql}
    )
    SELECT jsonb_build_object(
      'generatedAt', now(),
      'processKey', ${processSql},
      'requests', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'requestId', request_id,
          'processType', process_type,
          'createdAt', created_at,
          'updatedAt', updated_at,
          'data', data
        ) ORDER BY updated_at DESC, request_id)
        FROM selected_requests
      ), '[]'::jsonb),
      'events', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'id', id,
          'timestamp', timestamp,
          'requestId', request_id,
          'actorEmail', actor_email,
          'event', event,
          'details', details
        ) ORDER BY timestamp, id)
        FROM app_events
        WHERE EXISTS (
          SELECT 1
          FROM selected_requests
          WHERE selected_requests.request_id = app_events.request_id
        )
      ), '[]'::jsonb),
      'outboundEmails', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'id', id,
          'createdAt', created_at,
          'toEmail', to_email,
          'ccEmail', cc_email,
          'subject', subject,
          'body', body,
          'htmlBody', html_body,
          'providerResult', provider_result
        ) ORDER BY created_at, id)
        FROM outbound_emails
        WHERE EXISTS (
          SELECT 1
          FROM selected_requests
          WHERE outbound_emails.subject LIKE selected_requests.request_id || ':%'
        )
      ), '[]'::jsonb),
      'definitions', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'category', category,
          'definitionKey', definition_key,
          'data', data,
          'enabled', enabled,
          'source', source,
          'createdAt', created_at,
          'updatedAt', updated_at
        ) ORDER BY category, definition_key)
        FROM app_definitions
        WHERE enabled = true
          AND (
            (category = 'process_definition' AND definition_key = ${processSql})
            OR (
              category = 'form_definition'
              AND (
                definition_key = ${processSql}
                OR definition_key = (
                  SELECT data->>'requestForm'
                  FROM app_definitions
                  WHERE category = 'process_definition'
                    AND definition_key = ${processSql}
                  LIMIT 1
                )
              )
            )
          )
      ), '[]'::jsonb)
    )::text;
  `);
}

function psqlJson(sql) {
  const result = spawnSync('psql', ['-X', '-q', '-tAc', sql, process.env.DATABASE_URL || ''], {
    encoding: 'utf8',
    env: process.env
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || 'psql failed.');
  }
  return JSON.parse(String(result.stdout || '{}').trim() || '{}');
}

function sqlText(value) {
  return dollarQuote(String(value === null || value === undefined ? '' : value));
}

function dollarQuote(value) {
  let tag = '$q$';
  while (value.includes(tag)) {
    tag = `$q${tag.length}$`;
  }
  return `${tag}${value}${tag}`;
}

function safeDownloadFileName(value) {
  return String(value || 'admin-export')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'admin-export';
}

function contentDispositionAttachment(filename) {
  return `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function requestEmail(req, payload) {
  return String(
    (req.auth && req.auth.email) ||
    req.get('x-user-email') ||
    req.get('x-forwarded-email') ||
    req.query.email ||
    (payload && payload.email) ||
    ''
  ).trim().toLowerCase();
}

function loadAuthSession(req, res, next) {
  req.cookies = parseCookies(req.headers.cookie || '');
  req.auth = {};
  const session = verifyCookie(req.cookies.formapproval_session || '');
  if (session && session.email && (!session.exp || session.exp > Math.floor(Date.now() / 1000))) {
    req.auth = session;
  }
  next();
}

function oauthConfigured() {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.SESSION_SECRET);
}

function requireOAuthSession(req, res, next) {
  if (!oauthConfigured() || req.auth.email || isPublicTokenDecisionRequest(req)) {
    next();
    return;
  }
  if (String(req.path || '').startsWith('/api/')) {
    res.status(401).json({ ok: false, error: 'Sign in is required.' });
    return;
  }
  res.status(200).type('html').send(renderSignInPage(req));
}

function isPublicTokenDecisionRequest(req) {
  if (req.method !== 'GET' || String(req.path || '') !== '/') {
    return false;
  }
  const mode = String((req.query && req.query.mode) || '').toLowerCase();
  const token = String((req.query && req.query.token) || '');
  const decision = String((req.query && req.query.decision) || '').toLowerCase();
  return mode === 'decision' &&
    Boolean(token) &&
    ['approve', 'acknowledge', 'deny'].indexOf(decision) !== -1;
}

function signCookie(value) {
  const payload = Buffer.from(value).toString('base64url');
  const signature = crypto
    .createHmac('sha256', requiredSessionSecret())
    .update(payload)
    .digest('base64url');
  return `${payload}.${signature}`;
}

function verifyCookie(value) {
  const [payload, signature] = String(value || '').split('.');
  if (!payload || !signature) {
    return null;
  }
  const expected = crypto
    .createHmac('sha256', requiredSessionSecret())
    .update(payload)
    .digest('base64url');
  if (Buffer.byteLength(signature) !== Buffer.byteLength(expected)) {
    return null;
  }
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    return null;
  }
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch (err) {
    return null;
  }
}

function requiredSessionSecret() {
  if (!process.env.SESSION_SECRET) {
    return 'oauth-disabled-development-secret';
  }
  return process.env.SESSION_SECRET;
}

function parseCookies(header) {
  const cookies = {};
  String(header || '').split(';').forEach(part => {
    const index = part.indexOf('=');
    if (index === -1) {
      return;
    }
    const key = decodeURIComponent(part.slice(0, index).trim());
    const value = decodeURIComponent(part.slice(index + 1).trim());
    cookies[key] = value;
  });
  return cookies;
}

function setCookie(res, name, value, options = {}) {
  const parts = [`${encodeURIComponent(name)}=${encodeURIComponent(value)}`];
  if (options.maxAge !== undefined) parts.push(`Max-Age=${Number(options.maxAge)}`);
  if (options.httpOnly) parts.push('HttpOnly');
  if (options.secure) parts.push('Secure');
  if (options.sameSite) parts.push(`SameSite=${options.sameSite}`);
  parts.push('Path=/');
  res.append('Set-Cookie', parts.join('; '));
}

function clearCookie(res, name) {
  setCookie(res, name, '', {
    maxAge: 0,
    httpOnly: true,
    sameSite: 'Lax',
    secure: true
  });
}

function safeLocalTarget(value) {
  const text = String(value || '/');
  if (!text || text.startsWith('//') || /^https?:\/\//i.test(text)) {
    return '/';
  }
  return text.startsWith('/') ? text : '/';
}

function loadEnv(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }
  fs.readFileSync(filePath, 'utf8').split(/\r?\n/).forEach(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      return;
    }
    const index = trimmed.indexOf('=');
    if (index === -1) {
      return;
    }
    const key = trimmed.slice(0, index);
    let value = trimmed.slice(index + 1);
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) {
      process.env[key] = value;
    }
  });
}

function escapeHtml(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
