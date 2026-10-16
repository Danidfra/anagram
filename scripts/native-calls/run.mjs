import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'vite';
import { chromium } from '@playwright/test';
import { startIrohTestProxy } from '../iroh-test-proxy.cjs';

const browserOnly = process.argv.includes('--browser');
if (
  !browserOnly &&
  (process.env.GITHUB_ACTIONS !== 'true' || !['darwin', 'win32'].includes(process.platform))
)
  throw new Error(
    'Native mode requires a disposable macOS/Windows GitHub runner (test certificate trust). Use --browser for local harness checks.',
  );
const artifacts = resolve('.artifacts/native-calls', browserOnly ? 'browser' : process.platform);
await mkdir(artifacts, { recursive: true });
// Do not leave an earlier pass (or failure) beside a new interrupted run.
await Promise.all(
  ['result.json', 'failure.json', 'events.json'].map((file) =>
    rm(join(artifacts, file), { force: true }),
  ),
);
const directory = await mkdtemp(join(tmpdir(), 'anagram-native-calls-'));
const token = randomUUID();
const url = `http://127.0.0.1:5189/__native_calls?token=${token}&native=${browserOnly ? 0 : 1}`;
const children = [],
  logs = [],
  events = [];
let server,
  stopProxy,
  browser,
  removeTrust,
  lastStage = 'setup',
  finish,
  reject;
const result = new Promise((resolve, fail) => {
  finish = resolve;
  reject = fail;
});
// Build/startup errors can arrive before the runner awaits the probe result.
void result.catch(() => {});
const command = (file, args, options = {}) =>
  execFileSync(file, args, { encoding: 'utf8', ...options });
const launch = (file, args, name, env = process.env) => {
  const log = createWriteStream(join(artifacts, `${name}.log`));
  logs.push(log);
  const child = spawn(file, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  child.on('error', reject);
  children.push(child);
  return child;
};
const waitFor = async (check, milliseconds, description) => {
  const end = Date.now() + milliseconds;
  while (!(await check())) {
    if (Date.now() > end) throw new Error(`Timed out: ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
};
const startNativeProbe = (pid) => {
  if (process.platform === 'darwin') {
    command('osascript', [
      '-e',
      `tell application "System Events" to set frontmost of first process whose unix id is ${pid} to true`,
      '-e',
      'tell application "System Events" to key code 49',
    ]);
  } else {
    command('powershell', [
      '-NoProfile',
      '-Command',
      `$shell = New-Object -ComObject WScript.Shell; if (-not $shell.AppActivate(${pid})) { throw 'Cannot focus native app' }; Start-Sleep -Milliseconds 300; $shell.SendKeys(' ')`,
    ]);
  }
};
let app, timer;
try {
  const cert = join(directory, 'cert.pem');
  command(
    process.env.OPENSSL || 'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=Anagram disposable call test',
      '-addext',
      'subjectAltName=DNS:localhost,IP:127.0.0.1',
      '-keyout',
      join(directory, 'key.pem'),
      '-out',
      cert,
    ],
    { stdio: 'ignore' },
  );
  if (!browserOnly) {
    const fingerprint = command(process.env.OPENSSL || 'openssl', [
      'x509',
      '-in',
      cert,
      '-noout',
      '-fingerprint',
      '-sha1',
    ])
      .trim()
      .split('=')
      .at(-1)
      .replaceAll(':', '');
    if (process.platform === 'darwin') {
      command('sudo', [
        'security',
        'add-trusted-cert',
        '-d',
        '-r',
        'trustRoot',
        '-k',
        '/Library/Keychains/System.keychain',
        cert,
      ]);
      removeTrust = () =>
        command('sudo', [
          'security',
          'delete-certificate',
          '-Z',
          fingerprint,
          '/Library/Keychains/System.keychain',
        ]);
    } else {
      const escaped = cert.replaceAll("'", "''");
      command('powershell', [
        '-NoProfile',
        '-Command',
        `$ErrorActionPreference = 'Stop'; Import-Certificate -FilePath '${escaped}' -CertStoreLocation Cert:\\CurrentUser\\Root | Out-Null`,
      ]);
      removeTrust = () =>
        command('powershell', [
          '-NoProfile',
          '-Command',
          `$ErrorActionPreference = 'Stop'; Remove-Item 'Cert:\\CurrentUser\\Root\\${fingerprint}'`,
        ]);
    }
  }
  const relayConfig = join(directory, 'relay.toml');
  await writeFile(
    relayConfig,
    'http_bind_addr = "127.0.0.1:7003"\nenable_quic_addr_discovery = false\n',
  );
  const relay = launch(
    process.env.IROH_RELAY_BINARY || 'iroh-relay',
    ['--dev', '--config-path', relayConfig],
    'relay',
  );
  relay.on('exit', (code) => reject(new Error(`Iroh relay exited: ${code}`)));
  await waitFor(
    async () => {
      try {
        await fetch('http://127.0.0.1:7003/', { signal: AbortSignal.timeout(1000) });
        return true;
      } catch {
        return false;
      }
    },
    15000,
    'Iroh relay startup',
  );
  stopProxy = await startIrohTestProxy({ certificateDirectory: directory });
  server = await createServer({
    server: { host: '127.0.0.1', port: 5189, strictPort: true },
    plugins: [
      {
        name: 'native-call-probe',
        configureServer(vite) {
          vite.middlewares.use(async (request, response, next) => {
            const target = new URL(request.url, 'http://127.0.0.1:5189');
            if (!target.pathname.startsWith('/__native_calls')) return next();
            if (target.searchParams.get('token') !== token) {
              response.writeHead(403).end();
              return;
            }
            try {
              if (target.pathname === '/__native_calls/report' && request.method === 'POST') {
                let body = '';
                for await (const chunk of request) {
                  body += chunk;
                  if (body.length > 1000000) throw new Error('Oversized report');
                }
                const data = JSON.parse(body);
                events.push({ at: new Date().toISOString(), ...data });
                if (data.stage) {
                  lastStage = data.stage;
                  console.log(lastStage);
                }
                await writeFile(join(artifacts, 'events.json'), JSON.stringify(events, null, 2));
                response.writeHead(204).end();
                if (data.done) finish(data);
                if (data.stage === 'ready' && !browserOnly) {
                  // Generate a real user gesture; do not bypass native autoplay policy.
                  setTimeout(() => {
                    try {
                      startNativeProbe(app.pid);
                    } catch (error) {
                      reject(error);
                    }
                  }, 500);
                }
              } else if (target.pathname === '/__native_calls' && request.method === 'GET') {
                const html =
                  '<!doctype html><html><head><title>Anagram native call validation</title><style>video,canvas{width:120px;height:68px}pre{max-height:240px;overflow:auto}</style></head><body><button autofocus>Start call validation</button><pre>Loading</pre><div id="sources"></div><div id="players"></div><script type="module" src="/scripts/native-calls/probe.mjs"></script></body></html>';
                response.setHeader('Content-Type', 'text/html');
                response.end(await vite.transformIndexHtml(request.url, html));
              } else response.writeHead(404).end();
            } catch (error) {
              response.writeHead(500).end();
              reject(error);
            }
          });
        },
      },
    ],
  });
  await server.listen();
  if (browserOnly) {
    browser = await chromium.launch({
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
      args: ['--ignore-certificate-errors'],
    });
    const page = await browser.newPage({ ignoreHTTPSErrors: true });
    page.on('pageerror', reject);
    page.on('console', (message) => {
      if (message.type() === 'error') console.error(message.text());
    });
    await page.goto(url);
    await page.getByRole('button').click();
  } else {
    console.log('Building native debug app with isolated probe URL');
    const build = launch(
      'cargo',
      ['build', '--locked', '--manifest-path', 'src-tauri/Cargo.toml'],
      'build',
      { ...process.env, TAURI_CONFIG: JSON.stringify({ build: { devUrl: url } }) },
    );
    const buildTimer = setTimeout(() => build.kill(), 20 * 60 * 1000);
    const [code] = await once(build, 'exit');
    clearTimeout(buildTimer);
    if (code !== 0) throw new Error(`Native build failed (${code}); see build.log`);
    app = launch(
      resolve('src-tauri/target/debug', process.platform === 'win32' ? 'anagram.exe' : 'anagram'),
      [],
      'app',
    );
    app.on('exit', (code) =>
      reject(new Error(`Native app exited (${code}); last stage: ${lastStage}`)),
    );
  }
  timer = setTimeout(
    () => reject(new Error(`External 5-minute deadline; last stage: ${lastStage}`)),
    5 * 60 * 1000,
  );
  const completed = await result;
  await writeFile(
    join(artifacts, 'result.json'),
    JSON.stringify(
      {
        ...completed,
        commit: process.env.GITHUB_SHA,
        platform: process.platform,
        arch: process.arch,
      },
      null,
      2,
    ),
  );
  if (!completed.passed) throw new Error(completed.error);
  console.log(
    `PASS: ${browserOnly ? 'Chromium harness check' : 'native ' + process.platform} direct/four-person audio/video, sustained playback, reconnect, mute retention and hangup`,
  );
} catch (error) {
  await writeFile(
    join(artifacts, 'failure.json'),
    JSON.stringify({ error: String(error), lastStage }, null, 2),
  );
  console.error(error);
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  if (browser) await browser.close();
  for (const child of children.reverse()) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const exited = once(child, 'exit');
    child.kill();
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3000))]);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  if (stopProxy) await stopProxy();
  if (server) await server.close();
  if (removeTrust) {
    try {
      removeTrust();
    } catch (error) {
      console.error('Certificate cleanup failed', error);
      process.exitCode = 1;
    }
  }
  await rm(directory, { recursive: true, force: true });
  logs.forEach((log) => log.end());
}
