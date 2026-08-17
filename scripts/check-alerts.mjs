/**
 * Checks the alert definitions against the rules docs/15 §5 sets for them.
 *
 * The rule that matters: *"every alert has a runbook."* An alert that fires at
 * 3am and points nowhere is an alert that trains the on-call engineer to
 * acknowledge and go back to sleep — which is the failure mode docs/15 opens by
 * warning about.
 *
 * Parsed with a small reader rather than a YAML dependency: the file's shape is
 * fixed and known, and a monitoring check that itself needs a supply-chain
 * review is a poor trade.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const source = readFileSync(resolve(root, 'infra/monitoring/alerts.yml'), 'utf8');

/** Every `- id:` block, flattened to the fields this check cares about. */
function readAlerts(text) {
  const alerts = [];
  let current = null;

  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\s+$/, '');
    if (/^\s*#/.test(line) || line.trim() === '') continue;

    const start = /^\s*-\s+id:\s*(\S+)/.exec(line);
    if (start) {
      if (current) alerts.push(current);
      current = { id: start[1] };
      continue;
    }
    if (!current) continue;

    const field = /^\s{4}(\w+):\s*(.*)$/.exec(line);
    if (field) current[field[1]] = field[2].trim();
  }
  if (current) alerts.push(current);
  return alerts;
}

const alerts = readAlerts(source);
const problems = [];

if (alerts.length === 0) problems.push('No alerts were parsed — the file shape changed.');

const seen = new Set();
for (const alert of alerts) {
  const where = `alert "${alert.id}"`;

  if (seen.has(alert.id)) problems.push(`${where}: duplicate id`);
  seen.add(alert.id);

  if (!['P0', 'P1', 'P2'].includes(alert.severity)) {
    problems.push(`${where}: severity must be P0, P1 or P2 (got ${alert.severity ?? 'nothing'})`);
  }
  if (!alert.summary) problems.push(`${where}: no summary`);
  if (!alert.condition) problems.push(`${where}: no condition`);

  // The rule this script exists for.
  if (alert.severity === 'P0' || alert.severity === 'P1') {
    if (!alert.runbook) {
      problems.push(`${where}: ${alert.severity} alerts must name a runbook (docs/15 §5)`);
    } else if (!existsSync(resolve(root, alert.runbook))) {
      problems.push(`${where}: runbook ${alert.runbook} does not exist`);
    }
  }
}

console.log(`\nAlert definitions — ${alerts.length} alerts`);
for (const severity of ['P0', 'P1', 'P2']) {
  const count = alerts.filter((alert) => alert.severity === severity).length;
  console.log(`  ${severity}: ${count}`);
}

if (problems.length > 0) {
  console.error('\n✗ Alert definitions are not valid:');
  for (const problem of problems) console.error(`  • ${problem}`);
  process.exit(1);
}

console.log('\n✓ Every alert is well-formed, and every P0/P1 points at a runbook that exists.');
