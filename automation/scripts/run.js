const { launchContext, closeContext } = require('./browserContext');
const path = require('path');
const fs = require('fs');

const configPath = path.resolve(__dirname, '..', 'config.json');
if (!fs.existsSync(configPath)) {
  console.error('Missing config.json. Copy config.example.json to config.json and fill URLs.');
  process.exit(1);
}
const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
const selectors = config.selectors || {};
const formSelectors = selectors.feishuForm || {};

const outputCsvPath = path.resolve(__dirname, '..', config.outputCsvPath || './output/records.csv');
const outputJsonlPath = path.resolve(__dirname, '..', config.outputJsonlPath || './output/records.jsonl');
const { createPacerFromConfig } = require('../lib/runtime/pacer');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function normalizeWhitespace(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function normalizeUrlText(v) {
  return String(v || '').trim().replace(/[)\]>,，。；;]+$/g, '');
}

function resolveLikeUrl(raw, base) {
  const v = String(raw || '').trim();
  if (!v || v.startsWith('javascript:') || v === '#') return '';
  if (/^https?:\/\//i.test(v)) return v;
  if (v.startsWith('//')) return `https:${v}`;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(v)) return v;
  try { return new URL(v, base).toString(); } catch (_) { return ''; }
}

function isFeishuUrl(v) {
  const u = normalizeUrlText(v);
  if (!u || u.includes('...')) return false;
  if (!/^(https?:\/\/|lark:|feishu:)/i.test(u)) return false;
  return /(feishu|lark)/i.test(u);
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function normalizePublishDateText(raw) {
  const text = normalizeWhitespace(raw);
  if (!text) return '';

  const full = text.match(/(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\s+(\d{1,2}):(\d{2})/);
  if (full) {
    return `${full[1]}-${pad2(full[2])}-${pad2(full[3])} ${pad2(full[4])}:${pad2(full[5])}`;
  }

  const mdhm = text.match(/(\d{1,2})[-/.](\d{1,2})\s+(\d{1,2}):(\d{2})/);
  if (mdhm) {
    const year = String(new Date().getFullYear());
    return `${year}-${pad2(mdhm[1])}-${pad2(mdhm[2])} ${pad2(mdhm[3])}:${pad2(mdhm[4])}`;
  }

  const md = text.match(/(\d{1,2})[-/.](\d{1,2})/);
  if (md) {
    const year = String(new Date().getFullYear());
    return `${year}-${pad2(md[1])}-${pad2(md[2])} 00:00`;
  }

  return text;
}

function ensureFileHeader(csvPath) {
  if (!fs.existsSync(csvPath)) {
    fs.mkdirSync(path.dirname(csvPath), { recursive: true });
    const header = 'title,author,region,industry,publishDate,articleLink,feishuLink\n';
    fs.writeFileSync(csvPath, header, 'utf-8');
  }
}

function appendCsvRow(csvPath, row) {
  const esc = (v) => '"' + String(v || '').replace(/"/g, '""') + '"';
  const line = [
    row.title,
    row.author,
    row.region,
    row.industry,
    row.publishDate,
    row.articleLink,
    row.feishuLink
  ].map(esc).join(',') + '\n';
  fs.appendFileSync(csvPath, line, 'utf-8');
}

function appendJsonl(jsonlPath, row) {
  fs.mkdirSync(path.dirname(jsonlPath), { recursive: true });
  fs.appendFileSync(jsonlPath, JSON.stringify(row) + '\n', 'utf-8');
}

function loadSubmittedLinks(filePath) {
  if (!fs.existsSync(filePath)) return new Set();
  return new Set(
    fs.readFileSync(filePath, 'utf-8')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
  );
}

function appendSubmittedLink(filePath, link) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${link}\n`, 'utf-8');
}

function appendErrorLog(row, err) {
  const errorPath = path.resolve(__dirname, '..', './output/errors.log');
  const line = JSON.stringify({
    at: new Date().toISOString(),
    articleLink: row.articleLink,
    title: row.title,
    error: String(err && err.message ? err.message : err)
  });
  fs.appendFileSync(errorPath, line + '\n', 'utf-8');
}

function loadDedupeSet(jsonlPath, key) {
  const set = new Set();
  if (!fs.existsSync(jsonlPath)) return set;
  const lines = fs.readFileSync(jsonlPath, 'utf-8').split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj && obj[key]) set.add(obj[key]);
    } catch (_) {}
  }
  return set;
}

async function expandAll(page) {
  if (!config.expand?.enabled) return;
  const texts = config.expand.buttonTexts || [];
  let clicked = 0;
  for (let i = 0; i < (config.expand.maxClicks || 30); i++) {
    let didClick = false;
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
    await sleep(300);
    for (const t of texts) {
      const btn = page.getByText(t, { exact: false });
      const count = await btn.count();
      if (count > 0) {
        for (let j = 0; j < count; j++) {
          try {
            const node = btn.nth(j);
            if (!(await node.isVisible().catch(() => false))) continue;
            await node.click({ timeout: 1200, force: true });
            await sleep(500);
            didClick = true;
            clicked++;
          } catch (_) {}
        }
      }
    }
    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
    await sleep(200);
    if (!didClick) break;
  }
  console.log(`Expand clicks: ${clicked}`);
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
    const u = normalizeUrlText(resolveLikeUrl(popped, before));
    if (isFeishuUrl(u)) return u;
    if (isFeishuUrl(hrefUrl)) return normalizeUrlText(hrefUrl);
    return '';
  }

  await page.waitForURL((u) => u.toString() !== before, { timeout: 3000 }).catch(() => {});
  if (page.url() !== before) {
    const jumped = page.url();
    const u = normalizeUrlText(resolveLikeUrl(jumped, before));
    await page.goBack({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    await sleep(500);
    if (isFeishuUrl(u)) return u;
    if (isFeishuUrl(hrefUrl)) return normalizeUrlText(hrefUrl);
    return '';
  }

  if (isFeishuUrl(hrefUrl)) return normalizeUrlText(hrefUrl);
  return '';
}

async function extractFeishuLink(context, page) {
  const regex = new RegExp(selectors.feishuLinkRegex || 'https?:\\/\\/[^\\s\"\']*(feishu|lark)[^\\s\"\']*', 'i');

  const nearLabel = page.locator('xpath=(//*[contains(normalize-space(.),"飞书链接")]//a)[1] | (//*[contains(normalize-space(.),"飞书链接")]/following::a[1])').first();
  if (await nearLabel.count()) {
    const u = await captureUrlByClick(context, page, nearLabel, { forceRealClick: true });
    if (isFeishuUrl(u)) return u;
  }

  const feishuAnchors = page.locator('a[href*="feishu"], a[href*="lark"], a:has-text("飞书"), a:has-text("云文档")');
  const n = await feishuAnchors.count();
  for (let i = 0; i < Math.min(n, 5); i++) {
    const u = await captureUrlByClick(context, page, feishuAnchors.nth(i));
    if (isFeishuUrl(u)) return u;
  }

  const candidates = [];
  if (selectors.articleContent) {
    const contentLocator = page.locator(selectors.articleContent);
    const count = await contentLocator.count().catch(() => 0);
    if (count > 0) {
      candidates.push(contentLocator.first());
    }
  }
  candidates.push(page.locator('body'));

  for (const locator of candidates) {
    const text = await locator.innerText().catch(() => '');
    const match = text.match(regex);
    if (match) {
      const u = normalizeUrlText(match[0]);
      if (isFeishuUrl(u)) return u;
    }
    const html = await locator.innerHTML().catch(() => '');
    const match2 = html.match(regex);
    if (match2) {
      const u = normalizeUrlText(match2[0]);
      if (isFeishuUrl(u)) return u;
    }
  }
  return '';
}

async function getExpectedTotalCount(page) {
  const body = normalizeWhitespace(await page.locator('body').innerText().catch(() => ''));
  const m = body.match(/(\d+)\s*篇(?:文章|帖)/);
  return m ? Number(m[1]) : 0;
}

async function extractPublishDateFromArticle(page, fallbackDate) {
  const bodyText = await page.locator('body').innerText().catch(() => '');
  const firstFull = bodyText.match(/20\d{2}[-/.]\d{1,2}[-/.]\d{1,2}\s+\d{1,2}:\d{2}/);
  if (firstFull) {
    return normalizePublishDateText(firstFull[0]);
  }

  if (selectors.articleDate) {
    const dLoc = page.locator(selectors.articleDate);
    if (await dLoc.count() > 0) {
      const articleDateText = await dLoc.first().innerText().catch(() => '');
      const normalized = normalizePublishDateText(articleDateText);
      if (normalized) return normalized;
    }
  }

  return normalizePublishDateText(fallbackDate);
}

async function extractRegionFromAuthorPage(page) {
  const bodyText = normalizeWhitespace(await page.locator('body').innerText().catch(() => ''));
  const regionPattern = /((?:[\u4e00-\u9fa5]+(?:省|市|自治区|特别行政区))(?:\/[\u4e00-\u9fa5]+(?:市|区|县|旗|州|盟|自治州|自治县)){1,3})/;
  const directMatch = bodyText.match(regionPattern);
  if (directMatch && directMatch[1]) {
    return directMatch[1];
  }

  const labelTexts = selectors.authorRegionLabelTexts || ['地区', '所在地', '城市'];
  for (const label of labelTexts) {
    const labelLoc = page.getByText(label, { exact: false });
    if (await labelLoc.count() > 0) {
      const candidate = await labelLoc.first().locator('..').innerText().catch(() => '');
      const normalized = normalizeWhitespace(candidate);
      if (normalized && normalized !== label) {
        const value = normalized.replace(label, '').replace(':', '').trim();
        if (value) return value;
      }
    }
  }

  if (selectors.authorRegionValue) {
    const loc = page.locator(selectors.authorRegionValue);
    if (await loc.count() > 0) {
      const text = normalizeWhitespace(await loc.first().innerText().catch(() => ''));
      if (text) return text;
    }
  }

  return formSelectors.unknownRegionText || '暂时不知';
}

async function resolveAuthorProfileUrl(articlePage, articleUrl, authorName) {
  const headerCandidates = articlePage.locator('.post-item-top a[href*="user"], .post-item-top a[href*="profile"], .name-identity a[href*="user"], .name-identity a[href*="profile"]');
  const headerCount = await headerCandidates.count().catch(() => 0);
  for (let i = 0; i < headerCount; i++) {
    const node = headerCandidates.nth(i);
    const href = await node.getAttribute('href').catch(() => '');
    if (!href) continue;
    const abs = href.startsWith('http') ? href : new URL(href, articleUrl).toString();
    const text = normalizeWhitespace(await node.innerText().catch(() => ''));
    if (authorName && text && (text === authorName || text.includes(authorName))) {
      return abs;
    }
  }

  if (authorName) {
    const nearAuthor = articlePage.locator(`xpath=(//*[contains(@class,"post-item-top")]//*[normalize-space(text())="${authorName}"]/ancestor::a[@href])[1]`);
    if (await nearAuthor.count()) {
      const href = await nearAuthor.first().getAttribute('href').catch(() => '');
      if (href) return href.startsWith('http') ? href : new URL(href, articleUrl).toString();
    }
  }

  const candidates = articlePage.locator(selectors.authorLink || 'a[href*="user"], a[href*="profile"]');
  const count = await candidates.count();
  for (let i = 0; i < count; i++) {
    const node = candidates.nth(i);
    const href = await node.getAttribute('href').catch(() => '');
    if (!href) continue;
    const abs = href.startsWith('http') ? href : new URL(href, articleUrl).toString();
    const text = normalizeWhitespace(await node.innerText().catch(() => ''));
    if (authorName && text && (text === authorName || text.includes(authorName))) {
      return abs;
    }
    if (!authorName && /user|profile/i.test(abs)) return abs;
  }
  return '';
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

async function extractRegionByAuthorClick(context, articlePage, authorName) {
  const unknown = formSelectors.unknownRegionText || '暂时不知';
  const opened = await tryOpenAuthorDetail(context, articlePage, authorName);
  if (!opened) return unknown;
  if (opened.mode === 'popup') {
    await sleep(1200);
    const region = await extractRegionFromAuthorPage(opened.page);
    await opened.page.close().catch(() => {});
    return region || unknown;
  }
  await sleep(1200);
  const region = await extractRegionFromAuthorPage(articlePage);
  if (articlePage.url() !== opened.previousUrl) {
    await articlePage.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {});
    await sleep(800);
  }
  return region || unknown;
}

async function fillFeishuForm(page, row) {
  const fieldContainerByLabel = async (label) => {
    const labelNode = page.getByText(label, { exact: false }).first();
    if ((await labelNode.count()) === 0) {
      throw new Error(`Label not found: ${label}`);
    }
    const container = labelNode.locator('xpath=ancestor::div[starts-with(@id,"field-item-")][1]').first();
    if ((await container.count()) === 0) {
      throw new Error(`Field container not found: ${label}`);
    }
    return container;
  };

  const fillByLabel = async (label, value) => {
    if (!label) return;
    const valueText = String(value || '');
    const container = await fieldContainerByLabel(label);
    const input = container.locator('input, textarea').first();
    if (await input.count() > 0) {
      await input.click({ force: true });
      await input.fill(valueText);
      await input.dispatchEvent('input').catch(() => {});
      await input.dispatchEvent('change').catch(() => {});
      await input.press('Tab').catch(() => {});
      await sleep(120);
      const v = await input.inputValue().catch(() => '');
      if (valueText && !String(v).includes(valueText)) {
        throw new Error(`Input verify failed: ${label} expected=${valueText} actual=${v}`);
      }
      return;
    }

    const editable = container.locator('[contenteditable="true"]').first();
    if (await editable.count() > 0) {
      await editable.click({ force: true });
      await editable.press('Meta+A').catch(async () => {
        await editable.press('Control+A').catch(() => {});
      });
      await editable.press('Backspace').catch(() => {});
      await editable.type(valueText, { delay: 10 });
      await editable.press('Tab').catch(() => {});
      await sleep(120);
      const check = normalizeWhitespace(await container.innerText().catch(() => ''));
      if (valueText && !check.includes(valueText)) {
        throw new Error(`Field verify failed: ${label} expected=${valueText} actual=${check}`);
      }
      return;
    }

    throw new Error(`No writable control found: ${label}`);
  };

  const fillByIndex = async (index, value) => {
    const editable = page.locator('[contenteditable="true"]').nth(index);
    if ((await editable.count()) === 0) {
      throw new Error(`contenteditable index not found: ${index}`);
    }
    const valueText = String(value || '');
    await editable.click({ force: true });
    await editable.press('Meta+A').catch(async () => {
      await editable.press('Control+A').catch(() => {});
    });
    await editable.press('Backspace').catch(() => {});
    await editable.type(valueText, { delay: 10 });
    await sleep(120);
  };

  try {
    await fillByLabel(formSelectors.titleLabel, row.title);
    await fillByLabel(formSelectors.authorLabel, row.author);
    await fillByLabel(formSelectors.regionLabel, row.region);
    await fillByLabel(formSelectors.industryLabel, row.industry);
    await fillByLabel(formSelectors.publishDateLabel, row.publishDate);
    await fillByLabel(formSelectors.articleLinkLabel, row.articleLink);
    await fillByLabel(formSelectors.feishuLinkLabel, row.feishuLink || '');
  } catch (err) {
    // Fallback path for localized/variant form DOM where labels are not reliably bindable.
    await fillByIndex(0, row.title);
    await fillByIndex(1, row.author);
    await fillByIndex(2, row.region);
    await fillByIndex(3, row.industry);
    await fillByIndex(4, row.publishDate);
    await fillByIndex(5, row.articleLink);
    await fillByIndex(6, row.feishuLink || '');
  }

  if (formSelectors.submitText) {
    const submit = page.getByText(formSelectors.submitText, { exact: false }).first();
    const enabled = await submit.isEnabled().catch(() => false);
    if (!enabled) {
      throw new Error('Submit button is disabled after filling fields');
    }
    await submit.click();
  }
}

async function openInNewPage(context, url) {
  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => {});
  await sleep(2200);
  return page;
}

async function openArticleFromCard(context, listPage, card, knownLink) {
  if (knownLink) {
    const articlePage = await openInNewPage(context, knownLink);
    return { articlePage, articleLink: knownLink, closeMode: 'close' };
  }

  const previousUrl = listPage.url();
  const popupPromise = context.waitForEvent('page', { timeout: 5000 }).catch(() => null);
  await card.click({ timeout: 5000 });
  const popupPage = await popupPromise;
  if (popupPage) {
    await popupPage.waitForLoadState('domcontentloaded').catch(() => {});
    await popupPage.waitForLoadState('networkidle').catch(() => {});
    await sleep(1800);
    return { articlePage: popupPage, articleLink: popupPage.url(), closeMode: 'close' };
  }

  await listPage.waitForURL((u) => u.toString() !== previousUrl, { timeout: 5000 }).catch(() => {});
  const currentUrl = listPage.url();
  if (currentUrl !== previousUrl) {
    return { articlePage: listPage, articleLink: currentUrl, closeMode: 'back' };
  }

  return null;
}

async function closeArticlePage(listPage, articlePage, closeMode) {
  if (closeMode === 'close') {
    await articlePage.close().catch(() => {});
    return;
  }
  if (closeMode === 'back') {
    await articlePage.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {});
    await sleep(800);
  }
}

(async () => {
  const context = await launchContext(config, __dirname);
  const pacer = createPacerFromConfig(config, { label: 'scys', maxPerHour: 30, jitterMs: 8000 });
  const maxSubmissions = Number.isFinite(Number(config.maxSubmissions)) ? Number(config.maxSubmissions) : 0;
  const ignoreDedupe = config.ignoreDedupe === true;
  let submittedCount = 0;
  let collectedCount = 0;
  let expectedTotal = 0;
  let shouldStop = false;
  try {
    const page = await context.newPage();
    await page.goto(config.scysCollectionUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => {});
    await sleep(2500);

  if (config.manualLoginWait) {
    console.log('If login is required, please complete it in the browser. Waiting 20s...');
    await sleep(20000);
  }

  await expandAll(page);
  expectedTotal = await getExpectedTotalCount(page);
  if (expectedTotal > 0) {
    console.log(`Expected total from page header: ${expectedTotal}`);
  } else {
    console.log('Expected total from page header: not found');
  }

  const sectionsSelector = selectors.sections || 'section';
  await page.waitForSelector(sectionsSelector, { timeout: 15000 }).catch(() => {});

  const sectionLoc = page.locator(sectionsSelector);
  const sectionCount = await sectionLoc.count();
  if (sectionCount === 0) {
    console.error('No sections found. Update selectors.sections in config.json');
    await closeContext(context);
    process.exit(1);
  }

  ensureFileHeader(outputCsvPath);
  const dedupeSet = loadDedupeSet(outputJsonlPath, config.dedupeKey || 'articleLink');
  const submittedLinksPath = path.resolve(__dirname, '..', './output/submitted_links.txt');
  const submittedLinks = loadSubmittedLinks(submittedLinksPath);

  for (let i = 0; i < sectionCount; i++) {
    const section = sectionLoc.nth(i);
    let industry = '';
    if (selectors.sectionTitle) {
      const titleLoc = section.locator(selectors.sectionTitle);
      if (await titleLoc.count() > 0) {
        industry = normalizeWhitespace(await titleLoc.first().innerText().catch(() => ''));
      }
    }

    const cardLoc = section.locator(selectors.card || 'li');
    const cardCount = await cardLoc.count();
    for (let c = 0; c < cardCount; c++) {
      const card = cardLoc.nth(c);
      // Even pacing to avoid bursty bot-like behavior.
      await pacer.beforeItem(`section=${i + 1}/${sectionCount} card=${c + 1}/${cardCount}`);

      let title = '';
      let author = '';
      let publishDate = '';
      let articleLink = '';

      if (selectors.cardTitle) {
        const tLoc = card.locator(selectors.cardTitle);
        if (await tLoc.count() > 0) title = normalizeWhitespace(await tLoc.first().innerText().catch(() => ''));
      }

      if (selectors.cardAuthor) {
        const aLoc = card.locator(selectors.cardAuthor);
        if (await aLoc.count() > 0) author = normalizeWhitespace(await aLoc.first().innerText().catch(() => ''));
      }

      if (selectors.cardDate) {
        const dLoc = card.locator(selectors.cardDate);
        if (await dLoc.count() > 0) {
          publishDate = normalizePublishDateText(await dLoc.first().innerText().catch(() => ''));
        }
      }

      if (selectors.cardLink) {
        const lLoc = card.locator(selectors.cardLink);
        if (await lLoc.count() > 0) {
          const href = await lLoc.first().getAttribute('href');
          if (href) articleLink = href.startsWith('http') ? href : new URL(href, config.scysCollectionUrl).toString();
        }
      }

      if (!ignoreDedupe && articleLink && dedupeSet.has(articleLink)) continue;
      const opened = await openArticleFromCard(context, page, card, articleLink);
      if (!opened) continue;
      const articlePage = opened.articlePage;
      articleLink = opened.articleLink || articleLink;
      if (!articleLink) articleLink = articlePage.url();
      if (!articleLink || (!ignoreDedupe && dedupeSet.has(articleLink))) {
        await closeArticlePage(page, articlePage, opened.closeMode);
        continue;
      }

      if (!title && selectors.articleTitle) {
        const tLoc = articlePage.locator(selectors.articleTitle);
        if (await tLoc.count() > 0) title = normalizeWhitespace(await tLoc.first().innerText().catch(() => ''));
      }

      if (!author && selectors.articleAuthor) {
        const aLoc = articlePage.locator(selectors.articleAuthor);
        if (await aLoc.count() > 0) author = normalizeWhitespace(await aLoc.first().innerText().catch(() => ''));
      }

      publishDate = await extractPublishDateFromArticle(articlePage, publishDate);

      let feishuLink = await extractFeishuLink(context, articlePage);

      let region = formSelectors.unknownRegionText || '暂时不知';
      if (author) {
        const authorUrl = await resolveAuthorProfileUrl(articlePage, articleLink, author);
        if (authorUrl) {
          const authorPage = await openInNewPage(context, authorUrl);
          region = await extractRegionFromAuthorPage(authorPage);
          await authorPage.close().catch(() => {});
        } else {
          region = await extractRegionByAuthorClick(context, articlePage, author);
        }
      }

      await closeArticlePage(page, articlePage, opened.closeMode);

      const row = {
        at: new Date().toISOString(),
        title,
        author,
        region,
        industry,
        publishDate,
        articleLink,
        feishuLink
      };

      appendJsonl(outputJsonlPath, row);
      appendCsvRow(outputCsvPath, row);
      collectedCount += 1;
      dedupeSet.add(articleLink);

      if (config.feishuFormUrl) {
        if (!ignoreDedupe && submittedLinks.has(row.articleLink)) {
          await sleep(200);
          continue;
        }
        const formPage = await openInNewPage(context, config.feishuFormUrl);
        try {
          await fillFeishuForm(formPage, row);
          appendSubmittedLink(submittedLinksPath, row.articleLink);
          submittedLinks.add(row.articleLink);
          submittedCount += 1;
          await sleep(1000);
          if (maxSubmissions > 0 && submittedCount >= maxSubmissions) {
            console.log(`Reached maxSubmissions=${maxSubmissions}`);
            shouldStop = true;
          }
        } catch (err) {
          if (pacer && typeof pacer.afterError === 'function') {
            await pacer.afterError(`submit card=${c + 1}/${cardCount}`).catch(() => {});
          }
          appendErrorLog(row, err);
          const shotPath = path.resolve(__dirname, '..', `./output/submit_error_${Date.now()}.png`);
          await formPage.screenshot({ path: shotPath, fullPage: true }).catch(() => {});
        } finally {
          await formPage.close();
        }
      }

      await sleep(800);
      if (shouldStop) break;
    }
    if (shouldStop) break;
  }

    console.log(`Done. expected=${expectedTotal || 'unknown'} collected=${collectedCount} submitted=${submittedCount}`);
    if (expectedTotal > 0 && collectedCount !== expectedTotal) {
      console.log(`WARNING: count mismatch expected=${expectedTotal} collected=${collectedCount}`);
    }
  } catch (err) {
    throw err;
  } finally {
    await closeContext(context);
  }
})();
