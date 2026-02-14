const fs = require('fs');
const path = require('path');
const os = require('os');
const { launchContext, closeContext } = require('./browserContext');

const DEFAULT_CSV = '/Users/admin/Downloads/Untitled spreadsheet - Sheet1.csv';
const OUTPUT_JSONL = path.resolve(__dirname, '..', './output/csv_enrich_results.jsonl');
const OUTPUT_ERR = path.resolve(__dirname, '..', './output/csv_enrich_errors.log');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function norm(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === ',' && !inQuotes) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

function readCsv(filePath) {
  const text = fs.readFileSync(filePath, 'utf-8');
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) throw new Error(`CSV is empty: ${filePath}`);
  const header = parseCsvLine(lines[0]);
  const rows = lines.slice(1).map((l) => parseCsvLine(l));
  return { header, rows };
}

function findCol(header, name) {
  const idx = header.findIndex((h) => norm(h) === name);
  if (idx === -1) throw new Error(`Column not found: ${name}`);
  return idx;
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

function isMissingRegion(v) {
  const s = norm(v);
  return !s || s === '暂时不知';
}

function isMissingDate(v) {
  return !fmtDate(v);
}

function isMissingFeishu(v) {
  return !/(feishu|lark)\./i.test(norm(v));
}

function extractTopicId(articleLink) {
  const s = String(articleLink || '');
  let m = s.match(/[?&]topic_id=(\d+)/);
  if (m) return m[1];
  m = s.match(/\/topic\/(\d+)/);
  if (m) return m[1];
  return '';
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

function resolveProfileDirByName(config, profileName) {
  const chromeUserDataDir = path.join(os.homedir(), 'Library/Application Support/Google/Chrome');
  const localStatePath = path.join(chromeUserDataDir, 'Local State');
  if (!fs.existsSync(localStatePath)) return config.chromeProfileDirectory || 'Default';
  try {
    const localState = JSON.parse(fs.readFileSync(localStatePath, 'utf-8'));
    const info = localState?.profile?.info_cache || {};
    if (fs.existsSync(path.join(chromeUserDataDir, profileName))) return profileName;
    for (const [dirName, meta] of Object.entries(info)) {
      if (norm(meta && meta.name) === norm(profileName)) return dirName;
    }
  } catch (_) {}
  return config.chromeProfileDirectory || 'Default';
}

async function getTopicPayload(context, page, topicId, articleLink) {
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
  await sleep(1800);

  if (payload) return payload;
  // fallback: direct API request with context cookies
  const r = await context.request.get(`https://pub-api.zsxq.com/v2/topics/${topicId}`);
  if (r.ok()) return await r.text();
  return '';
}

async function fieldContainerByLabel(page, label) {
  const labelNode = page.getByText(label, { exact: false }).first();
  if ((await labelNode.count()) === 0) throw new Error(`Label not found: ${label}`);
  const container = labelNode.locator('xpath=ancestor::div[starts-with(@id,"field-item-")][1]').first();
  if ((await container.count()) === 0) throw new Error(`Field container not found: ${label}`);
  return container;
}

async function fillField(page, label, value) {
  const v = String(value || '');
  const container = await fieldContainerByLabel(page, label);
  const input = container.locator('input, textarea').first();
  if (await input.count()) {
    await input.click({ force: true });
    await input.fill(v);
    await input.dispatchEvent('input').catch(() => {});
    await input.dispatchEvent('change').catch(() => {});
    await input.press('Tab').catch(() => {});
    return;
  }
  const editable = container.locator('[contenteditable="true"]').first();
  if ((await editable.count()) === 0) throw new Error(`No writable control: ${label}`);
  await editable.click({ force: true });
  await editable.press('Meta+A').catch(async () => { await editable.press('Control+A').catch(() => {}); });
  await editable.press('Backspace').catch(() => {});
  await editable.type(v, { delay: 10 });
  await editable.press('Tab').catch(() => {});
}

async function submitForm(page, formLabels, row) {
  await fillField(page, formLabels.titleLabel, row.title);
  await fillField(page, formLabels.authorLabel, row.author);
  await fillField(page, formLabels.regionLabel, row.region);
  await fillField(page, formLabels.industryLabel, row.typeValue);
  await fillField(page, formLabels.publishDateLabel, row.publishDate);
  await fillField(page, formLabels.articleLinkLabel, row.articleLink);
  await fillField(page, formLabels.feishuLinkLabel, row.feishuLink || '');

  const submit = page.getByRole('button', { name: /提交|submit/i }).first();
  const enabled = await submit.isEnabled().catch(() => false);
  if (!enabled) throw new Error('Submit disabled');
  await submit.click({ timeout: 10000 });
}

function appendJsonl(filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, JSON.stringify(obj) + '\n', 'utf-8');
}

function appendErr(filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, JSON.stringify(obj) + '\n', 'utf-8');
}

async function main() {
  const configPath = path.resolve(__dirname, '..', 'config.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  const csvPath = process.env.CSV_PATH || DEFAULT_CSV;
  const maxRows = Number(process.env.MAX_ROWS || '2');
  const profileName = process.env.PROFILE_NAME || 'brian';

  const profileDir = resolveProfileDirByName(config, profileName);
  const runConfig = { ...config, chromeProfileDirectory: profileDir };
  console.log(`Using Chrome profile name=${profileName} dir=${profileDir}`);

  const { header, rows } = readCsv(csvPath);
  const idx = {
    title: findCol(header, '标题'),
    author: findCol(header, '圈友'),
    region: findCol(header, '地区'),
    typeValue: findCol(header, '类型'),
    publishDate: findCol(header, '文章发布时间'),
    articleLink: findCol(header, '文章链接'),
    feishuLink: findCol(header, '飞书链接')
  };

  const candidates = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const link = norm(r[idx.articleLink]);
    if (!link) continue;
    if (isMissingRegion(r[idx.region]) || isMissingDate(r[idx.publishDate]) || isMissingFeishu(r[idx.feishuLink])) {
      candidates.push({ lineNo: i + 2, row: r });
    }
  }
  console.log(`CSV rows=${rows.length}, candidates=${candidates.length}, maxRows=${maxRows}`);

  const context = await launchContext(runConfig, __dirname);
  try {
    const formLabels = config.selectors.feishuForm;
    let done = 0;
    for (const item of candidates) {
      if (done >= maxRows) break;
      const r = item.row;
      const base = {
        title: norm(r[idx.title]),
        author: norm(r[idx.author]),
        region: norm(r[idx.region]),
        typeValue: norm(r[idx.typeValue]),
        publishDate: norm(r[idx.publishDate]),
        articleLink: norm(r[idx.articleLink]),
        feishuLink: norm(r[idx.feishuLink])
      };
      const topicId = extractTopicId(base.articleLink);
      if (!topicId) {
        appendErr(OUTPUT_ERR, { lineNo: item.lineNo, articleLink: base.articleLink, error: 'topic_id not found' });
        continue;
      }

      const articlePage = await context.newPage();
      try {
        const payload = await getTopicPayload(context, articlePage, topicId, base.articleLink);
        if (!payload) throw new Error('topic payload empty');
        const json = JSON.parse(payload);
        const topic = json?.resp_data?.topic || {};
        const owner = topic?.talk?.owner || {};

        const enriched = {
          ...base,
          author: base.author || norm(owner.name),
          publishDate: fmtDate(base.publishDate) || fmtDateFromCreateTime(topic.create_time),
          feishuLink: base.feishuLink || firstFeishuLinkFromJson(topic),
          region: isMissingRegion(base.region) ? (extractRegionFromJson(topic) || (formLabels.unknownRegionText || '暂时不知')) : base.region
        };

        const formPage = await context.newPage();
        await formPage.goto(config.feishuFormUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
        await sleep(1800);
        await submitForm(formPage, formLabels, enriched);
        await sleep(1200);
        await formPage.close().catch(() => {});

        appendJsonl(OUTPUT_JSONL, { lineNo: item.lineNo, ...enriched });
        done += 1;
        console.log(`Submitted test row ${done}/${maxRows}: line=${item.lineNo} title=${enriched.title}`);
      } catch (err) {
        appendErr(OUTPUT_ERR, {
          at: new Date().toISOString(),
          lineNo: item.lineNo,
          articleLink: base.articleLink,
          error: String(err && err.message ? err.message : err)
        });
      } finally {
        await articlePage.close().catch(() => {});
      }
    }
    console.log(`Done. submitted=${done}`);
  } finally {
    await closeContext(context);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
