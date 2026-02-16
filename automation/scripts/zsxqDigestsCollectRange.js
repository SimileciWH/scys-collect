// Collect ZSXQ digests within a date range (descending, newest -> oldest),
// extract Feishu link from each topic detail, submit to Feishu Base form,
// and persist progress for resume.
//
// Default range: 2026-02 (end) back to 2020-01-01, inclusive.
//
// Usage:
//   node automation/scripts/zsxqDigestsCollectRange.js
//
// Env:
//   GROUP_ID=1824528822
//   DIGESTS_URL=https://wx.zsxq.com/digests/1824528822
//   START_DATE=2026-02-28  (inclusive, YYYY-MM-DD; upper bound)
//   END_DATE=2020-01-01    (inclusive, YYYY-MM-DD; lower bound)
//   MAX_ITEMS=0            (0 => unlimited; for testing set 2/10)
//   FAST=0                 (FAST=1 disables pacing, test only)
//   LOGIN_TIMEOUT_MS=43200000 (default 12h)
//
// Outputs (relative to automation/):
//   output/zsxq_digests_progress.json
//   output/zsxq_digests_done.jsonl
//   output/zsxq_digests_errors.jsonl

const fs = require('fs');
const path = require('path');

const { launchContext, closeContext } = require('./browserContext');
const { sleep } = require('../lib/runtime/wait');
const { createPacerFromConfig } = require('../lib/runtime/pacer');
const { submitRowToFeishuForm, ensureFormEntryPage } = require('../lib/sinks/feishuForm');
const { fmtDateFromCreateTime } = require('../lib/extractors/zsxq');
const {
  parseDigestListItemText,
  waitForDigestItems,
  clickDigestAndGetDetailPage,
  extractFeishuLinkFromDetailPage,
  extractPublishDateFromDetailPage,
  extractTypeTagsFromDetailPage,
  humanScroll
} = require('../lib/extractors/zsxqDigestsUi');

function normDate(s) {
  const m = String(s || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return '';
  return `${m[1]}-${m[2]}-${m[3]}`;
}

function appendJsonl(filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, JSON.stringify(obj) + '\n', 'utf-8');
}

function readJsonSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const j = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    return j && typeof j === 'object' ? j : fallback;
  } catch (_) {
    return fallback;
  }
}

function writeJsonAtomic(filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf-8');
  fs.renameSync(tmp, filePath);
}

async function ensureLoggedIn(page, context, storageStatePath, labelForLog) {
  const isLogin = async () => {
    const hasQr = (await page.getByText('获取登录二维码', { exact: false }).count().catch(() => 0)) > 0;
    const hasScan = (await page.getByText('扫码登录', { exact: false }).count().catch(() => 0)) > 0;
    const hasWx = (await page.getByText('微信扫码', { exact: false }).count().catch(() => 0)) > 0;
    return hasQr || hasScan || hasWx;
  };

  if (!(await isLogin())) return;

  const timeoutMs = Number(process.env.LOGIN_TIMEOUT_MS || String(12 * 60 * 60 * 1000));
  const started = Date.now();
  console.log(`[${labelForLog}] need login: please scan QR in the opened browser window...`);

  while (Date.now() - started < timeoutMs) {
    if (!(await isLogin())) {
      await context.storageState({ path: storageStatePath });
      console.log(`[${labelForLog}] login ok; saved storage state: ${storageStatePath}`);
      return;
    }
    await sleep(3000);
    if (Math.random() < 0.12) console.log(`[${labelForLog}] still waiting for login...`);
  }

  throw new Error('Login timeout waiting for QR scan.');
}

async function gotoNextPage(listPage) {
  const nextBtn = listPage.locator('li.page-next').first();
  const cls = (await nextBtn.getAttribute('class').catch(() => '')) || '';
  if (/disabled/i.test(cls)) return false;
  await nextBtn.scrollIntoViewIfNeeded().catch(() => {});
  await sleep(120 + Math.floor(Math.random() * 320));
  await nextBtn.click({ timeout: 15000, force: true }).catch(() => {});
  await waitForDigestItems(listPage);
  return true;
}

async function openFeishuFormPage(context, config, storageStatePath) {
  const formPage = await context.newPage();
  await formPage.goto(config.feishuFormUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await sleep(400 + Math.floor(Math.random() * 600));

  const labels = config.selectors.feishuForm;
  const ready = (await formPage.getByText(labels.titleLabel, { exact: false }).count().catch(() => 0)) > 0;
  if (!ready) {
    console.log('[feishu] form not ready; waiting for you to login in the opened Feishu tab...');
    const timeoutMs = Number(process.env.FEISHU_TIMEOUT_MS || String(12 * 60 * 60 * 1000));
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const ok = (await formPage.getByText(labels.titleLabel, { exact: false }).count().catch(() => 0)) > 0;
      if (ok) break;
      await sleep(2000);
      if (Math.random() < 0.08) console.log('[feishu] still waiting for login/permission...');
    }
    const ok2 = (await formPage.getByText(labels.titleLabel, { exact: false }).count().catch(() => 0)) > 0;
    if (!ok2) throw new Error('Feishu form still not ready after waiting');

    await context.storageState({ path: storageStatePath });
    console.log(`[feishu] login ok; saved combined storage state: ${storageStatePath}`);
  }

  return formPage;
}

async function collectOne(context, config, formPage, digestsUrl, groupId, pageNo, indexInPage) {
  const listPage = context.pages().find((p) => p.url().includes('/digests/')) || context.pages()[0];
  const items = await waitForDigestItems(listPage);
  const item = items.nth(indexInPage);
  const raw = await item.innerText().catch(() => '');
  const parsed = parseDigestListItemText(raw);

  const clicked = await clickDigestAndGetDetailPage(context, listPage, indexInPage);
  const topicId = clicked.topicId || '';
  const detailPage = clicked.detailPage;

  try {
    await detailPage.waitForLoadState('domcontentloaded').catch(() => {});
    await detailPage.waitForLoadState('networkidle').catch(() => {});
    await sleep(180 + Math.floor(Math.random() * 420));

    const u = detailPage.url();
    if (u.includes('/join_group') || u.includes('topicStatus=error')) {
      // We can often still fetch title/author/time via pub-api using topicId.
      // Treat this as "limited extraction": skip UI-based fields (type tags, feishu link).
    }

    // If we are on the real topic detail (not error redirect), do a little scroll to
    // trigger lazy content and reduce bot-like behavior.
    if (!u.includes('/join_group') && !u.includes('topicStatus=error')) {
      await humanScroll(detailPage, 1);
    }

    // Feishu link is optional now: if missing, still submit with empty feishuLink.
    const feishuLink =
      !u.includes('/join_group') && !u.includes('topicStatus=error')
        ? await extractFeishuLinkFromDetailPage(context, detailPage)
        : '';

    const typeValue =
      !u.includes('/join_group') && !u.includes('topicStatus=error')
        ? await extractTypeTagsFromDetailPage(detailPage)
        : '';

    // Prefer pub-api payload for title/author/publishDate if list parsing is incomplete.
    let topicJson = null;
    if (topicId) {
      try {
        const r = await context.request.get(`https://pub-api.zsxq.com/v2/topics/${topicId}`);
        if (r.ok()) topicJson = await r.json();
      } catch (_) {}
    }

    const jsonTopic = topicJson && topicJson.resp_data && topicJson.resp_data.topic ? topicJson.resp_data.topic : null;
    const jsonTitle = jsonTopic && jsonTopic.title ? String(jsonTopic.title) : '';
    const jsonAuthor =
      jsonTopic && jsonTopic.talk && jsonTopic.talk.owner && jsonTopic.talk.owner.name ? String(jsonTopic.talk.owner.name) : '';
    const jsonCreateTime = jsonTopic && jsonTopic.create_time ? String(jsonTopic.create_time) : '';
    const jsonPublishDate = jsonCreateTime ? fmtDateFromCreateTime(jsonCreateTime) : '';

    const publishDate =
      jsonPublishDate || (await extractPublishDateFromDetailPage(detailPage)) || parsed.publishDate || '';
    const articleLink =
      u && /zsxq\.com/i.test(u) && !u.includes('/digests/')
        ? u
        : topicId
          ? `https://wx.zsxq.com/mweb/views/topicdetail/topicdetail.html?topic_id=${topicId}`
          : '';

    const row = {
      title: jsonTitle || parsed.title || '',
      author: jsonAuthor || parsed.author || '',
      region: '', // optional
      typeValue: typeValue || '', // optional
      publishDate,
      articleLink,
      feishuLink: feishuLink || ''
    };

    const missing = [];
    if (!row.title.trim()) missing.push('title');
    if (!row.author.trim()) missing.push('author');
    if (!String(row.publishDate || '').trim()) missing.push('publishDate');
    if (!String(row.articleLink || '').trim()) missing.push('articleLink');
    if (missing.length) throw new Error(`missing required fields: ${missing.join(',')}`);

    // Ensure the persistent Feishu form tab is on the entry page (click "Fill Again" if needed).
    await ensureFormEntryPage(formPage, config.selectors.feishuForm);
    await submitRowToFeishuForm(formPage, config.selectors.feishuForm, row);

    return { topicId, dateOnly: parsed.dateOnly || '', row, pageNo, indexInPage };
  } finally {
    if (detailPage !== listPage) {
      await detailPage.close().catch(() => {});
    } else {
      // Navigate back to digests list if click switched the SPA view.
      if (!detailPage.url().includes('/digests/')) {
        await detailPage.goBack({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
        if (!detailPage.url().includes('/digests/')) {
          await detailPage.goto(digestsUrl, { waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => {});
        }
        await waitForDigestItems(detailPage);
      }
    }
  }
}

function isSkippableError(err) {
  if (!err) return false;
  if (err._skip) return true;
  const msg = String(err && err.message ? err.message : err);
  if (msg.startsWith('SKIP:')) return true;
  return false;
}

async function main() {
  const configPath = path.resolve(__dirname, '..', 'config.json');
  if (!fs.existsSync(configPath)) throw new Error('Missing automation/config.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

  const groupId = String(process.env.GROUP_ID || '1824528822');
  const digestsUrl = process.env.DIGESTS_URL || `https://wx.zsxq.com/digests/${groupId}`;

  const startDate = normDate(process.env.START_DATE || '2026-02-28');
  const endDate = normDate(process.env.END_DATE || '2020-01-01');
  if (!startDate || !endDate) throw new Error('START_DATE/END_DATE must be YYYY-MM-DD');

  const maxItems = Number(process.env.MAX_ITEMS || '0');
  const outDir = path.resolve(__dirname, '..', 'output');
  const progressPath = path.join(outDir, 'zsxq_digests_progress.json');
  const donePath = path.join(outDir, 'zsxq_digests_done.jsonl');
  const errPath = path.join(outDir, 'zsxq_digests_errors.jsonl');
  const storageStatePath = path.resolve(__dirname, '..', config.storageStatePath || './storage_state.json');

  // Human-like pacing (avoid risk controls).
  const pacer = createPacerFromConfig(config, {
    label: 'zsxq-digests',
    mode: 'human',
    // Tuned "recommended" speed: faster than before, still pattern-broken.
    maxPerHour: 36,
    dailyMax: 600,
    allowedWindows: [{ start: '07:00', end: '23:59' }],
    jitterMs: 6000,
    session: {
      workMinMs: 22 * 60 * 1000,
      workMaxMs: 42 * 60 * 1000,
      restMinMs: 3 * 60 * 1000,
      restMaxMs: 8 * 60 * 1000
    },
    dwellWeights: [
      { w: 0.82, min: 18 * 1000, max: 75 * 1000 },
      { w: 0.15, min: 75 * 1000, max: 3 * 60 * 1000 },
      { w: 0.03, min: 4 * 60 * 1000, max: 7 * 60 * 1000 }
    ],
    megaPause: {
      everyMin: 10,
      everyMax: 20,
      minMs: 2 * 60 * 1000,
      maxMs: 6 * 60 * 1000
    }
  });
  if (process.env.FAST === '1') {
    pacer.enabled = false;
    console.log('[collect] FAST=1 => pacing disabled (test only)');
  }

  const state0 = readJsonSafe(progressPath, null);
  const progress =
    state0 &&
    state0.groupId === groupId &&
    state0.range &&
    state0.range.startDate === startDate &&
    state0.range.endDate === endDate
      ? state0
      : {
          groupId,
          range: { startDate, endDate },
          pageNo: 1,
          indexInPage: 0,
          done: 0,
          skippedNewer: 0,
          lastDate: '',
          lastTopicId: '',
          status: 'init',
          reason: ''
        };

  const context = await launchContext(config, __dirname);
  try {
    const listPage = await context.newPage();
    await listPage.goto(digestsUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await waitForDigestItems(listPage);
    await ensureLoggedIn(listPage, context, storageStatePath, 'zsxq');

    // Keep one Feishu tab open for all submissions to avoid per-item reloading/login churn.
    const formPage = await openFeishuFormPage(context, config, storageStatePath);
    await ensureFormEntryPage(formPage, config.selectors.feishuForm);

    // Seek pages if resuming.
    if (progress.pageNo > 1) {
      console.log(`[resume] seeking to pageNo=${progress.pageNo} ...`);
      for (let p = 1; p < progress.pageNo; p++) {
        const ok = await gotoNextPage(listPage);
        if (!ok) break;
        await ensureLoggedIn(listPage, context, storageStatePath, 'zsxq');
        await sleep(160 + Math.floor(Math.random() * 420));
      }
      console.log('[resume] seek done.');
    }

    let processed = 0;
    progress.status = 'running';
    writeJsonAtomic(progressPath, progress);

    while (true) {
      await ensureLoggedIn(listPage, context, storageStatePath, 'zsxq');
      const items = await waitForDigestItems(listPage);
      const itemCount = await items.count().catch(() => 0);
      if (itemCount <= 0) throw new Error('No digest items found');

      for (let i = progress.indexInPage; i < itemCount; i++) {
        const raw = await items.nth(i).innerText().catch(() => '');
        const parsed = parseDigestListItemText(raw);
        const dateOnly = parsed.dateOnly;
        if (!dateOnly) continue;

        // Newer than start => skip.
        if (dateOnly > startDate) {
          progress.skippedNewer += 1;
          continue;
        }

        // Older than end => stop entire job.
        if (dateOnly < endDate) {
          progress.status = 'done';
          progress.reason = `reached end: ${dateOnly} < ${endDate}`;
          writeJsonAtomic(progressPath, progress);
          console.log(`[collect] done: ${progress.reason}`);
          return;
        }

        await pacer.beforeItem(`page=${progress.pageNo} idx=${i + 1}/${itemCount} date=${dateOnly}`);

        try {
          const res = await collectOne(context, config, formPage, digestsUrl, groupId, progress.pageNo, i);
          progress.done += 1;
          progress.lastTopicId = res.topicId || '';
          progress.lastDate = res.dateOnly || dateOnly;
          progress.indexInPage = i + 1;
          appendJsonl(donePath, { at: new Date().toISOString(), ...res });
          writeJsonAtomic(progressPath, progress);
          processed += 1;

          if (maxItems > 0 && processed >= maxItems) {
            progress.status = 'paused';
            progress.reason = `MAX_ITEMS=${maxItems}`;
            writeJsonAtomic(progressPath, progress);
            console.log(`[collect] ${progress.reason}; stopping`);
            return;
          }
        } catch (err) {
          const msg = String(err && err.message ? err.message : err);
          appendJsonl(errPath, {
            at: new Date().toISOString(),
            pageNo: progress.pageNo,
            indexInPage: i,
            error: msg
          });

          if (isSkippableError(err)) {
            // Non-recoverable for this item; skip forward without long backoff.
            progress.status = 'running';
            progress.reason = '';
            progress.indexInPage = i + 1;
            writeJsonAtomic(progressPath, progress);
            // Small jitter so we don't look like a tight loop on errors.
            await sleep(700 + Math.floor(Math.random() * 1400));
            continue;
          }

          progress.status = 'error';
          progress.reason = msg;
          writeJsonAtomic(progressPath, progress);

          if (pacer && typeof pacer.afterError === 'function') {
            await pacer.afterError(`page=${progress.pageNo} idx=${i}`).catch(() => {});
          }
          // Retry from same i for potentially recoverable errors.
          continue;
        }
      }

      // Finished this page; go next.
      progress.pageNo += 1;
      progress.indexInPage = 0;
      writeJsonAtomic(progressPath, progress);

      const ok = await gotoNextPage(listPage);
      if (!ok) {
        progress.status = 'done';
        progress.reason = 'next button disabled';
        writeJsonAtomic(progressPath, progress);
        console.log('[collect] next button disabled; stopping');
        return;
      }
    }
  } finally {
    await closeContext(context);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
