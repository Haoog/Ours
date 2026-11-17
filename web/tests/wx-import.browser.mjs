// Run the synthetic browser test with an isolated headless Chrome profile.
// Node 22+ is required for its built-in WebSocket client; no npm package or
// external network is used. WX_IMPORT_CHROME can specify the Chrome executable.
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

if (typeof WebSocket !== 'function') throw new Error('浏览器测试需要 Node 22 或更新版本。');
const executable = process.env.WX_IMPORT_CHROME || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : 'google-chrome');
const profile = await mkdtemp(join(tmpdir(), 'wx-import-browser-'));
const page = new URL('./wx-import.browser.html', import.meta.url).href;
const chrome = spawn(executable, [
  '--headless=new', '--disable-gpu', '--disable-background-networking', '--host-resolver-rules=MAP * ~NOTFOUND',
  '--no-first-run', '--no-default-browser-check', '--allow-file-access-from-files', '--remote-debugging-port=0',
  `--user-data-dir=${profile}`, page,
], { stdio: ['ignore', 'ignore', 'pipe'] });
chrome.stderr.resume();
let launchError;
chrome.on('error', error => { launchError = error; });
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
let socket;
try {
  let port;
  for (let attempt = 0; attempt < 200 && !port; attempt++) {
    if (launchError || chrome.exitCode !== null) throw launchError || new Error('Chrome 提前退出。');
    try { port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); } catch { await delay(50); }
  }
  if (!port) throw new Error('Chrome 调试端口未启动。');
  let target;
  for (let attempt = 0; attempt < 200 && !target; attempt++) {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`);
    target = (await response.json()).find(item => item.type === 'page' && item.url === page);
    if (!target) await delay(50);
  }
  if (!target) throw new Error(`未打开测试页面：${fileURLToPath(page)}`);
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let sequence = 0;
  const pending = new Map();
  socket.addEventListener('message', event => {
    const response = JSON.parse(event.data);
    if (!pending.has(response.id)) return;
    const { resolve, reject } = pending.get(response.id); pending.delete(response.id);
    if (response.error) reject(new Error(response.error.message)); else resolve(response.result);
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params }));
  });
  let state;
  for (let attempt = 0; attempt < 200; attempt++) {
    const response = await request('Runtime.evaluate', {
      expression: '({result: document.documentElement.dataset.result || null, text: document.querySelector("#result")?.textContent || ""})',
      returnByValue: true,
    });
    state = response.result.value;
    if (state.result) break;
    await delay(50);
  }
  if (state?.result !== 'pass') throw new Error(state?.text || '浏览器测试超时。');
  console.log(state.text);
} finally {
  if (socket) socket.close();
  chrome.kill();
  if (chrome.exitCode === null && !launchError) await Promise.race([new Promise(resolve => chrome.once('close', resolve)), delay(3000)]);
  await rm(profile, { recursive: true, force: true });
}
