/*!
 * engine.js — 화사 스튜디오 보정 엔진
 *
 * 사진마다 먼저 분석하고(작은 사본), 그 결과로 원본 크기를 조각(타일)별로 보정해요.
 *  1) 흰 벽·종이 같은 무채색을 찾아 색 틀어짐을 바로잡고(자동 색 맞춤), 흰색이 흰색답게 밝기를 맞춰요.
 *     어두운 사진(야간 프리셋)은 전체 밝기 기준으로도 끌어올려요.
 *  2) 밝은 중간톤만 올리고 그림자는 지켜서 뿌옇지 않게, 검정점·윤곽 대비로 또렷하게.
 *  3) 얼굴(피부)을 찾아 밝기·붉은기·살구빛을 사진마다 맞춰요.
 *  4) 색 노이즈 정리(야간), 잔디테일 선명하게.
 * 계산은 Lab(사람 눈에 가까운 색 공간)에서 하고, 그림판은 원본과 같은 색 공간(Display P3)을 써요.
 */
(function (global) {
  'use strict';

  /* ------------------------------------------------------------ 기본값 */
  var BASE = {
    wbStrength: 0.8,            // 색 틀어짐을 80%만 바로잡기
    warm: [1.015, 1.0, 0.975],  // 바로잡은 뒤 살짝 따뜻하게
    whiteTarget: 0.85,          // 흰 벽/종이를 이 밝기까지 (어둡게는 안 함)
    maxGain: 1.52,              // 흰색 기준 최대 +0.6스톱
    shoulder: 0.82,             // 밝은 부분 부드럽게 눌러주기 시작점
    midLift: 0.05,              // 밝은 중간톤 올리기
    clarity: 0.22,              // 윤곽 대비
    claritySkin: 0.5,           // 얼굴 위 윤곽 대비 비율
    sharpen: 0.55,              // 잔디테일 선명하게
    sharpenSkin: 0.35,          // 얼굴 위 선명하게 비율
    skinL: 68, skinLMax: 2.5,   // 얼굴 밝기 목표 / 최대 추가 밝기
    skinB: 14.5, skinBMax: 2,   // 살구빛(노란기) 목표 / 최대 조정
    skinA: 11, skinAMax: 1.2    // 붉은기가 이보다 높을 때만 최대 1.2 줄이기
  };

  var PRESETS = {
    auto: {
      key: 'auto', name: '18 Pro 자동', badge: '추천',
      desc: '사진마다 색·밝기·얼굴을 자동으로 맞춰요. 대비는 지켜서 뿌옇지 않게',
      exposureEV: 0, shadows: 0, contrast: 0, warmth: 0, detail: 0.5,
      autoWB: true, face: 'auto', nr: 0, vibrance: 0.04, lowLight: 0
    },
    portrait: {
      key: 'portrait', name: '실내·인물', badge: '피부톤',
      desc: '얼굴 보정을 켜고 살짝 따뜻하게. 피부결은 부드럽게',
      exposureEV: 0.05, shadows: 0.1, contrast: 0, warmth: 0.12, detail: 0.4,
      autoWB: true, face: 'on', nr: 0.15, vibrance: 0.03, lowLight: 0
    },
    night: {
      key: 'night', name: '저조도·야간', badge: '암부 복원',
      desc: '어두운 사진을 전체적으로 끌어올리고 색 노이즈를 정리',
      exposureEV: 0.1, shadows: 0.45, contrast: 0.05, warmth: 0, detail: 0.4,
      autoWB: true, face: 'auto', nr: 0.6, vibrance: 0.06, lowLight: 1
    },
    outdoor: {
      key: 'outdoor', name: '선명한 야외', badge: '선명함',
      desc: '하늘은 지키면서 윤곽과 색을 또렷하게. 얼굴 보정은 꺼요',
      exposureEV: 0, shadows: 0.05, contrast: 0.12, warmth: 0, detail: 0.75,
      autoWB: true, face: 'off', nr: 0, vibrance: 0.1, lowLight: 0
    }
  };
  var PRESET_ORDER = ['auto', 'portrait', 'night', 'outdoor'];

  var SLIDERS = [
    { key: 'exposureEV', label: '밝기', min: -0.6, max: 1.0, step: 0.01, unit: 'EV' },
    { key: 'shadows', label: '암부 복원', min: 0, max: 1, step: 0.01, unit: '' },
    { key: 'contrast', label: '대비', min: -0.5, max: 0.5, step: 0.01, unit: '' },
    { key: 'warmth', label: '따뜻함', min: -0.5, max: 0.5, step: 0.01, unit: '' },
    { key: 'detail', label: '선명도', min: 0, max: 1, step: 0.01, unit: '' }
  ];

  function paramsFromPreset(key, overrides) {
    var base = PRESETS[key] || PRESETS.auto, p = {};
    for (var k in base) p[k] = base[k];
    p.presetKey = base.key;
    if (overrides) for (var j in overrides) p[j] = overrides[j];
    return p;
  }

  /* ------------------------------------------------------------ 도구 */
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function smoothstep(e0, e1, x) { var t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); }

  var TO_LIN = new Float32Array(256);
  for (var i = 0; i < 256; i++) { var x = i / 255; TO_LIN[i] = x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); }
  var GAM_N = 8192, TO_GAM = new Uint8ClampedArray(GAM_N + 1);
  for (var j = 0; j <= GAM_N; j++) { var y = j / GAM_N; TO_GAM[j] = Math.round((y <= 0.0031308 ? y * 12.92 : 1.055 * Math.pow(y, 1 / 2.4) - 0.055) * 255); }

  var XN = 0.950456, ZN = 1.088754;
  function fLab(t) { return t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116; }
  function linToLab(r, g, b, out) {
    var X = (0.412453 * r + 0.357580 * g + 0.180423 * b) / XN;
    var Y = 0.212671 * r + 0.715160 * g + 0.072169 * b;
    var Z = (0.019334 * r + 0.119193 * g + 0.950227 * b) / ZN;
    var fx = fLab(X), fy = fLab(Y), fz = fLab(Z);
    out[0] = Y > 0.008856 ? 116 * fy - 16 : 903.3 * Y;
    out[1] = 500 * (fx - fy);
    out[2] = 200 * (fy - fz);
  }
  function finv(f) { var f3 = f * f * f; return f3 > 0.008856 ? f3 : (f - 16 / 116) / 7.787; }
  function labToLin(L, a, b, out) {
    var fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
    var Y = L > 7.9996 ? fy * fy * fy : L / 903.3;
    var X = finv(fx) * XN, Z = finv(fz) * ZN;
    out[0] = 3.240479 * X - 1.537150 * Y - 0.498535 * Z;
    out[1] = -0.969256 * X + 1.875991 * Y + 0.041556 * Z;
    out[2] = 0.055648 * X - 0.204043 * Y + 1.057311 * Z;
  }
  function histQuantile(hist, lo, step, q) {
    var total = 0, k;
    for (k = 0; k < hist.length; k++) total += hist[k];
    var want = total * q, acc = 0;
    for (k = 0; k < hist.length; k++) { acc += hist[k]; if (acc >= want) return lo + (k + 0.5) * step; }
    return lo + hist.length * step;
  }

  // 빠른 가우시안 흐림 (박스 흐림 3번)
  function boxPass(src, dst, w, h, r, horiz) {
    var inv = 1 / (2 * r + 1), x, y, acc, o, i;
    if (horiz) {
      for (y = 0; y < h; y++) {
        o = y * w; acc = 0;
        for (i = -r; i <= r; i++) acc += src[o + clamp(i, 0, w - 1)];
        for (x = 0; x < w; x++) {
          dst[o + x] = acc * inv;
          acc += src[o + Math.min(x + r + 1, w - 1)] - src[o + Math.max(x - r, 0)];
        }
      }
    } else {
      for (x = 0; x < w; x++) {
        acc = 0;
        for (i = -r; i <= r; i++) acc += src[clamp(i, 0, h - 1) * w + x];
        for (y = 0; y < h; y++) {
          dst[y * w + x] = acc * inv;
          acc += src[Math.min(y + r + 1, h - 1) * w + x] - src[Math.max(y - r, 0) * w + x];
        }
      }
    }
  }
  function fastBlur(src, w, h, sigma) {
    var n = 3, wIdeal = Math.sqrt(12 * sigma * sigma / n + 1);
    var wl = Math.floor(wIdeal); if (wl % 2 === 0) wl--;
    var wu = wl + 2, m = Math.round((12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4));
    var a = Float32Array.from(src), b = new Float32Array(src.length);
    for (var k = 0; k < 3; k++) {
      var r = ((k < m ? wl : wu) - 1) / 2;
      if (r < 1) continue;
      boxPass(a, b, w, h, r, true); boxPass(b, a, w, h, r, false);
    }
    return a;
  }

  /* ------------------------------------------------------------ 분석 */
  /**
   * 작은 사본(RGBA)으로 사진 상태를 분석해요. 파라미터(색 맞춤·밝기·따뜻함·얼굴)에 따라 결과가 달라져요.
   */
  function analyze(px, w, h, p) {
    var n = w * h, i, q;
    var YB = 4096, histY = new Uint32Array(YB);
    var Y = new Float32Array(n), cand = new Uint8Array(n), candCount = 0, sumY = 0;
    for (i = 0, q = 0; i < n; i++, q += 4) {
      var r8 = px[q], g8 = px[q + 1], b8 = px[q + 2];
      var yy = 0.2126 * TO_LIN[r8] + 0.7152 * TO_LIN[g8] + 0.0722 * TO_LIN[b8];
      Y[i] = yy; sumY += yy;
      var mx = r8 > g8 ? (r8 > b8 ? r8 : b8) : (g8 > b8 ? g8 : b8);
      var mn = r8 < g8 ? (r8 < b8 ? r8 : b8) : (g8 < b8 ? g8 : b8);
      if ((mx - mn) / 255 < 0.12) { cand[i] = 1; candCount++; histY[Math.min(YB - 1, (yy * YB) | 0)]++; }
    }
    var meanY = sumY / n;
    var useCand = candCount > n * 0.0003;
    if (!useCand) { histY.fill(0); for (i = 0; i < n; i++) histY[Math.min(YB - 1, (Y[i] * YB) | 0)]++; }
    var thr = histQuantile(histY, 0, 1 / YB, useCand ? 0.97 : 0.99) - 0.5 / YB;
    var rs = 0, gs = 0, bs = 0, c = 0;
    for (i = 0, q = 0; i < n; i++, q += 4) {
      if ((useCand && !cand[i]) || Y[i] < thr) continue;
      rs += TO_LIN[px[q]]; gs += TO_LIN[px[q + 1]]; bs += TO_LIN[px[q + 2]]; c++;
    }
    var ref = c ? [rs / c, gs / c, bs / c] : [1, 1, 1];
    var refMean = (ref[0] + ref[1] + ref[2]) / 3;
    var cast = Math.max(ref[0], ref[1], ref[2]) / Math.max(1e-6, Math.min(ref[0], ref[1], ref[2]));

    // 자동 색 맞춤: 노을·조명처럼 일부러 색이 강한 장면은 약하게
    var wbK = p.autoWB ? BASE.wbStrength * clamp((1.45 - cast) / 0.3, 0.25, 1) * (useCand ? 1 : 0.5) : 0;
    var warmAdj = [1 + 0.08 * p.warmth, 1, 1 - 0.08 * p.warmth];
    var warmBase = p.autoWB ? BASE.warm : [1, 1, 1];
    var wb = [0, 1, 2].map(function (k) { return (1 + wbK * (refMean / Math.max(ref[k], 1e-6) - 1)) * warmBase[k] * warmAdj[k]; });

    // 밝기: 흰색 기준 + (야간) 전체 밝기 기준
    var gainWhite = clamp(BASE.whiteTarget / ((ref[0] * wb[0] + ref[1] * wb[1] + ref[2] * wb[2]) / 3), 1, BASE.maxGain);
    var gainMid = p.lowLight > 0 ? clamp(Math.sqrt(0.12 / Math.max(meanY, 1e-4)), 1, 1 + p.lowLight) : 1;
    var gainAuto = Math.min(Math.max(gainWhite, gainMid), BASE.maxGain * (1 + 0.35 * p.lowLight));
    var gain = clamp(gainAuto * Math.pow(2, p.exposureEV), 0.5, 3.2);

    var skinRaw = new Float32Array(n), Ls = new Float32Array(n), As = new Float32Array(n), Bs = new Float32Array(n);
    var lab = [0, 0, 0], k0 = BASE.shoulder;
    function sh(v) { return v > k0 ? k0 + (1 - k0) * (1 - Math.exp(-(v - k0) / (1 - k0))) : v; }
    for (i = 0, q = 0; i < n; i++, q += 4) {
      linToLab(clamp(sh(TO_LIN[px[q]] * wb[0] * gain), 0, 1), clamp(sh(TO_LIN[px[q + 1]] * wb[1] * gain), 0, 1), clamp(sh(TO_LIN[px[q + 2]] * wb[2] * gain), 0, 1), lab);
      var L = lab[0], A = lab[1], B = lab[2];
      Ls[i] = L; As[i] = A; Bs[i] = B;
      var hue = Math.atan2(B, A) * 180 / Math.PI, ch = Math.sqrt(A * A + B * B);
      if (hue > 22 && hue < 75 && ch > 8 && ch < 40 && L < 90) skinRaw[i] = clamp((L - 50) / 8, 0, 1);
    }
    var scale = w / 1512;  // 처음 맞춘 기준(가로 1512px)과 같은 비율
    var mask = fastBlur(skinRaw, w, h, 6 * scale);
    var lowL = fastBlur(Ls, w, h, 20 * scale);
    var lowA = null, lowB = null;
    if (p.nr > 0.001) { lowA = fastBlur(As, w, h, 3 * scale + 0.6); lowB = fastBlur(Bs, w, h, 3 * scale + 0.6); }

    var hAll = new Uint32Array(1000);
    for (i = 0; i < n; i++) hAll[clamp((Ls[i] * 10) | 0, 0, 999)]++;
    var blackPt = clamp(histQuantile(hAll, 0, 0.1, 0.005) - 1, 0, 4) * 0.8;

    var hL = new Uint32Array(1000), hA = new Uint32Array(2560), hB = new Uint32Array(2560), sc = 0;
    for (i = 0; i < n; i++) if (mask[i] > 0.5) {
      sc++; hL[clamp((Ls[i] * 10) | 0, 0, 999)]++;
      hA[clamp(((As[i] + 128) * 10) | 0, 0, 2559)]++; hB[clamp(((Bs[i] + 128) * 10) | 0, 0, 2559)]++;
    }
    var skinFrac = sc / n, skinFound = sc > n * 0.00015;
    var sL = 70, sA = 10, sB = 16;
    if (skinFound) { sL = histQuantile(hL, 0, 0.1, 0.5); sA = histQuantile(hA, -128, 0.1, 0.5); sB = histQuantile(hB, -128, 0.1, 0.5); }
    var autoPerson = skinFrac > 0.004 && skinFrac < 0.35;
    var faceOn = p.face === 'on' || (p.face === 'auto' && autoPerson);
    var face = faceOn && skinFound;
    if (!face) mask.fill(0);
    return {
      wb: wb, gain: gain, gainAuto: gainAuto, mask: mask, lowL: lowL, lowA: lowA, lowB: lowB, blackPt: blackPt,
      mw: w, mh: h, cast: cast, wbK: wbK, skinFrac: skinFrac, skinFound: skinFound, autoPerson: autoPerson, faceOn: faceOn,
      dL: face ? clamp(BASE.skinL - sL, 0, BASE.skinLMax) : 0,
      dB: face ? clamp(BASE.skinB - sB, -BASE.skinBMax, BASE.skinBMax) : 0,
      dA: face ? clamp(BASE.skinA - sA, -BASE.skinAMax, 0) : 0
    };
  }

  /* ------------------------------------------------------------ 보정 적용 */
  /**
   * px: 조각(타일) RGBA. 조각의 0번째 줄이 전체 사진의 y0번째 줄이에요. (fullW × fullH 기준 좌표)
   * skinW(선택): 선명하게 단계에서 쓸 피부 지도(조각 크기)를 채워요.
   */
  function toneTile(px, w, h, y0, fullW, fullH, an, p, skinW) {
    var wb = an.wb, gain = an.gain, mask = an.mask, lowL = an.lowL, lowA = an.lowA, lowB = an.lowB;
    var mw = an.mw, mh = an.mh, dL = an.dL, dA = an.dA, dB = an.dB;
    var bpScale = 100 / (100 - an.blackPt), blackPt = an.blackPt;
    var detail = p.detail / 0.5;
    var clar = BASE.clarity * detail, cSkin = BASE.claritySkin, vib = p.vibrance, mid = BASE.midLift;
    var shadows = p.shadows, contrast = p.contrast, nr = p.nr;
    var lab = [0, 0, 0], rgb = [0, 0, 0], k0 = BASE.shoulder, kk = 1 - k0;
    var sxs = mw / fullW, sys = mh / fullH;
    for (var yy = 0; yy < h; yy++) {
      var gy = y0 + yy;
      var fy = clamp((gy + 0.5) * sys - 0.5, 0, mh - 1), ya = fy | 0, yb = Math.min(ya + 1, mh - 1), ty = fy - ya;
      for (var x = 0; x < w; x++) {
        var q = (yy * w + x) * 4;
        var fx = clamp((x + 0.5) * sxs - 0.5, 0, mw - 1), xa = fx | 0, xb = Math.min(xa + 1, mw - 1), tx = fx - xa;
        var i00 = ya * mw + xa, i01 = ya * mw + xb, i10 = yb * mw + xa, i11 = yb * mw + xb;
        var w00 = (1 - tx) * (1 - ty), w01 = tx * (1 - ty), w10 = (1 - tx) * ty, w11 = tx * ty;
        var m = mask[i00] * w00 + mask[i01] * w01 + mask[i10] * w10 + mask[i11] * w11;
        var lo = lowL[i00] * w00 + lowL[i01] * w01 + lowL[i10] * w10 + lowL[i11] * w11;
        if (skinW) skinW[yy * w + x] = m * 255;

        var r = TO_LIN[px[q]] * wb[0] * gain, g = TO_LIN[px[q + 1]] * wb[1] * gain, b = TO_LIN[px[q + 2]] * wb[2] * gain;
        if (r > k0) r = k0 + kk * (1 - Math.exp(-(r - k0) / kk));
        if (g > k0) g = k0 + kk * (1 - Math.exp(-(g - k0) / kk));
        if (b > k0) b = k0 + kk * (1 - Math.exp(-(b - k0) / kk));
        linToLab(r < 0 ? 0 : r > 1 ? 1 : r, g < 0 ? 0 : g > 1 ? 1 : g, b < 0 ? 0 : b > 1 ? 1 : b, lab);
        var L0 = lab[0], A0 = lab[1], B0 = lab[2];
        var Ln = L0 / 100;
        var bell = Math.sin(clamp(Ln, 0, 1) * Math.PI);

        // 색 노이즈 정리: 주변 평균 색 쪽으로 (경계선의 큰 색 차이는 그대로)
        if (nr > 0.001) {
          var la = lowA[i00] * w00 + lowA[i01] * w01 + lowA[i10] * w10 + lowA[i11] * w11;
          var lb = lowB[i00] * w00 + lowB[i01] * w01 + lowB[i10] * w10 + lowB[i11] * w11;
          var dev = Math.abs(A0 - la) + Math.abs(B0 - lb);
          var kn = nr * 0.8 * (1 - 0.5 * Ln) * (1 - smoothstep(6, 16, dev));
          A0 += (la - A0) * kn; B0 += (lb - B0) * kn;
        }
        var ch = Math.sqrt(A0 * A0 + B0 * B0);

        var L = 100 * (Ln + mid * 6.75 * Ln * Ln * (1 - Ln));           // 밝은 중간톤 올리기
        if (shadows > 0.001) L += shadows * 70 * Ln * Math.pow(1 - Ln, 2.5); // 암부 복원
        if (contrast !== 0) L += contrast * 100 * (Ln * Ln * (3 - 2 * Ln) - Ln); // 대비 S곡선
        L += clar * (1 - m * (1 - cSkin)) * (L0 - lo) * bell;            // 윤곽 대비
        L += m * dL * bell;                                               // 얼굴 밝게
        L = (L - blackPt) * bpScale;                                      // 검정은 검정답게

        var A = A0 + m * dA;
        var B = B0 + m * dB - 0.5 * m * dA;
        var vb = 1 + vib * (1 - clamp(ch / 50, 0, 1)) * (1 - 0.6 * m);
        A *= vb; B *= vb;
        labToLin(clamp(L, 0, 100), clamp(A, -128, 127), clamp(B, -128, 127), rgb);
        px[q] = TO_GAM[((rgb[0] < 0 ? 0 : rgb[0] > 1 ? 1 : rgb[0]) * GAM_N + 0.5) | 0];
        px[q + 1] = TO_GAM[((rgb[1] < 0 ? 0 : rgb[1] > 1 ? 1 : rgb[1]) * GAM_N + 0.5) | 0];
        px[q + 2] = TO_GAM[((rgb[2] < 0 ? 0 : rgb[2] > 1 ? 1 : rgb[2]) * GAM_N + 0.5) | 0];
        px[q + 3] = 255;
      }
    }
  }

  // 반경은 사진 크기에 비례 → 미리보기와 저장본이 같은 느낌
  function sharpenRadius(fullW) { var s = clamp(fullW / 1512, 0.8, 2.2); return { sigma: s, r: Math.ceil(s * 2.5) }; }

  function sharpenTile(px, w, h, skinW, amount, fullW) {
    if (amount <= 0.001) return;
    var n = w * h, gray = new Uint8Array(n), tmp = new Uint8Array(n), i, q, x, yy, k;
    for (i = 0, q = 0; i < n; i++, q += 4) gray[i] = (px[q] * 77 + px[q + 1] * 150 + px[q + 2] * 29) >> 8;
    var sr = sharpenRadius(fullW), sigma = sr.sigma, r = sr.r, kern = new Float32Array(2 * r + 1), ks = 0;
    for (k = -r; k <= r; k++) { kern[k + r] = Math.exp(-(k * k) / (2 * sigma * sigma)); ks += kern[k + r]; }
    for (k = 0; k < kern.length; k++) kern[k] /= ks;
    for (yy = 0; yy < h; yy++) {
      var o = yy * w;
      for (x = 0; x < w; x++) { var v = 0; for (k = -r; k <= r; k++) v += gray[o + clamp(x + k, 0, w - 1)] * kern[k + r]; tmp[o + x] = v + 0.5; }
    }
    var thr = 1.5, cap = 24, skinK = 1 - BASE.sharpenSkin;
    for (yy = 0; yy < h; yy++) {
      for (x = 0; x < w; x++) {
        var blur = 0; for (k = -r; k <= r; k++) blur += tmp[clamp(yy + k, 0, h - 1) * w + x] * kern[k + r];
        var j = yy * w + x, d = gray[j] - blur, ad = d < 0 ? -d : d;
        if (ad < thr) continue;
        d = (d < 0 ? -1 : 1) * Math.min(ad - thr, cap);
        var add = d * amount * (1 - (skinW ? skinW[j] / 255 : 0) * skinK);
        q = j * 4; px[q] += add; px[q + 1] += add; px[q + 2] += add;
      }
    }
  }

  /* ------------------------------------------------------------ 렌더 */
  function makeCanvas(w, h) { var c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
  function ctx2d(c, colorSpace, read) {
    var opt = { colorSpace: colorSpace || 'srgb' };
    if (read) opt.willReadFrequently = true;
    return c.getContext('2d', opt);
  }

  /**
   * src(이미지)를 w×h 크기로 보정해서 dstCanvas에 그려요. 조각(타일)으로 나눠 메모리를 아껴요.
   * opts: { colorSpace, tileH, onProgress(done,total), shouldCancel(), yieldEvery }
   * 반환: Promise<boolean> (취소되면 false)
   */
  async function render(src, dstCanvas, w, h, an, p, opts) {
    opts = opts || {};
    if (opts.pool && opts.pool.size > 0) {
      try { return await renderParallel(src, dstCanvas, w, h, an, p, opts); }
      catch (e) { console.warn('parallel render failed, using single thread', e); opts.pool.broken = true; }
    }
    var cs = opts.colorSpace || 'srgb';
    var sw = src.naturalWidth || src.width, shh = src.naturalHeight || src.height;
    dstCanvas.width = w; dstCanvas.height = h;
    var dctx = ctx2d(dstCanvas, cs);
    var pad = sharpenRadius(w).r + 2;
    var tileH = opts.tileH || Math.max(64, Math.min(512, Math.round(3000000 / w)));
    var tiles = Math.ceil(h / tileH);
    var tile = makeCanvas(w, tileH + pad * 2);
    var tctx = ctx2d(tile, cs, true);
    tctx.imageSmoothingEnabled = true; tctx.imageSmoothingQuality = 'high';
    var sy = shh / h, amount = BASE.sharpen * (p.detail / 0.5);
    for (var t = 0; t < tiles; t++) {
      if (opts.shouldCancel && opts.shouldCancel()) return false;
      var y0 = t * tileH, rows = Math.min(tileH, h - y0);
      var top = Math.max(0, y0 - pad), bottom = Math.min(h, y0 + rows + pad), th = bottom - top;
      tctx.clearRect(0, 0, w, tile.height);
      tctx.drawImage(src, 0, top * sy, sw, th * sy, 0, 0, w, th);
      var img = tctx.getImageData(0, 0, w, th, { colorSpace: cs });
      var skinW = new Uint8Array(w * th);
      toneTile(img.data, w, th, top, w, h, an, p, skinW);
      sharpenTile(img.data, w, th, skinW, amount, w);
      tctx.putImageData(img, 0, 0);
      dctx.drawImage(tile, 0, y0 - top, w, rows, 0, y0, w, rows);
      if (opts.onProgress) opts.onProgress(t + 1, tiles);
      if (opts.yieldEvery && (t + 1) % opts.yieldEvery === 0) await new Promise(function (res) { setTimeout(res, 0); });
    }
    return true;
  }

  /* ------------------------------------------------------------ 여러 일꾼으로 나눠 처리 */
  /**
   * 일꾼(Web Worker) 묶음. 아이폰 14 Pro는 동시에 6가지 일을 할 수 있어서 3~4개를 써요.
   */
  function WorkerPool(url, size) {
    this.workers = []; this.idle = []; this.waiting = []; this.handlers = {}; this.seq = 0; this.size = 0; this.broken = false;
    for (var i = 0; i < size; i++) {
      var wk;
      try { wk = new Worker(url); } catch (e) { break; }
      wk.onmessage = this._onMessage.bind(this, wk);
      wk.onerror = this._onError.bind(this, wk);
      this.workers.push(wk); this.idle.push(wk);
    }
    this.size = this.workers.length;
  }
  WorkerPool.prototype._onMessage = function (wk, e) {
    var h = this.handlers[e.data.id];
    if (!h) return;
    delete this.handlers[e.data.id];
    this._release(wk);
    if (e.data.type === 'error') h.reject(new Error(e.data.message)); else h.resolve(e.data);
  };
  WorkerPool.prototype._onError = function (wk, e) {
    this.broken = true;
    for (var id in this.handlers) { if (this.handlers[id].worker === wk) { this.handlers[id].reject(new Error('worker-error: ' + (e && e.message))); delete this.handlers[id]; } }
  };
  WorkerPool.prototype._release = function (wk) {
    var next = this.waiting.shift();
    if (next) next(wk); else this.idle.push(wk);
  };
  WorkerPool.prototype._acquire = function () {
    var self = this;
    if (this.idle.length) return Promise.resolve(this.idle.shift());
    return new Promise(function (res) { self.waiting.push(res); });
  };
  WorkerPool.prototype._send = function (wk, msg, transfer) {
    var self = this, id = ++this.seq;
    msg.id = id;
    return new Promise(function (resolve, reject) {
      self.handlers[id] = { resolve: resolve, reject: reject, worker: wk };
      wk.postMessage(msg, transfer || []);
    });
  };
  // 모든 일꾼에게 이번 사진의 분석 결과·설정을 한 번씩 보내요
  WorkerPool.prototype.setup = function (an, p) {
    var self = this, plainAn = {}, k;
    for (k in an) plainAn[k] = an[k];
    return Promise.all(this.workers.map(function (wk) {
      var at = self.idle.indexOf(wk);
      if (at >= 0) self.idle.splice(at, 1);
      return self._send(wk, { type: 'setup', an: plainAn, p: p });
    }));
  };
  WorkerPool.prototype.tile = function (job) {
    var self = this;
    return this._acquire().then(function (wk) { return self._send(wk, job, [job.buf]); });
  };

  // 한 번에 한 작업만 일꾼들을 쓰도록 줄 세우기
  async function renderParallel(src, dstCanvas, w, h, an, p, opts) {
    var pool = opts.pool, release, prev = pool._lock || Promise.resolve();
    pool._lock = new Promise(function (r) { release = r; });
    try { await prev; return await renderParallelLocked(src, dstCanvas, w, h, an, p, opts); }
    finally { release(); }
  }
  async function renderParallelLocked(src, dstCanvas, w, h, an, p, opts) {
    var pool = opts.pool, cs = opts.colorSpace || 'srgb';
    var sw = src.naturalWidth || src.width, shh = src.naturalHeight || src.height;
    dstCanvas.width = w; dstCanvas.height = h;
    var dctx = ctx2d(dstCanvas, cs);
    var pad = sharpenRadius(w).r + 2;
    var tileH = Math.max(48, Math.min(384, Math.round(1200000 / w)));
    var tiles = Math.ceil(h / tileH);
    var tile = makeCanvas(w, tileH + pad * 2);
    var tctx = ctx2d(tile, cs, true);
    tctx.imageSmoothingEnabled = true; tctx.imageSmoothingQuality = 'high';
    var sy = shh / h, amount = BASE.sharpen * (p.detail / 0.5);
    await pool.setup(an, p);
    var inflight = [], done = 0, cancelled = false, failure = null;
    for (var t = 0; t < tiles; t++) {
      if (opts.shouldCancel && opts.shouldCancel()) { cancelled = true; break; }
      if (failure) break;
      // 일꾼 수보다 조금 더 많이 미리 보내 두고, 하나 끝나면 다음 조각
      while (inflight.length >= pool.size + 1) await Promise.race(inflight);
      var y0 = t * tileH, rows = Math.min(tileH, h - y0);
      var top = Math.max(0, y0 - pad), bottom = Math.min(h, y0 + rows + pad), th = bottom - top;
      tctx.clearRect(0, 0, w, tile.height);
      tctx.drawImage(src, 0, top * sy, sw, th * sy, 0, 0, w, th);
      var buf = tctx.getImageData(0, 0, w, th, { colorSpace: cs }).data.buffer;
      (function (y0, rows, top, th, buf) {
        var job = pool.tile({ type: 'tile', buf: buf, w: w, th: th, top: top, fullW: w, fullH: h, amount: amount })
          .then(function (res) {
            var img = new ImageData(new Uint8ClampedArray(res.buf), w, th, { colorSpace: cs });
            dctx.putImageData(img, 0, top, 0, y0 - top, w, rows);  // 가장자리 여백은 빼고 가운데 줄만
            done++;
            if (opts.onProgress) opts.onProgress(done, tiles);
          }, function (err) { failure = err; });
        var tracked = job.then(function () { inflight.splice(inflight.indexOf(tracked), 1); });
        inflight.push(tracked);
      })(y0, rows, top, th, buf);
      await new Promise(function (res) { setTimeout(res, 0); });  // 화면이 멈추지 않게 잠깐 쉬기
    }
    await Promise.all(inflight);
    tile.width = tile.height = 0;
    if (failure) throw failure;
    return !cancelled;
  }

  /* 작은 사본 만들기 (분석용) */
  function sampleSmall(src, maxSide, colorSpace) {
    var sw = src.naturalWidth || src.width, sh = src.naturalHeight || src.height;
    var s = Math.min(1, maxSide / Math.max(sw, sh));
    var w = Math.max(1, Math.round(sw * s)), h = Math.max(1, Math.round(sh * s));
    var c = makeCanvas(w, h), x = ctx2d(c, colorSpace, true);
    x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high';
    x.drawImage(src, 0, 0, w, h);
    var d = x.getImageData(0, 0, w, h, { colorSpace: colorSpace || 'srgb' });
    c.width = c.height = 0;
    return { data: d.data, w: w, h: h };
  }

  var api = {
    BASE: BASE, PRESETS: PRESETS, PRESET_ORDER: PRESET_ORDER, SLIDERS: SLIDERS,
    paramsFromPreset: paramsFromPreset, analyze: analyze, toneTile: toneTile, sharpenTile: sharpenTile,
    render: render, sampleSmall: sampleSmall, WorkerPool: WorkerPool
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.P18Engine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
