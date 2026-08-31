// ESC/APE — src/game/audio.js (A3 core-audio)
// WebAudio 합성 사운드 싱글턴. 외부 오디오 파일 0 — 전부 오실레이터/노이즈 즉석 합성.
// 게임 내 VOLUME 슬라이더 = 실제 마스터 볼륨. 설정과 세계가 같은 값을 공유한다는 것을 소리로 증명한다.
// 음질보다 안정성: 모든 public 메서드는 try/catch — 오디오가 죽어도 게임은 죽지 않는다.

import { store, effective } from './settingsStore.js';

// ---------------------------------------------------------------------------
// internal state
// ---------------------------------------------------------------------------

let ctx = null;          // AudioContext (init()에서 생성)
let master = null;       // 마스터 게인 — 모든 소리가 여기로 모인다
let limiter = null;      // 합성음 클리핑 방지용 컴프레서
let sfxBus = null;       // 효과음 버스
let musicBus = null;     // 앰비언트/음악 버스
let noiseBuf = null;     // 공유 화이트노이즈 버퍼
let crushCurve = null;   // 비트크러시 느낌 웨이브셰이퍼 커브 (erase용)
let unsupported = false; // AudioContext 미지원 플래그
let pendingStage = null; // init 이전에 setStage가 불렸을 때 기억

// 룩어헤드 뮤직 스케줄러 상태
let music = null;        // { key, def, gain, nextTime, step }
let schedTimer = null;
const SCHED_INTERVAL_MS = 250; // setInterval 주기
const SCHED_AHEAD = 0.1;       // 매 tick마다 (interval + 0.1s)까지 선행 스케줄
const CROSSFADE = 1.15;        // 루프 교체 크로스페이드 (초)
const MUSIC_LEVEL = 0.8;

const lastSfxAt = {};          // sfx 스팸 방지 (같은 이름 최소 간격)

// ---------------------------------------------------------------------------
// bootstrap helpers
// ---------------------------------------------------------------------------

function createContext() {
  const AC = (typeof window !== 'undefined') && (window.AudioContext || window.webkitAudioContext);
  if (!AC) { unsupported = true; return; }
  ctx = new AC();

  master = ctx.createGain();
  master.gain.value = volumeGain();

  limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -14;
  limiter.knee.value = 22;
  limiter.ratio.value = 9;
  limiter.attack.value = 0.004;
  limiter.release.value = 0.24;

  sfxBus = ctx.createGain();
  sfxBus.gain.value = 1.0;
  musicBus = ctx.createGain();
  musicBus.gain.value = MUSIC_LEVEL;

  sfxBus.connect(master);
  musicBus.connect(master);
  master.connect(limiter);
  limiter.connect(ctx.destination);

  // 2초 화이트노이즈 버퍼 (모든 노이즈 소리가 공유)
  const len = Math.floor(ctx.sampleRate * 2);
  noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = noiseBuf.getChannelData(0);
  for (let i = 0; i < len; i += 1) data[i] = Math.random() * 2 - 1;

  // 계단형 커브 = 저해상도 양자화 느낌 (erase 글리치)
  const N = 257;
  crushCurve = new Float32Array(N);
  const steps = 7;
  for (let i = 0; i < N; i += 1) {
    const x = (i / (N - 1)) * 2 - 1;
    crushCurve[i] = Math.round(x * steps) / steps;
  }

  // settingsStore 구독 — VOLUME 슬라이더가 곧 마스터 볼륨
  try {
    store.subscribe((ev) => {
      try {
        if (!ev || ev.key === 'volume' || ev.type === 'reset') applyVolume();
      } catch (e) { /* noop */ }
    });
  } catch (e) { /* store가 없어도 오디오는 산다 */ }
  applyVolume();
}

function volumeGain() {
  let v = 70;
  try { v = Number(effective('volume')); } catch (e) { /* noop */ }
  if (!Number.isFinite(v)) v = 70;
  v = Math.min(100, Math.max(0, v));
  return Math.pow(v / 100, 1.5); // 지각 볼륨 커브 — 0이면 완전 무음 (감시자 취침 연출과 일치)
}

function applyVolume() {
  if (!ctx || !master) return;
  master.gain.setTargetAtTime(volumeGain(), ctx.currentTime, 0.08);
}

function ensureRunning() {
  if (!ctx) return false;
  if (ctx.state === 'suspended') {
    const p = ctx.resume();
    if (p && p.catch) p.catch(() => {});
  }
  return ctx.state !== 'closed';
}

function midi(n) { return 440 * Math.pow(2, (n - 69) / 12); }

// ---------------------------------------------------------------------------
// synth voice helpers (내부 — 호출부가 ctx 존재를 보장)
// ---------------------------------------------------------------------------

// 오실레이터 + 게인 엔벨로프 단음
function tone(t, opts) {
  const o = opts || {};
  const type = o.type || 'sine';
  const freq = o.freq || 440;
  const to = o.to || null;              // 피치 슬라이드 목표
  const dur = o.dur != null ? o.dur : 0.2;
  const vol = o.vol != null ? o.vol : 0.12;
  const attack = o.attack != null ? o.attack : 0.005;
  const detune = o.detune || 0;
  const dest = o.dest || sfxBus;

  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(Math.max(1, freq), t);
  if (to) osc.frequency.exponentialRampToValueAtTime(Math.max(1, to), t + dur);
  if (detune) osc.detune.setValueAtTime(detune, t);

  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(vol, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);

  let node = osc;
  if (o.filter) { // { type, freq, to, Q }
    const f = ctx.createBiquadFilter();
    f.type = o.filter.type || 'lowpass';
    f.frequency.setValueAtTime(o.filter.freq || 1200, t);
    if (o.filter.to) f.frequency.exponentialRampToValueAtTime(Math.max(20, o.filter.to), t + dur);
    if (o.filter.Q) f.Q.value = o.filter.Q;
    osc.connect(f);
    node = f;
  }
  node.connect(g);
  g.connect(dest);
  osc.start(t);
  osc.stop(t + dur + 0.08);
  osc.onended = () => { try { g.disconnect(); } catch (e) { /* noop */ } };
  return osc;
}

// 필터 통과 화이트노이즈 버스트
function noise(t, opts) {
  const o = opts || {};
  const dur = o.dur != null ? o.dur : 0.2;
  const vol = o.vol != null ? o.vol : 0.2;
  const attack = o.attack != null ? o.attack : 0.003;
  const dest = o.dest || sfxBus;

  const src = ctx.createBufferSource();
  src.buffer = noiseBuf;
  src.loop = true;

  const f = ctx.createBiquadFilter();
  f.type = o.type || 'lowpass';
  f.frequency.setValueAtTime(o.freq || 1000, t);
  if (o.to) f.frequency.exponentialRampToValueAtTime(Math.max(20, o.to), t + dur);
  f.Q.value = o.Q != null ? o.Q : 0.8;

  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(vol, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);

  src.connect(f);
  f.connect(g);
  g.connect(dest);
  src.start(t, Math.random() * 1.2);
  src.stop(t + dur + 0.08);
  src.onended = () => { try { g.disconnect(); } catch (e) { /* noop */ } };
  return src;
}

// ---------------------------------------------------------------------------
// SFX — 13종, 각자 다른 표정
// ---------------------------------------------------------------------------

const SFX = {
  // 가볍게 차오르는 도약음
  jump(t) {
    tone(t, { type: 'triangle', freq: 310, to: 640, dur: 0.14, vol: 0.11, attack: 0.004 });
    tone(t, { type: 'square', freq: 620, to: 1180, dur: 0.09, vol: 0.028 });
  },

  // 짧고 둔탁한 착지
  land(t) {
    tone(t, { type: 'sine', freq: 165, to: 62, dur: 0.11, vol: 0.16 });
    noise(t, { type: 'lowpass', freq: 420, to: 140, dur: 0.06, vol: 0.09 });
  },

  // 하강 소우투스 + 노이즈 임팩트 — 세계가 꺼지는 소리
  death(t) {
    tone(t, { type: 'sawtooth', freq: 390, to: 42, dur: 0.62, vol: 0.13,
      filter: { type: 'lowpass', freq: 2400, to: 180, Q: 1.5 } });
    tone(t, { type: 'sawtooth', freq: 398, to: 45, dur: 0.62, vol: 0.1, detune: -18,
      filter: { type: 'lowpass', freq: 2000, to: 160, Q: 1.2 } });
    noise(t, { type: 'lowpass', freq: 900, to: 90, dur: 0.34, vol: 0.3 });
    tone(t + 0.02, { type: 'sine', freq: 96, to: 34, dur: 0.5, vol: 0.24 });
  },

  // 비트크러시 글리치 — 단어가 지워지는 소리
  erase(t) {
    const shaper = ctx.createWaveShaper();
    shaper.curve = crushCurve;
    const bus = ctx.createGain();
    bus.gain.value = 1;
    shaper.connect(bus);
    bus.connect(sfxBus);
    setTimeout(() => { try { bus.disconnect(); } catch (e) { /* noop */ } }, 900);

    // 잘게 쪼개진 스퀘어 블립들 — 데이터가 부서지는 느낌
    for (let i = 0; i < 8; i += 1) {
      const bt = t + i * 0.042 + Math.random() * 0.012;
      const f = 170 + Math.random() * 2100;
      tone(bt, { type: 'square', freq: f, to: f * (0.4 + Math.random() * 1.4),
        dur: 0.028 + Math.random() * 0.03, vol: 0.05, attack: 0.001, dest: shaper });
    }
    // 뭉개진 하강 스윕 + 지지직 크래클
    tone(t, { type: 'sawtooth', freq: 880, to: 130, dur: 0.4, vol: 0.055, dest: shaper });
    noise(t, { type: 'highpass', freq: 1500, dur: 0.36, vol: 0.05, Q: 1.4 });
  },

  // 상승 아르페지오 — 권한 획득
  unlock(t) {
    const seq = [60, 64, 67, 72, 76];
    for (let i = 0; i < seq.length; i += 1) {
      const nt = t + i * 0.075;
      tone(nt, { type: 'square', freq: midi(seq[i]), dur: 0.16, vol: 0.05, attack: 0.004 });
      tone(nt, { type: 'sine', freq: midi(seq[i] + 12), dur: 0.2, vol: 0.035 });
    }
    // 밑에서 받쳐주는 부드러운 스웰
    tone(t, { type: 'sawtooth', freq: midi(48), dur: 0.7, vol: 0.05, attack: 0.18,
      filter: { type: 'lowpass', freq: 900, Q: 0.7 } });
    tone(t + 0.38, { type: 'triangle', freq: midi(84), dur: 0.34, vol: 0.045 });
  },

  // 미세한 UI 틱
  ui(t) {
    tone(t, { type: 'square', freq: 720, dur: 0.035, vol: 0.05, attack: 0.001 });
    tone(t + 0.03, { type: 'square', freq: 1060, dur: 0.03, vol: 0.032, attack: 0.001 });
  },

  // 반짝이는 수집음
  collect(t) {
    tone(t, { type: 'sine', freq: 880, dur: 0.09, vol: 0.09, attack: 0.002 });
    tone(t + 0.07, { type: 'sine', freq: 1318, dur: 0.12, vol: 0.08, attack: 0.002 });
    tone(t + 0.13, { type: 'triangle', freq: 1760, dur: 0.16, vol: 0.045 });
  },

  // 금속성 차단음 — 패널 방패
  shield(t) {
    tone(t, { type: 'square', freq: 196, dur: 0.13, vol: 0.09, attack: 0.001 });
    tone(t, { type: 'square', freq: 289, dur: 0.11, vol: 0.06, attack: 0.001, detune: 14 });
    tone(t, { type: 'sine', freq: 520, to: 190, dur: 0.12, vol: 0.08 });
    noise(t, { type: 'bandpass', freq: 1900, dur: 0.1, vol: 0.11, Q: 7 });
  },

  // 음파탄 발사 — 내리꽂는 재프
  shot(t) {
    tone(t, { type: 'sawtooth', freq: 940, to: 170, dur: 0.19, vol: 0.085,
      filter: { type: 'lowpass', freq: 3200, to: 500, Q: 2 } });
    tone(t, { type: 'square', freq: 470, to: 90, dur: 0.16, vol: 0.05 });
    noise(t, { type: 'highpass', freq: 2400, dur: 0.06, vol: 0.035 });
  },

  // 바람을 가르는 대시
  dash(t) {
    noise(t, { type: 'bandpass', freq: 340, to: 2600, dur: 0.22, vol: 0.16, Q: 1.3, attack: 0.008 });
    tone(t, { type: 'triangle', freq: 210, to: 540, dur: 0.18, vol: 0.05 });
  },

  // 짧은 승리 모티프
  win(t) {
    const mel = [[67, 0.0], [72, 0.13], [76, 0.26], [79, 0.45]];
    for (let i = 0; i < mel.length; i += 1) {
      const nt = t + mel[i][1];
      const last = i === mel.length - 1;
      tone(nt, { type: 'triangle', freq: midi(mel[i][0]), dur: last ? 0.7 : 0.18, vol: 0.09, attack: 0.004 });
      tone(nt, { type: 'square', freq: midi(mel[i][0] - 12), dur: last ? 0.6 : 0.14, vol: 0.03 });
    }
    // 마지막 화음 (C major) — 따뜻하게
    const chord = [72, 76, 79];
    for (let i = 0; i < chord.length; i += 1) {
      tone(t + 0.45, { type: 'sine', freq: midi(chord[i]), dur: 0.8, vol: 0.04, attack: 0.03 });
    }
  },

  // 낮게 우르릉 — 보스 등장/지진
  rumble(t) {
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.28, t + 0.06);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.85);
    g.connect(sfxBus);

    const sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(43, t);
    sub.frequency.linearRampToValueAtTime(34, t + 0.85);
    // 6.5Hz 진폭 흔들림 — 진짜 진동처럼
    const lfo = ctx.createOscillator();
    const lfoAmt = ctx.createGain();
    lfo.type = 'sine';
    lfo.frequency.value = 6.5;
    lfoAmt.gain.value = 0.35;
    lfo.connect(lfoAmt);
    lfoAmt.connect(g.gain);
    sub.connect(g);
    sub.start(t); sub.stop(t + 0.95);
    lfo.start(t); lfo.stop(t + 0.95);
    sub.onended = () => { try { g.disconnect(); } catch (e) { /* noop */ } };

    noise(t, { type: 'lowpass', freq: 140, dur: 0.8, vol: 0.22, attack: 0.05, Q: 0.6 });
  },

  // 타자기 틱 — 시스템 텍스트 타이핑
  type(t) {
    noise(t, { type: 'highpass', freq: 2600, dur: 0.025, vol: 0.045, Q: 1 });
    tone(t, { type: 'square', freq: 1050 + Math.random() * 550, dur: 0.02, vol: 0.028, attack: 0.001 });
  },
};

// ---------------------------------------------------------------------------
// 스테이지 앰비언트 — 룩어헤드 스케줄러가 재생하는 짧은 시퀀스 루프
// 각 def: { step: 스텝 길이(초), level: 루프 게인, schedule(t, i, out) }
// ---------------------------------------------------------------------------

// 뮤직 보이스는 항상 out(스테이지 게인)으로 — 크로스페이드가 걸리는 지점
function mtone(t, o, out) { tone(t, Object.assign({}, o, { dest: out })); }
function mnoise(t, o, out) { noise(t, Object.assign({}, o, { dest: out })); }

const STAGES = {
  // 낮고 불안한 드론 + 가끔 물방울음
  stage0: {
    step: 1.0,
    level: 1.0,
    schedule(t, i, out) {
      if (i % 4 === 0) {
        // 두 개의 미세하게 어긋난 저음 — 느리게 숨쉬는 어둠
        mtone(t, { type: 'sawtooth', freq: midi(33), dur: 4.6, vol: 0.05, attack: 1.4,
          filter: { type: 'lowpass', freq: 210, Q: 0.9 } }, out);
        mtone(t, { type: 'sawtooth', freq: midi(33) * 1.011, dur: 4.6, vol: 0.04, attack: 1.7,
          filter: { type: 'lowpass', freq: 170, Q: 0.9 } }, out);
      }
      if (i % 8 === 4) {
        // 반음 위 그림자 — 불안
        mtone(t, { type: 'sine', freq: midi(34), dur: 3.2, vol: 0.02, attack: 1.2 }, out);
      }
      if (Math.random() < 0.16) {
        // 어딘가에서 떨어지는 물방울 (+ 희미한 메아리)
        const f = 900 + Math.random() * 900;
        const dt = Math.random() * 0.5;
        mtone(t + dt, { type: 'sine', freq: f, to: f * 0.45, dur: 0.16, vol: 0.045, attack: 0.002 }, out);
        mtone(t + dt + 0.21, { type: 'sine', freq: f * 0.92, to: f * 0.4, dur: 0.2, vol: 0.018, attack: 0.003 }, out);
      }
    },
  },

  // 조심스러운 미니멀 아르페지오 — 발소리를 죽인 정원
  stage1: {
    step: 0.31,
    level: 0.9,
    schedule(t, i, out) {
      const pat = [57, null, null, 60, null, 62, null, null, 64, null, null, 62, null, 60, null, null];
      const n = pat[i % pat.length];
      if (n != null && Math.random() < 0.9) {
        mtone(t, { type: 'triangle', freq: midi(n), dur: 0.24, vol: 0.075, attack: 0.004 }, out);
      }
      if (i % 16 === 0) {
        mtone(t, { type: 'sine', freq: midi(45), dur: 3.4, vol: 0.055, attack: 0.4 }, out);
      }
      if (i % 32 === 24) {
        // 아주 가끔 높은 곳의 경계음
        mtone(t, { type: 'sine', freq: midi(76), dur: 0.7, vol: 0.02, attack: 0.06 }, out);
      }
    },
  },

  // 넓은 패드 + 공허한 5도 — 프레임 밖의 공허
  stage2: {
    step: 2.4,
    level: 1.0,
    schedule(t, i, out) {
      const roots = [38, 36, 33, 41];
      const r = roots[i % roots.length];
      // 3도가 빠진 5도 화음 — 비어 있는 세계
      mtone(t, { type: 'sine', freq: midi(r), dur: 3.4, vol: 0.06, attack: 1.1 }, out);
      mtone(t, { type: 'sine', freq: midi(r + 7), dur: 3.4, vol: 0.05, attack: 1.3 }, out);
      mtone(t, { type: 'triangle', freq: midi(r + 12), dur: 3.2, vol: 0.028, attack: 1.5 }, out);
      if (Math.random() < 0.35) {
        mnoise(t + Math.random() * 0.8, { type: 'bandpass', freq: 800 + Math.random() * 1400,
          dur: 1.8, vol: 0.012, Q: 3, attack: 0.8 }, out);
      }
    },
  },

  // 긴박한 저음 펄스 + 불협화 — SYS_ADMIN
  boss: {
    step: 0.21,
    level: 0.95,
    schedule(t, i, out) {
      const bass = [31, 31, null, 31, 31, null, 31, 34];
      const b = bass[i % bass.length];
      if (b != null) {
        mtone(t, { type: 'square', freq: midi(b), dur: 0.13, vol: 0.085, attack: 0.002,
          filter: { type: 'lowpass', freq: 500, Q: 1.2 } }, out);
      }
      if (i % 16 === 12) {
        // 트라이톤 스탭 — 시스템의 경고
        mtone(t, { type: 'sawtooth', freq: midi(65), dur: 0.3, vol: 0.04, attack: 0.004,
          filter: { type: 'lowpass', freq: 2200, Q: 1 } }, out);
        mtone(t, { type: 'sawtooth', freq: midi(71), dur: 0.3, vol: 0.04, attack: 0.004,
          filter: { type: 'lowpass', freq: 2200, Q: 1 } }, out);
      }
      if (i % 32 === 0) {
        // 위에서 조여오는 단2도 클러스터
        mtone(t, { type: 'sine', freq: midi(81), dur: 3.0, vol: 0.014, attack: 0.9 }, out);
        mtone(t, { type: 'sine', freq: midi(82), dur: 3.0, vol: 0.014, attack: 1.1 }, out);
      }
    },
  },

  // 거의 침묵 + 심장박동 저음 — 실패 공간
  deathspace: {
    step: 1.9,
    level: 1.0,
    schedule(t, i, out) {
      // lub — dub, 그리고 긴 침묵
      mtone(t, { type: 'sine', freq: 62, to: 38, dur: 0.17, vol: 0.15, attack: 0.006 }, out);
      mtone(t + 0.3, { type: 'sine', freq: 55, to: 36, dur: 0.15, vol: 0.1, attack: 0.006 }, out);
      if (i % 4 === 2) {
        // 아득한 공기 — 있는 듯 없는 듯
        mnoise(t, { type: 'lowpass', freq: 220, dur: 1.7, vol: 0.008, attack: 0.8, Q: 0.5 }, out);
      }
    },
  },

  // 따뜻한 장조 모티프 — 집으로
  ending: {
    step: 0.35,
    level: 0.95,
    schedule(t, i, out) {
      const mel = [72, null, 76, null, 79, null, 76, null, 74, null, 72, null, 71, null, 72, null];
      const n = mel[i % mel.length];
      if (n != null) {
        mtone(t, { type: 'triangle', freq: midi(n), dur: 0.42, vol: 0.07, attack: 0.01 }, out);
        mtone(t, { type: 'sine', freq: midi(n + 12), dur: 0.3, vol: 0.018, attack: 0.01 }, out);
      }
      if (i % 16 === 0) {
        const chords = [[48, 55, 64], [41, 48, 57]];
        const c = chords[Math.floor(i / 16) % chords.length];
        for (let k = 0; k < c.length; k += 1) {
          mtone(t, { type: 'sine', freq: midi(c[k]), dur: 5.6, vol: 0.035, attack: 1.6 }, out);
        }
      }
    },
  },
};

// ---------------------------------------------------------------------------
// music scheduler
// ---------------------------------------------------------------------------

function schedulerTick() {
  if (!ctx || !music) return;
  const now = ctx.currentTime;
  // 탭 백그라운드 스로틀 등으로 크게 뒤처졌으면 놓친 스텝은 버리고 재정렬
  if (music.nextTime < now - 0.3) {
    music.nextTime = now + 0.05;
  }
  const horizon = now + SCHED_INTERVAL_MS / 1000 + SCHED_AHEAD;
  while (music.nextTime < horizon) {
    try {
      music.def.schedule(music.nextTime, music.step, music.gain);
    } catch (e) { /* 한 스텝 실패해도 루프는 계속 */ }
    music.nextTime += music.def.step;
    music.step += 1;
  }
}

function startScheduler() {
  if (schedTimer == null) schedTimer = setInterval(schedulerTick, SCHED_INTERVAL_MS);
}

function stopScheduler() {
  if (schedTimer != null) { clearInterval(schedTimer); schedTimer = null; }
}

function fadeOutCurrent() {
  if (!music) return;
  const old = music.gain;
  const now = ctx.currentTime;
  try {
    old.gain.cancelScheduledValues(now);
    old.gain.setValueAtTime(old.gain.value, now);
    old.gain.linearRampToValueAtTime(0.0001, now + CROSSFADE);
  } catch (e) { /* noop */ }
  setTimeout(() => { try { old.disconnect(); } catch (e) { /* noop */ } }, (CROSSFADE + 0.4) * 1000);
  music = null;
}

function setStageInternal(key) {
  if (!ctx) { pendingStage = key; return; }
  if (!key || !STAGES[key]) { // null 또는 미지의 키 → 정지
    fadeOutCurrent();
    stopScheduler();
    return;
  }
  if (music && music.key === key) return; // 같은 스테이지면 그대로 유지

  const def = STAGES[key];
  const now = ctx.currentTime;

  fadeOutCurrent(); // 이전 루프는 페이드아웃 (이미 스케줄된 꼬리도 함께 잦아든다)

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.linearRampToValueAtTime(def.level, now + CROSSFADE);
  gain.connect(musicBus);

  music = { key, def, gain, nextTime: now + 0.06, step: 0 };
  startScheduler();
  schedulerTick(); // 첫 노트는 즉시 선행 스케줄
}

// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------

export const audio = {
  // 최초 사용자 제스처(시작 버튼)에서 호출. 여러 번 불러도 안전.
  init() {
    try {
      if (unsupported) return;
      if (!ctx) createContext();
      if (!ctx) return;
      ensureRunning();
      applyVolume();
      if (pendingStage) {
        const key = pendingStage;
        pendingStage = null;
        setStageInternal(key);
      }
    } catch (e) {
      unsupported = true; // 초기화 실패 → 이후 전부 무해한 no-op
    }
  },

  // 'jump','land','death','erase','unlock','ui','collect','shield','shot','dash','win','rumble','type'
  sfx(name) {
    try {
      if (!ctx || !SFX[name]) return;
      if (!ensureRunning()) return;
      const now = ctx.currentTime;
      // 같은 소리 초고속 연타 방지 (프레임당 다중 호출 보호)
      if (lastSfxAt[name] != null && now - lastSfxAt[name] < 0.03) return;
      lastSfxAt[name] = now;
      SFX[name](now + 0.001);
    } catch (e) { /* 소리 하나 실패해도 게임은 계속 */ }
  },

  // 'stage0'|'stage1'|'stage2'|'boss'|'deathspace'|'ending'|null
  setStage(key) {
    try {
      if (!ctx) { pendingStage = key; return; }
      ensureRunning();
      setStageInternal(key);
    } catch (e) { /* noop */ }
  },

  stopMusic() {
    try {
      pendingStage = null;
      if (!ctx) return;
      fadeOutCurrent();
      stopScheduler();
    } catch (e) { /* noop */ }
  },
};
