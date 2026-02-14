// Trial: open ZSXQ digests list, pick 1 topic, extract fields, submit to Feishu form.
// Usage:
//   node automation/scripts/zsxqDigestsTrialOne.js
// Env:
//   DIGESTS_URL=... (optional)
//   PROFILE_NAME=brian (optional; only used if useChromeProfile=true)

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const { launchContext, closeContext } = require('./browserContext');
const { sleep } = require('../lib/runtime/wait');
const { createPacerFromConfig } = require('../lib/runtime/pacer');
const { norm } = require('../lib/io/csv');
const { extractTopicId, fmtDateFromCreateTime, firstFeishuLinkFromJson, fetchTopicPayload } = require('../lib/extractors/zsxq');
const { submitRowToFeishuForm } = require('../lib/sinks/feishuForm');

function rlQuestion(prompt) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(prompt, () => { rl.close(); resolve(); }));
}

async function maybeWaitForLoginAndSave(context, page, config, storageStatePath) {
  const loginHints = ['获取登录二维码', '扫码登录', '微信扫码'];
  for (const t of loginHints) {
    const c = await page.getByText(t, { exact: false }).count().catch(() => 0);
    if (c > 0) {
      console.log(`Detected login page via text="${t}".`);
      console.log('Please scan QR code / login in the opened browser window. Waiting for login to complete...');

      // Auto-detect login success: once the digests page has topic links, proceed and save state.
      const timeoutMs = Number(process.env.LOGIN_TIMEOUT_MS || String(10 * 60 * 1000)); // default 10 minutes
      const started = Date.now();
      let iter = 0;
      while (Date.now() - started < timeoutMs) {
        iter += 1;
        await sleep(1500);
        const still = await page.getByText(t, { exact: false }).count().catch(() => 0);
        const maybeLink = await findFirstTopicLink(page).catch(() => '');
        const looksLikeList = await looksLikeDigestsList(page).catch(() => false);

        if (iter % 10 === 0) {
          const aCount = await page.locator('a[href]').count().catch(() => 0);
          console.log(`[login-wait] stillHint=${still} anchors=${aCount} hasTopicLink=${!!maybeLink} looksLikeList=${looksLikeList}`);
        }

        // Some pages keep the login hint text in the DOM even after login (hidden),
        // so we treat "looks like list" or "has topic link" as the real signal.
        if (maybeLink || looksLikeList) {
          await context.storageState({ path: storageStatePath });
          console.log(`Saved storage state: ${storageStatePath}`);
          return true;
        }
      }

      // Fallback to manual confirmation, in case DOM keeps showing login hint text.
      await rlQuestion('Login timeout reached. If you are already logged in and can see the digests list, press Enter to continue...');
      await context.storageState({ path: storageStatePath });
      console.log(`Saved storage state: ${storageStatePath}`);
      return true;
    }
  }
  return false;
}

function titleFromTalkText(talkText) {
  const s = norm(talkText);
  if (!s) return '';
  const firstLine = s.split('\n')[0].trim();
  if (firstLine.length <= 80) return firstLine;
  return firstLine.slice(0, 77) + '...';
}

async function detectCurrentType(page) {
  // ZSXQ digests page uses `.hashtag actived` for the selected category chip.
  const chip = page.locator('.hashtag.actived').first();
  if ((await chip.count().catch(() => 0)) > 0) {
    const t = norm(await chip.innerText().catch(() => ''));
    if (t) return t;
  }

  // Fallback: avoid picking sort controls like "最新发布".
  const type = await page
    .evaluate(() => {
      const bad = new Set(['最新发布', '最早发布', '返回', '生财有术', '首页']);
      const nodes = Array.from(document.querySelectorAll('button, a, div, span'));
      for (const el of nodes) {
        const cls = String(el.className || '');
        if (!/(actived|active|selected|current)/i.test(cls)) continue;
        const t = (el.textContent || '').trim();
        if (!t || t.length > 12) continue;
        if (bad.has(t)) continue;
        return t;
      }
      return '';
    })
    .catch(() => '');

  return type || '全部';
}

async function looksLikeDigestsList(page) {
  const header = await page.getByText('精华主题', { exact: false }).count().catch(() => 0);
  if (header > 0) return true;

  // A lot of list rows show "赞" and a date like "2025/12/24".
  const hasDateLike = await page
    .evaluate(() => /20\d{2}\/\d{2}\/\d{2}/.test((document.body && document.body.innerText) || ''))
    .catch(() => false);
  if (hasDateLike) return true;

  const likes = await page.getByText('赞', { exact: false }).count().catch(() => 0);
  if (likes >= 3) return true;

  return false;
}

async function clickDigestAndGetTopicLink(page, index = 0) {
  // Digests list uses DIVs (no <a href>).
  const item = page.locator('.digest-topic-item').nth(index);
  if ((await item.count().catch(() => 0)) === 0) {
    throw new Error('No .digest-topic-item found on digests page');
  }

  let topicId = '';
  const captureFromUrl = (u) => {
    const m1 = String(u || '').match(/[?&]topic_id=(\d+)/);
    if (m1) return m1[1];
    const m2 = String(u || '').match(/\/topic\/(\d+)/);
    if (m2) return m2[1];
    return '';
  };

  const onResponse = async (res) => {
    const u = res.url();
    const m = u.match(/\/v2\/topics\/(\d+)/);
    if (m && !topicId) topicId = m[1];
  };
  page.on('response', onResponse);

  await item.scrollIntoViewIfNeeded().catch(() => {});
  const popupPromise = page.waitForEvent('popup', { timeout: 5000 }).catch(() => null);
  await item.click({ timeout: 15000 }).catch((e) => {
    throw new Error(`Failed to click digest item index=${index}: ${String(e && e.message ? e.message : e)}`);
  });
  const popup = await popupPromise;

  let activePage = page;
  if (popup) {
    activePage = popup;
    popup.on('response', onResponse);
    await popup.waitForLoadState('domcontentloaded').catch(() => {});
    await popup.waitForLoadState('networkidle').catch(() => {});
  } else {
    // If it navigates in the same tab, wait a bit.
    await page.waitForLoadState('networkidle').catch(() => {});
  }

  // Try URL first.
  const fromUrl = captureFromUrl(activePage.url());
  if (fromUrl) topicId = topicId || fromUrl;

  // Wait briefly for API response capture.
  const started = Date.now();
  while (!topicId && Date.now() - started < 12000) {
    await sleep(400);
    const u = activePage.url();
    const id = captureFromUrl(u);
    if (id) topicId = id;
  }

  page.off('response', onResponse);

  if (!topicId) {
    throw new Error('Clicked digest item but could not detect topic_id (no href, no /v2/topics/ response captured)');
  }

  return {
    topicId,
    topicLink: `https://wx.zsxq.com/mweb/views/topicdetail/topicdetail.html?topic_id=${topicId}`,
    activePage,
    openedPopup: !!popup
  };
}

async function findFirstTopicLink(page) {
  // Collect anchor hrefs and pick the first one that looks like a topic detail.
  const hrefs = await page.evaluate(() => Array.from(document.querySelectorAll('a[href]')).map((a) => a.href)).catch(() => []);
  const topicLinks = [];
  for (const h of hrefs) {
    if (!h) continue;
    if (!/zsxq\.com/i.test(h)) continue;
    if (!/(topic_id=|\/topic\/\d+)/.test(h)) continue;
    if (/digests|digest/i.test(h)) continue;
    topicLinks.push(h);
  }
  // De-dupe while preserving order.
  const seen = new Set();
  const uniq = [];
  for (const h of topicLinks) {
    if (seen.has(h)) continue;
    seen.add(h);
    uniq.push(h);
  }
  if (uniq[0]) return uniq[0];
  return '';
}

async function tryOpenFeishuLinkFromTopicPage(context, topicPage) {
  // If the Feishu link is rendered as a clickable anchor but not a direct https URL,
  // clicking it and capturing the opened page URL is more reliable.
  const anchor = topicPage.locator('a').filter({ hasText: /飞书|云文档|Feishu|Lark/i }).first();
  if ((await anchor.count().catch(() => 0)) === 0) return '';

  const href = await anchor.getAttribute('href').catch(() => '');
  if (href && /^https?:\/\//i.test(href) && /(feishu|lark)\./i.test(href)) return href;

  // Clicking may open a new tab/page.
  const popupPromise = context.waitForEvent('page', { timeout: 8000 }).catch(() => null);
  await anchor.click({ timeout: 8000 }).catch(() => {});
  const popup = await popupPromise;
  if (!popup) return '';
  await popup.waitForLoadState('domcontentloaded').catch(() => {});
  await sleep(800);
  const u = popup.url();
  await popup.close().catch(() => {});
  if (/(feishu|lark)\./i.test(u)) return u;
  return '';
}

async function waitForFeishuFormReady(page, formLabels) {
  const timeoutMs = Number(process.env.FEISHU_TIMEOUT_MS || String(10 * 60 * 1000)); // default 10 minutes
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const c = await page.getByText(formLabels.titleLabel, { exact: false }).count().catch(() => 0);
    if (c > 0) return true;
    await sleep(1500);
  }
  return false;
}

async function dumpPaginationHints(page) {
  const texts = ['下一页', '下一章', '下一页 >', '>', 'Next'];
  const found = [];
  for (const t of texts) {
    const n = await page.getByText(t, { exact: false }).count().catch(() => 0);
    if (n > 0) found.push(`${t} x${n}`);
  }
  const links = await page.evaluate(() => {
    const a = Array.from(document.querySelectorAll('a[href]')).map((x) => x.href);
    return a.filter((h) => /page=|cursor=|offset=|start=/.test(h)).slice(0, 10);
  }).catch(() => []);

  console.log('Pagination hints:');
  console.log(`- textMatches: ${found.length ? found.join(', ') : '(none)'}`);
  console.log(`- urlCandidates: ${links.length ? links.join(' | ') : '(none)'}`);

  // ZSXQ digests uses a paginator with li.page-prev/page-next.
  const paginatorInfo = await page.evaluate(() => {
    const next = document.querySelector('li.page-next');
    const prev = document.querySelector('li.page-prev');
    const item = document.querySelector('li.page-item.page-item-active');
    const cls = (el) => (el && el.className ? String(el.className) : '');
    const text = (el) => (el && el.textContent ? el.textContent.trim() : '');
    return {
      hasPaginator: !!document.querySelector('.paginator'),
      activeText: text(item),
      prevClass: cls(prev),
      nextClass: cls(next)
    };
  }).catch(() => ({}));
  console.log(`- paginator: ${JSON.stringify(paginatorInfo)}`);
}

async function main() {
  const configPath = path.resolve(__dirname, '..', 'config.json');
  if (!fs.existsSync(configPath)) {
    throw new Error('Missing automation/config.json. Copy automation/config.example.json to automation/config.json and fill URLs.');
  }
  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

  const digestsUrl = process.env.DIGESTS_URL || 'https://wx.zsxq.com/digests/1824528822';
  const maxItems = Number(process.env.MAX_ITEMS || '1');
  const profileName = process.env.PROFILE_NAME || 'brian';
  const runConfig = { ...config, chromeProfileDirectory: profileName };
  // Quick toggle for reusing a Chrome profile snapshot instead of storage_state.json.
  // USE_CHROME_PROFILE=1 will set useChromeProfile=true and force useSavedStorageState=false.
  if (process.env.USE_CHROME_PROFILE === '1') {
    runConfig.useChromeProfile = true;
    runConfig.useSavedStorageState = false;
  }
  const storageStatePath = path.resolve(__dirname, '..', config.storageStatePath || './storage_state.json');

  const pacer = createPacerFromConfig(config, { label: 'zsxq-digests', maxPerHour: 30, jitterMs: 8000 });

  const context = await launchContext(runConfig, __dirname);
  try {
    try {
      await pacer.beforeItem('digests-trial');
      const page = await context.newPage();
      await page.goto(digestsUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
      await page.waitForLoadState('networkidle').catch(() => {});
      await sleep(1200);

      await maybeWaitForLoginAndSave(context, page, config, storageStatePath);

      // Ensure we are on digests page after login.
      if (!page.url().includes('/digests/')) {
        await page.goto(digestsUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
        await page.waitForLoadState('networkidle').catch(() => {});
        await sleep(1200);
      }

      await dumpPaginationHints(page);

      // Type is optional; user prefers not to fill it. Keep empty.
      const typeValue = '';
      console.log('Detected typeValue="" (skipped)');

      for (let idx = 0; idx < maxItems; idx++) {
        await pacer.beforeItem(`digests-item idx=${idx + 1}/${maxItems}`);

        let topicLink = await findFirstTopicLink(page);
        let topicPageFromClick = null;
        let topicIdFromClick = '';

        if (!topicLink) {
          // Digests list doesn't expose <a href>, so click the list item and infer topic_id.
          const clicked = await clickDigestAndGetTopicLink(page, idx);
          topicLink = clicked.topicLink;
          topicPageFromClick = clicked.activePage;
          topicIdFromClick = clicked.topicId;
        }

        if (!topicLink) {
          throw new Error('No topic link found on digests page. (Maybe not logged in, or DOM changed.)');
        }

        const topicId = topicIdFromClick || extractTopicId(topicLink);
        console.log(`Picked topicLink=${topicLink}`);
        console.log(`topicId=${topicId || '(empty)'}`);
        if (!topicId) throw new Error('topic_id not found in picked link');

        // Reuse the page opened by clicking the digest item (to avoid duplicate tabs).
        const topicPage = topicPageFromClick || (await context.newPage());
        try {
          const payload = await fetchTopicPayload(context, topicPage, topicId, topicLink);
          if (!payload) throw new Error('topic payload empty');
          const json = JSON.parse(payload);
          const topic = json?.resp_data?.topic || {};
          const owner = topic?.talk?.owner || {};

          if (process.env.DEBUG === '1') {
            console.log('topic.keys=', Object.keys(topic || {}));
            console.log('talk.keys=', Object.keys((topic && topic.talk) || {}));
            console.log('owner.name=', norm(owner && owner.name));
            console.log('talk.text.len=', String((topic && topic.talk && topic.talk.text) || '').length);
          }

          const title = titleFromTalkText(topic?.talk?.text || '');
          const author = norm(owner?.name) || '';
          const publishDate = fmtDateFromCreateTime(topic?.create_time) || '';

          let feishuLink = firstFeishuLinkFromJson(topic);
          if (!/(feishu|lark)\./i.test(feishuLink)) {
            const clicked2 = await tryOpenFeishuLinkFromTopicPage(context, topicPage);
            if (clicked2) feishuLink = clicked2;
          }

          const row = {
            title,
            author,
            // Region is optional; leave empty if not available.
            region: '',
            typeValue,
            publishDate,
            articleLink: topicPage.url(),
            feishuLink
          };

          console.log('Extracted row preview:');
          console.log(row);
          console.log(`Feishu submit search key (articleLink): ${row.articleLink}`);

          const formPage = await context.newPage();
          await formPage.goto(config.feishuFormUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
          await sleep(1500);

          // If the form requires login, wait until field labels appear, then persist combined storage_state.
          const formLabels = config.selectors.feishuForm;
          const readyNow = (await formPage.getByText(formLabels.titleLabel, { exact: false }).count().catch(() => 0)) > 0;
          if (!readyNow) {
            console.log('Feishu form not ready (likely requires login). Please login in the opened Feishu tab...');
            const ok = await waitForFeishuFormReady(formPage, formLabels);
            if (!ok) throw new Error('Feishu form still not ready after waiting');
            await context.storageState({ path: storageStatePath });
            console.log(`Saved combined storage state (zsxq+feishu): ${storageStatePath}`);
          }

          await submitRowToFeishuForm(formPage, formLabels, row);
          await sleep(1200);
          await formPage.close().catch(() => {});

          console.log(`Submitted row idx=${idx + 1}/${maxItems} to Feishu form.`);
        } finally {
          // Only close if it's not the main list page.
          if (topicPage !== page) {
            await topicPage.close().catch(() => {});
          }
        }
      }

      await page.close().catch(() => {});
    } catch (err) {
      if (pacer && typeof pacer.afterError === 'function') {
        await pacer.afterError('zsxq-digests').catch(() => {});
      }
      throw err;
    }
  } finally {
    await closeContext(context);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
