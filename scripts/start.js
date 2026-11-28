#!/usr/bin/env node
/**
 * `npm start` / `npm run dev`: launch Electron on this project from source.
 *
 * ELECTRON_RUN_AS_NODE makes Electron behave as plain Node and the app never
 * opens. Some editors and terminals set it, so it is removed from the child's
 * environment. Doing this in Node instead of `env -u` lets the scripts run
 * from PowerShell and cmd.exe on Windows, not only from a Unix shell.
 *
 * Extra arguments are passed to Electron (for example `--disable-gpu`).
 */

const { spawn } = require('child_process');
const path = require('path');

let electronPath;
try {
  // In Node, the electron package exports the path to its binary.
  electronPath = require('electron');
} catch (_) {
  console.error('Electron is not installed. Run "npm install" in the project folder, then try again.');
  process.exit(1);
}

if (typeof electronPath !== 'string' || !electronPath) {
  console.error('Could not find the Electron binary. Run "npm install" again, then retry.');
  process.exit(1);
}

const env = {};
for (const [name, value] of Object.entries(process.env)) {
  // Windows variable names are case-insensitive.
  if (name.toUpperCase() === 'ELECTRON_RUN_AS_NODE') continue;
  env[name] = value;
}

const projectDir = path.resolve(__dirname, '..');
const child = spawn(electronPath, [projectDir, ...process.argv.slice(2)], {
  cwd: projectDir,
  env,
  stdio: 'inherit',
  windowsHide: false,
});

child.on('error', (error) => {
  console.error(`Could not start Electron: ${error.message}`);
  process.exit(1);
});

// Pass Ctrl+C and termination on to Electron so it can shut down cleanly.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (!child.killed) child.kill(signal);
  });
}

child.on('exit', (code, signal) => {
  if (signal) {
    process.exit(signal === 'SIGINT' ? 130 : 1);
  }
  process.exit(code === null ? 1 : code);
});
