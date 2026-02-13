const fs = require('fs');
const path = require('path');
const { launchContext, closeContext } = require('./browserContext');

const config = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'config.json'), 'utf-8'));
const FORM_URL = 'https://ucnbnmgoiyel.feishu.cn/share/base/form/shrcnetYBXcFx13cg9Cx0KmaCsf';

const targets = [
  {
    title: '【大学老师初入油管】21天2400万观看，初级YPP审核失败，我用AI手搓了一个油管视频流水线',
    author: '天才老师',
    industry: '出海',
    articleLink: 'https://scys.com/articleDetail/xq_topic/14588582112884152'
  },
  {
    title: '深耕亚马逊两年，分享做电商开品的底层思路，国内也适用，新人可参考',
    author: '女巫的蛋挞',
    industry: '出海',
    articleLink: 'https://scys.com/articleDetail/xq_topic/55188521852482814'
  },
  {
    title: '心力跃迁手册 | 开启你新一年的10倍增长',
    author: '石神马',
    industry: '生财认知',
    articleLink: 'https://scys.com/articleDetail/xq_topic/45811541144228118'
  },
  {
    title: '抖音自然流 CPS 与 B 站好物投流实战全解析：从 267 万 GMV 到长效增长的底层逻辑',
    author: '星空海绵',
    industry: '生财认知',
    articleLink: 'https://scys.com/articleDetail/xq_topic/45811542418552218'
  }
];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function norm(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }
function resolveLikeUrl(raw, base) {
  const v = String(raw || '').trim();
  if (!v || v.startsWith('javascript:') || v === '#') return '';
  if (/^https?:\/\//i.test(v)) return v;
  if (v.startsWith('//')) return `https:${v}`;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(v)) return v;
  try { return new URL(v, base).toString(); } catch (_) { return ''; }
}
function normalizeUrlText(v) {
  return String(v || '').trim().replace(/[)\]>,，。；;]+$/g, '');
}
function isFeishuUrl(v) {
  const u = normalizeUrlText(v);
  if (!u || u.includes('...')) return false;
  if (!/^(https?:\/\/|lark:|feishu:)/i.test(u)) return false;
  return /(feishu|lark)/i.test(u);
}
function extractDatetime(text) {
  const m = norm(text).match(/20\d{2}[-/.]\d{1,2}[-/.]\d{1,2}\s+\d{1,2}:\d{2}/);
  if (!m) return '';
  const [y, mo, d, h, mi] = m[0].match(/(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\s+(\d{1,2}):(\d{2})/).slice(1);
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')} ${String(h).padStart(2, '0')}:${mi}`;
}
function extractRegion(text) {
  const m = norm(text).match(/((?:[\u4e00-\u9fa5]+(?:省|市|自治区|特别行政区))(?:\/[\u4e00-\u9fa5]+(?:市|区|县|旗|州|盟|自治州|自治县)){1,3})/);
  return m ? m[1] : '暂时不知';
}
function extractFeishu(text) {
  const m = text.match(/https?:\/\/[^\s"']*(?:feishu|lark)[^\s"']*/i);
  const u = m ? normalizeUrlText(m[0]) : '';
  return isFeishuUrl(u) ? u : '';
}

async function tryOpenAuthorDetail(context, articlePage, authorName) {
  const clickSelectors = [
    '.post-item-top-left img',
    '.name-identity .name',
    '.name-identity',
    '.post-item-top-right img',
    '.post-item-top-left',
    '.post-item-top-right',
    'img[alt*="头像"]'
  ];
  const previousUrl = articlePage.url();

  for (let round = 0; round < 5; round++) {
    try {
      const candidates = [];
      if (authorName) {
        candidates.push(articlePage.getByText(authorName, { exact: true }).first());
        candidates.push(articlePage.locator(`xpath=(//*[contains(@class,"post-item-top")]//*[normalize-space(text())="${authorName}"])[1]`));
      }
      for (const sel of clickSelectors) candidates.push(articlePage.locator(sel).first());

      for (const target of candidates) {
        if ((await target.count()) === 0) continue;
        const popupPromise = context.waitForEvent('page', { timeout: 3500 }).catch(() => null);
        await target.click({ force: true, timeout: 2500 }).catch(() => {});
        const popup = await popupPromise;
        if (popup) {
          await popup.waitForLoadState('domcontentloaded').catch(() => {});
          return { mode: 'popup', page: popup, previousUrl };
        }
        await articlePage.waitForURL((u) => u.toString() !== previousUrl, { timeout: 2500 }).catch(() => {});
        if (articlePage.url() !== previousUrl) {
          return { mode: 'same-tab', page: articlePage, previousUrl };
        }
      }
    } catch (_) {}
    await sleep(250);
  }
  return null;
}

async function captureUrlByClick(context, page, locator, options = {}) {
  const forceRealClick = options.forceRealClick === true;
  const href = await locator.getAttribute('href').catch(() => '');
  const hrefUrl = resolveLikeUrl(href, page.url());
  if (!forceRealClick && isFeishuUrl(hrefUrl)) return normalizeUrlText(hrefUrl);

  const before = page.url();
  const popupPromise = context.waitForEvent('page', { timeout: 4500 }).catch(() => null);
  await locator.click({ force: true, timeout: 2500 }).catch(() => {});
  const popup = await popupPromise;
  if (popup) {
    await popup.waitForLoadState('domcontentloaded').catch(() => {});
    await sleep(1200);
    const popped = popup.url();
    await popup.close().catch(() => {});
    const u = resolveLikeUrl(popped, before);
    const normalized = normalizeUrlText(u || '');
    if (isFeishuUrl(normalized)) return normalized;
    if (isFeishuUrl(hrefUrl)) return normalizeUrlText(hrefUrl);
    return normalized;
  }

  await page.waitForURL((u) => u.toString() !== before, { timeout: 3000 }).catch(() => {});
  if (page.url() !== before) {
    const jumped = page.url();
    const u = resolveLikeUrl(jumped, before);
    await page.goBack({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    await sleep(500);
    const normalized = normalizeUrlText(u || '');
    if (isFeishuUrl(normalized)) return normalized;
    if (isFeishuUrl(hrefUrl)) return normalizeUrlText(hrefUrl);
    return normalized;
  }
  if (isFeishuUrl(hrefUrl)) return normalizeUrlText(hrefUrl);
  return '';
}

async function extractFeishuByDomOrClick(context, articlePage, bodyText) {
  const textMatch = extractFeishu(bodyText);
  if (textMatch) return textMatch;

  const nearLabel = articlePage.locator('xpath=(//*[contains(normalize-space(.),"飞书链接")]//a)[1] | (//*[contains(normalize-space(.),"飞书链接")]/following::a[1])').first();
  if (await nearLabel.count()) {
    const u = await captureUrlByClick(context, articlePage, nearLabel, { forceRealClick: true });
    if (isFeishuUrl(u)) return normalizeUrlText(u);
  }

  const feishuAnchors = articlePage.locator('a[href*="feishu"], a[href*="lark"], a:has-text("飞书"), a:has-text("云文档")');
  const n = await feishuAnchors.count();
  for (let i = 0; i < Math.min(n, 5); i++) {
    const u = await captureUrlByClick(context, articlePage, feishuAnchors.nth(i));
    if (isFeishuUrl(u)) return normalizeUrlText(u);
  }

  const anyAnchor = articlePage.locator('a').filter({ hasText: /飞书|云文档/i }).first();
  if (await anyAnchor.count()) {
    const u = await captureUrlByClick(context, articlePage, anyAnchor);
    if (isFeishuUrl(u)) return normalizeUrlText(u);
  }

  return '';
}

async function getArticleData(context, target) {
  const { articleLink, industry } = target;
  const page = await context.newPage();
  await page.goto(articleLink, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await sleep(2500);

  const bodyText = await page.locator('body').innerText().catch(() => '');
  const title = target.title;
  const author = target.author;

  const publishDate = extractDatetime(bodyText);
  const feishuLink = await extractFeishuByDomOrClick(context, page, bodyText);

  let region = '暂时不知';
  if (author) {
    const opened = await tryOpenAuthorDetail(context, page, author);
    if (opened && opened.mode === 'popup') {
      await sleep(1200);
      const t = await opened.page.locator('body').innerText().catch(() => '');
      region = extractRegion(t);
      await opened.page.close().catch(() => {});
    } else if (opened && opened.mode === 'same-tab') {
      await sleep(1200);
      const t = await page.locator('body').innerText().catch(() => '');
      region = extractRegion(t);
      if (page.url() !== opened.previousUrl) {
        await page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {});
        await sleep(800);
      }
    }
  }

  await page.close().catch(() => {});
  return { title, author, region, industry, publishDate, articleLink, feishuLink };
}

async function fieldContainerByLabel(page, label) {
  const labelNode = page.getByText(label, { exact: false }).first();
  if ((await labelNode.count()) === 0) throw new Error(`Label not found: ${label}`);
  const container = labelNode.locator('xpath=ancestor::div[starts-with(@id,"field-item-")][1]').first();
  if ((await container.count()) === 0) throw new Error(`Field container not found: ${label}`);
  return container;
}

async function fillTextField(page, label, value) {
  const container = await fieldContainerByLabel(page, label);
  const v = String(value || '');
  const input = container.locator('input, textarea').first();
  if (await input.count()) {
    await input.click({ force: true });
    await input.fill(v);
    await input.dispatchEvent('input').catch(() => {});
    await input.dispatchEvent('change').catch(() => {});
    await input.press('Tab').catch(() => {});
    const inputValue = await input.inputValue().catch(() => '');
    if (v && !norm(inputValue).includes(norm(v))) throw new Error(`Fill verify failed: ${label}`);
    return;
  }

  const editable = container.locator('[contenteditable="true"]').first();
  if ((await editable.count()) === 0) throw new Error(`Editable not found: ${label}`);
  await editable.click({ force: true });
  await editable.press('Meta+A').catch(async () => { await editable.press('Control+A').catch(() => {}); });
  await editable.press('Backspace').catch(() => {});
  await editable.type(v, { delay: 12 });
  await editable.press('Tab').catch(() => {});
  await sleep(120);
  const check = norm(await container.innerText().catch(() => ''));
  if (v && !check.includes(v)) throw new Error(`Fill verify failed: ${label}`);
}

async function fillUrlField(page, label, value) {
  const container = await fieldContainerByLabel(page, label);
  const v = String(value || '');
  const urlInput = container.locator('input[type="url"], input[type="text"], textarea').first();
  if ((await urlInput.count()) > 0) {
    await urlInput.click({ force: true });
    await urlInput.fill(v);
    await urlInput.dispatchEvent('input').catch(() => {});
    await urlInput.dispatchEvent('change').catch(() => {});
    await urlInput.press('Tab').catch(() => {});
    await sleep(120);
    const inputValue = await urlInput.inputValue().catch(() => '');
    if (v && !norm(inputValue).includes(norm(v))) throw new Error(`URL fill verify failed: ${label}`);
    return;
  }
  await fillTextField(page, label, v);
}

async function submitOne(page, row) {
  await fillTextField(page, '标题', row.title);
  await fillTextField(page, '圈友', row.author);
  await fillTextField(page, '地区', row.region);
  await fillTextField(page, '行业', row.industry);
  await fillTextField(page, '文章发布时间', row.publishDate);
  await fillUrlField(page, '文章链接', row.articleLink);
  await fillUrlField(page, '飞书链接', row.feishuLink || '');

  const submit = page.getByRole('button', { name: /提交|submit/i }).first();
  const enabled = await submit.isEnabled().catch(() => false);
  if (!enabled) throw new Error('Submit disabled');
  await submit.click({ timeout: 10000 });
}

(async () => {
  const context = await launchContext(config, __dirname);
  const collected = [];
  for (const t of targets) {
    const row = await getArticleData(context, t);
    collected.push(row);
  }

  const out = path.resolve(__dirname, '..', './output/deterministic_4_rows.json');
  fs.writeFileSync(out, JSON.stringify(collected, null, 2), 'utf-8');

  for (let i = 0; i < collected.length; i++) {
    const form = await context.newPage();
    await form.goto(FORM_URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await sleep(2500);
    await submitOne(form, collected[i]);
    console.log(`Submitted ${i + 1}: ${collected[i].title}`);
    await sleep(1800);
    await form.close().catch(() => {});
  }

  console.log('Deterministic 4 submit finished.');
  await closeContext(context);
})();
