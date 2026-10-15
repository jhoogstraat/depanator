import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, chmodSync, mkdtempSync, writeFileSync, readFileSync, statSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { SCHEMA, INSTRUCTIONS, reviewInput, unavailable } from './llm.js';

const require = createRequire(import.meta.url);
export function codexExecutable() {
  const target = `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-${process.platform === 'darwin' ? 'apple-darwin' : 'unknown-linux-musl'}`;
  const root = dirname(require.resolve(`@openai/codex-${process.platform}-${process.arch}/package.json`));
  return join(root, 'vendor', target, 'bin', 'codex');
}

export function codexEnvironment(config, home) {
  mkdirSync(config.llm.codexHome, { recursive: true, mode: 0o700 });
  chmodSync(config.llm.codexHome, 0o700);
  // No API keys, Telegram credentials, browser settings, or inherited MCP env.
  return { PATH: process.env.PATH, HOME: home, CODEX_HOME: config.llm.codexHome, TERM: 'dumb' };
}

// The pinned CLI's static catalog prevents model metadata from enabling patch,
// shell, image, or experimental tools. Feature flags also disable integrations.
export function codexArguments(config, directory) {
  const model = config.llm.model;
  writeFileSync(join(directory, 'catalog.json'), JSON.stringify({ models: [{
    slug: model, display_name: model, description: null, priority: 0, base_instructions: INSTRUCTIONS,
    supported_reasoning_levels: [], shell_type: 'disabled', visibility: 'list',
    supported_in_api: true, availability_nux: null, upgrade: null,
    support_verbosity: false, default_verbosity: null, apply_patch_tool_type: null,
    truncation_policy: { mode: 'tokens', limit: 10000 }, experimental_supported_tools: [],
    include_apps_usage_instructions: false, node_repl_disabled: true,
  }] }), { mode: 0o600 });
  writeFileSync(join(directory, 'schema.json'), JSON.stringify(SCHEMA), { mode: 0o600 });
  const settings = {
    model_catalog_json: join(directory, 'catalog.json'), instructions: INSTRUCTIONS,
    forced_login_method: 'chatgpt', cli_auth_credentials_store: 'file',
    approval_policy: 'never', web_search: 'disabled', project_doc_max_bytes: 0,
    'tools.experimental_request_user_input.enabled': false,
    'tools.update_plan.enabled': false, 'skills.include_instructions': false,
  };
  const disabled = ['shell_tool', 'view_image', 'multi_agent', 'multi_agent_v2',
    'apps', 'plugins', 'plugin_hooks', 'code_mode', 'code_mode_only',
    'computer_use', 'browser_use', 'image_generation', 'skill_search',
    'skill_mcp_dependency_install', 'tool_suggest', 'sleep_tool', 'token_budget', 'goals'];
  return ['exec', '--ignore-user-config', '--ignore-rules', '--ephemeral',
    '--skip-git-repo-check', '--sandbox', 'read-only', '--cd', directory,
    '--model', model, '--output-schema', join(directory, 'schema.json'),
    '--output-last-message', join(directory, 'result.json'), '--json',
    ...Object.entries(settings).flatMap(([key, value]) => ['-c', `${key}=${JSON.stringify(value)}`]),
    '-c', 'features.skip_host_skill_discovery=true',
    ...disabled.flatMap(feature => ['--disable', feature]), '-'];
}

export async function evaluateWithCodex(config, snapshot, { spawnImpl = spawn, signal, revision } = {}) {
  signal?.throwIfAborted();
  const directory = mkdtempSync(join(tmpdir(), 'depanator-codex-'));
  try {
    const args = codexArguments(config, directory);
    const child = spawnImpl(codexExecutable(), args, { cwd: directory, env: codexEnvironment(config, directory), stdio: ['pipe', 'ignore', 'ignore'] });
    const complete = new Promise((resolve, reject) => {
      const abort = () => { child.kill('SIGKILL'); };
      signal?.addEventListener('abort', abort, { once: true });
      const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(unavailable('Codex review timed out; nothing was sent')); }, 120000);
      const cleanup = () => { clearTimeout(timeout); signal?.removeEventListener('abort', abort); };
      child.once('error', () => { cleanup(); reject(unavailable('Cannot start bundled Codex CLI')); });
      child.once('close', code => { cleanup(); code === 0 && !signal?.aborted ? resolve() : reject(signal?.aborted ? new Error('Codex review cancelled') : unavailable('Codex review failed; check subscription login with llm-login (no API fallback)')); });
      if (signal?.aborted) abort();
    });
    child.stdin.on('error', () => {});
    child.stdin.end(reviewInput(config, snapshot, revision));
    await complete;
    const filename = join(directory, 'result.json');
    if (statSync(filename).size > 65000) throw new Error('Codex output exceeded the review limit');
    try { return JSON.parse(readFileSync(filename, 'utf8')); }
    catch { throw new Error('Codex returned invalid JSON; nothing was sent'); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

export async function loginWithCodex(config) {
  if (config.llm.backend !== 'codex') throw new Error('Set llm.backend to codex before subscription login');
  const directory = mkdtempSync(join(tmpdir(), 'depanator-codex-login-'));
  try {
    const child = spawn(codexExecutable(), ['-c', 'cli_auth_credentials_store="file"', '-c', 'forced_login_method="chatgpt"', 'login', '--device-auth'], { cwd: directory, env: codexEnvironment(config, directory), stdio: 'inherit' });
    await new Promise((resolve, reject) => {
      child.once('error', () => reject(new Error('Cannot start bundled Codex CLI')));
      child.once('close', code => code === 0 ? resolve() : reject(new Error('Codex subscription login failed')));
    });
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
