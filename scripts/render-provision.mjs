/**
 * Applies `render.yaml` through Render's API (docs/22 §4).
 *
 * ## Why this exists rather than a dashboard click
 *
 * The blueprint is the reviewed artefact. Creating resources by hand in a
 * dashboard means the thing that runs and the thing that was reviewed are two
 * different objects that merely resemble each other — and the drift is
 * invisible until an incident. This reads `render.yaml` and creates exactly
 * what it declares.
 *
 * ## The rule that makes that claim true
 *
 * **Any field this script does not know how to send is a refusal, not a
 * silent omission.** `KNOWN_KEYS` below lists every key each resource kind may
 * carry; a key outside it stops the run before a single resource is created.
 *
 * Without that rule the failure mode is exactly the one worth fearing: a
 * blueprint saying `ipAllowList: []` and a database created wide open, or a
 * blueprint saying `preDeployCommand` and a service that never runs its
 * migrations. Both look fine in a dashboard.
 *
 * ## Idempotent
 *
 * Everything is matched by name first. A resource that already exists is
 * reported and left alone — never recreated, never modified. Running this
 * twice costs two listings and creates nothing.
 *
 * ## It prints no secret, ever
 *
 * Not a connection string, not an environment value, not the API key. Every
 * line names a resource and its status. `sync: false` variables are declared
 * by name and left empty by design — their values are typed into the dashboard
 * by a person (docs/22 §2).
 *
 *   node scripts/render-provision.mjs --mode preflight   # creates nothing
 *   node scripts/render-provision.mjs --mode provision   # creates what is missing
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const API = 'https://api.render.com/v1';

const args = process.argv.slice(2);
const mode = args.includes('--mode') ? args[args.indexOf('--mode') + 1] : 'preflight';
if (mode !== 'preflight' && mode !== 'provision') {
  console.error(`Unknown --mode "${mode}". Use preflight or provision.`);
  process.exit(2);
}

const apiKey = process.env.RENDER_API_KEY;
if (!apiKey) {
  console.error('');
  console.error('✖ RENDER_API_KEY is not set.');
  console.error('');
  console.error('  This is the one credential the provisioner cannot supply for itself.');
  console.error('  Add it as a repository secret (Settings → Secrets and variables →');
  console.error('  Actions → New repository secret, name: RENDER_API_KEY) using a key');
  console.error('  from https://dashboard.render.com/u/settings#api-keys');
  console.error('');
  process.exit(1);
}

/** The blueprint, read with the same small YAML reader the env check uses. */
const indentOf = (line) => line.length - line.trimStart().length;

function scalar(raw) {
  const text = raw.trim();
  if (text === '') return '';
  if (text === '[]') return [];
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (/^-?\d+$/.test(text)) return Number(text);
  if (
    (text.startsWith("'") && text.endsWith("'")) ||
    (text.startsWith('"') && text.endsWith('"'))
  ) {
    return text.slice(1, -1);
  }
  return text;
}

function parseNode(lines, start, indent) {
  if (lines[start] !== undefined && lines[start].trimStart().startsWith('- ')) {
    const list = [];
    let index = start;
    while (index < lines.length) {
      const line = lines[index];
      if (line.trim() === '' || line.trimStart().startsWith('#')) {
        index += 1;
        continue;
      }
      if (indentOf(line) < indent || !line.trimStart().startsWith('- ')) break;

      const inline = line.trimStart().slice(2);
      if (inline.includes(':')) {
        const rebuilt = [' '.repeat(indent + 2) + inline, ...lines.slice(index + 1)];
        const [value, consumed] = parseNode(rebuilt, 0, indent + 2);
        list.push(value);
        index += consumed;
      } else {
        list.push(scalar(inline));
        index += 1;
      }
    }
    return [list, index - start];
  }

  const object = {};
  let index = start;
  while (index < lines.length) {
    const line = lines[index];
    if (line.trim() === '' || line.trimStart().startsWith('#')) {
      index += 1;
      continue;
    }
    const currentIndent = indentOf(line);
    if (currentIndent < indent) break;
    if (currentIndent > indent) {
      index += 1;
      continue;
    }
    if (line.trimStart().startsWith('- ')) break;

    const colon = line.indexOf(':');
    const key = line.slice(0, colon).trim();
    const rest = line.slice(colon + 1);
    if (rest.trim() !== '') {
      object[key] = scalar(rest);
      index += 1;
      continue;
    }
    const [child, consumed] = parseNode(lines, index + 1, currentIndent + 2);
    object[key] = child;
    index += 1 + consumed;
  }
  return [object, index - start];
}

function readYaml(text) {
  const lines = text.split('\n').filter((line) => !line.trimStart().startsWith('#'));
  const [value] = parseNode(lines, 0, 0);
  return value;
}

const blueprint = readYaml(readFileSync(resolve(root, 'render.yaml'), 'utf8'));

/**
 * Every key this script knows how to send, per resource kind.
 *
 * A key in the blueprint but absent here stops the run. That is the whole
 * fidelity guarantee: the alternative is a resource created with a field
 * quietly dropped, which is how `ipAllowList: []` becomes a database open to
 * the internet.
 */
const KNOWN_KEYS = {
  web: new Set([
    'type',
    'name',
    'runtime',
    'repo',
    'branch',
    'region',
    'plan',
    'dockerfilePath',
    'dockerContext',
    'healthCheckPath',
    'autoDeploy',
    'numInstances',
    'envVars',
  ]),
  worker: new Set([
    'type',
    'name',
    'runtime',
    'repo',
    'branch',
    'region',
    'plan',
    'dockerfilePath',
    'dockerContext',
    'autoDeploy',
    'preDeployCommand',
    'envVars',
  ]),
  keyvalue: new Set(['type', 'name', 'region', 'plan', 'maxmemoryPolicy', 'ipAllowList']),
  database: new Set([
    'name',
    'databaseName',
    'user',
    'region',
    'plan',
    'postgresMajorVersion',
    'ipAllowList',
  ]),
  envVarGroup: new Set(['name', 'envVars']),
};

const refusals = [];

function checkKeys(kind, spec, label) {
  for (const key of Object.keys(spec)) {
    if (!KNOWN_KEYS[kind].has(key)) {
      refusals.push(
        `${label}: render.yaml declares "${key}", which this provisioner does not know how to send. ` +
          `Refusing rather than creating the resource without it.`,
      );
    }
  }
}

const services = Array.isArray(blueprint.services) ? blueprint.services : [];
const databases = Array.isArray(blueprint.databases) ? blueprint.databases : [];
const groups = Array.isArray(blueprint.envVarGroups) ? blueprint.envVarGroups : [];

for (const service of services) {
  const kind = service.type === 'web' ? 'web' : service.type === 'worker' ? 'worker' : 'keyvalue';
  checkKeys(kind, service, `${service.type} "${service.name}"`);
}
for (const database of databases) checkKeys('database', database, `database "${database.name}"`);
for (const group of groups) checkKeys('envVarGroup', group, `env group "${group.name}"`);

if (refusals.length > 0) {
  console.error('\n✖ The blueprint declares fields this provisioner cannot send:\n');
  for (const refusal of refusals) console.error(`  • ${refusal}`);
  console.error('\n  Nothing was created. Extend the provisioner, or apply the blueprint');
  console.error('  from the Render dashboard where every field is supported.\n');
  process.exit(1);
}

// ── The API ────────────────────────────────────────────────────────────────

async function api(path, init = {}) {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
      ...(init.headers ?? {}),
    },
  });

  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }

  if (!response.ok) {
    // The provider's own words. Guessing at a rejection is how a plan name
    // gets "corrected" into something nobody chose.
    const detail = typeof body === 'string' ? body : JSON.stringify(body);
    throw new Error(`${init.method ?? 'GET'} ${path} → ${response.status}: ${detail}`);
  }
  return body;
}

const owners = await api('/owners?limit=20');
if (!Array.isArray(owners) || owners.length === 0) {
  console.error('✖ The API key resolves to no owner. Is it valid?');
  process.exit(1);
}
if (owners.length > 1) {
  console.error('✖ The API key can see more than one owner; refusing to guess which one.');
  for (const entry of owners) console.error(`  • ${entry.owner?.name} (${entry.owner?.id})`);
  process.exit(1);
}
const ownerId = owners[0].owner.id;
console.warn(`Workspace: ${owners[0].owner.name} (${ownerId})`);
console.warn(`Mode: ${mode}\n`);

/** Existing resources, by name, so nothing is ever created twice. */
async function existingServices() {
  const rows = await api(`/services?ownerId=${ownerId}&limit=100`);
  return new Map(rows.map((row) => [row.service.name, row.service]));
}
async function existingPostgres() {
  const rows = await api(`/postgres?ownerId=${ownerId}&limit=100`);
  return new Map(rows.map((row) => [row.postgres.name, row.postgres]));
}
async function existingKeyValue() {
  const rows = await api(`/key-value?ownerId=${ownerId}&limit=100`);
  return new Map(rows.map((row) => [row.keyValue.name, row.keyValue]));
}
async function existingGroups() {
  const rows = await api(`/env-groups?ownerId=${ownerId}&limit=100`);
  return new Map(rows.map((row) => [row.envGroup.name, row.envGroup]));
}

const report = [];
const record = (kind, name, status, detail = '') => report.push({ kind, name, status, detail });

const [svcNow, pgNow, kvNow, grpNow] = await Promise.all([
  existingServices(),
  existingPostgres(),
  existingKeyValue(),
  existingGroups(),
]);

// ── Env var groups ─────────────────────────────────────────────────────────
//
// Created before the services that reference them. Values marked `sync: false`
// carry no value here on purpose — they are typed into the dashboard, and a
// provisioner that invented one would be writing a credential.

for (const group of groups) {
  if (grpNow.has(group.name)) {
    record('env group', group.name, 'exists', 'left untouched');
    continue;
  }
  const declared = (group.envVars ?? []).filter((entry) => entry.value !== undefined);
  const secretNames = (group.envVars ?? [])
    .filter((entry) => entry.value === undefined)
    .map((entry) => entry.key);

  if (mode === 'preflight') {
    record(
      'env group',
      group.name,
      'would create',
      `${declared.length} value(s)` +
        (secretNames.length ? `, ${secretNames.length} left for the dashboard` : ''),
    );
    continue;
  }

  await api('/env-groups', {
    method: 'POST',
    body: JSON.stringify({
      ownerId,
      name: group.name,
      envVars: declared.map((entry) => ({ key: entry.key, value: String(entry.value) })),
    }),
  });
  record(
    'env group',
    group.name,
    'created',
    secretNames.length ? `${secretNames.length} secret(s) still to be typed in` : '',
  );
}

// ── Postgres ───────────────────────────────────────────────────────────────

for (const database of databases) {
  if (pgNow.has(database.name)) {
    record('postgres', database.name, 'exists', pgNow.get(database.name).status ?? '');
    continue;
  }
  if (mode === 'preflight') {
    record('postgres', database.name, 'would create', `${database.plan} · ${database.region}`);
    continue;
  }
  const created = await api('/postgres', {
    method: 'POST',
    body: JSON.stringify({
      ownerId,
      name: database.name,
      databaseName: database.databaseName,
      databaseUser: database.user,
      region: database.region,
      plan: database.plan,
      version: String(database.postgresMajorVersion),
      // `[]` means "private network only" and must survive verbatim.
      ipAllowList: database.ipAllowList ?? [],
    }),
  });
  record('postgres', database.name, 'created', created.status ?? '');
}

// ── Key value ──────────────────────────────────────────────────────────────

for (const service of services.filter((entry) => entry.type === 'keyvalue')) {
  if (kvNow.has(service.name)) {
    record('key value', service.name, 'exists', 'left untouched');
    continue;
  }
  if (mode === 'preflight') {
    record('key value', service.name, 'would create', `${service.plan} · ${service.region}`);
    continue;
  }
  const created = await api('/key-value', {
    method: 'POST',
    body: JSON.stringify({
      ownerId,
      name: service.name,
      region: service.region,
      plan: service.plan,
      maxmemoryPolicy: service.maxmemoryPolicy,
      ipAllowList: service.ipAllowList ?? [],
    }),
  });
  record('key value', service.name, 'created', created.status ?? '');
}

// ── Web and worker ─────────────────────────────────────────────────────────
//
// Both are Docker services built from the committed Dockerfiles — the same two
// images the pre-Render gate builds and proves. A non-Docker service here
// would make that verdict describe something else.

function serviceEnvVars(service) {
  return (service.envVars ?? []).map((entry) => {
    if (entry.fromGroup) return { key: '__group__', value: entry.fromGroup };
    if (entry.fromDatabase) {
      return {
        key: entry.key,
        fromDatabase: { name: entry.fromDatabase.name, property: entry.fromDatabase.property },
      };
    }
    if (entry.fromService) {
      return {
        key: entry.key,
        fromService: {
          name: entry.fromService.name,
          type: entry.fromService.type,
          property: entry.fromService.property,
        },
      };
    }
    return { key: entry.key, value: String(entry.value) };
  });
}

for (const service of services.filter((entry) => entry.type === 'web' || entry.type === 'worker')) {
  if (svcNow.has(service.name)) {
    const found = svcNow.get(service.name);
    record('service', service.name, 'exists', found.serviceDetails?.url ?? found.type ?? '');
    continue;
  }
  if (mode === 'preflight') {
    record(
      'service',
      service.name,
      'would create',
      `${service.type} · docker · ${service.plan} · ${service.region}`,
    );
    continue;
  }

  const envVars = serviceEnvVars(service);
  const groupNames = envVars.filter((entry) => entry.key === '__group__').map((e) => e.value);
  const plainVars = envVars.filter((entry) => entry.key !== '__group__');

  const details =
    service.type === 'web'
      ? {
          env: 'docker',
          region: service.region,
          plan: service.plan,
          healthCheckPath: service.healthCheckPath,
          numInstances: service.numInstances ?? 1,
          envSpecificDetails: {
            dockerfilePath: service.dockerfilePath,
            dockerContext: service.dockerContext,
          },
        }
      : {
          env: 'docker',
          region: service.region,
          plan: service.plan,
          preDeployCommand: service.preDeployCommand,
          envSpecificDetails: {
            dockerfilePath: service.dockerfilePath,
            dockerContext: service.dockerContext,
          },
        };

  const created = await api('/services', {
    method: 'POST',
    body: JSON.stringify({
      ownerId,
      type: service.type === 'web' ? 'web_service' : 'background_worker',
      name: service.name,
      repo: service.repo,
      branch: service.branch,
      autoDeploy: service.autoDeploy === false ? 'no' : 'yes',
      serviceDetails: details,
      envVars: plainVars,
    }),
  });

  const id = created.service?.id ?? created.id;
  record('service', service.name, 'created', id ?? '');

  // Groups are linked after creation; the create payload takes plain vars only.
  for (const groupName of groupNames) {
    const group = grpNow.get(groupName) ?? (await existingGroups()).get(groupName);
    if (!group) {
      record('link', `${service.name} → ${groupName}`, 'FAILED', 'group not found');
      continue;
    }
    await api(`/services/${id}/env-groups/${group.id}`, { method: 'PUT' });
    record('link', `${service.name} → ${groupName}`, 'linked');
  }
}

// ── Report ─────────────────────────────────────────────────────────────────

console.warn('Resource                     Kind         Status         Detail');
console.warn('───────────────────────────────────────────────────────────────────────────');
for (const row of report) {
  console.warn(
    `${row.name.padEnd(28)} ${row.kind.padEnd(12)} ${row.status.padEnd(14)} ${row.detail}`,
  );
}
console.warn('');

const failed = report.filter((row) => row.status === 'FAILED');
if (failed.length > 0) {
  console.error(`✖ ${failed.length} step(s) failed.`);
  process.exit(1);
}
console.warn(
  mode === 'preflight'
    ? '✓ Preflight only. Nothing was created.'
    : '✓ Applied. Secrets marked `sync: false` are still to be typed into the dashboard.',
);
