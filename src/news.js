'use strict';

const { verifyPayload } = require('./config');

const NEWS_URL = 'https://MrGragory.github.io/dead-souls-launcher/news.signed.json';
const MAX_ITEMS = 200;

function str(value) {
  return typeof value === 'string' ? value : '';
}

function safeLink(value) {
  try {
    const { protocol } = new URL(value);
    return protocol === 'https:' || protocol === 'steam:' ? value : '';
  } catch {
    return '';
  }
}

function verifyNews(envelopeText, publicKeyPem, minRevision) {
  const feed = JSON.parse(verifyPayload(envelopeText, publicKeyPem).toString('utf8'));
  if (!Number.isSafeInteger(feed.revision) || feed.revision < 0) throw new Error('Неверная лента новостей');
  if (feed.revision < minRevision) throw new Error('Откат ленты новостей запрещён');
  const items = (Array.isArray(feed.items) ? feed.items : []).slice(0, MAX_ITEMS).map((item) => ({
    date: str(item?.date),
    title: str(item?.title),
    text: str(item?.text),
    url: safeLink(item?.url),
  }));
  return { revision: feed.revision, items };
}

module.exports = { NEWS_URL, verifyNews };
