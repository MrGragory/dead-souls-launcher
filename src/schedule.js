'use strict';

const MSK_OFFSET_MS = 3 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const STABLE_ELAPSED_MS = 30 * 1000;

function restartInstants(hours, nowMs) {
  const msk = new Date(nowMs + MSK_OFFSET_MS);
  const year = msk.getUTCFullYear();
  const month = msk.getUTCMonth();
  const day = msk.getUTCDate();
  const instants = [];
  for (let offset = -1; offset <= 2; offset += 1) {
    for (const hour of hours) instants.push(Date.UTC(year, month, day + offset, hour) - MSK_OFFSET_MS);
  }
  return instants.sort((a, b) => a - b);
}

class RestartPolicy {
  constructor() {
    this.observedBoundary = null;
    this.sawOffline = false;
    this.consecutiveOnline = 0;
  }

  evaluate(server, nowMs, online, newProbe = false) {
    const instants = restartInstants(server.restartHoursMsk, nowMs);
    const next = instants.find((instant) => instant > nowMs);
    const last = instants.filter((instant) => instant <= nowMs).at(-1);
    if (this.observedBoundary !== last) {
      this.observedBoundary = last;
      this.sawOffline = false;
      this.consecutiveOnline = 0;
    }
    if (newProbe) {
      if (online) {
        this.consecutiveOnline += 1;
      } else {
        this.sawOffline = true;
        this.consecutiveOnline = 0;
      }
    }
    const untilMs = next - nowMs;
    if (untilMs <= server.blockMinutes * MINUTE_MS) {
      const minutes = Math.ceil(untilMs / MINUTE_MS);
      return {
        blocked: true,
        message:
          minutes <= 1
            ? 'Сервер будет перезапущен менее чем через минуту. Подключитесь к серверу позже.'
            : `Сервер будет перезапущен через ${minutes} мин. Подключитесь к серверу позже.`,
        nextUtc: next,
      };
    }
    const elapsed = nowMs - last;
    const stable = this.sawOffline && this.consecutiveOnline >= 2 && elapsed >= STABLE_ELAPSED_MS;
    if (elapsed < server.postRestartGuardMinutes * MINUTE_MS && !stable) {
      return {
        blocked: true,
        message: 'Ожидание перезапуска сервера. Подключитесь к серверу позже.',
        nextUtc: next,
      };
    }
    return {
      blocked: false,
      message: online
        ? 'Подключение доступно после проверки модов'
        : 'Сервер не отвечает или находится на обслуживании',
      nextUtc: next,
    };
  }
}

module.exports = { RestartPolicy };
