const { launchContext, closeContext } = require('./browserContext');
const path = require('path');
const fs = require('fs');
const readline = require('readline');

const configPath = path.resolve(__dirname, '..', 'config.json');
if (!fs.existsSync(configPath)) {
  console.error('Missing config.json. Copy config.example.json to config.json and fill URLs.');
  process.exit(1);
}
const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

(async () => {
  const context = await launchContext({ ...config, headless: false }, __dirname);

  const page = await context.newPage();
  await page.goto(config.scysCollectionUrl, { waitUntil: 'domcontentloaded' });

  console.log('Use Playwright inspector or DevTools to find stable selectors.');
  console.log('Press Enter in this terminal to close.');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await new Promise((resolve) => {
    rl.question('', () => {
      rl.close();
      resolve();
    });
  });

  await closeContext(context);
})();
