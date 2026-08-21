/**
 * Inline Node program that observes the Harness Host's private control pipe
 * and terminates its managed process group when ownership is lost. Windows
 * additionally uses kernel Job ownership to contain every descendant.
 * @module dsh-subprocess-local/parent-death-guardian
 */

/**
 * Guardian source passed to the current Node executable through `-e`. The
 * parent writes one JSON launch line to stdin and keeps that pipe open. EOF means
 * the parent can no longer own cleanup, so the guardian force-stops the actual
 * command group before exiting. fd 3 reports only actual-command spawn errors;
 * stdout and stderr remain byte-exact command streams.
 */
export const PARENT_DEATH_GUARDIAN_SOURCE = String.raw`
const { spawn, spawnSync } = require('node:child_process');
const { createWriteStream } = require('node:fs');

const control = process.stdin;
const status = createWriteStream(null, { fd: 3 });
let input = '';
let command;
let ownerGone = false;
let launched = false;
let reportingFailure = false;

function reportSpawnError(error) {
  reportingFailure = true;
  const record = {
    message: error instanceof Error ? error.message : String(error),
    ...(typeof error?.code === 'string' ? { code: error.code } : {}),
    ...(typeof error?.path === 'string' ? { path: error.path } : {}),
    ...(typeof error?.syscall === 'string' ? { syscall: error.syscall } : {}),
  };
  status.end(JSON.stringify(record) + '\n', () => { process.exit(127); });
}

function terminateForOwnerLoss() {
  if (command?.pid === undefined) {
    process.exitCode = 70;
    return;
  }
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(command.pid), '/T', '/F'], { stdio: 'ignore' });
    process.exit(70);
  }
  try {
    process.kill(-process.pid, 'SIGKILL');
  } catch {
    try { command.kill('SIGKILL'); } catch {}
    process.exit(70);
  }
}

function launch(line) {
  if (launched) return;
  launched = true;
  let argv;
  let stdin;
  try {
    const launch = JSON.parse(line);
    argv = launch.argv;
    stdin = launch.stdin;
    if (!Array.isArray(argv) || argv.length === 0 || argv.some(value => typeof value !== 'string')
      || (launch.stdin !== undefined && typeof launch.stdin !== 'string')) {
      throw new Error('guardian received invalid argv');
    }
  } catch (error) {
    reportSpawnError(error);
    return;
  }
  command = spawn(argv[0], argv.slice(1), {
    cwd: process.cwd(),
    env: process.env,
    stdio: [stdin === undefined ? 'ignore' : 'pipe', 'inherit', 'inherit'],
  });
  command.once('error', (error) => {
    reportSpawnError(error);
  });
  command.once('spawn', () => { status.end(); });
  if (stdin !== undefined) command.stdin.end(stdin);
  command.once('close', (code, signal) => {
    if (reportingFailure) return;
    if (ownerGone) return terminateForOwnerLoss();
    if (signal !== null && process.platform !== 'win32') {
      try { process.kill(process.pid, signal); } catch { process.exitCode = 1; }
      return;
    }
    process.exit(code ?? 1);
  });
  if (ownerGone) terminateForOwnerLoss();
}

control.setEncoding('utf8');
control.on('data', (chunk) => {
  input += chunk;
  const newline = input.indexOf('\n');
  if (newline !== -1) launch(input.slice(0, newline));
});
control.once('end', () => {
  ownerGone = true;
  if (!launched || command !== undefined) terminateForOwnerLoss();
});
control.once('error', () => {
  ownerGone = true;
  if (!launched || command !== undefined) terminateForOwnerLoss();
});
`
