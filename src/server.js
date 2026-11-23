'use strict';

const dgram = require('node:dgram');

const HEADER = Buffer.from([0xff, 0xff, 0xff, 0xff]);
const INFO_REQUEST = Buffer.concat([HEADER, Buffer.from('TSource Engine Query\0', 'latin1')]);
const CHALLENGE_REPLY = 0x41;
const INFO_REPLY = 0x49;
const MAX_STRING = 4096;
const INFO_FIXED_BYTES = 9;

function parseInfo(buffer) {
  if (buffer.length < 6 || !buffer.subarray(0, 4).equals(HEADER)) {
    throw new Error('Фрагментированный или сжатый A2S-пакет в этой версии не поддерживается');
  }
  if (buffer[4] !== INFO_REPLY) throw new Error('Неизвестный A2S-ответ');
  let pos = 6;
  const readString = () => {
    const end = buffer.indexOf(0, pos);
    if (end === -1 || end - pos > MAX_STRING) throw new Error('Ответ сервера обрезан');
    const value = buffer.toString('utf8', pos, end);
    pos = end + 1;
    return value;
  };
  const name = readString();
  const map = readString();
  const folder = readString();
  readString();
  if (buffer.length < pos + INFO_FIXED_BYTES) throw new Error('Ответ сервера обрезан');
  const players = buffer[pos + 2];
  const maxPlayers = buffer[pos + 3];
  pos += INFO_FIXED_BYTES;
  const version = readString();
  if (!folder.toLowerCase().includes('dayz')) throw new Error('На query-порту не DayZ');
  return { name, map, players, maxPlayers, version };
}

function queryServer({ host, queryPort, timeoutMs = 4000 }) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    const startedAt = performance.now();
    let settled = false;
    let timer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      resolve(result);
    };
    const fail = (error) => finish({ online: false, error });
    const send = (payload) => {
      socket.send(payload, queryPort, host, (error) => {
        if (error) fail(error.message);
      });
    };
    timer = setTimeout(() => fail('Нет ответа query-порта'), timeoutMs);
    socket.on('error', (error) => fail(error.message));
    socket.on('message', (message) => {
      try {
        if (message.length >= 9 && message[4] === CHALLENGE_REPLY) {
          send(Buffer.concat([INFO_REQUEST, message.subarray(5, 9)]));
          return;
        }
        const info = parseInfo(message);
        finish({ online: true, ...info, ping: Math.round(performance.now() - startedAt) });
      } catch (error) {
        fail(error.message);
      }
    });
    send(INFO_REQUEST);
  });
}

module.exports = { queryServer, parseInfo };
