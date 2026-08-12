import { constants } from 'node:fs';
import { access, readFile, stat } from 'node:fs/promises';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REQUIRED_PROJECT_FILES = [
  'CLAUDE-RESEARCH.md',
  'PROJECT_IDENTITY.json',
  'PROGRAM_ORIGIN.md',
  'SEED.md',
  'PIPELINE_STATE.md',
  'CLAUDE.md',
];

async function executable(name) {
  for (const directory of String(process.env.PATH || '').split(delimiter).filter(Boolean)) {
    const candidate = join(directory, name);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue through PATH.
    }
  }
  return null;
}

function expand(value) {
  return String(value).replace(/\$\{RESEARCH_PROJECT_ROOT\}/g,
    process.env.RESEARCH_PROJECT_ROOT || join(process.env.HOME || '', 'research'));
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

const checks = [];
const major = Number(process.versions.node.split('.')[0]);
checks.push({ ok: major >= 26, label: `Node.js ${process.versions.node}`, fix: 'Install Node.js 26+.' });
checks.push({
  ok: process.platform === 'darwin',
  label: `Platform ${process.platform}`,
  fix: 'FIRM external iTerm control is currently supported on macOS.',
});

for (const command of ['claude', 'codex']) {
  const path = await executable(command);
  checks.push({
    ok: Boolean(path) || (command === 'codex' && /^(?:0|false|off)$/i.test(
      String(process.env.FIRM_CODEX_AUDIT_ENABLED || ''),
    )),
    label: path ? `${command}: ${path}` : `${command}: not found`,
    fix: command === 'claude'
      ? 'Install and log in to Claude Code.'
      : 'Install/log in to Codex, or set FIRM_CODEX_AUDIT_ENABLED=false.',
  });
}

const configPath = resolve(process.env.FIRM_CONFIG || join(ROOT, 'config', 'projects.json'));
if (!(await exists(configPath))) {
  checks.push({
    ok: false,
    label: `Project config missing: ${configPath}`,
    fix: 'Copy config/projects.example.json to config/projects.json and edit it.',
  });
} else {
  try {
    const projects = JSON.parse(await readFile(configPath, 'utf8'));
    checks.push({
      ok: Array.isArray(projects) && projects.length > 0,
      label: `${projects.length || 0} configured project(s)`,
      fix: 'Add at least one project to the JSON array.',
    });
    for (const project of projects) {
      const path = resolve(expand(project.path));
      const missing = [];
      const requiredFiles = [
        ...REQUIRED_PROJECT_FILES,
        project.bootstrapFile || 'prompt.txt',
      ];
      for (const file of requiredFiles) {
        if (!(await exists(join(path, file)))) missing.push(file);
      }
      checks.push({
        ok: missing.length === 0,
        label: `${project.id || '<missing id>'}: ${path}`,
        fix: missing.length ? `Missing: ${missing.join(', ')}` : '',
      });
    }
  } catch (error) {
    checks.push({
      ok: false,
      label: `Project config is invalid: ${configPath}`,
      fix: error.message,
    });
  }
}

for (const check of checks) {
  console.log(`${check.ok ? 'PASS' : 'FAIL'}  ${check.label}`);
  if (!check.ok) console.log(`      ${check.fix}`);
}

const failures = checks.filter((check) => !check.ok).length;
console.log(`\n${checks.length - failures}/${checks.length} checks passed.`);
process.exitCode = failures ? 1 : 0;
