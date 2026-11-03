// Development tool: screenshots of the local site in headless Edge or Chrome, signed in as
// one of the local test accounts (scripts/seed-local.js). Zero dependencies (Node 22+).
// Usage: node scripts/shot.js <hash> <out.png> [--as storyteller|ana|ben|none] [--size 1400x900] [--wait ms]
//                                              [--click "<css selector>"] [--eval "<js>"] ...
// Steps run in order after the page settles: --click clicks the first match, --eval runs an
// expression (promises are awaited). In Git Bash, set MSYS_NO_PATHCONV=1 first, or it
// rewrites "#/t/..." into a Windows path.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const flag = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args.splice(i, 2)[1] : dflt; };
const steps = [];
for (let i = 0; i < args.length;) {
  if (args[i] === '--click' || args[i] === '--eval') steps.push([args[i].slice(2), args.splice(i, 2)[1]]);
  else i++;
}
const who = flag('as', 'storyteller');
const [w, h] = flag('size', '1400x900').split('x').map(Number);
const settle = Number(flag('wait', 1800));
const [hash = '#/', out = 'shot.png'] = args;
const base = process.env.ELYSIUM_URL || 'http://localhost:4890/';

const root = fileURLToPath(new URL('..', import.meta.url));
// --as none stays signed out
const account = who === 'none' ? null : JSON.parse(readFileSync(join(root, '.local/test-users.json'), 'utf8'))[who];
const browsers = [
  join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe'),
  join(process.env.ProgramFiles || 'C:\\Program Files', 'Google/Chrome/Application/chrome.exe'),
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];
const exe = process.env.ELYSIUM_BROWSER || browsers.find((b) => existsSync(b));
if (!exe) throw new Error('No Edge or Chrome found; set ELYSIUM_BROWSER.');

const profile = mkdtempSync(join(tmpdir(), 'elysium-shot-'));
const child = spawn(exe, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, `--window-size=${w},${h}`,
  '--no-first-run', '--no-default-browser-check', '--autoplay-policy=no-user-gesture-required', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  let port = null;
  for (let i = 0; i < 100 && !port; i++) {
    try { port = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]; } catch { await sleep(100); }
  }
  if (!port) throw new Error('the browser never opened its DevTools port');
  const target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0;
  const waiting = new Map();
  const logs = [];
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.method === 'Runtime.exceptionThrown') logs.push(msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text);
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') logs.push(msg.params.args.map((a) => a.value ?? a.description).join(' '));
    if (waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); }
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const n = ++id;
    waiting.set(n, (msg) => (msg.error ? reject(new Error(`${method}: ${msg.error.message}`)) : resolve(msg.result)));
    ws.send(JSON.stringify({ id: n, method, params }));
  });
  const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.value;
  const waitFor = async (expression, ms = 8000) => {
    for (let t = 0; t < ms; t += 100) { if (await evaluate(expression)) return true; await sleep(100); }
    throw new Error(`timed out waiting for ${expression}`);
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 700 });
  await send('Page.navigate', { url: `${base}#/signin` });
  await waitFor(`!!document.querySelector('input[type=email]') || !!document.querySelector('.topbar')`);
  if (account && await evaluate(`!!document.querySelector('input[type=email]')`)) {
    await evaluate(`(() => {
      const set = (sel, v) => { const i = document.querySelector(sel); i.value = v; i.dispatchEvent(new Event('input', { bubbles: true })); };
      set('input[type=email]', ${JSON.stringify(account.email)});
      set('input[type=password]', ${JSON.stringify(account.password)});
      document.querySelector('form').requestSubmit();
    })()`);
    await waitFor(`location.hash === '#/' && !!document.querySelector('.topbar')`);
  }
  await send('Page.navigate', { url: `${base}${hash}` });
  await sleep(settle);
  for (const [kind, value] of steps) {
    await evaluate(kind === 'click' ? `document.querySelector(${JSON.stringify(value)})?.click()` : value);
    await sleep(900);
  }
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(out, Buffer.from(shot.data, 'base64'));
  console.log(`saved ${out} at ${await evaluate('location.hash')}${logs.length ? `\npage errors:\n  ${logs.join('\n  ')}` : ''}`);
  ws.close();
} finally {
  child.kill();
  await sleep(300);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* the browser may still hold it */ }
}
