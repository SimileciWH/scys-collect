const fs = require('fs');
const path = require('path');
const { launchContext, closeContext } = require('./browserContext');

const { readCsvFile, findCol, norm } = require('../lib/io/csv');
const { sleep } = require('../lib/runtime/wait');
const { createPacerFromConfig } = require('../lib/runtime/pacer');
const {
  extractTopicId,
  fmtDate,
  fmtDateFromCreateTime,
  firstFeishuLinkFromJson,
  extractRegionFromJson,
  fetchTopicPayload
} = require('../lib/extractors/zsxq');
const { submitRowToFeishuForm } = require('../lib/sinks/feishuForm');

const DEFAULT_CSV = '/Users/admin/Downloads/Untitled spreadsheet - Sheet1.csv';
const OUTPUT_JSONL = path.resolve(__dirname, '..', './output/csv_enrich_results.jsonl');
const OUTPUT_ERR = path.resolve(__dirname, '..', './output/csv_enrich_errors.log');

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
  // Keep the same entry command semantics. Profile mapping is handled in browserContext now.
  const runConfig = { ...config, chromeProfileDirectory: profileName };
  console.log(`Using Chrome profile name=${profileName}`);

  // Spread work evenly: e.g. 30/hour => 1 item per ~120s.
  const pacer = createPacerFromConfig(config, { label: 'zsxq', maxPerHour: 30, jitterMs: 8000 });

  const { header, rows } = readCsvFile(fs, csvPath);
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
      await pacer.beforeItem(`line=${item.lineNo}`);
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
        const payload = await fetchTopicPayload(context, articlePage, topicId, base.articleLink);
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
        await submitRowToFeishuForm(formPage, formLabels, enriched);
        await sleep(1200);
        await formPage.close().catch(() => {});

        appendJsonl(OUTPUT_JSONL, { at: new Date().toISOString(), lineNo: item.lineNo, ...enriched });
        done += 1;
        console.log(`Submitted test row ${done}/${maxRows}: line=${item.lineNo} title=${enriched.title}`);
      } catch (err) {
        if (pacer && typeof pacer.afterError === 'function') {
          await pacer.afterError(`line=${item.lineNo}`).catch(() => {});
        }
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
