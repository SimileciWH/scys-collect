const path = require('path');
const fs = require('fs');
const { launchContext, closeContext } = require('./browserContext');

const configPath = path.resolve(__dirname, '..', 'config.json');
if (!fs.existsSync(configPath)) {
  console.error('Missing config.json. Copy config.example.json to config.json and fill URLs.');
  process.exit(1);
}
const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

(async () => {
  const context = await launchContext({ ...config, useSavedStorageState: false, headless: false }, __dirname);
  const page = await context.newPage();

  if (config.scysCollectionUrl) {
    await page.goto(config.scysCollectionUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
  }
  if (config.feishuFormUrl) {
    const p2 = await context.newPage();
    await p2.goto(config.feishuFormUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
  }

  await page.waitForTimeout(3000);

  const storageStatePath = path.resolve(__dirname, '..', config.storageStatePath || './storage_state.json');
  await context.storageState({ path: storageStatePath });

  console.log(`Saved storage state: ${storageStatePath}`);
  await closeContext(context);
})();
