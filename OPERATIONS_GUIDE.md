# Operations Guide

This guide is intentionally deployment-neutral so it can be included in a public repository. Keep live server details, real credentials, staff routing, and production-only notes in private documentation outside this repo.

## Runtime Components

- Node.js web server: `src/server.js`
- PostgreSQL data/configuration store
- SMTP email delivery
- Google OAuth sign-in
- Nginx or another reverse proxy in front of the Node service
- Optional systemd timers for scheduled reminders/follow-ups

## Private Configuration

Private values belong in the deployment environment file or database, not in tracked source.

Environment values:

- `APP_BASE_URL`
- `DATABASE_URL`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `SESSION_SECRET`
- `SMTP_HOST`
- `SMTP_PORT`
- `SMTP_SECURE`
- `SMTP_USER`
- `SMTP_PASS`
- `MAIL_FROM_NAME`
- `MAIL_FROM_ADDRESS`
- `OAUTH_ALLOWED_DOMAIN`
- `OAUTH_REDIRECT_URI`
- `SCHEDULED_JOB_ACTOR_EMAIL`
- `REGRESSION_TEST_SECRET`

Database-backed values in `app_definitions`:

- form definitions
- process definitions
- workflow steps
- global admin emails
- process admin emails
- notification recipients
- email copy and waiting/status messages

## Deployment Outline

1. Install Node.js, PostgreSQL, nginx, and certbot or your preferred TLS tooling.
2. Create the PostgreSQL database and application role.
3. Load or create `app_definitions` rows for each form and process.
4. Copy `.env.example` to the private environment-file location and fill in real values.
5. Install Node dependencies with `npm install`.
6. Start the service with `npm start` or a process manager.
7. Configure the reverse proxy to forward HTTPS traffic to the local Node port.
8. Install scheduled timers if reminder/follow-up automation is required.
9. Run `npm test` before deploying code changes.

## Scheduled Jobs

Use the runner in `scripts/run-scheduled-job.js`:

```bash
node scripts/run-scheduled-job.js sendDueActualHoursRequests
node scripts/run-scheduled-job.js sendWeeklyPendingReminders
```

Example systemd units are in `deploy/systemd/`. Treat them as templates and update paths, user names, and environment-file locations for the target server.

## Data Export

Admins can download audit workbooks from the native web app. Exports are generated at request time and should not be committed to the repository.

## Public Release Checklist

- `.env` and private environment files are ignored.
- `SERVER_CONTEXT.md` and local handover notes are ignored.
- source spreadsheets, PDFs, and imported reference data are ignored.
- no OAuth client secrets, SMTP app passwords, session secrets, database passwords, or private keys are present in tracked files.
- no live workflow routing or admin list is hardcoded in source.
- `.env.example` contains placeholders only.
