const { sleep } = require('./wait');
const fs = require('fs');
const path = require('path');

function nowMs() {
  return Date.now();
}

function dateKeyLocal(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function randInt(min, max) {
  const lo = Math.ceil(min);
  const hi = Math.floor(max);
  return Math.floor(lo + Math.random() * (hi - lo + 1));
}

// Leaky-bucket pacer: spreads work evenly over time.
// Guarantee: over the long run, average rate <= maxPerHour.
class Pacer {
  constructor(opts = {}) {
    this.enabled = opts.enabled !== false;
    this.maxPerHour = Number(opts.maxPerHour || 0);
    this.jitterMs = Number(opts.jitterMs || 0);
    this.label = String(opts.label || 'pacer');
    this._nextSlotAt = 0;

    if (!Number.isFinite(this.maxPerHour) || this.maxPerHour <= 0) {
      this.enabled = false;
    }
    if (!Number.isFinite(this.jitterMs) || this.jitterMs < 0) {
      this.jitterMs = 0;
    }
  }

  intervalMs() {
    // Example: 30/hour => 120000 ms
    return Math.ceil((60 * 60 * 1000) / this.maxPerHour);
  }

  async beforeItem(meta = '') {
    if (!this.enabled) return;

    const interval = this.intervalMs();
    const t = nowMs();
    if (this._nextSlotAt === 0) {
      this._nextSlotAt = t;
    }

    // If we are behind schedule, catch up to "now" (no extra sleep).
    if (t > this._nextSlotAt) {
      this._nextSlotAt = t;
    }

    // Only add positive jitter to keep the average rate <= maxPerHour.
    const jitter = this.jitterMs > 0 ? randInt(0, this.jitterMs) : 0;
    const waitMs = clamp(this._nextSlotAt + jitter - t, 0, 24 * 60 * 60 * 1000);

    if (waitMs > 0) {
      console.log(`[${this.label}] pacing: wait ${Math.ceil(waitMs / 1000)}s before next item ${meta ? `(${meta})` : ''}`);
      await sleep(waitMs);
    }

    // Book next slot.
    this._nextSlotAt += interval;
  }
}

function parseHHMM(s) {
  const m = String(s || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return hh * 60 + mm;
}

function pickWeighted(weights) {
  // weights: [{ w, value }]
  const total = weights.reduce((s, x) => s + x.w, 0);
  if (total <= 0) return weights[0] ? weights[0].value : 0;
  let r = Math.random() * total;
  for (const x of weights) {
    r -= x.w;
    if (r <= 0) return x.value;
  }
  return weights[weights.length - 1].value;
}

class HumanPacer {
  constructor(opts = {}) {
    this.enabled = opts.enabled !== false;
    this.label = String(opts.label || 'pacer');
    this.base = new Pacer({
      enabled: this.enabled,
      maxPerHour: Number(opts.maxPerHour || 0),
      jitterMs: Number(opts.jitterMs || 0),
      label: this.label
    });

    this.dailyMax = Number(opts.dailyMax || 0); // 0 => unlimited
    this.allowedWindows = Array.isArray(opts.allowedWindows) ? opts.allowedWindows : [];
    this.statePath = String(opts.statePath || '');

    // Session settings (ms).
    this.workMinMs = Number(opts.workMinMs || 35 * 60 * 1000);
    this.workMaxMs = Number(opts.workMaxMs || 75 * 60 * 1000);
    this.restMinMs = Number(opts.restMinMs || 12 * 60 * 1000);
    this.restMaxMs = Number(opts.restMaxMs || 28 * 60 * 1000);

    // Per-item extra dwell distribution (ms). Keeps a "human" variance beyond base pacing.
    this.dwellWeights = opts.dwellWeights || [
      { w: 0.82, min: 60 * 1000, max: 140 * 1000 },   // normal reading
      { w: 0.14, min: 200 * 1000, max: 420 * 1000 },  // deeper reading / click links
      { w: 0.04, min: 10 * 1000, max: 30 * 1000 }     // quick skim
    ];
    this.megaPauseEveryMin = Number(opts.megaPauseEveryMin || 6);
    this.megaPauseEveryMax = Number(opts.megaPauseEveryMax || 12);
    this.megaPauseMinMs = Number(opts.megaPauseMinMs || 5 * 60 * 1000);
    this.megaPauseMaxMs = Number(opts.megaPauseMaxMs || 15 * 60 * 1000);

    // Backoff on error (ms).
    this.errorBackoffMinMs = Number(opts.errorBackoffMinMs || 30 * 60 * 1000);
    this.errorBackoffMaxMs = Number(opts.errorBackoffMaxMs || 120 * 60 * 1000);

    this._state = this._loadState();
    this._nextMegaAt = this._state.nextMegaAt || randInt(this.megaPauseEveryMin, this.megaPauseEveryMax);
  }

  _loadState() {
    const init = {
      day: dateKeyLocal(),
      doneToday: 0,
      sessionEndsAt: 0,
      restUntilAt: 0,
      nextMegaAt: 0
    };
    if (!this.statePath) return init;
    try {
      if (!fs.existsSync(this.statePath)) return init;
      const raw = JSON.parse(fs.readFileSync(this.statePath, 'utf-8'));
      if (!raw || typeof raw !== 'object') return init;
      const day = String(raw.day || init.day);
      if (day !== init.day) return init;
      return { ...init, ...raw };
    } catch (_) {
      return init;
    }
  }

  _saveState() {
    if (!this.statePath) return;
    try {
      fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
      fs.writeFileSync(this.statePath, JSON.stringify(this._state, null, 2), 'utf-8');
    } catch (_) {}
  }

  _resetIfNewDay() {
    const today = dateKeyLocal();
    if (this._state.day !== today) {
      this._state = { day: today, doneToday: 0, sessionEndsAt: 0, restUntilAt: 0, nextMegaAt: 0 };
      this._nextMegaAt = randInt(this.megaPauseEveryMin, this.megaPauseEveryMax);
      this._state.nextMegaAt = this._nextMegaAt;
      this._saveState();
    }
  }

  _withinWindow(now = new Date()) {
    if (!this.allowedWindows.length) return true;
    const mins = now.getHours() * 60 + now.getMinutes();
    for (const w of this.allowedWindows) {
      const start = parseHHMM(w.start);
      const end = parseHHMM(w.end);
      if (start === null || end === null) continue;
      if (start <= end) {
        if (mins >= start && mins <= end) return true;
      } else {
        // Spans midnight.
        if (mins >= start || mins <= end) return true;
      }
    }
    return false;
  }

  _msUntilNextWindow(now = new Date()) {
    if (!this.allowedWindows.length) return 0;
    if (this._withinWindow(now)) return 0;

    const minsNow = now.getHours() * 60 + now.getMinutes();
    let best = null;

    for (const w of this.allowedWindows) {
      const start = parseHHMM(w.start);
      const end = parseHHMM(w.end);
      if (start === null || end === null) continue;

      // Find the next occurrence of "start" in minutes-from-now.
      let deltaMins = 0;
      if (start > minsNow) {
        deltaMins = start - minsNow;
      } else {
        deltaMins = 24 * 60 - (minsNow - start);
      }
      if (best === null || deltaMins < best) best = deltaMins;
    }

    if (best === null) return 0;
    return best * 60 * 1000;
  }

  _pickDwellMs() {
    const chosen = pickWeighted(this.dwellWeights.map((x) => ({ w: x.w, value: x })));
    return randInt(chosen.min, chosen.max);
  }

  async _sleepWithLog(ms, reason) {
    const waitMs = clamp(ms, 0, 24 * 60 * 60 * 1000);
    if (waitMs <= 0) return;
    console.log(`[${this.label}] human: sleep ${Math.ceil(waitMs / 1000)}s (${reason})`);
    await sleep(waitMs);
  }

  async beforeItem(meta = '') {
    if (!this.enabled) return;

    this._resetIfNewDay();

    // Allowed time window.
    const msToWindow = this._msUntilNextWindow(new Date());
    if (msToWindow > 0) {
      // Add a small random slack to avoid "exact on the hour" behavior.
      await this._sleepWithLog(msToWindow + randInt(20 * 1000, 3 * 60 * 1000), 'outside allowed window');
      this._resetIfNewDay();
    }

    // Daily cap.
    if (this.dailyMax > 0 && this._state.doneToday >= this.dailyMax) {
      // Sleep until next day's allowed window.
      const untilTomorrow = (24 * 60 * 60 * 1000) - (nowMs() - new Date(new Date().setHours(0, 0, 0, 0)).getTime());
      await this._sleepWithLog(untilTomorrow + randInt(2 * 60 * 1000, 10 * 60 * 1000), `daily cap reached (${this._state.doneToday}/${this.dailyMax})`);
      this._resetIfNewDay();
    }

    // Session rest handling.
    const t = nowMs();
    if (this._state.restUntilAt && t < this._state.restUntilAt) {
      await this._sleepWithLog(this._state.restUntilAt - t, 'session rest');
    }

    // Session lifecycle.
    const t2 = nowMs();
    if (this._state.sessionEndsAt && t2 >= this._state.sessionEndsAt) {
      // End session -> rest.
      const restMs = randInt(this.restMinMs, this.restMaxMs);
      this._state.restUntilAt = t2 + restMs;
      this._state.sessionEndsAt = 0;
      this._saveState();
      await this._sleepWithLog(restMs, 'session ended');
    }
    if (!this._state.sessionEndsAt) {
      const workMs = randInt(this.workMinMs, this.workMaxMs);
      this._state.sessionEndsAt = nowMs() + workMs;
      this._saveState();
      console.log(`[${this.label}] human: new session for ~${Math.ceil(workMs / 60000)}min`);
    }

    // Base rate limit.
    await this.base.beforeItem(meta);

    // Extra dwell (variance).
    const dwellMs = this._pickDwellMs();
    await this._sleepWithLog(dwellMs, `reading variance${meta ? ` ${meta}` : ''}`);

    // Occasional "mega pause" to break patterns.
    this._state.doneToday += 1;
    if (this._state.doneToday >= this._nextMegaAt) {
      const megaMs = randInt(this.megaPauseMinMs, this.megaPauseMaxMs);
      this._nextMegaAt = this._state.doneToday + randInt(this.megaPauseEveryMin, this.megaPauseEveryMax);
      this._state.nextMegaAt = this._nextMegaAt;
      this._saveState();
      await this._sleepWithLog(megaMs, 'occasional long pause');
    } else {
      this._saveState();
    }
  }

  async afterError(meta = '') {
    if (!this.enabled) return;
    this._resetIfNewDay();
    const backoff = randInt(this.errorBackoffMinMs, this.errorBackoffMaxMs);
    const until = nowMs() + backoff;
    this._state.restUntilAt = Math.max(this._state.restUntilAt || 0, until);
    this._saveState();
    await this._sleepWithLog(backoff, `error backoff${meta ? ` ${meta}` : ''}`);
  }
}

function createPacerFromConfig(config, fallback = {}) {
  const p = (config && config.pacing) || {};
  const enabled = p.enabled !== undefined ? p.enabled : (fallback.enabled !== undefined ? fallback.enabled : true);
  const maxPerHour = fallback.maxPerHour || p.maxPerHour || 0;
  const jitterMs = fallback.jitterMs !== undefined ? fallback.jitterMs : (p.jitterMs !== undefined ? p.jitterMs : 5000);
  const label = fallback.label || p.label || 'pacer';
  const mode = String(fallback.mode || p.mode || 'fixed').toLowerCase();
  if (mode === 'human') {
    const defaultStatePath = path.resolve(process.cwd(), `automation/output/pacing_state_${label}.json`);
    return new HumanPacer({
      enabled,
      maxPerHour,
      jitterMs,
      label,
      dailyMax: Number(fallback.dailyMax || p.dailyMax || 0),
      allowedWindows: fallback.allowedWindows || p.allowedWindows || [],
      statePath: fallback.statePath || p.statePath || defaultStatePath,
      workMinMs: (fallback.session && fallback.session.workMinMs) || (p.session && p.session.workMinMs),
      workMaxMs: (fallback.session && fallback.session.workMaxMs) || (p.session && p.session.workMaxMs),
      restMinMs: (fallback.session && fallback.session.restMinMs) || (p.session && p.session.restMinMs),
      restMaxMs: (fallback.session && fallback.session.restMaxMs) || (p.session && p.session.restMaxMs),
      dwellWeights: fallback.dwellWeights || p.dwellWeights || null,
      megaPauseEveryMin: (fallback.megaPause && fallback.megaPause.everyMin) || (p.megaPause && p.megaPause.everyMin),
      megaPauseEveryMax: (fallback.megaPause && fallback.megaPause.everyMax) || (p.megaPause && p.megaPause.everyMax),
      megaPauseMinMs: (fallback.megaPause && fallback.megaPause.minMs) || (p.megaPause && p.megaPause.minMs),
      megaPauseMaxMs: (fallback.megaPause && fallback.megaPause.maxMs) || (p.megaPause && p.megaPause.maxMs),
      errorBackoffMinMs: (fallback.errorBackoff && fallback.errorBackoff.minMs) || (p.errorBackoff && p.errorBackoff.minMs),
      errorBackoffMaxMs: (fallback.errorBackoff && fallback.errorBackoff.maxMs) || (p.errorBackoff && p.errorBackoff.maxMs)
    });
  }
  return new Pacer({ enabled, maxPerHour, jitterMs, label });
}

module.exports = {
  Pacer,
  HumanPacer,
  createPacerFromConfig
};
