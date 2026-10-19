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
  // No Telegram credentials or inherited MCP env.
  return { PATH: process.env.PATH, HOME: home, CODEX_HOME: config.llm.codexHome, TERM: 'dumb' };
}

// The pinned CLI's static catalog prevents model metadata from enabling patch,
// shell, image, or experimental tools. Feature flags also disable integrations.
export function codexArguments(config, directory) {
  const { model, thinking } = config.llm;
  writeFileSync(join(directory, 'catalog.json'), JSON.stringify({ models: [{
    slug: model, display_name: model, description: null, priority: 0, base_instructions: INSTRUCTIONS,
    supported_reasoning_levels: thinking ? [{ effort: thinking, description: thinking }] : [], ...(thinking && { default_reasoning_level: thinking }),
    shell_type: 'disabled', visibility: 'list',
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
    '--model', model, ...(thinking ? ['-c', `model_reasoning_effort=${JSON.stringify(thinking)}`] : []), '--output-schema', join(directory, 'schema.json'),
    '--output-last-message', join(directory, 'result.json'), '--json',
    ...Object.entries(settings).flatMap(([key, value]) => ['-c', `${key}=${JSON.stringify(value)}`]),
    '-c', 'features.skip_host_skill_discovery=true',
    ...disabled.flatMap(feature => ['--disable', feature]), '-'];
}

// The connected ChatGPT account ({ email, plan: 'plus', 'pro', ... }), from the login Codex stored; '' if unknown.
export function codexAccount(config) {
  try {
    const { tokens } = JSON.parse(readFileSync(join(config.llm.codexHome, 'auth.json'), 'utf8'));
    const claims = JSON.parse(Buffer.from(tokens.id_token.split('.')[1], 'base64url'));
    return { email: String(claims.email || ''), plan: String(claims['https://api.openai.com/auth']?.chatgpt_plan_type || '') };
  } catch { return { email: '', plan: '' }; }
}

// The models this ChatGPT plan offers, with the thinking levels each supports (first = its default).
export async function listCodexModels(config, { spawnImpl = spawn } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'depanator-codex-models-'));
  try {
    const child = spawnImpl(codexExecutable(), ['debug', 'models'], { cwd: directory, env: codexEnvironment(config, directory), stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Codex model list timed out')); }, 30000);
      child.once('error', () => { clearTimeout(timeout); reject(new Error('Cannot start the bundled Codex CLI')); });
      child.once('close', code => { clearTimeout(timeout); code === 0 ? resolve() : reject(new Error('Cannot read the ChatGPT model list')); });
    });
    return JSON.parse(output).models.filter(model => model.visibility === 'list').map(model => {
      const levels = (model.supported_reasoning_levels || []).map(level => level.effort);
      return { id: model.slug, name: model.display_name || model.slug, thinking: levels, defaultThinking: model.default_reasoning_level || '' };
    });
  } finally { rmSync(directory, { recursive: true, force: true }); }
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
      child.once('close', code => { cleanup(); code === 0 && !signal?.aborted ? resolve() : reject(signal?.aborted ? new Error('Codex review cancelled') : unavailable('ChatGPT review failed; if this repeats, send /login in Telegram to reconnect your subscription')); });
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

const LOGIN_FLAGS = ['-c', 'cli_auth_credentials_store="file"', '-c', 'forced_login_method="chatgpt"', 'login'];
function runCodex(config, args, { spawnImpl = spawn, onOutput = () => {} } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'depanator-codex-login-'));
  const child = spawnImpl(codexExecutable(), [...LOGIN_FLAGS, ...args], { cwd: directory, env: codexEnvironment(config, directory), stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  const collect = chunk => { output += String(chunk).replace(/\x1b\[[0-9;]*m/g, ''); onOutput(output); };
  child.stdout?.on('data', collect);
  child.stderr?.on('data', collect);
  return new Promise(resolve => {
    child.once('error', () => resolve(false));
    child.once('close', code => resolve(code === 0));
  }).finally(() => rmSync(directory, { recursive: true, force: true }));
}
export function codexLoggedIn(config, options) { return runCodex(config, ['status'], options); }
// Device-code login for the ChatGPT subscription: onCode({ url, code }) is called once both are printed.
export async function loginWithCodex(config, { onCode, ...options } = {}) {
  let reported = false;
  const ok = await runCodex(config, ['--device-auth'], { ...options, onOutput(output) {
    const url = /https:\/\/\S+/.exec(output)?.[0];
    const code = /\b[A-Z0-9]{4}-[A-Z0-9]{4,6}\b/.exec(output)?.[0];
    if (!reported && url && code) { reported = true; onCode({ url, code }); }
  } });
  if (!ok) throw new Error('ChatGPT login did not complete (the code expires after 15 minutes)');
}
