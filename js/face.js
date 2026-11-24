/*!
 * face.js — 사진에서 얼굴 위치 찾기
 *
 * pico.js(Nenad Markus)의 얼굴 찾기 방법을 이 앱에 맞게 옮겨 적은 것이에요.
 * 원본: https://github.com/nenadmarkus/picojs , 학습된 얼굴 모델: https://github.com/nenadmarkus/pico (rnt/cascades/facefinder)
 *
 * The MIT License
 * Copyright (c) 2013 Nenad Markus
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
 * documentation files (the "Software"), to deal in the Software without restriction, including without limitation
 * the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to
 * permit persons to whom the Software is furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in all copies or substantial portions of
 * the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO
 * THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
 * TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
(function (global) {
  'use strict';

  // 학습된 얼굴 모델(바이트)을 판별 함수로 풀기
  function unpackCascade(bytes) {
    var dv = new DataView(new ArrayBuffer(4));
    function i32(p) { dv.setUint8(0, bytes[p]); dv.setUint8(1, bytes[p + 1]); dv.setUint8(2, bytes[p + 2]); dv.setUint8(3, bytes[p + 3]); return dv.getInt32(0, true); }
    function f32(p) { dv.setUint8(0, bytes[p]); dv.setUint8(1, bytes[p + 1]); dv.setUint8(2, bytes[p + 2]); dv.setUint8(3, bytes[p + 3]); return dv.getFloat32(0, true); }
    var p = 8;                       // 앞 8바이트는 버전·학습 정보
    var tdepth = i32(p); p += 4;
    var ntrees = i32(p); p += 4;
    var leaves = Math.pow(2, tdepth), codes = [], preds = [], thresh = [];
    for (var t = 0; t < ntrees; t++) {
      codes.push(0, 0, 0, 0);
      for (var k = 0; k < 4 * leaves - 4; k++) codes.push(bytes[p + k]);
      p += 4 * leaves - 4;
      for (var l = 0; l < leaves; l++) { preds.push(f32(p)); p += 4; }
      thresh.push(f32(p)); p += 4;
    }
    var tcodes = new Int8Array(codes), tpreds = new Float32Array(preds), th = new Float32Array(thresh);
    return function classify(r, c, s, pixels, ldim) {
      r = 256 * r; c = 256 * c;
      var root = 0, o = 0;
      for (var i = 0; i < ntrees; i++) {
        var idx = 1;
        for (var j = 0; j < tdepth; j++) {
          idx = 2 * idx + (pixels[((r + tcodes[root + 4 * idx] * s) >> 8) * ldim + ((c + tcodes[root + 4 * idx + 1] * s) >> 8)] <=
                           pixels[((r + tcodes[root + 4 * idx + 2] * s) >> 8) * ldim + ((c + tcodes[root + 4 * idx + 3] * s) >> 8)]);
        }
        o += tpreds[leaves * i + idx - leaves];
        if (o <= th[i]) return -1;
        root += 4 * leaves;
      }
      return o - th[ntrees - 1];
    };
  }

  function runCascade(gray, rows, cols, classify, params) {
    var dets = [], scale = params.minsize;
    while (scale <= params.maxsize) {
      var step = Math.max(params.shiftfactor * scale, 1) >> 0, off = (scale / 2 + 1) >> 0;
      for (var r = off; r <= rows - off; r += step)
        for (var c = off; c <= cols - off; c += step) {
          var q = classify(r, c, scale, gray, cols);
          if (q > 0) dets.push([r, c, scale, q]);
        }
      scale *= params.scalefactor;
    }
    return dets;
  }

  function clusterDetections(dets, iouThreshold) {
    dets = dets.slice().sort(function (a, b) { return b[3] - a[3]; });
    function iou(a, b) {
      var orr = Math.max(0, Math.min(a[0] + a[2] / 2, b[0] + b[2] / 2) - Math.max(a[0] - a[2] / 2, b[0] - b[2] / 2));
      var occ = Math.max(0, Math.min(a[1] + a[2] / 2, b[1] + b[2] / 2) - Math.max(a[1] - a[2] / 2, b[1] - b[2] / 2));
      return orr * occ / (a[2] * a[2] + b[2] * b[2] - orr * occ);
    }
    var used = new Uint8Array(dets.length), out = [];
    for (var i = 0; i < dets.length; i++) {
      if (used[i]) continue;
      var r = 0, c = 0, s = 0, q = 0, n = 0;
      for (var j = i; j < dets.length; j++) {
        if (iou(dets[i], dets[j]) > iouThreshold) { used[j] = 1; r += dets[j][0]; c += dets[j][1]; s += dets[j][2]; q += dets[j][3]; n++; }
      }
      out.push([r / n, c / n, s / n, q]);
    }
    return out;
  }

  /**
   * RGBA 작은 사본에서 얼굴 찾기. 비스듬한 얼굴도 찾도록 사진을 조금씩 돌려서 다시 봐요.
   * 반환: [{x, y, size, score}] — 좌표는 입력 사진(w×h) 기준
   */
  function detect(classify, rgba, w, h, opts) {
    opts = opts || {};
    var minScore = opts.minScore || 10;
    var sides = opts.sides || [420, 480];          // 두 가지 크기로 찾고 더 확실한 점수를 써요
    var angles = opts.angles || [0, -25, 25, -50, 50];
    // 똑바른 얼굴만 한 크기 더 크게 찾아요 (작게 찍힌 아기 얼굴용)
    var uprightSides = opts.uprightSides || [560];
    var jobs = [];
    sides.forEach(function (sd) { jobs.push({ side: sd, angles: angles }); });
    uprightSides.forEach(function (sd) { jobs.push({ side: sd, angles: [0] }); });
    var faces = [];
    for (var si = 0; si < jobs.length; si++) {
      var s = Math.min(1, jobs[si].side / Math.max(w, h)), gw = Math.max(1, Math.round(w * s)), gh = Math.max(1, Math.round(h * s));
      var gray = new Uint8Array(gw * gh);
      for (var y = 0; y < gh; y++) {
        var sy = Math.min(h - 1, Math.floor(y / s));
        for (var x = 0; x < gw; x++) {
          var sx = Math.min(w - 1, Math.floor(x / s)), q = (sy * w + sx) * 4;
          gray[y * gw + x] = (rgba[q] * 77 + rgba[q + 1] * 150 + rgba[q + 2] * 29) >> 8;
        }
      }
      var short = Math.min(gw, gh);
      var params = { shiftfactor: 0.1, minsize: Math.max(16, Math.round(short * 0.06)), maxsize: Math.round(short * 0.95), scalefactor: 1.12 };
      var angs = jobs[si].angles;
      for (var a = 0; a < angs.length; a++) {
        var rot = rotate(gray, gw, gh, angs[a]);
        var dets = clusterDetections(runCascade(rot.px, rot.h, rot.w, classify, params), 0.2);
        for (var d = 0; d < dets.length; d++) {
          var p = rot.back(dets[d][1], dets[d][0]);   // 돌린 좌표 → 원래 좌표
          faces.push({ x: p[0] / s, y: p[1] / s, size: dets[d][2] / s, score: dets[d][3], angle: angs[a] });
        }
      }
    }
    // 같은 자리에서 여러 번 찾은 얼굴은 점수가 가장 높은 것 하나로
    faces.sort(function (a, b) { return b.score - a.score; });
    var keep = [];
    faces.forEach(function (f) {
      for (var k = 0; k < keep.length; k++) {
        var dx = f.x - keep[k].x, dy = f.y - keep[k].y;
        if (Math.sqrt(dx * dx + dy * dy) < 0.5 * Math.max(f.size, keep[k].size)) return;
      }
      keep.push(f);
    });
    return keep.filter(function (f) { return f.score >= minScore; });
  }

  // 회색 사진을 가운데 기준으로 돌리기 (빈 곳은 회색). back(x,y)로 원래 좌표를 돌려줘요.
  function rotate(gray, w, h, deg) {
    if (!deg) return { px: gray, w: w, h: h, back: function (x, y) { return [x, y]; } };
    var t = deg * Math.PI / 180, cs = Math.cos(t), sn = Math.sin(t);
    var nw = Math.round(Math.abs(w * cs) + Math.abs(h * sn)), nh = Math.round(Math.abs(w * sn) + Math.abs(h * cs));
    var out = new Uint8Array(nw * nh), cx = w / 2, cy = h / 2, ncx = nw / 2, ncy = nh / 2;
    for (var y = 0; y < nh; y++) for (var x = 0; x < nw; x++) {
      var dx = x - ncx, dy = y - ncy;
      var sx = Math.round(cs * dx + sn * dy + cx), sy = Math.round(-sn * dx + cs * dy + cy);
      out[y * nw + x] = (sx >= 0 && sy >= 0 && sx < w && sy < h) ? gray[sy * w + sx] : 128;
    }
    return { px: out, w: nw, h: nh, back: function (x, y) {
      var dx = x - ncx, dy = y - ncy;
      return [cs * dx + sn * dy + cx, -sn * dx + cs * dy + cy];
    } };
  }

  var api = { unpackCascade: unpackCascade, detect: detect };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.P18Face = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
