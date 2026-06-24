#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { createNativeRuntime } = require('../src/nativeRuntime');

const ENV_PATH = '/etc/formapproval/formapproval.env';
const APP_BASE_URL = process.env.APP_BASE_URL || 'http://localhost:3000';
const ALLOWED_JOBS = new Set([
  'sendDueActualHoursRequests',
  'sendWeeklyPendingReminders',
  'getDatabaseDiagnostic'
]);

loadEnv(ENV_PATH);

async function main() {
  const job = process.argv[2] || '';
  if (!ALLOWED_JOBS.has(job)) {
    console.error(`Usage: ${path.basename(process.argv[1])} <${Array.from(ALLOWED_JOBS).join('|')}>`);
    process.exit(64);
  }

  const runtime = createNativeRuntime({
    webAppUrl: process.env.APP_BASE_URL || APP_BASE_URL
  });
  await runtime.init();
  const started = Date.now();
  const result = runtime.call(job, {}, process.env.SCHEDULED_JOB_ACTOR_EMAIL || 'system@example.invalid');
  console.log(JSON.stringify({
    ok: true,
    job,
    elapsedMs: Date.now() - started,
    result
  }));
}

function loadEnv(filePath) {
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
}

main().catch(err => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
});
