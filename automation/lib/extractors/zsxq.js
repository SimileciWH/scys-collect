const { sleep } = require('../runtime/wait');
const { norm } = require('../io/csv');

function extractTopicId(articleLink) {
  const s = String(articleLink || '');
  let m = s.match(/[?&]topic_id=(\d+)/);
  if (m) return m[1];
  m = s.match(/\/topic\/(\d+)/);
  if (m) return m[1];
  m = s.match(/\/group\/\d+\/topic\/(\d+)/);
  if (m) return m[1];
  return '';
}

function fmtDate(raw) {
  const s = norm(raw);
  if (!s) return '';
  const full = s.match(/(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})[ T](\d{1,2}):(\d{2})/);
  if (full) {
    return `${full[1]}-${String(full[2]).padStart(2, '0')}-${String(full[3]).padStart(2, '0')} ${String(full[4]).padStart(2, '0')}:${full[5]}`;
  }
  return '';
}

function fmtDateFromCreateTime(raw) {
  const t = norm(raw);
  // Example: 2025-05-25T03:44:52.640+0800
  const m = t.match(/(20\d{2})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return '';
  return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}`;
}

function firstFeishuLinkFromJson(topicJson) {
  const all = JSON.stringify(topicJson || {});
  const links = all.match(/https?:\/\/[^\s"\\]+/g) || [];
  for (const link of links) {
    if (/(feishu|lark)\./i.test(link)) return link;
  }
  return '';
}

function extractRegionFromJson(topicJson) {
  const text = JSON.stringify(topicJson || {});
  const m = text.match(/((?:[\u4e00-\u9fa5]+(?:省|市|自治区|特别行政区))(?:\/[\u4e00-\u9fa5]+(?:市|区|县|旗|州|盟|自治州|自治县)){1,3})/);
  return m ? m[1] : '';
}

async function fetchTopicPayload(context, page, topicId, articleLink) {
  let payload = '';
  page.on('response', async (res) => {
    const u = res.url();
    if (u.includes(`/v2/topics/${topicId}`)) {
      try {
        payload = await res.text();
      } catch (_) {}
    }
  });

  await page.goto(articleLink, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForLoadState('networkidle').catch(() => {});
  await sleep(1200);

  // Some endpoints under wx.zsxq.com return HTML for /v2/topics/*.
  // Prefer JSON; otherwise fall back to pub-api.
  if (payload) {
    const s = String(payload).trimStart();
    if (s.startsWith('{')) {
      try {
        const j = JSON.parse(payload);
        if (j && j.resp_data && j.resp_data.topic) return payload;
      } catch (_) {}
    }
    payload = '';
  }

  const r = await context.request.get(`https://pub-api.zsxq.com/v2/topics/${topicId}`);
  if (r.ok()) return await r.text();
  return '';
}

module.exports = {
  extractTopicId,
  fmtDate,
  fmtDateFromCreateTime,
  firstFeishuLinkFromJson,
  extractRegionFromJson,
  fetchTopicPayload
};
