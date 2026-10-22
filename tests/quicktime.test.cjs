const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const sourcePath = require('node:path').join(__dirname, '../js/quicktime.js');
function gate() {
  assert.ok(fs.existsSync(sourcePath), 'QuickTime capture module exists');
  const context = { window: {}, URLSearchParams, location: { search: '' } };
  vm.runInNewContext(fs.readFileSync(sourcePath, 'utf8'), context);
  return new context.window.TartarusQuickTime.FrameGate(700);
}
const frame = (value) => new Uint8Array(1200).fill(value);
test('changed game invalidates advice immediately and waits for a stable frame', () => {
  const g = gate();
  assert.equal(g.update(frame(20), 0).ready, false);
  assert.equal(g.update(frame(20), 800).ready, true);
  g.accept();
  assert.equal(g.update(frame(20), 1100).ready, false);
  assert.equal(g.update(frame(80), 1200).changed, true);
  assert.equal(g.update(frame(80), 1600).ready, false);
  assert.equal(g.update(frame(80), 2000).ready, true);
});
test('tiny cursor flicker does not repeatedly rescan an unchanged board', () => {
  const g = gate();
  g.update(frame(20), 0);
  g.update(frame(20), 800);
  g.accept();
  const cursor = frame(20); cursor[0] = 240;
  assert.equal(g.update(cursor, 1000).changed, false);
  assert.equal(g.update(cursor, 2000).ready, false);
});
test('a new board during recognition makes the old token unusable', () => {
  const g = gate();
  g.update(frame(20), 0);
  const token = g.update(frame(20), 800).version;
  g.update(frame(80), 850);
  assert.notEqual(g.version, token);
});
function readiness(read, state) {
  const context = { window: {}, URLSearchParams, location: { search: '' } };
  vm.runInNewContext(fs.readFileSync(sourcePath, 'utf8'), context);
  return context.window.TartarusQuickTime.boardReadiness(read, state);
}
test('a recognized chain meal screen is usable even without the ordinary decision row', () => {
  assert.equal(readiness({ ok: true, controls: false }, { controls: true, chain: true, daysRead: true, wardenRead: true, checks: 0, step: 'chain' }), '');
});
test('a board without known buttons or remaining days cannot produce a confident move', () => {
  assert.match(readiness({ ok: true }, { controls: false, daysRead: true, wardenRead: true, checks: 0 }), /кнопки/);
  assert.match(readiness({ ok: true }, { controls: true, daysRead: false, wardenRead: true, checks: 0 }), /дни/);
});
test('unconfirmed tools and an event overlay require explicit review', () => {
  assert.match(readiness({ ok: true }, { controls: true, daysRead: true, wardenRead: true, toolsToConfirm: 'blacklist', checks: 0 }), /These are right/);
  assert.match(readiness({ ok: true }, { controls: true, daysRead: true, wardenRead: true, step: 'event', checks: 0 }), /событи/);
});
test('ending from a meal picker tells the player to cancel before ending', () => {
  const context = { window: {}, URLSearchParams, location: { search: '' } };
  vm.runInNewContext(fs.readFileSync(sourcePath, 'utf8'), context);
  assert.equal(context.window.TartarusQuickTime.endText({ chain: true }), 'Отмени пожирание (Cancel), затем заверши день.');
  assert.equal(context.window.TartarusQuickTime.endText({ chain: false }), 'Нажми «Завершить» (End).');
});
function lifecycle() {
  const context = { window: {}, URLSearchParams, location: { search: '' }, setTimeout, clearTimeout };
  vm.runInNewContext(fs.readFileSync(sourcePath, 'utf8'), context);
  return context.window.TartarusQuickTime.RecognitionLane;
}
test('timed-out recognition holds the lane until its analyzer finishes and discards its result', async () => {
  const Lane = lifecycle();
  let alarm, resolveRead, notices = 0;
  const lane = new Lane((fn) => { alarm = fn; return 1; }, () => {});
  const pending = lane.run(() => new Promise((resolve) => { resolveRead = resolve; }), 100, () => notices++);
  alarm();
  assert.equal(notices, 1);
  assert.equal(lane.busy, true);
  await assert.rejects(lane.run(() => 'must not run', 100, () => {}), /занят/);
  resolveRead({ ok: true });
  const outcome = await pending;
  assert.equal(outcome.expired, true);
  assert.equal(outcome.value, undefined);
  assert.equal(lane.busy, false);
});
test('an old stage timeout cannot erase a newer stage after the old analyzer drains', async () => {
  const Lane = lifecycle();
  const alarms = [];
  let notices = 0, finishNew;
  const lane = new Lane((fn) => { alarms.push(fn); return alarms.length; }, () => {});
  await lane.run(() => Promise.resolve('old'), 100, () => notices++);
  const newer = lane.run(() => new Promise((resolve) => { finishNew = resolve; }), 100, () => notices++);
  alarms[0]();
  assert.equal(notices, 0);
  assert.equal(lane.busy, true);
  finishNew('new');
  assert.equal((await newer).value, 'new');
});
// Run the real capture pipeline with synthetic media frames and the analyzer's
// actual treasure state machine. Browser media/DOM are the boundary doubles.
function bridgeHarness() {
  const elements = new Map();
  const classes = new Set();
  const element = () => ({ textContent: '', hidden: false, disabled: false, checked: true, listeners: {}, addEventListener(name, fn) { this.listeners[name] = fn; } });
  const get = (id) => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); };
  const intervals = new Map(); let intervalId = 0, now = 0, pixel = 20, view = false;
  const analyzerSource = fs.readFileSync(require('node:path').join(__dirname, '../js/analyze.js'), 'utf8');
  const start = analyzerSource.indexOf('  function useTreasure(after) {');
  const finish = analyzerSource.indexOf('\n  // Without workers', start);
  const state = { model: { step: 'manage', choice: {}, cells: [], warden: 0 }, applied: null, solver: {}, undo: [], reader: {}, selected: 0, shot: false,
    gifts: {}, picksNow: () => 1, pickedSinceBoard: () => false, fresh: () => !!state.isFresh, settled: () => true,
    changed: () => { state.isFresh = false; }, renderScan() {}, toast() {}, ask: () => { state.isFresh = true; return true; } };
  vm.createContext(state); vm.runInContext(analyzerSource.slice(start, finish), state);
  const A = {
    async readFrame() { return view ? { ok: true, statusView: true } : { ok: false }; },
    async readTreasure() { return { ok: true }; },
    async readPick() { throw new Error('Treasure must not wait for three-card OCR'); },
    useReading() {}, useTreasure: state.useTreasure,
    quickTimeState: () => ({ controls: false, daysRead: true, wardenRead: true, checks: 0, step: 'manage', signature: 'fresh viewed board' }),
    ask: state.ask, recommendation: () => state.isFresh && !state.model.treasureWait ? { action: { type: 'choose', id: 'wine' } } : null,
    setGameLang() {},
  };
  const track = { getSettings: () => ({ displaySurface: 'window' }), stop() {}, addEventListener() {} };
  const ctx = {
    window: { TartarusAnalyzer: A, Tartarus: { OFFICE: 0, GIFTS: { wine: { name: 'Crimson Wine' } } }, addEventListener() {} },
    location: { search: '?quicktime=1' }, URLSearchParams, setTimeout, clearTimeout,
    setInterval: (fn, ms) => { intervals.set(++intervalId, { fn, ms }); return intervalId; }, clearInterval: (id) => intervals.delete(id),
    navigator: { mediaDevices: { getDisplayMedia: async () => ({ getVideoTracks: () => [track], getTracks: () => [track] }) } },
    performance: { now: () => now }, createImageBitmap: async () => ({ close() {} }),
    document: {
      getElementById: get, querySelector: () => ({ prepend() {} }), addEventListener() {},
      documentElement: { classList: { add: (...names) => names.forEach((n) => classes.add(n)), remove: (...names) => names.forEach((n) => classes.delete(n)) } },
      createElement(tag) {
        if (tag === 'video') return { videoWidth: 1400, videoHeight: 1050, readyState: 2, play: async () => {} };
        if (tag === 'canvas') return { width: 144, height: 100, getContext: () => ({ drawImage() {}, clearRect() {}, getImageData: () => ({ data: new Uint8Array(144 * 100 * 4).fill(pixel) }) }) };
        return element();
      },
    },
  };
  vm.runInNewContext(fs.readFileSync(sourcePath, 'utf8'), ctx);
  return {
    start: () => get('qt-start').listeners.click(),
    async screen(statusView) {
      view = statusView; pixel += 50; now += 100;
      [...intervals.values()].find((i) => i.ms === 250).fn();
      now += 1000; [...intervals.values()].find((i) => i.ms === 250).fn();
      await new Promise((resolve) => setImmediate(resolve));
    },
    get: (id) => get(id).textContent,
    stop: () => get('qt-stop').listeners.click(),
    classes,
  };
}
test('consecutive treasure overlays never reuse gift advice; each fresh eye view can advise', async () => {
  const bridge = bridgeHarness();
  await bridge.start();
  await bridge.screen(false);
  assert.match(bridge.get('qt-advice'), /свежее поле/);
  assert.equal(bridge.classes.has('qt-stale'), true);
  await bridge.screen(true);
  assert.match(bridge.get('qt-advice'), /Crimson Wine/);
  await bridge.screen(false);
  assert.match(bridge.get('qt-advice'), /свежее поле/);
  assert.equal(bridge.classes.has('qt-stale'), true);
  await bridge.screen(false);
  assert.match(bridge.get('qt-advice'), /свежее поле/);
  assert.equal(bridge.classes.has('qt-stale'), true);
  await bridge.screen(true);
  assert.match(bridge.get('qt-advice'), /Crimson Wine/);
  assert.equal(bridge.classes.has('qt-stale'), false);
  bridge.stop();
});
test('Opulence gift advice requires a manually supplied remaining-pick count', () => {
  assert.match(readiness({ ok: true, statusView: true }, { controls: false, daysRead: true, wardenRead: true, checks: 0, giftPicksUncertain: true }), /Opulence.*Picks Left/);
  assert.equal(readiness({ ok: true, statusView: true }, { controls: false, daysRead: true, wardenRead: true, checks: 0, giftPicksUncertain: false }), '');
});
test('default recognition timers retain the browser global receiver', async () => {
  const ctx = { window: {}, URLSearchParams, location: { search: '' } };
  vm.createContext(ctx);
  vm.runInContext(`
    globalThis.setTimeout = function () { if (this !== globalThis) throw new TypeError('Illegal invocation'); return 1; };
    globalThis.clearTimeout = function () { if (this !== globalThis) throw new TypeError('Illegal invocation'); };
  `, ctx);
  vm.runInContext(fs.readFileSync(sourcePath, 'utf8'), ctx);
  const lane = new ctx.window.TartarusQuickTime.RecognitionLane();
  assert.equal((await lane.run(() => Promise.resolve('read'), 100, () => {})).value, 'read');
});
