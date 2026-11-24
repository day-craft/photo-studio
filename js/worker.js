/*!
 * worker.js — 보정 계산을 나눠 맡는 일꾼
 * 화면(메인 스레드)이 사진 조각을 보내면, 보정 엔진으로 계산해서 돌려줘요.
 */
/* global P18Engine */
importScripts('engine.js?v=3', 'face.js?v=3');
/* global P18Face */

var an = null, p = null, classify = null;
self.onmessage = function (e) {
  var m = e.data;
  if (m.type === 'faces') {          // 얼굴 찾기 (사진마다 한 번)
    (classify ? Promise.resolve() : fetch('facefinder.bin').then(function (r) { if (!r.ok) throw new Error('model ' + r.status); return r.arrayBuffer(); })
      .then(function (buf) { classify = P18Face.unpackCascade(new Int8Array(buf)); }))
      .then(function () {
        var faces = P18Face.detect(classify, m.rgba, m.w, m.h, { minScore: 10 });
        self.postMessage({ type: 'faces', id: m.id, faces: faces });
      })
      .catch(function (err) { self.postMessage({ type: 'error', id: m.id, message: String(err && err.message || err) }); });
    return;
  }
  if (m.type === 'setup') {          // 사진 분석 결과와 설정은 한 번만 받아 둬요
    an = m.an; p = m.p;
    self.postMessage({ type: 'ready', id: m.id });
    return;
  }
  if (m.type === 'tile') {
    try {
      var px = new Uint8ClampedArray(m.buf);
      var skin = new Uint8Array(m.w * m.th);
      P18Engine.toneTile(px, m.w, m.th, m.top, m.fullW, m.fullH, an, p, skin);
      P18Engine.sharpenTile(px, m.w, m.th, skin, m.amount, m.fullW);
      self.postMessage({ type: 'done', id: m.id, buf: px.buffer }, [px.buffer]);
    } catch (err) {
      self.postMessage({ type: 'error', id: m.id, message: String(err && err.message || err) });
    }
  }
};
