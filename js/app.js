/*!
 * app.js — 화사 스튜디오 화면
 */
(function () {
  'use strict';

  var EX = window.P18EXIF;
  var ENG = window.P18Engine;
  var $ = function (id) { return document.getElementById(id); };

  var APP_VERSION = '2026.11.28';
  var ANALYZE_SIDE = 900;     // 분석용 작은 사본 긴 변
  var PREVIEW_FAST = 620;     // 슬라이더 끄는 동안
  var PREVIEW_FULL = 1180;    // 손 뗐을 때
  var MAX_EXPORT_AREA = 16.5e6; // 아이폰 사파리 그림판 한도(약 16MP)

  var P3_OK = (function () {
    try {
      var c = document.createElement('canvas'); c.width = c.height = 1;
      var x = c.getContext('2d', { colorSpace: 'display-p3' });
      return !!x && !!x.getContextAttributes && x.getContextAttributes().colorSpace === 'display-p3';
    } catch (e) { return false; }
  })();

  // 원본 크기 보정을 나눠 맡을 일꾼들 (아이폰 14 Pro: 6코어 → 4개)
  var pool = null;
  function getPool() {
    if (pool && !pool.broken) return pool;
    if (pool && pool.broken) return null;
    try {
      if (typeof Worker === 'undefined') return null;
      var n = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 1));
      pool = new ENG.WorkerPool('js/worker.js?v=6', n);
      if (!pool.size) pool = null;
    } catch (e) { console.warn('worker pool unavailable', e); pool = null; }
    return pool;
  }

  /* ───────────────────────────────────────────── 얼굴 찾기 (별도 일꾼, 사진마다 한 번) */
  var faceWorker = null, faceSeq = 0, faceWaiters = {}, mainClassify = null;
  function findFaces(small) {
    var timeout = new Promise(function (res) { setTimeout(function () { res(null); }, 8000); });
    var job;
    try {
      if (typeof Worker !== 'undefined') {
        if (!faceWorker) {
          faceWorker = new Worker('js/worker.js?v=6');
          faceWorker.onmessage = function (e) {
            var w = faceWaiters[e.data.id]; if (!w) return;
            delete faceWaiters[e.data.id];
            w(e.data.type === 'faces' ? e.data.faces : null);
          };
          faceWorker.onerror = function () { faceWorker = null; for (var k in faceWaiters) { faceWaiters[k](null); delete faceWaiters[k]; } };
        }
        var id = ++faceSeq;
        job = new Promise(function (res) { faceWaiters[id] = res; });
        faceWorker.postMessage({ type: 'faces', id: id, rgba: small.data, w: small.w, h: small.h });
      } else {
        job = (mainClassify ? Promise.resolve() : fetch('js/facefinder.bin').then(function (r) { return r.arrayBuffer(); })
          .then(function (b) { mainClassify = window.P18Face.unpackCascade(new Int8Array(b)); }))
          .then(function () { return window.P18Face.detect(mainClassify, small.data, small.w, small.h, { minScore: 5 }); });
      }
    } catch (e) { console.warn('face detection unavailable', e); return Promise.resolve(null); }
    return Promise.race([job.catch(function () { return null; }), timeout]);
  }

  var state = {
    file: null, buffer: null, kind: null, img: null, objectUrl: null,
    src: null, srcW: 0, srcH: 0,
    info: null, segs: null, heicTiff: null,
    cs: 'srgb', small: null, an: null, faces: null,
    preset: 'auto', params: null,
    out: null, busy: false, preparing: false, split: 0.5, photoId: 0
  };

  /* ───────────────────────────────────────────── 도구 */
  function fmtBytes(n) {
    if (!n && n !== 0) return '';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  }
  function fmtDateTime(s) {
    if (!s) return '';
    var m = String(s).match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2})/);
    if (!m) return String(s);
    var h = parseInt(m[4], 10), ampm = h < 12 ? '오전' : '오후', h12 = h % 12 === 0 ? 12 : h % 12;
    return m[1] + '. ' + parseInt(m[2], 10) + '. ' + parseInt(m[3], 10) + '. ' + ampm + ' ' + h12 + ':' + m[5];
  }
  function fmtExposure(t) { if (!t) return ''; return t >= 1 ? (Math.round(t * 10) / 10) + 's' : '1/' + Math.round(1 / t) + 's'; }
  function fmtCoords(lat, lon) { return lat == null || lon == null ? '' : lat.toFixed(4) + ', ' + lon.toFixed(4); }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function raf(fn) { return (window.requestAnimationFrame || function (f) { return setTimeout(f, 16); })(fn); }
  function nextFrame() { return new Promise(function (r) { raf(function () { raf(r); }); }); }

  var toastTimer = null;
  function toast(msg, isError) {
    var t = $('toast');
    t.textContent = msg;
    t.className = 'toast' + (isError ? ' err' : '');
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 3400);
  }
  function showOverlay(title, sub) {
    $('overlayTitle').textContent = title || '보정하는 중…';
    $('overlaySub').textContent = sub || '원본 해상도로 처리하고 있어요';
    $('progressBar').style.width = '0%';
    $('overlay').hidden = false;
  }
  function setProgress(done, total) { $('progressBar').style.width = Math.max(4, total ? Math.round(done / total * 100) : 0) + '%'; }
  function hideOverlay() { $('overlay').hidden = true; }

  /* ───────────────────────────────────────────── 프리셋 */
  function buildPresets() {
    var row = $('presetRow');
    row.innerHTML = '';
    ENG.PRESET_ORDER.forEach(function (key) {
      var p = ENG.PRESETS[key];
      var b = document.createElement('button');
      b.className = 'preset'; b.type = 'button';
      b.setAttribute('role', 'tab'); b.dataset.key = key;
      b.setAttribute('aria-selected', key === state.preset ? 'true' : 'false');
      b.innerHTML = '<strong></strong><span class="p-badge"></span><span class="p-desc"></span>';
      b.querySelector('strong').textContent = p.name;
      b.querySelector('.p-badge').textContent = p.badge;
      b.querySelector('.p-desc').textContent = p.desc;
      b.addEventListener('click', function () { selectPreset(key); });
      row.appendChild(b);
    });
  }
  function selectPreset(key) {
    state.preset = key;
    state.params = ENG.paramsFromPreset(key);
    document.querySelectorAll('.preset').forEach(function (el) {
      el.setAttribute('aria-selected', el.dataset.key === key ? 'true' : 'false');
    });
    $('presetNote').textContent = ENG.PRESETS[key].name;
    syncControls();
    paramsChanged(false);
  }

  /* ───────────────────────────────────────────── 슬라이더·토글 */
  function buildSliders() {
    var list = $('sliderList');
    list.innerHTML = '';
    ENG.SLIDERS.forEach(function (s) {
      var row = document.createElement('div');
      row.className = 'slider-row';
      var id = 's_' + s.key;
      row.innerHTML = '<label for="' + id + '">' + s.label + '</label>' +
        '<input type="range" id="' + id + '" min="' + s.min + '" max="' + s.max + '" step="' + s.step + '">' +
        '<span class="val" id="v_' + s.key + '"></span>';
      list.appendChild(row);
      var input = row.querySelector('input');
      input.addEventListener('input', function () { state.params[s.key] = parseFloat(input.value); syncControls(); paramsChanged(true); });
      input.addEventListener('change', function () { paramsChanged(false); });
    });
    // 자동 색 맞춤 · 얼굴 보정
    document.querySelectorAll('#toggleWB .seg, #toggleFace .seg').forEach(function (b) {
      b.addEventListener('click', function () {
        var group = b.parentElement.id;
        if (group === 'toggleWB') state.params.autoWB = b.dataset.v === 'on';
        else state.params.face = b.dataset.v;
        syncControls();
        paramsChanged(false);
      });
    });
  }
  function formatSliderValue(s, v) { return s.unit === 'EV' ? (v > 0 ? '+' : '') + v.toFixed(2) : Math.round(v * 100) + ''; }
  function syncControls() {
    var preset = ENG.PRESETS[state.preset];
    ENG.SLIDERS.forEach(function (s) {
      var input = $('s_' + s.key);
      if (!input) return;
      var v = state.params[s.key];
      input.value = v;
      input.style.setProperty('--fill', clamp((v - s.min) / (s.max - s.min) * 100, 0, 100) + '%');
      var label = $('v_' + s.key);
      label.textContent = formatSliderValue(s, v);
      label.className = 'val' + (Math.abs(v - preset[s.key]) > 1e-6 ? ' changed' : '');
    });
    document.querySelectorAll('#toggleWB .seg').forEach(function (b) {
      b.setAttribute('aria-pressed', (b.dataset.v === 'on') === !!state.params.autoWB ? 'true' : 'false');
    });
    document.querySelectorAll('#toggleFace .seg').forEach(function (b) {
      b.setAttribute('aria-pressed', b.dataset.v === state.params.face ? 'true' : 'false');
    });
  }

  /* ───────────────────────────────────────────── 비교 화면 */
  function freshStageCanvases() {
    // 사진마다 그림판을 새로 만들어요. (색 공간을 사진에 맞추고, 이전 사진이 남지 않게)
    var stage = $('stage');
    ['beforeCanvas', 'afterCanvas'].forEach(function (id) {
      var old = $(id), c = document.createElement('canvas');
      c.id = id; c.className = old.className;
      stage.replaceChild(c, old);
    });
  }
  function layoutStage() {
    var stage = $('stage');
    if (!state.srcW) return;
    var w = stage.clientWidth || (stage.parentElement ? stage.parentElement.clientWidth - 16 : 340);
    var h = w * state.srcH / state.srcW;
    var maxH = Math.min(window.innerHeight * 0.62, 620);
    if (h > maxH) h = maxH;
    if (h < 160) h = 160;
    stage.style.height = Math.round(h) + 'px';
    setSplit(state.split);
  }
  function setSplit(frac) {
    state.split = clamp(frac, 0, 1);
    $('stage').style.setProperty('--split', (state.split * 100).toFixed(2) + '%');
  }

  /* ───────────────────────────────────────────── 불러오기 */
  function sniffKind(buf) {
    if (!buf || buf.length < 12) return 'other';
    if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpeg';
    if (buf[0] === 0x89 && buf[1] === 0x50) return 'png';
    if (buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) return 'heif';
    return 'other';
  }
  function loadScriptOnce(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src; s.async = true; s.onload = resolve;
      s.onerror = function () { reject(new Error('script-load-failed')); };
      document.head.appendChild(s);
    });
  }
  async function decodeHeic(file) {
    if (!window.heic2any) await loadScriptOnce('https://cdn.jsdelivr.net/npm/heic2any@0.0.4/dist/heic2any.min.js');
    if (!window.heic2any) throw new Error('heic-decoder-unavailable');
    var blob = await window.heic2any({ blob: file, toType: 'image/jpeg', quality: 0.94 });
    return Array.isArray(blob) ? blob[0] : blob;
  }
  function loadImageElement(blobOrFile) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(blobOrFile), img = new Image();
      img.onload = function () { resolve({ img: img, url: url }); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('decode-failed')); };
      img.decoding = 'async';
      img.src = url;
    });
  }
  async function decodeFile(file) {
    try {
      var r = await loadImageElement(file);
      return { img: r.img, url: r.url, converted: false };
    } catch (e) {
      if (state.kind === 'heif' || /heic|heif/i.test(file.type || '') || /\.hei[cf]$/i.test(file.name || '')) {
        var r2 = await loadImageElement(await decodeHeic(file));
        return { img: r2.img, url: r2.url, converted: true };
      }
      throw e;
    }
  }

  async function handleFile(file) {
    if (!file || state.busy) return;
    state.busy = true;
    try {
      if (!/^image\//.test(file.type || '') && !/\.(jpe?g|heic|heif|png|webp)$/i.test(file.name || '')) {
        toast('사진 파일만 열 수 있어요', true);
        return;
      }
      var buf = new Uint8Array(await file.arrayBuffer());
      cancelWork();
      state.photoId++;
      state.file = file; state.buffer = buf; state.kind = sniffKind(buf);
      state.info = null; state.segs = null; state.heicTiff = null; state.out = null;
      try {
        if (state.kind === 'jpeg') {
          state.info = EX.readJPEGInfo(buf);
          state.segs = EX.collectSegments(buf);
        } else if (state.kind === 'heif') {
          var heif = EX.readHEIFExif(buf);
          state.heicTiff = heif ? heif.tiff : null;
          state.info = EX.readHEIFInfo(buf);
        }
      } catch (err) { console.warn('metadata parse failed', err); }

      // 색 공간: 원본이 Display P3 JPG면 P3 그대로, 그 밖에는 sRGB로 (색 프로필과 실제 색이 어긋나지 않게)
      state.cs = (state.kind === 'jpeg' && state.segs && state.segs.iccP3 && P3_OK) ? 'display-p3' : 'srgb';

      var dec = await decodeFile(file);
      if (state.objectUrl && state.objectUrl !== dec.url) URL.revokeObjectURL(state.objectUrl);
      state.objectUrl = dec.url;
      state.img = dec.img; state.src = dec.img;      // 브라우저가 회전(Orientation)을 적용해서 그려요
      state.srcW = dec.img.naturalWidth; state.srcH = dec.img.naturalHeight;
      state.small = ENG.sampleSmall(state.src, ANALYZE_SIDE, state.cs);
      state.faces = null;
      state.split = 0.5;

      $('emptyState').hidden = true;
      $('editor').hidden = false;
      $('saveBar').hidden = false;
      freshStageCanvases();
      layoutStage();
      renderMetaPanel();
      syncChips();
      $('autoNote').textContent = '얼굴 찾는 중…';
      var myId = state.photoId;
      var faces = await findFaces(state.small);
      if (myId !== state.photoId) return;
      state.faces = faces;            // null이면 얼굴 찾기를 못 쓴 것 → 예전 방식(피부색)으로 판단
      paramsChanged(false);
    } catch (e) {
      console.error(e);
      toast('이 사진은 열 수 없어요. 사진 앱에서 다시 골라 주세요.', true);
    } finally {
      state.busy = false;
    }
  }

  /* ───────────────────────────────────────────── 분석·미리보기 */
  function analyzeNow() {
    state.an = ENG.analyze(state.small.data, state.small.w, state.small.h, state.params, state.faces);
    renderAutoNote();
  }
  function renderAutoNote() {
    var an = state.an, bits = [];
    if (!state.params.autoWB) bits.push('색은 원래대로');
    else if (an.wbK < 0.5 * ENG.BASE.wbStrength) bits.push('분위기 있는 색이라 색 맞춤은 살짝만');
    else bits.push('흰색 기준으로 색 맞춤');
    var stop = Math.log2(an.gainAuto);
    if (stop >= 0.05) bits.push('자동 밝기 +' + stop.toFixed(1) + '스톱');
    if (an.faceCount > 0) bits.push('얼굴 ' + an.faceCount + '개 찾음');
    if (an.faceOn) {
      if (!an.skinFound) bits.push('얼굴 피부를 찾지 못했어요');
      else {
        var f = [];
        if (an.dL >= 0.5) f.push('밝게');
        if (an.dA <= -0.3) f.push('붉은기 줄임');
        if (an.dB >= 0.5) f.push('살구빛 더함');
        if (an.dB <= -0.5) f.push('누런기 뺌');
        bits.push('얼굴 보정' + (f.length ? '(' + f.join('·') + ')' : ''));
      }
    } else bits.push(state.params.face === 'auto' ? '얼굴이 없는 사진으로 판단 · 얼굴 보정 끔' : '얼굴 보정 끔');
    $('autoNote').textContent = bits.join(' · ');
    var faceAuto = $('faceAutoHint');
    if (faceAuto) faceAuto.textContent = state.params.face === 'auto' ? (an.autoPerson ? '→ 인물' : '→ 일반') : '';
  }

  var previewToken = 0, previewTimer = null;
  function paramsChanged(fast) {
    if (!state.src || !state.params) return;
    invalidateOutput();
    clearTimeout(previewTimer);
    var token = ++previewToken, id = state.photoId;
    previewTimer = setTimeout(async function () {
      if (token !== previewToken || id !== state.photoId) return;
      try {
        analyzeNow();
        var maxSide = fast ? PREVIEW_FAST : PREVIEW_FULL;
        var sc = Math.min(1, maxSide / Math.max(state.srcW, state.srcH));
        var pw = Math.max(1, Math.round(state.srcW * sc)), ph = Math.max(1, Math.round(state.srcH * sc));
        var before = $('beforeCanvas'), after = $('afterCanvas');
        if (before.width !== pw || before.height !== ph || before.dataset.photo !== String(id)) {
          before.width = pw; before.height = ph;
          var bctx = before.getContext('2d', { colorSpace: state.cs });
          bctx.imageSmoothingQuality = 'high';
          bctx.drawImage(state.src, 0, 0, pw, ph);
          before.dataset.photo = String(id);
        }
        var tmp = document.createElement('canvas');
        var ok = await ENG.render(state.src, tmp, pw, ph, state.an, state.params, {
          colorSpace: state.cs, tileH: ph,
          shouldCancel: function () { return token !== previewToken || id !== state.photoId; }
        });
        if (!ok || token !== previewToken || id !== state.photoId) return;
        after.width = pw; after.height = ph;
        after.getContext('2d', { colorSpace: state.cs }).drawImage(tmp, 0, 0);
        tmp.width = tmp.height = 0;
        if (!fast) schedulePrepare();
      } catch (e) { console.error('preview failed', e); }
    }, fast ? 40 : 0);
  }

  /* ───────────────────────────────────────────── 메타데이터 화면 */
  function fieldList(info) {
    if (!info) return [];
    var out = [];
    if (info.dateTimeOriginal || info.dateTime) out.push({ label: '촬영일시', value: fmtDateTime(info.dateTimeOriginal || info.dateTime) + (info.offsetTimeOriginal ? ' (' + info.offsetTimeOriginal + ')' : '') });
    if (info.make || info.model) out.push({ label: '기기', value: [info.make, info.model].filter(Boolean).join(' ') });
    if (info.lens) out.push({ label: '렌즈', value: info.lens });
    var expo = [];
    if (info.fNumber) expo.push('f/' + (Math.round(info.fNumber * 100) / 100));
    if (info.exposureTime) expo.push(fmtExposure(info.exposureTime));
    if (info.iso) expo.push('ISO ' + info.iso);
    if (info.focalLength35) expo.push(info.focalLength35 + 'mm'); else if (info.focalLength) expo.push(Math.round(info.focalLength) + 'mm');
    if (expo.length) out.push({ label: '노출', value: expo.join(' · ') });
    if (info.gps && info.gps.lat != null) out.push({ label: '위치', value: 'GPS 있음 · ' + fmtCoords(info.gps.lat, info.gps.lon) });
    else out.push({ label: '위치', value: 'GPS 없음', keep: false });
    if (info.hasMakerNote) out.push({ label: 'MakerNote', value: 'Apple 원본 ' + fmtBytes(info.makerNoteSize) });
    return out;
  }
  function renderMetaPanel() {
    var grid = $('metaGrid'), status = $('metaStatus'), info = state.info;
    var fields = fieldList(info), rows = fields.map(function (f) { return [f.label, f.value]; });
    rows.push(['해상도', state.srcW + ' × ' + state.srcH + ' (' + (state.srcW * state.srcH / 1e6).toFixed(1) + 'MP)']);
    rows.push(['파일', (state.file.name || '사진') + ' · ' + fmtBytes(state.file.size)]);
    rows.push(['형식', state.kind === 'heif' ? 'HEIC/HEIF (원본 EXIF 아이템 사용)' : state.kind === 'jpeg' ? 'JPEG' : state.kind.toUpperCase()]);
    rows.push(['색 공간', state.cs === 'display-p3' ? 'Display P3 (원본 그대로)' : 'sRGB']);
    if (!info) rows.push(['메타데이터', '이 파일에는 EXIF가 없어요']);
    grid.innerHTML = '';
    rows.forEach(function (r) {
      var dt = document.createElement('dt'); dt.textContent = r[0];
      var dd = document.createElement('dd'); dd.textContent = r[1];
      grid.appendChild(dt); grid.appendChild(dd);
    });
    var chip = $('chipMeta');
    if (info) {
      var keep = fields.filter(function (f) { return f.keep !== false; }).map(function (f) { return f.label; });
      status.className = 'meta-status';
      status.innerHTML = '<strong>저장할 때 그대로 유지돼요</strong><br>' + keep.join(' · ') +
        (info.orientation && info.orientation !== 1 ? '<br>방향 정보(' + info.orientation + ')는 똑바로 1로 맞춰 저장해요.' : '') +
        (state.segs && state.segs.dropped && state.segs.dropped.length ? '<br>HDR 추가 이미지 위치표(MPF)는 새 사진에 그 이미지가 없어서 빼요.' : '');
      $('metaSummary').textContent = keep.length + '개 항목 유지 · Orientation ' + (info.orientation || 1);
      chip.textContent = '메타데이터 ' + keep.length + '개 유지';
      chip.className = 'chip chip-meta-ok';
    } else {
      status.className = 'meta-status warn';
      status.innerHTML = '이 사진에는 EXIF 정보가 없어요. 보정은 그대로 되지만, 저장한 사진에도 메타데이터는 없고 사진 앱에는 오늘 날짜로 들어갈 수 있어요.';
      $('metaSummary').textContent = 'EXIF 없음 — 보정만 적용';
      chip.textContent = '메타데이터 없음';
      chip.className = 'chip';
    }
  }
  function syncChips() { $('chipSize').textContent = state.srcW + ' × ' + state.srcH + ' · ' + (state.srcW * state.srcH / 1e6).toFixed(1) + 'MP'; }
  function setOutInfo(text) { $('outInfo').textContent = text; }

  /* ───────────────────────────────────────────── 저장본 만들기 */
  var prepareTimer = null, prepareToken = 0;
  function cancelWork() { prepareToken++; previewToken++; clearTimeout(prepareTimer); clearTimeout(previewTimer); }
  function invalidateOutput() {
    state.out = null;
    prepareToken++;
    clearTimeout(prepareTimer);
    setOutInfo('보정 준비됨 · 잠시 후 저장용 사진을 미리 만들어 둬요');
    $('saveBtn').classList.remove('ready');
    if (state.file) renderMetaPanel();
  }
  // 아이폰은 누른 직후에만 공유 창을 열 수 있어서, 손을 뗀 뒤 원본 크기 결과를 미리 만들어 둬요.
  function schedulePrepare() {
    clearTimeout(prepareTimer);
    if (!state.src) return;
    prepareTimer = setTimeout(autoPrepare, 350);
  }
  async function autoPrepare() {
    if (!state.src || state.busy || state.preparing || state.out) return;
    var token = ++prepareToken;
    state.preparing = true;
    setOutInfo('저장용 사진 만드는 중…');
    try { await buildOutput({ silent: true, shouldCancel: function () { return token !== prepareToken; } }); }
    finally { state.preparing = false; }
    if (token !== prepareToken) return;
    if (!state.out) setOutInfo('보정 준비됨 · 저장을 누르면 원본 해상도로 처리해요');
  }

  function blobToBytes(blob) {
    return new Promise(function (resolve, reject) {
      if (blob.arrayBuffer) { blob.arrayBuffer().then(function (b) { resolve(new Uint8Array(b)); }, reject); return; }
      var fr = new FileReader();
      fr.onload = function () { resolve(new Uint8Array(fr.result)); };
      fr.onerror = function () { reject(fr.error || new Error('read-failed')); };
      fr.readAsArrayBuffer(blob);
    });
  }
  function canvasToBlob(canvas, quality) { return new Promise(function (resolve) { canvas.toBlob(function (b) { resolve(b); }, 'image/jpeg', quality); }); }

  function attachMetadata(newBytes, outW, outH) {
    var segs = [], info = state.info || null;
    if (state.kind === 'jpeg' && state.segs && state.segs.segments.length) {
      var col = state.segs;
      var keepIcc = state.cs === 'display-p3' ? col.iccP3 : !col.iccP3;  // 실제 색과 맞는 프로필만
      for (var i = 0; i < col.segments.length; i++) {
        if (col.iccIndices.indexOf(i) >= 0 && !keepIcc) continue;
        var seg = col.segments[i].slice();
        if (i === col.exifIndex) {
          var tiff = seg.slice(10);
          EX.patchTIFF(tiff, { orientation: 1, width: outW, height: outH, dropThumbnail: true });
          seg = EX.buildAPP1(tiff);
        } else if (i === col.xmpIndex) {
          var patched = EX.patchXMPOrientation(seg, 1);
          if (patched) seg = patched;
        }
        segs.push(seg);
      }
    } else if (state.heicTiff) {
      var ht = state.heicTiff.slice();
      EX.patchTIFF(ht, { orientation: 1, width: outW, height: outH, dropThumbnail: true });
      segs.push(EX.buildAPP1(ht));
    } else if (info) {
      segs.push(EX.buildAPP1(EX.buildTIFF({
        orientation: 1, make: info.make, model: info.model, software: info.software,
        dateTime: info.dateTime, dateTimeOriginal: info.dateTimeOriginal, offsetTimeOriginal: info.offsetTimeOriginal,
        exposureTime: info.exposureTime, fNumber: info.fNumber, iso: info.iso, focalLength: info.focalLength,
        focalLength35: info.focalLength35, lens: info.lens, width: outW, height: outH, pixelXDim: outW, pixelYDim: outH, gps: info.gps
      })));
    }
    var bytes = segs.length ? EX.injectSegments(newBytes, segs) : newBytes;
    var report = null;
    if (info) { try { report = EX.verify(info, bytes); } catch (e) { console.warn(e); } }
    return { bytes: bytes, report: report };
  }

  async function buildOutput(opts) {
    opts = opts || {};
    if (state.out && !opts.force) return state.out;
    if (!state.src) return null;
    var id = state.photoId;
    var cancelled = function () { return id !== state.photoId || (opts.shouldCancel && opts.shouldCancel()); };
    if (!opts.silent) { showOverlay('보정하는 중…', '원본 해상도로 처리하고 있어요'); await nextFrame(); }
    var area = state.srcW * state.srcH, scale = area > MAX_EXPORT_AREA ? Math.sqrt(MAX_EXPORT_AREA / area) : 1;
    var an = ENG.analyze(state.small.data, state.small.w, state.small.h, state.params, state.faces);
    var params = state.params, result = null;
    for (var attempt = 0; attempt < 4 && !result; attempt++) {
      if (cancelled()) break;
      var w = Math.max(320, Math.round(state.srcW * scale)), h = Math.max(320, Math.round(state.srcH * scale));
      var canvas = document.createElement('canvas');
      try {
        var ok = await ENG.render(state.src, canvas, w, h, an, params, {
          colorSpace: state.cs, yieldEvery: 1, shouldCancel: cancelled, pool: getPool(),
          onProgress: opts.silent ? null : setProgress
        });
        if (!ok) break;
        var blob = await canvasToBlob(canvas, 0.95);
        if (!blob) throw new Error('encode-failed');
        var bytes = await blobToBytes(blob);
        if (bytes.length < 1024) throw new Error('empty');
        var meta = attachMetadata(bytes, w, h);
        result = { blob: new Blob([meta.bytes], { type: 'image/jpeg' }), bytes: meta.bytes, report: meta.report, width: w, height: h, scaled: scale < 0.999 };
      } catch (e) {
        console.warn('export attempt failed at ' + w + 'x' + h, e);
        scale *= 0.7;  // 그림판 한도에 걸리면 조금 줄여서 다시
      } finally { canvas.width = 0; canvas.height = 0; }
    }
    if (!opts.silent) hideOverlay();
    if (!result || cancelled()) {
      if (!cancelled() && !opts.silent) toast('저장용 사진을 만들지 못했어요. 다시 시도해 주세요.', true);
      return null;
    }
    state.out = result;
    updateOutSummary();
    return result;
  }
  function updateOutSummary() {
    var o = state.out; if (!o) return;
    var bits = [o.width + ' × ' + o.height, fmtBytes(o.blob.size)];
    if (o.scaled) bits.push('메모리 한계로 축소');
    if (o.report) bits.push(o.report.ok ? '메타데이터 완전 유지' : '일부 항목 확인 필요');
    setOutInfo('저장 준비 완료 · ' + bits.join(' · '));
    $('saveBtn').classList.add('ready');
    renderVerification(o.report);
  }
  function renderVerification(report) {
    var status = $('metaStatus');
    if (!report || !report.checks.length) return;
    var failed = report.checks.filter(function (c) { return !c.ok; });
    status.className = 'meta-status' + (failed.length ? ' warn' : '');
    status.innerHTML = !failed.length
      ? '<strong>저장할 사진 검증 완료 ✓</strong><br>촬영일시 · 기기 · 렌즈 · 노출 · GPS · MakerNote 그대로 담겼어요.'
      : '<strong>저장할 사진 검증 결과</strong><ul>' + report.checks.map(function (c) {
          return '<li class="' + (c.ok ? '' : 'miss') + '">' + c.label + ': ' + (c.ok ? '유지' : '확인 필요') + '</li>';
        }).join('') + '</ul>';
  }

  function outName() { return ((state.file && state.file.name) || 'IMG').replace(/\.[^.]+$/, '') + '_화사.jpg'; }
  function downloadBlob(blob, filename) {
    var url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = filename; a.rel = 'noopener';
    document.body.appendChild(a); a.click();
    setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 4000);
  }

  async function onSave() {
    if (state.busy || !state.src) return;
    var prepared = state.out;
    if (prepared) {
      // 미리 만들어 둔 결과가 있으면 바로 공유 창 (누른 직후라 아이폰에서도 열려요)
      var file = new File([prepared.blob], outName(), { type: 'image/jpeg' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({ files: [file], title: '화사 스튜디오' });
          toast('공유 창에서 “이미지 저장”을 누르면 사진 앱에 들어가요');
        } catch (e) {
          if (e && e.name === 'AbortError') return;
          toast('공유 창을 열지 못했어요. 한 번 더 눌러 주세요.', true);
        }
      } else {
        downloadBlob(prepared.blob, outName());
        toast('다운로드에 저장했어요');
      }
      return;
    }
    // 아직이면 지금 만들고, 한 번 더 누르게 안내 (오래 걸리면 아이폰이 공유 창을 막아요)
    state.busy = true; $('saveBtn').disabled = true;
    try {
      prepareToken++; clearTimeout(prepareTimer);
      var o = await buildOutput();
      if (o) toast('준비 완료! 사진첩에 저장을 한 번 더 눌러 주세요');
    } finally { state.busy = false; $('saveBtn').disabled = false; }
  }
  async function onDownload() {
    if (state.busy || !state.src) return;
    state.busy = true; $('downloadBtn').disabled = true;
    try {
      var o = state.out || await buildOutput();
      if (!o) return;
      downloadBlob(o.blob, outName());
      toast('다운로드에 저장했어요');
    } finally { state.busy = false; $('downloadBtn').disabled = false; }
  }

  /* ───────────────────────────────────────────── 이벤트 */
  function wireStageSlider() {
    var stage = $('stage'), dragging = false;
    function move(clientX) {
      var rect = stage.getBoundingClientRect();
      setSplit((clientX - rect.left) / rect.width);
    }
    stage.addEventListener('pointerdown', function (e) { dragging = true; if (stage.setPointerCapture) stage.setPointerCapture(e.pointerId); move(e.clientX); });
    stage.addEventListener('pointermove', function (e) { if (!dragging) return; e.preventDefault(); move(e.clientX); });
    stage.addEventListener('pointerup', function () { dragging = false; });
    stage.addEventListener('pointercancel', function () { dragging = false; });
  }
  function wireUi() {
    $('pickBtn').addEventListener('click', function () { $('fileInput').click(); });
    $('changeBtn').addEventListener('click', function () { $('fileInput').click(); });
    $('fileInput').addEventListener('change', function (e) {
      var f = e.target.files && e.target.files[0];
      e.target.value = '';
      if (f) handleFile(f);
    });
    $('saveBtn').addEventListener('click', onSave);
    $('downloadBtn').addEventListener('click', onDownload);
    $('resetBtn').addEventListener('click', function () { state.params = ENG.paramsFromPreset(state.preset); syncControls(); paramsChanged(false); });
    $('metaToggle').addEventListener('click', function () {
      var btn = $('metaToggle'), open = btn.getAttribute('aria-expanded') === 'true';
      btn.setAttribute('aria-expanded', open ? 'false' : 'true');
      $('metaBody').hidden = open;
    });
    var sheet = $('infoSheet'), backdrop = $('sheetBackdrop');
    function openSheet() { sheet.hidden = false; backdrop.hidden = false; }
    function closeSheet() { sheet.hidden = true; backdrop.hidden = true; }
    $('infoBtn').addEventListener('click', openSheet);
    $('sheetClose').addEventListener('click', closeSheet);
    backdrop.addEventListener('click', closeSheet);

    var card = $('dropCard');
    ['dragenter', 'dragover'].forEach(function (t) { card.addEventListener(t, function (e) { e.preventDefault(); card.classList.add('dragover'); }); });
    ['dragleave', 'drop'].forEach(function (t) { card.addEventListener(t, function (e) { e.preventDefault(); card.classList.remove('dragover'); }); });
    document.addEventListener('dragover', function (e) { e.preventDefault(); });
    document.addEventListener('drop', function (e) {
      if (!e.dataTransfer || !e.dataTransfer.files || !e.dataTransfer.files.length) return;
      e.preventDefault(); handleFile(e.dataTransfer.files[0]);
    });
    document.addEventListener('paste', function (e) {
      var items = e.clipboardData && e.clipboardData.items; if (!items) return;
      for (var i = 0; i < items.length; i++) if (items[i].type && items[i].type.indexOf('image/') === 0) { var f = items[i].getAsFile(); if (f) { handleFile(f); break; } }
    });
    var resizeTimer = null;
    window.addEventListener('resize', function () {
      if (!state.srcW) return;
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(layoutStage, 120);
    });
  }

  function start() {
    buildPresets();
    state.params = ENG.paramsFromPreset('auto');
    buildSliders();
    syncControls();
    wireUi();
    wireStageSlider();
    setSplit(0.5);
    var v = $('version'); if (v) v.textContent = '버전 ' + APP_VERSION; var vh = $('versionHome'); if (vh) vh.textContent = '버전 ' + APP_VERSION;
  }
  // 테스트용으로 살짝 열어 둬요
  window.__studio = { state: state, buildOutput: buildOutput, pool: function () { return getPool(); } };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
