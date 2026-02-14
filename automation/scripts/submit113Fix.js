const path = require('path');
const { launchContext, closeContext } = require('./browserContext');
const fs = require('fs');

const config = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'config.json'), 'utf-8'));
const FORM_URL = 'https://ucnbnmgoiyel.feishu.cn/share/base/form/shrcnetYBXcFx13cg9Cx0KmaCsf';

const row = {
  title: '深耕亚马逊两年，分享做电商开品的底层思路，国内也适用，新人可参考',
  author: '女巫的蛋挞',
  region: '广东省/深圳市/宝安区',
  industry: '跨境电商',
  publishDate: '2026-01-09 18:59',
  articleLink: 'https://scys.com/articleDetail/xq_topic/55188521852482814',
  feishuLink: 'https://swsnt8up65p.feishu.cn/wiki/YIpAwrKcFiSU5Bk6C0DcxVnGnnc'
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function containerByLabel(page, label) {
  const loc = page.getByText(label, { exact: false }).first();
  if ((await loc.count()) === 0) throw new Error(`Label not found: ${label}`);
  const c = loc.locator('xpath=ancestor::div[starts-with(@id,"field-item-")][1]');
  if ((await c.count()) === 0) throw new Error(`Field container not found: ${label}`);
  return c.first();
}

async function setTextField(page, label, value) {
  const c = await containerByLabel(page, label);
  const editable = c.locator('[contenteditable="true"]').first();
  if ((await editable.count()) === 0) throw new Error(`Editable not found: ${label}`);
  await editable.click({ force: true });
  await editable.press('Meta+A').catch(async () => { await editable.press('Control+A').catch(() => {}); });
  await editable.press('Backspace').catch(() => {});
  await editable.type(String(value || ''), { delay: 15 });
  await sleep(200);
  const ok = (await c.innerText()).includes(String(value || ''));
  if (!ok) throw new Error(`Text not applied for ${label}`);
}

async function setSelectField(page, label, value) {
  const c = await containerByLabel(page, label);
  const trigger = c.locator('[data-e2e="bitable-select-value-placeholder"], input[placeholder="Select an option"]').first();
  if ((await trigger.count()) === 0) throw new Error(`Select trigger not found: ${label}`);
  await trigger.click({ force: true });
  await sleep(300);

  const input = c.locator('input[placeholder="Select an option"]').first();
  const valueText = String(value || '').trim();
  if ((await input.count()) > 0) {
    await input.fill(valueText, { timeout: 3000 }).catch(() => {});
    await sleep(150);
  }

  let option = page.locator('.b-select-option').filter({ hasText: valueText }).first();
  if ((await option.count()) === 0) {
    option = page.getByText(valueText, { exact: true }).first();
  }
  if ((await option.count()) > 0) {
    await option.click({ force: true, timeout: 5000 });
  } else if ((await input.count()) > 0) {
    // Create a new option when the dropdown has no exact match.
    await page.keyboard.press('Enter').catch(() => {});
  } else {
    throw new Error(`Option not found for ${label}: ${valueText}`);
  }
  await sleep(250);

  const text = await c.innerText();
  if (!text.includes(valueText)) {
    throw new Error(`Select mismatch for ${label}. expected=${valueText} got=${text}`);
  }
}

(async () => {
  const context = await launchContext(config, __dirname);
  const page = await context.newPage();
  await page.goto(FORM_URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await sleep(3500);

  await setTextField(page, '标题', row.title);
  await setTextField(page, '圈友', row.author);
  await setTextField(page, '地区', row.region);
  await setTextField(page, '类型', row.industry).catch(async () => {
    await setTextField(page, '行业', row.industry);
  });
  await setTextField(page, '文章发布时间', row.publishDate);
  await setTextField(page, '文章链接', row.articleLink);
  await setTextField(page, '飞书链接', row.feishuLink);

  const submit = page.getByText('Submit', { exact: false }).first();
  const enabled = await submit.isEnabled().catch(() => false);
  if (!enabled) throw new Error('Submit disabled after fill/validation');

  await submit.click({ timeout: 8000 });
  console.log('Submitted corrected row for 113.');

  await closeContext(context);
})();
