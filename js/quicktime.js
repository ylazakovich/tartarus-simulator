/* Optional local QuickTime bridge. Explicit window sharing; no game log. */
(function () {
  'use strict';

  // Compare a low-resolution game region, tolerating a tiny moving cursor.
  // Keep an anchor rather than the preceding frame so slow changes accumulate.
  class FrameGate {
    constructor(wait) { this.wait = wait || 900; this.version = 0; this.anchor = null; this.since = 0; this.accepted = -1; }
    update(pixels, now) {
      let changed = !this.anchor || this.anchor.length !== pixels.length;
      if (!changed) {
        let large = 0;
        for (let i = 0; i < pixels.length; i++) if (Math.abs(pixels[i] - this.anchor[i]) > 24) large++;
        changed = large / pixels.length > 0.006;
      }
      if (changed) { this.anchor = pixels.slice(); this.since = now; this.version++; }
      return { changed, version: this.version, ready: now - this.since >= this.wait && this.accepted !== this.version };
    }
    accept() { this.accepted = this.version; }
  }
  // A deadline changes the UI, never releases a still-mutating analyzer.
  // Its result is discarded after timeout; another stage waits for the drain.
  class RecognitionLane {
    constructor(schedule, cancel) {
      this.schedule = schedule || ((...args) => setTimeout(...args));
      this.cancel = cancel || ((...args) => clearTimeout(...args));
      this.busy = false; this.generation = 0;
    }
    async run(operation, milliseconds, onTimeout) {
      if (this.busy) throw new Error('Распознаватель занят предыдущим кадром');
      this.busy = true;
      const generation = ++this.generation;
      let expired = false;
      const alarm = this.schedule(() => {
        if (!this.busy || this.generation !== generation) return;
        expired = true; onTimeout();
      }, milliseconds);
      try {
        const value = await operation();
        return expired ? { expired: true } : { expired: false, value };
      } finally {
        this.cancel(alarm);
        if (this.generation === generation) { this.busy = false; this.generation++; }
      }
    }
  }
  function boardReadiness(read, state) {
    if (!read || !read.ok || !state) return 'Экран не распознан.';
    if (!state.controls && !read.statusView) return 'Не распознаны кнопки хода. Закрой меню и проверь English.';
    if (!state.daysRead) return 'Не распознаны оставшиеся дни — проверь поле ниже.';
    if (!state.wardenRead) return 'Не распознана текущая камера — проверь поле ниже.';
    if (read.statusView && state.giftPicksUncertain) return 'Opulence: число оставшихся наград не считывается. Останови захват и задай Picks Left вручную.';
    if (state.step === 'event') return 'Для события нужно вручную проверить его тип и условия ниже.';
    if (state.toolsToConfirm) return 'Подтверди орудия ниже: проверь список и нажми These are right. Затем Recheck.';
    if (state.checks || (state.checks == null && read.unsure)) return 'Есть неуверенно распознанные клетки. Исправь поле ниже и нажми Recheck.';
    return '';
  }
  function endText(state) { return state && state.chain ? 'Отмени пожирание (Cancel), затем заверши день.' : 'Нажми «Завершить» (End).'; }
  window.TartarusQuickTime = { FrameGate, RecognitionLane, boardReadiness, endText };
  if (new URLSearchParams(location.search).get('quicktime') !== '1') return;
  const A = window.TartarusAnalyzer;
  if (!A) return;
  const T = window.Tartarus;
  const panel = document.createElement('section');
  panel.id = 'qt-panel';
  panel.innerHTML = `<h1>Подсказки для iPad</h1>
    <p>Переключи игру на <strong>English</strong>. Нажми «Подключить» и выбери только окно <strong>QuickTime Player</strong>. Играй на iPad — совет обновится после изменения поля.</p>
    <div class="qt-buttons"><button type="button" id="qt-start">Подключить QuickTime</button><button type="button" id="qt-stop" disabled>Остановить</button><button type="button" id="qt-rescan" disabled>Перечитать экран</button><button type="button" id="qt-reload" hidden>Перезапустить помощник</button></div>
    <label><input type="checkbox" id="qt-fresh" checked> Следующий выбор орудий начинает новый забег</label>
    <p id="qt-status" role="status">Окно ещё не подключено.</p>
    <p id="qt-advice" aria-live="polite">Подсказка появится здесь.</p>
    <details><summary>Если распознавание не сработало</summary><p>Разверни игру в окне QuickTime, убери меню записи и дождись окончания анимации. Ниже можно загрузить снимок или исправить поле, орудия и цель вручную. Не следуй совету при неверно распознанном поле. Выбор наград требует свежего просмотра состояния тюрьмы.</p></details>`;
  document.querySelector('main').prepend(panel);
  const $ = (id) => document.getElementById(id);
  const status = (s) => { $('qt-status').textContent = s; };
  const advice = (s) => { $('qt-advice').textContent = s; };
  const video = document.createElement('video');
  video.muted = true; video.playsInline = true;
  const sample = document.createElement('canvas'); sample.width = 144; sample.height = 100;
  const sampleCtx = sample.getContext('2d', { willReadFrequently: true });
  const capture = document.createElement('canvas');
  let gate = new FrameGate();
  let stream = null, timer = null, busy = false, session = 0, adviceVersion = -1, advicePoll = null, lastSignature = '';
  let activeRead = null;
  const lane = new RecognitionLane();
  function clearAdvice() { document.documentElement.classList.add('qt-stale'); adviceVersion = -1; clearInterval(advicePoll); advicePoll = null; advice('Экран изменился — жду устойчивое изображение…'); }
  function stop() {
    session++;
    document.documentElement.classList.remove('qt-capturing', 'qt-stale');
    clearInterval(timer); timer = null; clearInterval(advicePoll); advicePoll = null;
    if (stream) stream.getTracks().forEach((track) => track.stop());
    stream = null; video.srcObject = null;
    $('qt-start').disabled = false; $('qt-stop').disabled = true; $('qt-rescan').disabled = true;
    $('qt-reload').hidden = !lane.busy;
    adviceVersion = -1; advice('Захват остановлен.'); status('Окно не считывается.');
  }
  function moveText(rec) {
    if (!rec || !rec.action) return '';
    const a = rec.action;
    const cell = (n) => Number(n) === T.OFFICE ? 'допросную' : `№${Number(n) + 1}`;
    switch (a.type) {
      case 'patrol': return `Иди в ${cell(a.cell)}.`;
      case 'devour': case 'chain': return `Пожирание → съешь узника в ${cell(a.to)}.`;
      case 'swap': return 'Нажми «Заменить» (Replace).';
      case 'end': return endText(A.quickTimeState && A.quickTimeState());
      case 'stopchain': return 'Отмени продолжение пожирания (Cancel).';
      case 'office': return a.choice === 'bestow' ? 'Выбери «Наградить» (Bestow).' : a.choice === 'instigate' ? 'Выбери «Подстрекнуть» (Instigate).' : `Допросная: ${a.choice}.`;
      case 'event': return a.accept ? 'Прими событие (Accept / Confirm).' : 'Откажись от события (Skip).';
      case 'choose': return `Выбери: ${T.TOOLS && T.TOOLS[a.id] ? T.TOOLS[a.id].name : T.GIFTS && T.GIFTS[a.id] ? T.GIFTS[a.id].name : a.id}.`;
      case 'reroll': return 'Обнови выбор орудий (Reroll).';
      case 'hunt': return `Отметь добычу в ${cell(a.to)}.`;
      default: return '';
    }
  }
  function showRecommendation(version, mine) {
    clearInterval(advicePoll);
    const show = () => {
      if (!stream || session !== mine || gate.version !== version) return;
      const state = A.quickTimeState && A.quickTimeState();
      if (activeRead && boardReadiness(activeRead, state)) {
        document.documentElement.classList.add('qt-stale');
        adviceVersion = -1;
        advice('Совет скрыт — проверь поле и нажми Recheck.');
        return;
      }
      const full = A.recommendation();
      const rec = full || (A.quickRecommendation && A.quickRecommendation());
      const text = moveText(rec);
      if (text) { document.documentElement.classList.remove('qt-stale'); advice(`${full ? 'Совет' : 'Быстрый совет'}: ${text}`); adviceVersion = version; }
      else { document.documentElement.classList.add('qt-stale'); adviceVersion = -1; advice('Расчёт ещё не готов. Если поле исправлено — нажми Recheck.'); }
    };
    show(); advicePoll = setInterval(show, 180);
  }
  async function recognize(version, mine) {
    busy = true;
    status('Распознаю экран…');
    let bitmap;
    const current = () => !!stream && session === mine && gate.version === version;
    let expired = false;
    const stage = async (label, operation, milliseconds) => {
      if (!current()) return null;
      status(label);
      const outcome = await lane.run(operation, milliseconds, () => {
        expired = true;
        if (!stream || session !== mine) return;
        document.documentElement.classList.add('qt-stale');
        clearInterval(advicePoll); advicePoll = null;
        status('Чтение задержалось. Жду завершения предыдущего кадра; новый расчёт пока не запускается.');
        advice('Если открыт выбор награды — нажми глаз / View Prison Status. Если чтение не восстановится, перезапусти помощник.');
        $('qt-reload').hidden = false;
      });
      if (outcome.expired) return null;
      return outcome.value;
    };
    try {
      const scale = Math.min(1, 1400 / video.videoWidth);
      capture.width = Math.round(video.videoWidth * scale); capture.height = Math.round(video.videoHeight * scale);
      capture.getContext('2d').drawImage(video, 0, 0, capture.width, capture.height);
      bitmap = await createImageBitmap(capture);
      const read = await stage('Читаю поле и кнопки хода…', () => A.readFrame(bitmap), 8000);
      if (!current() || !read) return;
      if (read.ok) {
        activeRead = read;
        const state = A.quickTimeState && A.quickTimeState();
        const problem = boardReadiness(read, state);
        // Load an actionable read for correction, but never turn a modal or an
        // unknown action row into a patrol. Manual Recheck can recover advice.
        if (state && (state.controls || read.statusView)) {
          if (read.statusView || !state.signature || state.signature !== lastSignature) A.useReading();
          if (problem) {
            status(problem); advice('Проверь распознавание ниже — совет скрыт.');
            showRecommendation(version, mine); return;
          }
          $('qt-fresh').checked = false;
          if (!read.statusView && state.signature && state.signature === lastSignature) {
            status('То же поле: повторный расчёт не нужен.');
            showRecommendation(version, mine); return;
          }
          const asked = read.statusView ? A.useTreasure('view') : A.ask();
          if (!asked) { status('Проверь настройки ниже и нажми Recheck.'); advice('Совет скрыт до проверки поля.'); showRecommendation(version, mine); return; }
          lastSignature = state.signature || '';
          status(read.statusView ? 'Свежее поле для выбора награды прочитано.' : 'Поле прочитано. Проверь орудия и цель ниже.');
          showRecommendation(version, mine); return;
        }
        status(problem); advice('Нужна проверка экрана — совет скрыт.'); return;
      }
      activeRead = null;
      // Give the player useful routing immediately, before slow card-name OCR.
      advice('Если открыт выбор награды — нажми глаз / View Prison Status и оставь поле открытым.');
      const treasure = A.readTreasure ? await stage('Поле закрыто: проверяю экран награды…', () => A.readTreasure(bitmap), 6000) : { ok: false };
      if (!current() || !treasure) return;
      if (treasure.ok) {
        // Without the game log, a second offer can mean either returning
        // from the eye view or a newly confirmed Opulence pick. Never reuse
        // the previous gift board/count here: advise only on a fresh eye view.
        document.documentElement.classList.add('qt-stale');
        status('Выбор сокровища: для КАЖДОЙ награды открой глаз / View Prison Status и оставь поле открытым.');
        advice('Для награды нужно свежее поле — предыдущий совет скрыт.');
        return;
      }
      const pick = await stage('Проверяю выбор орудий: читаю названия трёх карточек…', () => A.readPick(bitmap), 10000);
      if (!current() || !pick) return;
      if (pick.ok && pick.cards.length >= 2 && pick.cards.every((card) => card.conf >= 0.65) && !pick.unsure) {
        if (!A.usePick(pick, $('qt-fresh').checked)) { status('Проверь названия орудий ниже и нажми Recheck.'); advice('Орудия требуют ручного подтверждения.'); showRecommendation(version, mine); return; }
        status('Выбор орудий прочитан. Проверь три названия в анализаторе ниже.');
        showRecommendation(version, mine); return;
      }
      status('Экран не распознан. Если это награда, нажми глаз / View Prison Status; иначе проверь English или загрузи снимок ниже.');
      advice('Автоматического совета для этого экрана нет.');
    } catch (error) {
      if (current()) { status(`Не удалось прочитать экран: ${error.message || error}`); advice('Совет скрыт. Можно перечитать экран или загрузить снимок ниже.'); }
    } finally {
      if (bitmap) bitmap.close();
      busy = false;
      // A timed-out analyzer has now drained, so it is safe to take the
      // newest window frame. Never reset a gate belonging to a new session.
      if (expired && stream && session === mine) {
        gate = new FrameGate(); gate.version = Date.now();
        status('Предыдущее чтение завершилось. Перечитываю текущий экран…');
        $('qt-reload').hidden = true;
      }
    }
  }
  function tick() {
    if (!stream || !video.videoWidth || video.readyState < 2) return;
    // Exclude window borders, the iPad home indicator and QuickTime's floating
    // recording toolbar. Recognition still receives the complete game frame.
    sampleCtx.clearRect(0, 0, sample.width, sample.height);
    // Sample the board and action row, excluding the torches at both edges.
    sampleCtx.drawImage(video, video.videoWidth * 0.21, video.videoHeight * 0.17, video.videoWidth * 0.58, video.videoHeight * 0.43, 0, 0, 144, 64);
    sampleCtx.drawImage(video, video.videoWidth * 0.22, video.videoHeight * 0.63, video.videoWidth * 0.56, video.videoHeight * 0.16, 0, 64, 144, 24);
    sampleCtx.drawImage(video, video.videoWidth * 0.35, 0, video.videoWidth * 0.35, video.videoHeight * 0.05, 0, 88, 72, 12);
    sampleCtx.drawImage(video, video.videoWidth * 0.82, video.videoHeight * 0.07, video.videoWidth * 0.15, video.videoHeight * 0.45, 72, 88, 72, 12);
    const data = sampleCtx.getImageData(0, 0, sample.width, sample.height).data;
    const pixels = new Uint8Array(sample.width * sample.height);
    for (let i = 0; i < pixels.length; i++) pixels[i] = Math.round((data[i * 4] + data[i * 4 + 1] + data[i * 4 + 2]) / 3);
    const state = gate.update(pixels, performance.now());
    if (state.changed) { clearAdvice(); if (busy) status('Экран изменился. Жду окончания чтения предыдущего кадра…'); }
    if (state.ready && !busy && !lane.busy) { gate.accept(); recognize(state.version, session); }
  }
  $('qt-start').addEventListener('click', async () => {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) { status('Нужен Chrome или Edge на Mac и адрес localhost.'); return; }
    $('qt-start').disabled = true;
    try {
      const chosen = await navigator.mediaDevices.getDisplayMedia({ video: { displaySurface: 'window', frameRate: 5 }, audio: false, selfBrowserSurface: 'exclude', monitorTypeSurfaces: 'exclude' });
      const track = chosen.getVideoTracks()[0];
      if (track.getSettings().displaySurface !== 'window') {
        chosen.getTracks().forEach((t) => t.stop());
        throw new Error('Выбери вкладку «Окно» и QuickTime Player. Захват всего экрана или вкладки не используется.');
      }
      stream = chosen; session++; gate = new FrameGate(); lastSignature = ''; activeRead = null;
      document.documentElement.classList.add('qt-capturing', 'qt-stale');
      video.srcObject = stream; await video.play();
      track.addEventListener('ended', stop, { once: true });
      if (A.setGameLang) A.setGameLang('en', false);
      $('qt-stop').disabled = false; $('qt-rescan').disabled = false;
      status('Окно подключено. Дождись завершения анимации.');
      timer = setInterval(tick, 250); tick();
    } catch (error) { stop(); status(`Захват не начат: ${error.message || error}`); }
  });
  $('qt-stop').addEventListener('click', stop);
  $('qt-reload').addEventListener('click', () => { stop(); location.reload(); });
  $('qt-rescan').addEventListener('click', () => { gate = new FrameGate(); gate.version = Date.now(); clearAdvice(); tick(); });
  // A manual file/paste takes precedence; do not race it with captured frames.
  document.addEventListener('change', (event) => { if (stream && event.target.type === 'file' && event.target.files.length) stop(); }, true);
  document.addEventListener('paste', (event) => { if (stream && event.clipboardData && [...event.clipboardData.items].some((item) => item.type.startsWith('image/'))) stop(); }, true);
  document.addEventListener('drop', (event) => { if (stream && event.dataTransfer && event.dataTransfer.files.length) stop(); }, true);
  window.addEventListener('pagehide', stop);
})();
