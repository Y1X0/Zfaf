/**
 * Checks that the production blueprint and the environment schema agree.
 *
 * The failure this exists to prevent is quiet. `parseEnv` refuses to boot on a
 * missing variable, which is good — but only once something boots. A variable
 * added to the schema and forgotten in `render.yaml` fails at the end of a
 * deploy, after the image is built; a variable *misspelled* in `render.yaml`
 * never fails at all, because a name nothing reads is a name nothing misses.
 * The application then runs with a silently absent Sentry DSN, or a silently
 * absent purge token, and nobody learns until the day it matters.
 *
 * So this compares the two, in both directions, on every `pnpm verify`.
 *
 * Two modes:
 *
 *   node scripts/check-production-env.mjs
 *       Blueprint ↔ schema ↔ .env.example parity. Reads no environment and
 *       needs no credentials, which is why it can run in CI.
 *
 *   node scripts/check-production-env.mjs --env-file <path>
 *       Additionally judges a candidate production environment before its
 *       values are typed into a dashboard: placeholders, reused secrets, local
 *       hostnames, plaintext origins.
 *
 * **It never prints a value.** Every message names a variable and says what is
 * wrong with it. A check that echoed the secret it was validating would put
 * that secret into a CI log, which is the incident docs/14 §10 defines.
 *
 * YAML is read by a small reader rather than a dependency, for the reason
 * `check-alerts.mjs` gives next door: the file's shape is fixed and known, and
 * a deployment check that itself needs a supply-chain review is a poor trade.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const problems = [];
const warnings = [];

// ── A small YAML reader ────────────────────────────────────────────────────

const indentOf = (line) => line.length - line.trimStart().length;

function scalar(raw) {
  const text = raw.trim();
  if (text === '[]') return [];
  if (text === 'true') return true;
  if (text === 'false') return false;
  const quoted = /^"(.*)"$|^'(.*)'$/.exec(text);
  return quoted ? (quoted[1] ?? quoted[2]) : text;
}

function parseNode(lines, start, indent) {
  if (
    lines[start] !== undefined &&
    /^\s*-\s/.test(lines[start]) &&
    indentOf(lines[start]) === indent
  ) {
    const items = [];
    let cursor = start;
    while (
      cursor < lines.length &&
      indentOf(lines[cursor]) === indent &&
      /^\s*-\s/.test(lines[cursor])
    ) {
      const itemLines = [' '.repeat(indent + 2) + lines[cursor].slice(indent + 2)];
      let next = cursor + 1;
      while (next < lines.length && indentOf(lines[next]) >= indent + 2) {
        itemLines.push(lines[next]);
        next += 1;
      }
      items.push(parseNode(itemLines, 0, indent + 2)[0]);
      cursor = next;
    }
    return [items, cursor];
  }

  const map = {};
  let cursor = start;
  while (cursor < lines.length && indentOf(lines[cursor]) === indent) {
    const match = /^\s*([A-Za-z0-9_.-]+):\s*(.*)$/.exec(lines[cursor]);
    if (!match) break;
    const [, key, inline] = match;
    if (inline !== '') {
      map[key] = scalar(inline);
      cursor += 1;
      continue;
    }
    const child = cursor + 1;
    if (child < lines.length && indentOf(lines[child]) > indent) {
      const [value, next] = parseNode(lines, child, indentOf(lines[child]));
      map[key] = value;
      cursor = next;
    } else {
      map[key] = null;
      cursor += 1;
    }
  }
  return [map, cursor];
}

function readYaml(text) {
  const lines = text
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .filter((line) => line.trim() !== '' && !/^\s*#/.test(line));
  return parseNode(lines, 0, 0)[0];
}

// ── What the schema declares ───────────────────────────────────────────────

/**
 * The variable names in `EnvSchema`, and whether each must be supplied.
 *
 * Read out of the source rather than imported: this file is plain JavaScript
 * run by `node` with no loader, and the schema is TypeScript. The shape it
 * relies on — one `KEY:` per line at two spaces of indentation — is asserted
 * below, so a refactor that breaks the reader fails the check rather than
 * silently passing it.
 */
function readSchema() {
  const source = readFileSync(resolve(root, 'packages/config/src/env.ts'), 'utf8');
  const opening = source.indexOf('z.object({');
  const body = source.slice(opening, source.indexOf('\n});', opening));

  const keys = [];
  const lines = body.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^ {2}([A-Z][A-Z0-9_]*):\s*(.*)$/.exec(lines[index]);
    if (!match) continue;
    // Everything up to the next key at the same depth is this field's
    // definition — `.optional()` and `.default()` are frequently on a later
    // line than the name.
    let definition = match[2];
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      if (/^ {2}[A-Z][A-Z0-9_]*:/.test(lines[cursor])) break;
      definition += ` ${lines[cursor].trim()}`;
    }
    keys.push({
      name: match[1],
      required: !definition.includes('.optional()') && !definition.includes('.default('),
    });
  }
  return keys;
}

// ── The blueprint ──────────────────────────────────────────────────────────

const schema = readSchema();
const schemaNames = new Set(schema.map((entry) => entry.name));

if (schema.length < 20) {
  problems.push(
    `Only ${schema.length} variables were read from packages/config/src/env.ts — the file's shape changed and this check is no longer reading it.`,
  );
}

/**
 * Every blueprint this repository can be deployed from.
 *
 * There are two, and both are real (ADR-0023). `render.yaml` is the topology
 * ADR-0022 chose — a web service and a separate worker — and it is the way
 * back. `infra/render/free.yaml` is the zero-cost deployment: one free web
 * service that encodes in the request, with the database and the timer living
 * outside Render entirely.
 *
 * Both are checked, and that is the point of the list. A second blueprint that
 * nothing validates is a second place for a variable to be forgotten or
 * misspelled, and the failure arrives at the end of a deploy either way.
 */
const BLUEPRINTS = ['render.yaml', 'infra/render/free.yaml'];

for (const name of BLUEPRINTS) {
  checkBlueprint(name);
}

function checkBlueprint(name) {
  const blueprintPath = resolve(root, name);
  if (!existsSync(blueprintPath)) {
    problems.push(`${name} is listed as a deployment blueprint but does not exist.`);
    return;
  }
  const blueprintText = readFileSync(blueprintPath, 'utf8');
  const blueprint = readYaml(blueprintText);

  const services = Array.isArray(blueprint.services) ? blueprint.services : [];
  const groups = Array.isArray(blueprint.envVarGroups) ? blueprint.envVarGroups : [];
  const databases = Array.isArray(blueprint.databases) ? blueprint.databases : [];

  if (services.length === 0) problems.push(`${name} declares no services.`);
  /**
   * No rule about `databases:` here on purpose.
   *
   * The paid blueprint declares one; the free blueprint deliberately does not,
   * because its Postgres lives off-platform (docs/25 §3.3 — Render's free
   * database expires and is deleted). What actually matters either way is that
   * `DATABASE_URL` reaches every service, and the required-variable check
   * below enforces that without caring where the value comes from.
   */

  /**
   * The branch each service deploys from must actually exist.
   *
   * This blueprint said `branch: main` for both services while the repository
   * had **no `main` at all** — one branch, and a different name. Render would
   * have been pointed at a ref that does not resolve, and the failure arrives at
   * provisioning time, in a dashboard, with a Postgres instance already created
   * and billing.
   *
   * Nothing else catches it. The YAML is valid, the schema check passes, the
   * gate builds the images from the working tree rather than from the branch —
   * every existing check is blind to a branch name being wrong, because none of
   * them ever resolves it.
   *
   * Local refs first, then the remote-tracking ones: a fresh CI checkout has the
   * branch it checked out, and a developer's clone usually has both.
   */
  function branchExists(branch) {
    for (const ref of [`refs/heads/${branch}`, `refs/remotes/origin/${branch}`]) {
      try {
        execFileSync('git', ['rev-parse', '--verify', '--quiet', ref], {
          cwd: root,
          stdio: 'ignore',
        });
        return true;
      } catch {
        // Not this ref. Try the next, then report.
      }
    }
    return false;
  }

  let gitAvailable = true;
  try {
    execFileSync('git', ['rev-parse', '--git-dir'], { cwd: root, stdio: 'ignore' });
  } catch {
    gitAvailable = false;
  }

  for (const service of services) {
    // Only the services built from the repository. A key-value store has no
    // branch and declaring one would be the error.
    if (!service.repo) continue;

    if (!service.branch) {
      problems.push(`${service.name}: declares a repo but no branch to deploy from.`);
      continue;
    }
    if (!gitAvailable) {
      warnings.push(
        `${service.name}: branch "${service.branch}" was not verified — this is not a git checkout, so no ref could be resolved.`,
      );
      continue;
    }
    if (!branchExists(service.branch)) {
      problems.push(
        `${service.name}: branch "${service.branch}" does not exist in this repository. Render would be pointed at a ref that does not resolve.`,
      );
    }
  }

  const groupsByName = new Map(groups.map((group) => [group.name, group]));

  /** Every variable name a service ends up with, group membership included. */
  function variablesFor(service) {
    const names = new Map();
    for (const entry of service.envVars ?? []) {
      if (entry.fromGroup) {
        const group = groupsByName.get(entry.fromGroup);
        if (!group) {
          problems.push(
            `${service.name}: references env var group "${entry.fromGroup}", which is not defined in this blueprint.`,
          );
          continue;
        }
        for (const variable of group.envVars ?? []) names.set(variable.key, variable);
        continue;
      }
      if (entry.key) names.set(entry.key, entry);
    }
    return names;
  }

  /**
   * Defaults that are correct for a laptop and wrong for production.
   *
   * `parseEnv` already refuses both at boot; requiring them here means the
   * refusal is discovered while reading a blueprint rather than while watching a
   * deploy fail.
   */
  const MUST_BE_EXPLICIT = ['STORAGE_DRIVER', 'MAIL_DRIVER'];

  /**
   * Optional in the schema, expected in production.
   *
   * Warnings rather than failures, deliberately: the application runs correctly
   * without any of them, and a check that refuses to pass without a Sentry
   * account would be a check that gets commented out.
   */
  const EXPECTED_IN_PRODUCTION = [
    'SENTRY_DSN',
    'CDN_ZONE_ID',
    'CDN_API_TOKEN',
    'HEALTH_CHECK_TOKEN',
  ];

  /** Variables whose value may never appear in this file. */
  const SECRETS = new Set([
    'SESSION_SECRET',
    'TOTP_ENCRYPTION_KEY',
    'STORAGE_ENDPOINT',
    'STORAGE_ACCESS_KEY_ID',
    'STORAGE_SECRET_ACCESS_KEY',
    'MAIL_SMTP_URL',
    'MAIL_RESEND_API_KEY',
    'CDN_ZONE_ID',
    'CDN_API_TOKEN',
    'SENTRY_DSN',
    'HEALTH_CHECK_TOKEN',
    'TURNSTILE_SECRET_KEY',
    'GOOGLE_OAUTH_CLIENT_SECRET',
    'DATABASE_URL',
    'REDIS_URL',
  ]);

  const applicationServices = services.filter(
    (service) => service.type === 'web' || service.type === 'worker',
  );

  if (applicationServices.length === 0) {
    problems.push(`${name} declares no web or worker service to check.`);
  }

  for (const service of applicationServices) {
    const variables = variablesFor(service);
    const where = `${service.name} (${service.type})`;

    for (const entry of schema) {
      if (entry.required && !variables.has(entry.name)) {
        problems.push(
          `${where}: ${entry.name} is required by the environment schema and is not wired.`,
        );
      }
    }
    for (const name of MUST_BE_EXPLICIT) {
      if (!variables.has(name)) {
        problems.push(
          `${where}: ${name} must be set explicitly — its schema default is a local development value.`,
        );
      }
    }
    for (const name of EXPECTED_IN_PRODUCTION) {
      if (!variables.has(name)) warnings.push(`${where}: ${name} is not wired.`);
    }
    for (const [name, entry] of variables) {
      if (!schemaNames.has(name)) {
        problems.push(
          `${where}: ${name} is not a variable the application reads — nothing would ever notice it is wrong.`,
        );
      }
      if (SECRETS.has(name) && entry.value !== undefined && entry.value !== null) {
        problems.push(
          `${where}: ${name} carries a literal value in ${name}. Secrets are declared "sync: false" and typed into the dashboard.`,
        );
      }
    }

    if (service.autoDeploy !== false) {
      problems.push(
        `${where}: autoDeploy must be false — docs/14 §4 puts a human gate in front of production.`,
      );
    }
    if (service.runtime === 'docker') {
      const dockerfile = service.dockerfilePath;
      if (!dockerfile || !existsSync(resolve(root, dockerfile))) {
        problems.push(`${where}: dockerfilePath "${dockerfile ?? '(unset)'}" does not exist.`);
      }
    }
  }

  // ── Values a reviewer can check by reading them ────────────────────────────

  const configured = new Map();
  for (const group of groups) {
    for (const variable of group.envVars ?? []) {
      if (variable.value !== undefined && variable.value !== null) {
        configured.set(variable.key, String(variable.value));
      }
    }
  }

  if (configured.get('MAIL_DRIVER') === 'noop') {
    problems.push(
      `${name}: MAIL_DRIVER is "noop" — verification and reset links would be silently discarded.`,
    );
  }
  if (configured.get('STORAGE_DRIVER') === 'minio') {
    problems.push(`${name}: STORAGE_DRIVER is "minio", which is the local development driver.`);
  }
  for (const key of ['PUBLIC_BASE_URL', 'STORAGE_PUBLIC_BASE_URL']) {
    const value = configured.get(key);
    if (value && !value.startsWith('https://')) {
      problems.push(`${name}: ${key} must use https in production.`);
    }
  }

  const web = services.find((service) => service.type === 'web');
  if (web && !web.healthCheckPath) {
    problems.push(
      `${name}: the web service declares no healthCheckPath; a failed deploy would go into rotation.`,
    );
  }
  if (web && web.healthCheckPath === '/api/health/deep') {
    problems.push(
      `${name}: healthCheckPath points at the deep probe — a transient dependency blip would pull every instance at once (docs/14 §11).`,
    );
  }

  const keyValue = services.find((service) => service.type === 'keyvalue');
  if (keyValue && keyValue.maxmemoryPolicy !== 'noeviction') {
    problems.push(
      `${name}: the key-value store must use maxmemoryPolicy "noeviction" — BullMQ loses jobs under eviction, and a lost job is an upload that never becomes a thumbnail.`,
    );
  }
  if (keyValue && !Array.isArray(keyValue.ipAllowList)) {
    warnings.push(
      `${name}: the key-value store has no empty ipAllowList; confirm it is not reachable from the public internet.`,
    );
  }

  for (const database of databases) {
    if (database.plan === 'free') {
      problems.push(
        `Database "${database.name}" is on the free plan, which expires and is deleted.`,
      );
    }
    if (!Array.isArray(database.ipAllowList)) {
      warnings.push(
        `Database "${database.name}" has no empty ipAllowList; confirm it is not reachable from the public internet.`,
      );
    }
  }

  /**
   * A last, blunt sweep for a credential pasted into the blueprint by accident.
   *
   * Patterns rather than entropy: this runs on every verify and a false positive
   * that blocks a commit is worse than the narrow miss.
   */
  const SECRET_SHAPES = [
    [/\bre_[A-Za-z0-9_-]{12,}/, 'a Resend API key'],
    [/\bsk_(live|test)_[A-Za-z0-9]{10,}/, 'a Stripe-style secret key'],
    [
      /\b(postgres|postgresql|redis|rediss):\/\/[^\s:]+:[^\s@]+@/,
      'a connection string with a password',
    ],
    [/https:\/\/[a-f0-9]{16,}@[a-z0-9.-]*sentry\.io/, 'a Sentry DSN'],
  ];
  for (const [pattern, description] of SECRET_SHAPES) {
    if (pattern.test(blueprintText)) {
      problems.push(
        `${name} appears to contain ${description}. Nothing secret belongs in a committed file.`,
      );
    }
  }
}

// ── .env.example documents everything ──────────────────────────────────────

const exampleText = readFileSync(resolve(root, '.env.example'), 'utf8');
const documented = new Set(
  [...exampleText.matchAll(/^#?\s*([A-Z][A-Z0-9_]*)=/gm)].map((match) => match[1]),
);
for (const entry of schema) {
  if (!documented.has(entry.name)) {
    problems.push(
      `${entry.name} is in the environment schema but not in .env.example — a developer cannot know it exists.`,
    );
  }
}

// ── Optional: judge a candidate production environment ─────────────────────

const fileFlag = process.argv.indexOf('--env-file');
if (fileFlag !== -1) {
  const path = process.argv[fileFlag + 1];
  if (!path) {
    problems.push('--env-file needs a path.');
  } else {
    inspectEnvFile(resolve(process.cwd(), path));
  }
}

function inspectEnvFile(path) {
  if (!existsSync(path)) {
    problems.push(`--env-file: ${path} does not exist.`);
    return;
  }

  const values = new Map();
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (match) values.set(match[1], scalar(match[2]));
  }

  for (const entry of schema) {
    if (entry.required && !values.has(entry.name)) {
      problems.push(`--env-file: ${entry.name} is missing.`);
    }
  }

  for (const name of ['SESSION_SECRET', 'TOTP_ENCRYPTION_KEY']) {
    const value = values.get(name);
    if (typeof value !== 'string') continue;
    if (value.length < 32) problems.push(`--env-file: ${name} is shorter than 32 characters.`);
    if (/replace-me|changeme|example|placeholder/i.test(value)) {
      problems.push(`--env-file: ${name} still holds a placeholder.`);
    }
  }
  const keysShared =
    Boolean(values.get('SESSION_SECRET')) &&
    values.get('SESSION_SECRET') === values.get('TOTP_ENCRYPTION_KEY');
  if (keysShared) {
    problems.push(
      '--env-file: SESSION_SECRET and TOTP_ENCRYPTION_KEY are the same value. Rotating the first would break every enrolled authenticator.',
    );
  }

  // The cross-field rules `parseEnv` applies, applied before a deploy rather
  // than during one. A driver without its credential boots nothing.
  if (values.get('MAIL_DRIVER') === 'resend' && !values.get('MAIL_RESEND_API_KEY')) {
    problems.push('--env-file: MAIL_DRIVER is "resend" but MAIL_RESEND_API_KEY is missing.');
  }
  if (values.get('MAIL_DRIVER') === 'smtp' && !values.get('MAIL_SMTP_URL')) {
    problems.push('--env-file: MAIL_DRIVER is "smtp" but MAIL_SMTP_URL is missing.');
  }
  if (values.get('MAIL_DRIVER') === 'noop') {
    problems.push(
      '--env-file: MAIL_DRIVER is "noop" — every verification and reset link would be discarded silently.',
    );
  }

  // A reused value is the failure that survives every individual check: each
  // variable is present, long and non-placeholder, and one leak exposes all of
  // them.
  const seen = new Map();
  for (const [name, value] of values) {
    if (!SECRETS.has(name) || typeof value !== 'string' || value.length < 16) continue;
    const first = seen.get(value);
    if (first) {
      // The session/TOTP pair is reported above with the reason it matters;
      // saying it twice makes the list look longer than the fault is.
      const alreadySaid =
        keysShared &&
        [name, first].every((key) => key === 'SESSION_SECRET' || key === 'TOTP_ENCRYPTION_KEY');
      if (!alreadySaid) problems.push(`--env-file: ${name} and ${first} hold the same value.`);
    } else {
      seen.set(value, name);
    }
  }

  for (const [name, value] of values) {
    if (typeof value !== 'string') continue;
    if (/^(https?|postgres|postgresql|redis|rediss):\/\//.test(value)) {
      if (/(localhost|127\.0\.0\.1|::1)/.test(value)) {
        warnings.push(`--env-file: ${name} points at localhost.`);
      }
    }
    if (name.endsWith('_BASE_URL') && value.startsWith('http://')) {
      problems.push(`--env-file: ${name} uses plain http.`);
    }
  }
}

// ── Report ─────────────────────────────────────────────────────────────────

for (const warning of warnings) console.warn(`  ⚠ ${warning}`);

if (problems.length > 0) {
  console.error(`\n✖ Production environment check failed (${problems.length}):\n`);
  for (const problem of problems) console.error(`  • ${problem}`);
  console.error('');
  process.exit(1);
}

console.warn(
  `✔ ${BLUEPRINTS.length} blueprint(s) wire all ${schema.filter((entry) => entry.required).length} required variables, with no secret in any of them.`,
);
