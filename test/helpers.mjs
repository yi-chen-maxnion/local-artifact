import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '../..');

const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.once('error', reject);
  srv.listen(0, '127.0.0.1', () => {
    const { port } = srv.address();
    srv.close(() => resolve(port));
  });
});

/**
 * A daemon of its own: a free port, a private TMPDIR and a private config directory, so a test
 * never touches the state, token or scratch of a bridge that is actually in use - nor the real
 * config directory, where a real Slack user token lives.
 */
export async function startBridge({ tmp, port: fixedPort, env = {} } = {}) {
  const port = fixedPort || await freePort();
  const dir = tmp || fs.mkdtempSync(path.join(os.tmpdir(), 'cc-bridge-test-'));
  const stateDir = path.join(dir, 'claude-ui-comments');
  // Derived from `dir` rather than freshly made, so a restart onto the same tmp keeps its config.
  const configDir = path.join(dir, 'config');
  fs.mkdirSync(configDir, { recursive: true });
  // A previous daemon's token would otherwise be read before this one writes its own.
  fs.rmSync(path.join(stateDir, `token-${port}`), { force: true });
  const child = spawn(process.execPath, [path.join(ROOT, 'bridge', 'server.mjs')], {
    // The config directory is the empty one above unless a test names its own - never the real
    // one, which holds a real Slack token. `env` comes last so a test can still override it.
    env: {
      ...process.env,
      LOCAL_ARTIFACT_PORT: String(port),
      TMPDIR: dir,
      LOCAL_ARTIFACT_CONFIG_DIR: configDir,
      ...env,
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const origin = `http://127.0.0.1:${port}`;
  const tokenFile = path.join(stateDir, `token-${port}`);

  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 50));
    if (fs.existsSync(tokenFile)) break;
  }
  const token = fs.readFileSync(tokenFile, 'utf8').trim();

  /** A request with the control token unless `token: null`; `json` sets the body and its type. */
  const request = (route, { method, json, body, headers = {}, token: tok = token } = {}) =>
    fetch(`${origin}${route}`, {
      method: method || (json || body ? 'POST' : 'GET'),
      redirect: 'manual',
      headers: {
        ...(tok ? { 'x-cc-token': tok } : {}),
        ...(json ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      body: json ? JSON.stringify(json) : body,
    });

  const stop = () => new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.once('exit', resolve);
    child.kill();
  });

  return { port, origin, dir, stateDir, configDir, token, request, stop, child };
}

/** Registers a session owned by this test process, which is alive for as long as the test is. */
export async function register(bridge, key = `p${process.pid}`) {
  const res = await bridge.request('/register', { json: { key, pid: process.pid, cwd: '/tmp/repo', repo: 'repo' } });
  if (!res.ok) throw new Error(`register ${res.status}`);
  return key;
}
