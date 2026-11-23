'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { RestartPolicy } = require('../src/schedule');

const server = { restartHoursMsk: [0, 3, 6, 9, 12, 15, 18, 21], blockMinutes: 5, postRestartGuardMinutes: 6 };
const at = (time) => Date.parse(`2026-11-16T${time}+03:00`);

test('connections stay open until 5 minutes before a restart', () => {
  assert.equal(new RestartPolicy().evaluate(server, at('11:54:59'), true).blocked, false);
  assert.equal(new RestartPolicy().evaluate(server, at('11:55:00'), true).blocked, true);
});

test('one minute before restart shows the short message', () => {
  assert.match(new RestartPolicy().evaluate(server, at('11:59:01'), true).message, /менее чем через минуту/);
});

test('exact restart and an old server still answering stay blocked', () => {
  assert.equal(new RestartPolicy().evaluate(server, at('12:00:00'), true).blocked, true);
  assert.equal(new RestartPolicy().evaluate(server, at('12:03:00'), true).blocked, true);
});

test('guard window ends after 6 minutes', () => {
  assert.equal(new RestartPolicy().evaluate(server, at('12:06:00'), true).blocked, false);
});

test('observed offline followed by two successful probes unlocks the server', () => {
  const policy = new RestartPolicy();
  assert.equal(policy.evaluate(server, at('12:01:00'), false, true).blocked, true);
  assert.equal(policy.evaluate(server, at('12:02:00'), true, true).blocked, true);
  assert.equal(policy.evaluate(server, at('12:02:15'), true, true).blocked, false);
});

test('midnight wrap points to the next day restart', () => {
  const result = new RestartPolicy().evaluate(server, at('23:56:00'), true);
  assert.equal(result.blocked, true);
  assert.equal(new Date(result.nextUtc + 3 * 3600_000).getUTCDate(), 17);
});

test('gate depends on the instant, not the local timezone', () => {
  const instant = Date.parse('2026-11-16T00:56:00-08:00');
  assert.equal(instant, at('11:56:00'));
  assert.equal(new RestartPolicy().evaluate(server, instant, true).blocked, true);
});
