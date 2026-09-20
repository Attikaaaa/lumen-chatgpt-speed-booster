/**
 * Runs the DOM benchmark in real (non-virtual) time: spawns headless Chrome,
 * waits for the LUMEN_DOM result on stderr, then kills the browser.
 * Chrome location: CHROME_BIN env override, otherwise platform default.
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const CHROME =
  process.env.CHROME_BIN ||
  (process.platform === 'win32'
    ? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
    : process.platform === 'darwin'
      ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
      : 'google-chrome');

const PAGE = 'file:///' + path.resolve(__dirname, 'bench-dom.html').replace(/\\/g, '/');

const proc = spawn(CHROME, [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--user-data-dir=' + __dirname + '/chrome-tmp-profile',
  '--enable-logging=stderr',
  '--v=0',
  PAGE
], { stdio: ['ignore', 'ignore', 'pipe'] });

let buffer = '';
const killer = setTimeout(() => {
  console.error('TIMEOUT — no result in 180s');
  proc.kill();
  process.exit(1);
}, 180000);

proc.stderr.on('data', chunk => {
  buffer += chunk.toString();
  const match = buffer.match(/LUMEN_DOM \{.*\}/);
  if (match) {
    clearTimeout(killer);
    proc.kill();
    const data = JSON.parse(match[0].slice('LUMEN_DOM '.length));
    console.log(JSON.stringify(data, null, 2));
    process.exit(0);
  }
});
