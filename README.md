# Workflow Approval Forms

This project is a web-based approval workflow system for request forms such as overtime and event/checklist workflows. It was originally built for Google Apps Script with spreadsheet storage and has been migrated toward a native Node.js service with PostgreSQL-backed configuration and request storage.

The repository is intended to be public-safe. Deployment-specific values such as database URLs, SMTP credentials, OAuth secrets, admin lists, live workflow routing, and email recipients belong in environment variables or database rows, not in tracked source code.

## Architecture

- `src/server.js` - native Express web server, OAuth session handling, public pages, API endpoint, and admin export route.
- `src/nativeRuntime.js` - Apps Script compatibility runtime backed by PostgreSQL and SMTP.
- `src/xlsxExport.js` - admin audit workbook generation.
- `scripts/run-scheduled-job.js` - command runner for scheduled reminder/follow-up jobs.
- `apps-script/` - Apps Script-compatible business logic and UI files retained as the shared workflow engine and legacy runtime surface.
- `tests/` - unit/regression tests plus optional live browser/email tests.
- `deploy/systemd/` - example systemd unit/timer files for scheduled jobs.

## Configuration

Copy `.env.example` to your local or service-manager environment file and fill in real values there.

Required production configuration:

- `APP_BASE_URL`
- `DATABASE_URL`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `SESSION_SECRET`
- SMTP settings: `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`

Optional production configuration:

- `OAUTH_ALLOWED_DOMAIN`
- `OAUTH_REDIRECT_URI`
- `OAUTH_SESSION_MAX_AGE_SECONDS`
- `MAIL_FROM_NAME`
- `MAIL_FROM_ADDRESS`
- `SCHEDULED_JOB_ACTOR_EMAIL`
- `DEFINITION_CACHE_TTL_MS`

Live form definitions, workflow definitions, admin access lists, and notification recipients are stored in PostgreSQL `app_definitions`. The code-level `DEFAULT_PROCESS_DEFINITIONS`, `FORM_DEFINITIONS`, and `DEFAULT_ADMIN_EMAILS` defaults are intentionally empty or generic.

## Local Development

Install dependencies:

```bash
npm install
```

Create a local environment file from the template:

```bash
cp .env.example .env
```

Start the native server:

```bash
npm start
```

By default the app listens on `127.0.0.1:3000` and uses `http://localhost:3000` as the app URL unless `APP_BASE_URL` is set.

## Tests

Run the normal regression suite:

```bash
npm test
```

Live browser/email tests are disabled unless explicitly enabled through environment variables:

```bash
LIVE_FORM_TESTS=1 LIVE_FORM_URL=https://forms.example.edu npm run test:live
```

The optional submit-and-email path also requires a valid authenticated session cookie, SMTP/IMAP-capable mailbox credentials, and `REGRESSION_TEST_SECRET`.

## Scheduled Jobs

The native scheduled job runner supports:

```bash
node scripts/run-scheduled-job.js sendDueActualHoursRequests
node scripts/run-scheduled-job.js sendWeeklyPendingReminders
```

Example systemd service/timer files live in `deploy/systemd/`. Adjust paths, user, environment file location, and timer schedules before installing them.

## Public Repo Hygiene

Do not commit:

- `.env` or any `.env.*` file other than `.env.example`
- database dumps or SQL exports
- source spreadsheets, PDFs, or other reference data
- server context notes
- OAuth client secrets, SMTP passwords, session secrets, private keys, or certificates

Use `.env.example` for variable names and PostgreSQL `app_definitions` for deployment-specific workflow/admin/email configuration.
