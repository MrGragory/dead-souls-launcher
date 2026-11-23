'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('node:dgram');
const { parseInfo, queryServer } = require('../src/server');

function infoPacket({ folder = 'dayz', players = 1, max = 40, version = '1.30.0' } = {}) {
  const str = (text) => Buffer.from(`${text}\0`, 'utf8');
  return Buffer.concat([
    Buffer.from([0xff, 0xff, 0xff, 0xff, 0x49, 17]),
    str('Dead Souls'),
    str('chernarusplus'),
    str(folder),
    str('DayZ'),
    Buffer.from([0, 0, players, max, 0, 0x64, 0x77, 0, 1]),
    str(version),
  ]);
}

test('A2S info parsing matches the DayZ fixture', () => {
  assert.deepEqual(parseInfo(infoPacket()), {
    name: 'Dead Souls',
    map: 'chernarusplus',
    players: 1,
    maxPlayers: 40,
    version: '1.30.0',
  });
});

test('query port answering with another game is rejected', () => {
  assert.throws(() => parseInfo(infoPacket({ folder: 'csgo' })), /не DayZ/);
});

test('truncated A2S response is rejected', () => {
  assert.throws(() => parseInfo(infoPacket().subarray(0, 20)), /обрезан/);
});

test('queryServer completes the challenge handshake', async () => {
  const challenge = Buffer.from([0xff, 0xff, 0xff, 0xff, 0x41, 1, 2, 3, 4]);
  const fake = dgram.createSocket('udp4');
  fake.on('message', (message, rinfo) => {
    fake.send(message.length === 25 ? challenge : infoPacket(), rinfo.port, rinfo.address);
  });
  await new Promise((resolve) => fake.bind(0, '127.0.0.1', resolve));
  try {
    const result = await queryServer({ host: '127.0.0.1', queryPort: fake.address().port, timeoutMs: 2000 });
    assert.equal(result.online, true);
    assert.equal(result.name, 'Dead Souls');
    assert.equal(result.players, 1);
    assert.equal(result.maxPlayers, 40);
    assert.ok(result.ping >= 0);
  } finally {
    fake.close();
  }
});

test('silent query port is reported offline after the timeout', async () => {
  const silent = dgram.createSocket('udp4');
  await new Promise((resolve) => silent.bind(0, '127.0.0.1', resolve));
  try {
    const result = await queryServer({ host: '127.0.0.1', queryPort: silent.address().port, timeoutMs: 200 });
    assert.deepEqual(result, { online: false, error: 'Нет ответа query-порта' });
  } finally {
    silent.close();
  }
});
