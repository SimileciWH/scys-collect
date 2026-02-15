const { sleep } = require('../runtime/wait');
const fs = require('fs');
const path = require('path');

async function fieldContainerByLabel(page, label) {
  // Prefer actual <label> nodes to avoid matching unrelated text elsewhere on the page.
  const labelNode = page.locator('label', { hasText: label }).first();
  const fallback = page.getByText(label, { exact: false }).first();
  const node = (await labelNode.count().catch(() => 0)) > 0 ? labelNode : fallback;
  if ((await node.count()) === 0) throw new Error(`Label not found: ${label}`);
  const container = node.locator('xpath=ancestor::div[starts-with(@id,"field-item-")][1]').first();
  if ((await container.count()) === 0) throw new Error(`Field container not found: ${label}`);
  return container;
}

async function waitForSubmitSuccess(page) {
  // Feishu shared forms typically show a success page with "提交成功" or a "再次填写" button.
  const patterns = [
    /提交成功/i,
    /感谢.*提交/i,
    /已提交/i,
    /再次填写/i,
    /继续填写/i,
    /submitted/i,
    /fill again/i
  ];
  const started = Date.now();
  const timeoutMs = Number(process.env.FEISHU_SUBMIT_TIMEOUT_MS || '20000');
  while (Date.now() - started < timeoutMs) {
    for (const re of patterns) {
      const c = await page.getByText(re, { exact: false }).count().catch(() => 0);
      if (c > 0) return true;
    }
    await sleep(500);
  }
  return false;
}

async function dumpDebugArtifacts(page, prefix) {
  try {
    const dir = path.resolve(process.cwd(), 'automation/output');
    fs.mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const png = path.join(dir, `${prefix}_${ts}.png`);
    const html = path.join(dir, `${prefix}_${ts}.html`);
    await page.screenshot({ path: png, fullPage: true }).catch(() => {});
    const content = await page.content().catch(() => '');
    if (content) fs.writeFileSync(html, content, 'utf-8');
  } catch (_) {}
}

async function ensureFormEntryPage(page, formLabels) {
  // If we're on the success/landing page, click "Fill Again/再次填写" to get back to the form.
  const againBtn = page.getByRole('button', { name: /fill again|再次填写|继续填写|重新填写|开始填写|填写表单/i }).first();
  if ((await againBtn.count().catch(() => 0)) > 0) {
    await againBtn.click({ timeout: 10000 }).catch(() => {});
    await sleep(1200);
  }

  // Wait until the form fields are visible.
  const started = Date.now();
  const timeoutMs = Number(process.env.FEISHU_FORM_READY_TIMEOUT_MS || '20000');
  while (Date.now() - started < timeoutMs) {
    const c = await page.getByText(formLabels.titleLabel, { exact: false }).count().catch(() => 0);
    if (c > 0) return true;
    await sleep(500);
  }
  return false;
}

async function fillField(page, label, value, attempt = 0) {
  const v = String(value || '');
  const container = await fieldContainerByLabel(page, label);
  await container.scrollIntoViewIfNeeded().catch(() => {});
  await sleep(120);

  const anyControl = container.locator('input, textarea, [contenteditable], [role="textbox"]');
  if ((await anyControl.count().catch(() => 0)) === 0) {
    // Controls may mount lazily.
    await anyControl.first().waitFor({ state: 'attached', timeout: 8000 }).catch(() => {});
  }

  let input = container.locator('input, textarea').first();
  if ((await input.count().catch(() => 0)) > 0) {
    await input.click({ force: true });
    await input.fill(v);
    await input.dispatchEvent('input').catch(() => {});
    await input.dispatchEvent('change').catch(() => {});
    await input.press('Tab').catch(() => {});
    await sleep(80);
    return;
  }
  // Bitable form editor uses rich text nodes. contenteditable can be "true" or "plaintext-only".
  let editable = container.locator('[contenteditable], [role="textbox"]').first();
  if ((await editable.count()) === 0) {
    // Some editors only appear after focus.
    await container.click({ force: true }).catch(() => {});
    await sleep(200);
    input = container.locator('input, textarea').first();
    if ((await input.count().catch(() => 0)) > 0) {
      await input.fill(v);
      await input.dispatchEvent('input').catch(() => {});
      await input.dispatchEvent('change').catch(() => {});
      await input.press('Tab').catch(() => {});
      await sleep(80);
      return;
    }
    editable = container.locator('[contenteditable], [role=\"textbox\"]').first();

    // Some shared forms show a landing/success page that requires clicking "开始填写/再次填写".
    if (attempt === 0) {
      const start = page.getByRole('button', { name: /再次填写|开始填写|填写表单|继续填写|重新填写/i }).first();
      if ((await start.count().catch(() => 0)) > 0) {
        await start.click({ timeout: 10000 }).catch(() => {});
        await sleep(1200);
        return fillField(page, label, value, attempt + 1);
      }
      const startText = page.getByText(/再次填写|开始填写|填写表单|继续填写|重新填写/i, { exact: false }).first();
      if ((await startText.count().catch(() => 0)) > 0) {
        await startText.click({ timeout: 10000 }).catch(() => {});
        await sleep(1200);
        return fillField(page, label, value, attempt + 1);
      }
    }
    if (process.env.FEISHU_DEBUG === '1') {
      const dbg = await container
        .evaluate((el) => ({
          id: el.id,
          cls: el.className,
          contenteditableCount: el.querySelectorAll('[contenteditable]').length,
          inputCount: el.querySelectorAll('input,textarea').length,
          html: el.outerHTML.slice(0, 600)
        }))
        .catch(() => null);
      // eslint-disable-next-line no-console
      console.log(`[feishu-debug] label=${label} attempt=${attempt} container=`, dbg);
    }
    throw new Error(`No writable control: ${label}`);
  }
  await editable.click({ force: true });
  await editable.press('Meta+A').catch(async () => { await editable.press('Control+A').catch(() => {}); });
  await editable.press('Backspace').catch(() => {});
  await editable.type(v, { delay: 10 });
  await editable.press('Tab').catch(() => {});
  await sleep(80);
}

async function submitRowToFeishuForm(page, formLabels, row) {
  const ok = await ensureFormEntryPage(page, formLabels);
  if (!ok) throw new Error('Feishu form not ready for entry');

  await fillField(page, formLabels.titleLabel, row.title);
  await fillField(page, formLabels.authorLabel, row.author);
  if (String(row.region || '').trim()) {
    await fillField(page, formLabels.regionLabel, row.region);
  }
  if (String(row.typeValue || '').trim()) {
    await fillField(page, formLabels.industryLabel, row.typeValue);
  }
  await fillField(page, formLabels.publishDateLabel, row.publishDate);
  await fillField(page, formLabels.articleLinkLabel, row.articleLink);
  if (String(row.feishuLink || '').trim()) {
    await fillField(page, formLabels.feishuLinkLabel, row.feishuLink || '');
  }

  const submit = page.getByRole('button', { name: /提交|submit/i }).first();
  const enabled = await submit.isEnabled().catch(() => false);
  if (!enabled) throw new Error('Submit disabled');
  await submit.click({ timeout: 10000 });

  const ok2 = await waitForSubmitSuccess(page);
  if (!ok2) {
    await dumpDebugArtifacts(page, 'feishu_submit_failed');
    throw new Error('Submit click done but no success confirmation detected');
  }
}

module.exports = {
  fillField,
  submitRowToFeishuForm,
  ensureFormEntryPage
};
