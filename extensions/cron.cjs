'use strict';

// Five-field cron schedules (minute hour day-of-month month day-of-week) and a
// scheduler that runs saved jobs through the local shell while it is started.
const { spawn } = require('node:child_process');
const { shellCommand, shellEnvironment } = require('./common.cjs');

const FIELDS = [['minute', 0, 59], ['hour', 0, 23], ['day', 1, 31], ['month', 1, 12], ['weekday', 0, 7]];
const ALIASES = { '@hourly': '0 * * * *', '@daily': '0 0 * * *', '@midnight': '0 0 * * *', '@weekly': '0 0 * * 0', '@monthly': '0 0 1 * *', '@yearly': '0 0 1 1 *', '@annually': '0 0 1 1 *' };
const MAX_OUTPUT = 64 * 1024;
const MAX_RUNTIME = 60 * 60 * 1000;

function parseField(text, [name, min, max]) {
  const values = new Set();
  for (const part of text.split(',')) {
    const match = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
    if (!match) throw new Error(`Invalid ${name} field "${part}"`);
    const step = match[4] ? Number(match[4]) : 1;
    let start = match[1] === '*' ? min : Number(match[2]);
    let end = match[1] === '*' ? max : match[3] !== undefined ? Number(match[3]) : (match[4] ? max : start);
    if (start < min || end > max || start > end || step < 1) throw new Error(`The ${name} field must stay within ${min}-${max}`);
    for (let value = start; value <= end; value += step) values.add(name === 'weekday' && value === 7 ? 0 : value);
  }
  return { values, any: text === '*' };
}

function parseSchedule(expression) {
  const text = String(expression || '').trim().toLowerCase();
  const fields = (ALIASES[text] || text).split(/\s+/);
  if (fields.length !== 5) throw new Error('A schedule needs five fields: minute hour day month weekday (or @hourly, @daily, @weekly, @monthly)');
  const [minute, hour, day, month, weekday] = fields.map((field, index) => parseField(field, FIELDS[index]));
  return { minute, hour, day, month, weekday };
}

function matches(schedule, date) {
  const parsed = typeof schedule === 'string' ? parseSchedule(schedule) : schedule;
  if (!parsed.minute.values.has(date.getMinutes()) || !parsed.hour.values.has(date.getHours()) || !parsed.month.values.has(date.getMonth() + 1)) return false;
  const day = parsed.day.values.has(date.getDate()), weekday = parsed.weekday.values.has(date.getDay());
  // Standard cron: when both day fields are restricted, either may match.
  if (!parsed.day.any && !parsed.weekday.any) return day || weekday;
  return day && weekday;
}

// Next matching minute after `from`, searching up to about four years ahead.
function nextRun(schedule, from = new Date()) {
  const parsed = typeof schedule === 'string' ? parseSchedule(schedule) : schedule;
  const date = new Date(from); date.setSeconds(0, 0); date.setMinutes(date.getMinutes() + 1);
  for (let i = 0; i < 4 * 366 * 24 * 60; i++) {
    if (matches(parsed, date)) return date;
    if (!parsed.month.values.has(date.getMonth() + 1)) { date.setMonth(date.getMonth() + 1, 1); date.setHours(0, 0, 0, 0); continue; }
    if (!parsed.hour.values.has(date.getHours())) { date.setHours(date.getHours() + 1, 0, 0, 0); continue; }
    date.setMinutes(date.getMinutes() + 1);
  }
  return null;
}

function runCommand(command, { shell, timeout = MAX_RUNTIME } = {}) {
  return new Promise(resolve => {
    const started = Date.now();
    const [file, args] = shellCommand(shell).exec(command);
    let output = '', timedOut = false;
    const add = data => { if (output.length < MAX_OUTPUT) output = (output + data.toString()).slice(0, MAX_OUTPUT); };
    let child;
    try { child = spawn(file, args, { env: shellEnvironment(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (error) { resolve({ started, finished: Date.now(), exitCode: -1, output: error.message }); return; }
    child.stdout.on('data', add); child.stderr.on('data', add);
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeout);
    child.on('error', error => add(`${error.message}\n`));
    child.on('close', code => { clearTimeout(timer); resolve({ started, finished: Date.now(), exitCode: code ?? -1, output: output + (timedOut ? '\n[Stopped after the time limit.]' : '') }); });
  });
}

class CronScheduler {
  constructor({ jobs, onResult, shell } = {}) {
    this.jobs = jobs; this.onResult = onResult; this.shell = shell; this.timer = null; this.running = new Set(); this.results = new Map();
  }
  start() {
    if (this.timer) return;
    const tick = () => {
      const now = new Date();
      this.timer = setTimeout(tick, 60000 - (now.getSeconds() * 1000 + now.getMilliseconds()) + 50);
      this.timer.unref?.();
      for (const job of this.jobs() || []) {
        if (!job.enabled) continue;
        try { if (matches(job.schedule, now)) this.run(job); } catch {}
      }
    };
    const now = new Date();
    this.timer = setTimeout(tick, 60000 - (now.getSeconds() * 1000 + now.getMilliseconds()) + 50);
    this.timer.unref?.();
  }
  stop() { clearTimeout(this.timer); this.timer = null; }
  // A job never overlaps itself; a run that is still going skips the next one.
  async run(job) {
    if (this.running.has(job.id)) return { skipped: true };
    this.running.add(job.id);
    try {
      const result = { id: job.id, ...(await runCommand(job.command, { shell: job.shell || this.shell })) };
      this.results.set(job.id, result); this.onResult?.(result);
      return result;
    } finally { this.running.delete(job.id); }
  }
}

module.exports = { parseSchedule, matches, nextRun, runCommand, CronScheduler };
