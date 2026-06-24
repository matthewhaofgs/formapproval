const assert = require('node:assert/strict');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

let cachedDefinitions = null;

function loadLiveDefinitionStore() {
  if (cachedDefinitions) {
    return clone(cachedDefinitions);
  }

  loadEnvFile('/etc/formapproval/formapproval.env');
  assert.ok(process.env.DATABASE_URL, 'DATABASE_URL must be available to load app_definitions.');

  const sql = `
    SELECT jsonb_build_object(
      'formDefinitions',
      COALESCE(
        (SELECT jsonb_object_agg(definition_key, data)
         FROM app_definitions
         WHERE enabled = true
           AND category = 'form_definition'),
        '{}'::jsonb
      ),
      'processDefinitions',
      COALESCE(
        (SELECT jsonb_object_agg(definition_key, data)
         FROM app_definitions
         WHERE enabled = true
           AND category = 'process_definition'),
        '{}'::jsonb
      ),
      'globalAdminEmails',
      COALESCE(
        (SELECT CASE
           WHEN jsonb_typeof(data) = 'array' THEN data
           ELSE data->'emails'
         END
         FROM app_definitions
         WHERE enabled = true
           AND category = 'global_setting'
           AND definition_key = 'admin_emails'
         LIMIT 1),
        '[]'::jsonb
      )
    )::text;
  `;
  const result = spawnSync('psql', ['-X', '-q', '-tAc', sql, process.env.DATABASE_URL], {
    encoding: 'utf8',
    env: process.env
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || 'psql failed while loading app_definitions');
  }

  cachedDefinitions = anonymizeFixtureEmails(JSON.parse(result.stdout.trim()), new Map());
  if (!Object.keys(cachedDefinitions.formDefinitions || {}).length) {
    throw new Error('No enabled form_definition rows found in app_definitions.');
  }
  if (!Object.keys(cachedDefinitions.processDefinitions || {}).length) {
    throw new Error('No enabled process_definition rows found in app_definitions.');
  }
  return clone(cachedDefinitions);
}

function applyLiveDefinitionStore(api) {
  const store = loadLiveDefinitionStore();
  replaceObjectContents(api.FORM_DEFINITIONS, store.formDefinitions || {});
  replaceObjectContents(api.DEFAULT_PROCESS_DEFINITIONS, store.processDefinitions || {});
  if (Array.isArray(api.DEFAULT_ADMIN_EMAILS)) {
    replaceArrayContents(api.DEFAULT_ADMIN_EMAILS, store.globalAdminEmails || []);
  }
  return store;
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
    // Non-server environments should fail later with a clear DATABASE_URL error.
  }
}

function replaceObjectContents(target, source) {
  Object.keys(target || {}).forEach(key => {
    delete target[key];
  });
  Object.keys(source || {}).forEach(key => {
    target[key] = clone(source[key]);
  });
}

function replaceArrayContents(target, source) {
  target.splice(0, target.length, ...(source || []));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function anonymizeFixtureEmails(value, aliases) {
  if (Array.isArray(value)) {
    return value.map(entry => anonymizeFixtureEmails(entry, aliases));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, anonymizeFixtureEmails(entry, aliases)]));
  }
  if (typeof value === 'string') {
    return value.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, email => anonymizeFixtureEmail(email, aliases));
  }
  return value;
}

function anonymizeFixtureEmail(email, aliases) {
  const at = email.indexOf('@');
  const local = email.slice(0, at).toLowerCase();
  const prefix = local.startsWith('smtp+') ? 'smtp+' : '';
  const key = prefix ? local.slice(prefix.length) : local;
  if (!aliases.has(key)) {
    aliases.set(key, `user${aliases.size + 1}`);
  }
  return `${prefix}${aliases.get(key)}@example.edu`;
}

module.exports = {
  applyLiveDefinitionStore,
  loadLiveDefinitionStore
};
