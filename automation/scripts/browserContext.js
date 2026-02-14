const { chromium } = require('playwright');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawnSync } = require('child_process');

function resolveHome(p) {
  if (!p) return p;
  if (p.startsWith('~/')) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

function resolveProfileDirectory(chromeUserDataDir, profileDirectory) {
  const directPath = path.join(chromeUserDataDir, profileDirectory);
  if (fs.existsSync(directPath)) return profileDirectory;

  const localStatePath = path.join(chromeUserDataDir, 'Local State');
  if (!fs.existsSync(localStatePath)) return profileDirectory;
  try {
    const localState = JSON.parse(fs.readFileSync(localStatePath, 'utf-8'));
    const info = localState && localState.profile && localState.profile.info_cache ? localState.profile.info_cache : {};
    for (const [dirName, meta] of Object.entries(info)) {
      const displayName = meta && meta.name ? String(meta.name) : '';
      if (displayName === profileDirectory) {
        return dirName;
      }
    }
  } catch (_) {}
  return profileDirectory;
}

function syncChromeProfileSnapshot(config, scriptDir) {
  const chromeUserDataDir = resolveHome(config.chromeUserDataDir || '~/Library/Application Support/Google/Chrome');
  const profileDirectoryInput = config.chromeProfileDirectory || 'Default';
  const profileDirectory = resolveProfileDirectory(chromeUserDataDir, profileDirectoryInput);
  const cloneDir = path.resolve(scriptDir, '..', config.chromeProfileCloneDir || './chrome_profile_clone');

  fs.mkdirSync(cloneDir, { recursive: true });

  const srcProfile = path.join(chromeUserDataDir, profileDirectory);
  const dstProfile = path.join(cloneDir, profileDirectory);

  if (!fs.existsSync(srcProfile)) {
    throw new Error(`Chrome profile not found: ${srcProfile}`);
  }

  const rsyncArgs = [
    '-a',
    '--delete',
    '--exclude=Cache',
    '--exclude=Code Cache',
    '--exclude=GPUCache',
    '--exclude=ShaderCache',
    '--exclude=Service Worker/CacheStorage',
    '--exclude=GrShaderCache',
    `${srcProfile}/`,
    `${dstProfile}/`
  ];
  const rsyncResult = spawnSync('rsync', rsyncArgs, { encoding: 'utf-8' });
  if (rsyncResult.status !== 0) {
    throw new Error(`Failed to sync Chrome profile snapshot: ${rsyncResult.stderr || rsyncResult.stdout}`);
  }

  const localStateSrc = path.join(chromeUserDataDir, 'Local State');
  const localStateDst = path.join(cloneDir, 'Local State');
  if (fs.existsSync(localStateSrc)) {
    fs.copyFileSync(localStateSrc, localStateDst);
  }

  return {
    clonedUserDataDir: cloneDir,
    profileDirectory
  };
}

async function launchContext(config, scriptDir) {
  const useChromeProfile = config.useChromeProfile === true;
  const useSavedStorageState = config.useSavedStorageState === true;
  const slowMo = config.slowMoMs || 0;
  const headless = config.headless === true;
  const viewport = { width: 1280, height: 900 };
  const storageStatePath = path.resolve(scriptDir, '..', config.storageStatePath || './storage_state.json');

  if (useSavedStorageState && fs.existsSync(storageStatePath)) {
    const browser = await chromium.launch({
      channel: 'chrome',
      headless,
      slowMo
    });
    const context = await browser.newContext({
      viewport,
      storageState: storageStatePath
    });
    context.__codexBrowser = browser;
    return context;
  }

  if (useChromeProfile) {
    const { clonedUserDataDir, profileDirectory } = syncChromeProfileSnapshot(config, scriptDir);
    try {
      return await chromium.launchPersistentContext(clonedUserDataDir, {
        channel: 'chrome',
        headless,
        slowMo,
        viewport,
        args: [`--profile-directory=${profileDirectory}`]
      });
    } catch (err) {
      const message = String(err && err.message ? err.message : err);
      if (message.includes('SingletonLock') || message.includes('profile appears to be in use')) {
        throw new Error('Chrome profile snapshot is locked by another process. Please rerun.');
      }
      throw err;
    }
  }

  const userDataDir = path.resolve(scriptDir, '..', config.userDataDir || './user_data');
  return chromium.launchPersistentContext(userDataDir, {
    headless,
    slowMo,
    viewport
  });
}

async function closeContext(context) {
  await context.close().catch(() => {});
  if (context && context.__codexBrowser) {
    await context.__codexBrowser.close().catch(() => {});
  }
}

module.exports = {
  launchContext,
  closeContext,
  resolveHome
};
