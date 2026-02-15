// ZSXQ (知识星球) digests UI helpers.
//
// Why UI-based:
// - Avoid calling signed API endpoints directly (x-signature etc).
// - Reuse the same click-path that a real user uses.

const { sleep } = require('../runtime/wait');

function norm(s) {
  return String(s || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function normalizeRowText(s) {
  return String(s || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function dateToYmdFromSlash(s) {
  const m = String(s || '').match(/(20\d{2})\/(\d{2})\/(\d{2})/);
  if (!m) return '';
  return `${m[1]}-${m[2]}-${m[3]}`;
}

function extractTopicIdFromUrl(u) {
  const url = String(u || '');
  let m = url.match(/[?&]topic_id=(\d+)/);
  if (m) return m[1];
  m = url.match(/\/topic\/(\d+)/);
  if (m) return m[1];
  m = url.match(/\/v2\/topics\/(\d+)/);
  if (m) return m[1];
  return '';
}

function parseDigestListItemText(rawText) {
  const text = normalizeRowText(rawText);
  if (!text) return { title: '', author: '', publishDate: '', dateOnly: '' };

  const lines = text.split('\n').map((x) => x.trim()).filter(Boolean);
  const dateSlash = (text.match(/20\d{2}\/\d{2}\/\d{2}/) || [])[0] || '';
  const dateOnly = dateToYmdFromSlash(dateSlash);

  // Title: first line that isn't like "赞 58; 评论 1" footer.
  let title = '';
  for (const ln of lines) {
    if (/^赞\s*\d+/.test(ln)) continue;
    if (/^评论\s*\d+/.test(ln)) continue;
    if (/20\d{2}\/\d{2}\/\d{2}/.test(ln) && ln.length < 40) continue;
    title = ln;
    break;
  }
  title = norm(title);

  // Author: usually in footer like "...  作者 · 2025/12/24"
  let author = '';
  const footer = lines.find((ln) => /20\d{2}\/\d{2}\/\d{2}/.test(ln)) || '';
  if (footer) {
    const m = footer.match(/(?:^|;|\s)([^;·]{1,30})\s*·\s*20\d{2}\/\d{2}\/\d{2}/);
    if (m) author = norm(m[1]);
  }

  const publishDate = dateOnly ? `${dateOnly} 00:00` : '';
  return { title, author, publishDate, dateOnly, raw: text };
}

async function waitForDigestItems(page) {
  const items = page.locator('.digest-topic-item');
  await items.first().waitFor({ state: 'attached', timeout: 60000 }).catch(() => {});
  await page.waitForLoadState('networkidle').catch(() => {});
  await sleep(300 + Math.floor(Math.random() * 400));
  return items;
}

async function humanScroll(page, rounds = 2) {
  for (let i = 0; i < rounds; i++) {
    const steps = 3 + Math.floor(Math.random() * 4);
    for (let s = 0; s < steps; s++) {
      await page.mouse.wheel(0, 300 + Math.floor(Math.random() * 700)).catch(() => {});
      await sleep(350 + Math.floor(Math.random() * 650));
    }
    if (Math.random() < 0.25) {
      await page.mouse.wheel(0, -200 - Math.floor(Math.random() * 400)).catch(() => {});
      await sleep(300 + Math.floor(Math.random() * 600));
    }
  }
}

async function clickDigestAndGetDetailPage(context, listPage, index = 0) {
  const items = await waitForDigestItems(listPage);
  const item = items.nth(index);
  await item.scrollIntoViewIfNeeded().catch(() => {});

  // Try capture topic id from API responses triggered by opening the detail.
  const respPromise = listPage
    .waitForResponse((r) => /\/v2\/topics\/\d+/.test(r.url()) && r.request().method() === 'GET', { timeout: 8000 })
    .catch(() => null);

  const popupPromise = context.waitForEvent('page', { timeout: 6000 }).catch(() => null);
  const beforeUrl = listPage.url();
  await item.click({ timeout: 15000 }).catch(() => {});

  const popup = await popupPromise;
  const detailPage = popup || listPage;

  if (popup) {
    await popup.waitForLoadState('domcontentloaded').catch(() => {});
    await sleep(500 + Math.floor(Math.random() * 600));
  } else {
    // If navigated within same tab, wait a bit.
    if (listPage.url() !== beforeUrl) {
      await listPage.waitForLoadState('domcontentloaded').catch(() => {});
    }
    await sleep(400 + Math.floor(Math.random() * 600));
  }

  let topicId = extractTopicIdFromUrl(detailPage.url());
  if (!topicId) {
    const resp = await respPromise;
    if (resp) {
      try {
        const u = resp.url();
        topicId = extractTopicIdFromUrl(u);
        if (!topicId) {
          const j = await resp.json();
          const fromJson = j && j.resp_data && j.resp_data.topic && j.resp_data.topic.topic_id;
          if (fromJson) topicId = String(fromJson);
        }
      } catch (_) {}
    }
  }

  return { topicId, detailPage, openedPopup: !!popup };
}

async function extractFeishuLinkFromDetailPage(context, page) {
  // 1) Direct feishu/lark href
  const direct = page.locator("a[href*='feishu'], a[href*='lark']").first();
  if ((await direct.count().catch(() => 0)) > 0) {
    const href = await direct.getAttribute('href').catch(() => '');
    if (href) return href;
  }

  // 2) Anchors by text, then click to capture the opened tab URL.
  const candidate = page.locator('a').filter({ hasText: /飞书|云文档|Feishu|Lark/i }).first();
  if ((await candidate.count().catch(() => 0)) === 0) return '';

  const href = await candidate.getAttribute('href').catch(() => '');
  if (href && /^https?:\/\//i.test(href) && /(feishu|lark)\./i.test(href)) return href;

  const popupPromise = context.waitForEvent('page', { timeout: 10000 }).catch(() => null);
  await candidate.click({ timeout: 10000 }).catch(() => {});
  const popup = await popupPromise;
  if (!popup) return '';

  await popup.waitForLoadState('domcontentloaded').catch(() => {});
  await sleep(1000 + Math.floor(Math.random() * 1200));
  const u = popup.url();
  await popup.close().catch(() => {});
  if (/(feishu|lark)\./i.test(u)) return u;
  return u || '';
}

async function extractPublishDateFromDetailPage(page) {
  // Best-effort: look for "2026/02/11" style in page text.
  const txt = await page.evaluate(() => (document.body && document.body.innerText ? document.body.innerText : '')).catch(() => '');
  const m = String(txt || '').match(/(20\d{2})\/(\d{2})\/(\d{2})/);
  if (!m) return '';
  return `${m[1]}-${m[2]}-${m[3]} 00:00`;
}

async function extractTypeTagsFromDetailPage(page) {
  // Topic detail page usually shows custom tags near the bottom as clickable "chips".
  // We keep this heuristic-based to tolerate DOM changes.
  const bad = new Set([
    '精华主题',
    '最新发布',
    '最早发布',
    '返回',
    '首页',
    '赞',
    '评论',
    '分享',
    '收藏'
  ]);

  const tags = await page
    .evaluate(() => {
      const texts = [];
      const sels = [
        '.tag',
        '.tags .tag',
        '.topic-tag',
        '.topic-tags .tag',
        '.hashtag',
        'a.hashtag',
        'span.hashtag',
        "a[href*='#']",
        "a[href*='hashtag']"
      ];
      const seen = new Set();
      for (const sel of sels) {
        for (const el of Array.from(document.querySelectorAll(sel))) {
          const t = (el.textContent || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
          if (!t) continue;
          if (seen.has(t)) continue;
          seen.add(t);
          texts.push(t);
        }
      }
      return texts;
    })
    .catch(() => []);

  const cleaned = [];
  const seen2 = new Set();
  for (let t of tags) {
    t = String(t || '').trim();
    if (!t) continue;
    if (t.startsWith('#')) t = t.replace(/^#+\s*/, '').trim();
    if (!t) continue;
    if (bad.has(t)) continue;
    if (/20\d{2}\/\d{2}\/\d{2}/.test(t)) continue;
    if (t.length > 18) continue; // chips are usually short
    if (/[;；]/.test(t)) continue;
    if (seen2.has(t)) continue;
    seen2.add(t);
    cleaned.push(t);
  }

  // If we accidentally captured too many unrelated chips, keep the last few.
  const result = cleaned.length > 10 ? cleaned.slice(-10) : cleaned;
  return result.join(',');
}

module.exports = {
  norm,
  normalizeRowText,
  extractTopicIdFromUrl,
  parseDigestListItemText,
  waitForDigestItems,
  humanScroll,
  clickDigestAndGetDetailPage,
  extractFeishuLinkFromDetailPage,
  extractPublishDateFromDetailPage,
  extractTypeTagsFromDetailPage
};
