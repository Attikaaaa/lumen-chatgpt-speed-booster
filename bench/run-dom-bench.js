/**
 * Runs the DOM benchmark in real (non-virtual) time: spawns headless Chrome,
 * waits for the LUMEN_DOM result on stderr, then kills the browser.
 */
const { spawn } = require('child_process');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PAGE = 'file:///C:/Users/azrip/AppData/Local/Temp/opencode/bench-dom.html';

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
