const fs = require('fs');
const path = require('path');
const { launchContext, closeContext } = require('./browserContext');

const configPath = path.resolve(__dirname, '..', 'config.json');
if (!fs.existsSync(configPath)) {
  console.error('Missing config.json');
  process.exit(1);
}
const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function loadRows() {
  return [
    {
      title: '【大学老师初入油管】21天2400万观看，初级YPP审核失败，我用AI手搓了一个油管视频流水线',
      author: '天才老师',
      region: '广西壮族自治区/北海市/银海区',
      industry: '出海',
      publishDate: '2026-01-01 00:52',
      articleLink: 'https://scys.com/articleDetail/xq_topic/14588582112884152',
      feishuLink: 'https://vcn55ni4prkd.feishu.cn/wiki/F7zuwK7YXioUbNkGmwNcZ5PUngf'
    },
    {
      title: '深耕亚马逊两年，分享做电商开品的底层思路，国内也适用，新人可参考',
      author: '女巫的蛋挞',
      region: '广东省/深圳市/宝安区',
      industry: '出海',
      publishDate: '2026-01-09 18:59',
      articleLink: 'https://scys.com/articleDetail/xq_topic/55188521852482814',
      feishuLink: 'https://swsnt8up65p.feishu.cn/wiki/YIpAwrKcFiSU5Bk6C0DcxVnGnnc'
    }
  ];
}

async function setEditableByIndex(page, index, value) {
  const editable = page.locator('[contenteditable="true"]').nth(index);
  if ((await editable.count()) === 0) {
    throw new Error(`contenteditable index ${index} not found`);
  }
  await editable.click({ timeout: 5000 });
  await editable.press('Meta+A').catch(async () => {
    await editable.press('Control+A').catch(() => {});
  });
  await editable.press('Backspace').catch(() => {});
  await editable.type(String(value || ''), { delay: 15 });
}

async function setTextByLabel(page, label, value) {
  const labelNode = page.getByText(label, { exact: false }).first();
  if ((await labelNode.count()) === 0) throw new Error(`label not found: ${label}`);
  const container = labelNode.locator('xpath=ancestor::div[starts-with(@id,"field-item-")][1]').first();
  const editable = container.locator('[contenteditable="true"]').first();
  if ((await editable.count()) === 0) throw new Error(`editable not found: ${label}`);
  await editable.click({ force: true });
  await editable.press('Meta+A').catch(async () => {
    await editable.press('Control+A').catch(() => {});
  });
  await editable.press('Backspace').catch(() => {});
  await editable.type(String(value || ''), { delay: 12 });
  await sleep(150);
}

async function waitSubmitEnabled(page, timeoutMs = 12000) {
  const submit = page.getByText('Submit', { exact: false }).first();
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await submit.isEnabled().catch(() => false)) return true;
    await sleep(300);
  }
  return false;
}

async function clickFillAgain(page) {
  const texts = ['再次填写表单', '再次提交', '再填一份', 'Submit another response', 'Fill out another response'];
  for (const t of texts) {
    const btn = page.getByText(t, { exact: false }).first();
    if ((await btn.count()) > 0) {
      await btn.click({ timeout: 8000 });
      return true;
    }
  }
  return false;
}

function toFormRow(row) {
  return {
    title: row.title || '测试标题',
    publishDate: row.publishDate || '2026-01-01 00:00',
    articleLink: row.articleLink || 'https://scys.com',
    feishuLink: row.feishuLink || '',
    authorOption: row.author || '天才老师',
    regionOption: row.region && row.region !== '暂时不知' ? row.region : '广西壮族自治区/北海市/银海区',
    industryOption: row.industry === '出海' ? '跨境电商' : (row.industry || '跨境电商')
  };
}

(async () => {
  const rows = loadRows();
  if (rows.length < 2) {
    throw new Error('Need at least 2 rows in output/records.jsonl');
  }

  const context = await launchContext(config, __dirname);
  const page = await context.newPage();
  await page.goto('https://ucnbnmgoiyel.feishu.cn/share/base/form/shrcnetYBXcFx13cg9Cx0KmaCsf', {
    waitUntil: 'domcontentloaded',
    timeout: 90000
  });
  await sleep(5000);

  for (let i = 0; i < 2; i++) {
    const row = toFormRow(rows[i]);
    console.log(`Preparing row ${i + 1}: ${row.title}`);

    await setTextByLabel(page, '标题', row.title);
    await setTextByLabel(page, '圈友', row.authorOption);
    await setTextByLabel(page, '地区', row.regionOption);
    await setTextByLabel(page, '类型', row.industryOption).catch(async () => {
      await setTextByLabel(page, '行业', row.industryOption);
    });
    await setTextByLabel(page, '文章发布时间', row.publishDate);
    await setTextByLabel(page, '文章链接', row.articleLink);
    await setTextByLabel(page, '飞书链接', row.feishuLink);

    const enabled = await waitSubmitEnabled(page, 12000);
    if (!enabled) {
      await page.screenshot({ path: path.resolve(__dirname, '..', `./output/trial_submit_disabled_${Date.now()}.png`), fullPage: true }).catch(() => {});
      throw new Error('Submit button still disabled after filling required fields.');
    }

    await page.getByText('Submit', { exact: false }).first().click({ timeout: 10000 });
    console.log(`Submitted row ${i + 1}`);
    await sleep(3000);

    if (i < 1) {
      const ok = await clickFillAgain(page);
      if (!ok) {
        await page.goto('https://ucnbnmgoiyel.feishu.cn/share/base/form/shrcnetYBXcFx13cg9Cx0KmaCsf', {
          waitUntil: 'domcontentloaded',
          timeout: 90000
        });
        await sleep(2500);
      }
      await sleep(1200);
    }
  }

  console.log('Two-row trial submit finished.');
  await closeContext(context);
})();
