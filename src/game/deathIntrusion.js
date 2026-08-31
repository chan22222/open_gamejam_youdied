// ESC/APE — deathIntrusion (C 코어 · PATCH2 1절)
// 사망 반전: 죽어도 화면을 떠나지 않는다.
// 흐름: 쓰러짐(기존 사망 연출 재사용) → 가짜 게임오버 UI 1.1초(RETRY 버튼 + 커서까지)
//      → 기상 반전 + 오버레이 글자의 월드 실체화(글자 발판 3개 / RETRY 버튼 min(deaths,3) / 금색 단어)
//      → 단어 위 [E] 홀드 1초 → 글리치 소멸 → store.unlock + erased + PERMISSION GRANTED 배너 → 디졸브.
// truce: 침입 활성(가짜 UI~디졸브) 동안 scene.__truce=true — 재사망 없음.
// 자족 모듈: 씬은 killPlayer(scene, cause)만 부른다. SHUTDOWN/RESTART에서 완전 해제.

import Phaser from 'phaser';
import { store } from './settingsStore.js';
import { audio } from './audio.js';
import { emitState } from './events.js';
import { addCorpse } from './corpses.js';
import { createInput, getRunState, saveRunState } from './shared.js';

const FAKE_UI_MS = 1100; // 진짜 게임오버처럼 정지하는 시간
const ERASE_HOLD_MS = 1000;
const BTN_W = 148;
const BTN_H = 52;
const PLAYER_SCALE = 2.65;
const LENS_HOLD = 0.8; // 가짜 게임오버의 어둠
const LENS_LIVE = 0.45; // 반전 후 남는 죽음의 렌즈
const WORD_RAISE = 175; // 단어 부유 높이 — 사망 지점 위 ~170px

// 씬 어둠 오버레이(depth 90) 위에 침입 요소를 둔다 — Stage0 암흑에서도 읽힌다.
const D_WORLD = 93;
const D_LENS = 200;
const D_WORD = 205;
const D_UI = 210;
const D_FX = 238;
const D_FLASH = 240;
const D_BANNER = 250;

// cause 테이블 (PATCH2 — GRAVITY 폐지, SPIKES 신설)
const CAUSES = {
  DARKNESS: {
    word: 'DARKNESS', unlock: 'brightness', permission: 'BRIGHTNESS',
    accent: 0xe4b65a, accentCss: '#e4b65a',
    rule: 'DARKNESS = DEATH', ruleAfter: 'DARKNESS = ______', afterHint: 'ESC → BRIGHTNESS',
  },
  SOUND: {
    word: 'SOUND', unlock: 'volume', permission: 'VOLUME',
    accent: 0x71d98b, accentCss: '#71d98b',
    rule: 'SOUND = DETECTION', ruleAfter: 'SOUND = ______', afterHint: 'ESC → VOLUME',
  },
  FRAME: {
    word: 'FRAME', unlock: 'display', permission: 'DISPLAY',
    accent: 0x8fd8f0, accentCss: '#8fd8f0',
    rule: 'FRAME = BOUNDARY', ruleAfter: 'FRAME = ______', afterHint: 'ESC → DISPLAY',
  },
  SPIKES: {
    word: 'SPIKES', unlock: 'shake', permission: 'SHAKE',
    accent: 0xd97f4a, accentCss: '#d97f4a',
    rule: 'SPIKES = DEATH', ruleAfter: 'SPIKES = ______', afterHint: 'ESC → SHAKE',
  },
  ADMIN: {
    word: 'ADMIN', unlock: null, permission: null,
    accent: 0xef4d5b, accentCss: '#ef4d5b',
    rule: 'ADMIN = ROOT', ruleAfter: 'ADMIN = ______', afterHint: null,
  },
};

function causeConfig(cause) {
  if (Object.prototype.hasOwnProperty.call(CAUSES, cause)) return CAUSES[cause];
  const word = String(cause || 'DEATH').toUpperCase();
  return {
    word, unlock: null, permission: null,
    accent: 0xef4d5b, accentCss: '#ef4d5b',
    rule: `${word} = DEATH`, ruleAfter: `${word} = ______`, afterHint: null,
  };
}

function safeSfx(name) {
  try {
    audio.sfx(name);
  } catch {
    // 오디오는 절대 진행을 막지 않는다.
  }
}

function interactKeyName() {
  return store.getState().bindings.interact || 'E';
}

function hudMode(scene) {
  return scene.scene.key === 'BossScene' ? 'boss' : 'world';
}

function seededRng(seed) {
  let s = (seed * 16807 + 11) % 2147483647;
  if (s <= 0) s += 2147483645;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

function delay(scene, st, ms, fn) {
  const t = scene.time.delayedCall(ms, () => {
    if (st.dead) return;
    fn();
  });
  st.timers.push(t);
  return t;
}

// ---------------------------------------------------------------------------
// 진입점
// ---------------------------------------------------------------------------

export function triggerDeathIntrusion(scene, cause) {
  if (scene.__dying || scene.__truce) return;
  if (scene.__intrusion && !scene.__intrusion.done) return;

  // 이전 침입의 잔해(버튼/시체 발판)는 걷어낸다 — 겹쳐 쌓이면 밀 수 없게 된다.
  // 주의: 그룹 자체를 destroy하면 그 그룹을 참조하는 콜라이더가 매 프레임 크래시한다(2회 사망 프리즈).
  // 그룹은 살려두고 내용물만 비운다.
  if (scene.__intrusion && scene.__intrusion.done) {
    const prev = scene.__intrusion;
    try {
      if (prev.buttons && prev.buttons.clear) prev.buttons.clear(true, true);
      if (prev.solids && prev.solids.clear) prev.solids.clear(true, true);
      (prev.debris || []).forEach((obj) => {
        if (obj && obj.active && obj.destroy) obj.destroy();
      });
    } catch { /* 정리 실패해도 진행 */ }
    scene.__intrusion = null;
  }

  const cfg = causeConfig(cause);
  const runState = getRunState(scene);
  runState.deaths += 1;
  saveRunState(scene, runState);

  const player = scene.player;
  const px = player ? player.x : 480;
  const py = player ? player.y : 270;
  addCorpse(scene, scene.scene.key, px, py);

  const st = {
    active: true, done: false, dead: false, dissolved: false,
    cause, cfg, deaths: runState.deaths,
    px, py, baseX: px, baseY: py,
    timers: [], debris: [], graffiti: [],
    solids: null, buttons: null,
    word: null, wordGlow: null, prompt: null, gauge: null,
    glitchEmitter: null, scatterEmitter: null, flash: null, lens: null,
    uiTitle: null, uiLabel: null, uiWord: null, uiBtn: null,
    wordBaseX: 0, wordBaseY: 0,
    wordActive: false, erasing: false, eraseMs: 0, glitchAt: 0,
    input: null, onUpdate: null, updateHooked: false,
  };
  scene.__intrusion = st;
  scene.__dying = true;
  ensureCleanupHook(scene);

  // 워치독 — 어떤 링크가 끊겨도 침입은 6초 안에 반드시 끝난다 (게임 멈춤 방지)
  delay(scene, st, 6000, () => {
    if (st.done) return;
    try {
      if (!st.erasing) performErase(scene, st);
    } catch { /* 이펙트 실패 무시 */ }
    scene.time.delayedCall(1500, () => {
      if (st.dead || st.done) return;
      try {
        dissolve(scene, st);
      } catch {
        st.done = true;
        st.dissolved = true;
        st.active = false;
        scene.__truce = false;
        scene.__dying = false;
      }
    });
  });

  // --- 1단계: 쓰러짐 — 기존 사망 연출(슬로모/셰이크/플래시) 재사용, 씬 전환 없음 ---
  if (player) {
    if (player.anims) player.anims.stop();
    player.setTint(0xef4d5b);
    if (player.body) {
      player.setVelocity(0, 0);
      player.body.enable = false;
    }
    if (scene.textures.exists('cat-dead')) player.setTexture('cat-dead');
  }

  const cam = scene.cameras.main;
  if (scene.physics && scene.physics.world) scene.physics.world.timeScale = 3.5;
  cam.shake(150, 0.009);
  cam.flash(90, 239, 77, 91);
  deathBurst(scene, px, py - 26);
  safeSfx('death');

  emitState({
    mode: 'dying',
    chapter: 'SYSTEM // FAILURE',
    objective: `KILLED BY: ${cfg.word}`,
    rule: 'LIFE // TERMINATED',
    deaths: runState.deaths,
  });

  delay(scene, st, 620, () => showFakeUi(scene, st));
}

// ---------------------------------------------------------------------------
// 2단계: 가짜 게임오버 UI — 진짜처럼 보여야 한다 (RETRY 버튼 + 커서)
// ---------------------------------------------------------------------------

function showFakeUi(scene, st) {
  scene.__truce = true;
  if (scene.physics && scene.physics.world) scene.physics.world.timeScale = 1;

  st.lens = scene.add.rectangle(480, 270, 2400, 1400, 0x05060a)
    .setScrollFactor(0).setDepth(D_LENS).setAlpha(0);
  scene.tweens.add({ targets: st.lens, alpha: LENS_HOLD, duration: 140 });

  st.uiTitle = scene.add.text(480, 198, 'YOU DIED?', {
    fontFamily: 'Georgia, "Times New Roman", serif',
    fontSize: '96px', fontStyle: 'bold',
    color: '#e9e2d2', stroke: '#321217', strokeThickness: 2,
  }).setOrigin(0.5).setScrollFactor(0).setDepth(D_UI)
    .setShadow(0, 14, '#000000', 20, true, true).setAlpha(0).setScale(1.05);
  scene.tweens.add({ targets: st.uiTitle, alpha: 1, scaleX: 1, scaleY: 1, duration: 170 });

  st.uiLabel = scene.add.text(0, 292, 'KILLED BY: ', {
    fontFamily: 'monospace', fontSize: '15px', color: '#d9d2c1', letterSpacing: 4,
  }).setOrigin(0, 0.5).setScrollFactor(0).setDepth(D_UI).setAlpha(0);
  st.uiWord = scene.add.text(0, 292, st.cfg.word, {
    fontFamily: 'monospace', fontSize: '15px', fontStyle: 'bold', color: '#ef4d5b', letterSpacing: 4,
  }).setOrigin(0, 0.5).setScrollFactor(0).setDepth(D_UI).setAlpha(0);
  const lineW = st.uiLabel.width + st.uiWord.width;
  st.uiLabel.setX(480 - lineW / 2);
  st.uiWord.setX(st.uiLabel.x + st.uiLabel.width);
  scene.tweens.add({ targets: [st.uiLabel, st.uiWord], alpha: 1, delay: 190, duration: 160 });

  st.uiBtn = scene.add.image(480, 398, ensureRetryTexture(scene, 0))
    .setScrollFactor(0).setDepth(D_UI).setAlpha(0);
  scene.tweens.add({ targets: st.uiBtn, alpha: 1, delay: 260, duration: 160 });

  delay(scene, st, FAKE_UI_MS, () => reveal(scene, st));
}

// ---------------------------------------------------------------------------
// 3단계: 반전 — 고양이 기상, 오버레이 글자가 월드로 낙하해 실체화
// ---------------------------------------------------------------------------

function reveal(scene, st) {
  const cam = scene.cameras.main;
  safeSfx('rumble');
  cam.shake(280, 0.004);

  // 오버레이가 무너져 내린다
  const drop = (obj, dy, angle, duration) => {
    if (!obj || !obj.active) return;
    scene.tweens.killTweensOf(obj);
    scene.tweens.add({
      targets: obj, y: `+=${dy}`, angle, alpha: 0, duration, ease: 'Cubic.easeIn',
      onComplete: () => obj.destroy(),
    });
  };
  drop(st.uiTitle, 360, 5, 640);
  drop(st.uiLabel, 300, -4, 460);
  drop(st.uiWord, 260, 6, 340);
  drop(st.uiBtn, 420, 14, 560);

  // 어둠은 걷히지 않고 렌즈로 남는다
  scene.tweens.add({ targets: st.lens, alpha: LENS_LIVE, duration: 700, ease: 'Sine.easeInOut' });

  spawnIntrusionWorld(scene, st);
  wakeCat(scene, st);

  emitState({
    mode: hudMode(scene),
    chapter: 'SYSTEM // INTRUSION',
    objective: '일어나라.',
    rule: st.cfg.rule,
    deaths: st.deaths,
  });
}

function wakeCat(scene, st) {
  // 몸은 남는다 — 시체 발판 실체화 (다음 방문의 spawnCorpses와 동일 규격)
  if (st.solids && scene.textures.exists('cat-dead')) {
    const corpse = st.solids.create(st.px, st.py, 'cat-dead');
    corpse.setScale(PLAYER_SCALE).setOrigin(0.5, 1).setDepth(D_WORLD - 2).setTint(0xd9b8b4);
    corpse.refreshBody();
    const cbody = corpse.body;
    cbody.setSize(58, 18);
    cbody.position.x = st.px - 29;
    cbody.position.y = st.py - 18;
    if (cbody.updateCenter) cbody.updateCenter();
    st.debris.push(corpse);
  }

  const player = scene.player;
  if (!player || !player.active) {
    scene.__dying = false;
    return;
  }
  player.setPosition(st.px, st.py - 26);
  player.clearTint().setAlpha(1);
  if (scene.textures.exists('cat-idle')) player.setTexture('cat-idle', 0);
  player.setScale(PLAYER_SCALE * 1.16, PLAYER_SCALE * 0.64);
  scene.tweens.add({
    targets: player, scaleX: PLAYER_SCALE, scaleY: PLAYER_SCALE,
    duration: 300, ease: 'Back.easeOut',
  });
  delay(scene, st, 260, () => {
    if (!player.active || !player.body) {
      scene.__dying = false;
      return;
    }
    player.body.enable = true;
    player.setVelocity(0, -140);
    scene.__dying = false; // 입력 복귀
    safeSfx('ui');
  });
}

function spawnIntrusionWorld(scene, st) {
  const wb = scene.physics.world.bounds;
  const baseX = Phaser.Math.Clamp(st.px, wb.x + 230, Math.max(wb.x + 230, wb.right - 230));
  const baseY = Phaser.Math.Clamp(st.py, wb.y + 250, Math.max(wb.y + 250, wb.bottom - 16));
  const m = baseX > wb.centerX ? -1 : 1; // 여유 있는 쪽으로 계단을 편다
  st.baseX = baseX;
  st.baseY = baseY;

  st.solids = scene.physics.add.staticGroup();
  st.buttons = scene.physics.add.group();
  // (글자 발판 없음 — 월드에 남는 침입물은 RETRY 버튼뿐이다)

  // --- RETRY 버튼 (pushable) — 사망 횟수만큼, 최대 3 ---
  const count = Math.min(st.deaths, 3);
  for (let i = 0; i < count; i += 1) {
    const wear = Phaser.Math.Clamp(st.deaths - 1 - i, 0, 5);
    const bx = Phaser.Math.Clamp(
      baseX + (i - (count - 1) / 2) * 70 + Phaser.Math.Between(-6, 6),
      wb.x + BTN_W / 2, wb.right - BTN_W / 2,
    );
    const by = Math.max(wb.y + 40 + i * 58, baseY - 320 - i * 64);
    makeIntrusionButton(scene, st, bx, by, wear);
  }

  // --- 충돌 배선 (씬 지형 관례 그룹은 있으면 전부 연결) ---
  const terrain = [scene.platforms, scene.solids, scene.ghosts, scene.corpseGroup]
    .filter((g) => g && g !== st.solids);
  if (scene.player) {
    scene.physics.add.collider(scene.player, st.solids);
    // 공중에서 몸으로 치면 버튼이 날아간다 — 끼임 방지
    scene.physics.add.collider(scene.player, st.buttons, (playerObj, btn) => {
      const pb = playerObj.body;
      if (!pb || !btn.body) return;
      const airborne = !pb.blocked.down && !pb.touching.down;
      if (airborne && Math.abs(pb.velocity.y) > 160) {
        const now = scene.time.now;
        if (now - (btn.__stompAt || 0) < 350) return; // 연속 접촉 프레임 중복 방지
        btn.__stompAt = now;
        btn.__stomps = (btn.__stomps || 0) + 1;
        if (btn.__stomps >= 2) {
          // 두 번째 밟기부터 튕겨 나간다
          btn.__stomps = 0;
          const dir = btn.x >= playerObj.x ? 1 : -1;
          btn.setVelocity(dir * 140, -130);
          safeSfx('ui');
        } else {
          // 첫 밟기: 눌리는 반응만
          scene.tweens.add({ targets: btn, scaleY: 0.86, duration: 70, yoyo: true });
          safeSfx('type');
        }
      }
    });
  }
  scene.physics.add.collider(st.buttons, st.solids);
  scene.physics.add.collider(st.buttons, st.buttons);
  terrain.forEach((g) => scene.physics.add.collider(st.buttons, g));

  // 단어/글자 침입물 없음 — 월드에 남는 것은 RETRY 버튼뿐.
  // 죽음 자체가 해금이다 (한 판에 하나): 잠시 뒤 규칙이 스스로 붕괴한다.
  delay(scene, st, 900, () => performErase(scene, st));

  // --- 이펙트 도구 ---
  if (scene.textures.exists('white-pixel')) {
    st.glitchEmitter = scene.add.particles(0, 0, 'white-pixel', {
      speed: { min: 20, max: 95 },
      lifespan: { min: 130, max: 340 },
      scale: { start: 1.8, end: 0 },
      alpha: { start: 0.9, end: 0 },
      tint: [0xe4b65a, st.cfg.accent, 0xffffff],
      blendMode: Phaser.BlendModes.ADD,
      gravityY: 0,
      emitting: false,
    }).setDepth(D_FX);
    st.scatterEmitter = scene.add.particles(0, 0, 'white-pixel', {
      speed: { min: 50, max: 270 },
      lifespan: { min: 420, max: 950 },
      scale: { start: 2.4, end: 0 },
      alpha: { start: 1, end: 0 },
      tint: [0xe4b65a, st.cfg.accent, 0xd9d2c1],
      gravityY: 430,
      emitting: false,
    }).setDepth(D_FX);
  }
  st.gauge = scene.add.graphics().setDepth(D_FX);
  st.flash = scene.add.rectangle(480, 270, 2400, 1400, 0xffffff)
    .setScrollFactor(0).setDepth(D_FLASH).setAlpha(0);

}

function makeIntrusionButton(scene, st, x, y, wear) {
  const key = ensureRetryTexture(scene, Phaser.Math.Clamp(wear, 0, 5));
  const btn = scene.physics.add.sprite(x, y, key);
  btn.setDepth(D_WORLD + 1).setPushable(true);
  btn.body.setSize(BTN_W - 6, BTN_H - 10).setOffset(3, 5);
  // 무겁고 느리게 — 질량으로 밀림 자체를 둔하게, 속도 상한은 캐릭터(265)의 절반 근처
  btn.setDragX(1600).setMaxVelocity(140, 980).setBounce(0);
  btn.body.setMass(4);
  btn.setCollideWorldBounds(true);
  st.buttons.add(btn);
  st.debris.push(btn);
  // worldToys가 부착돼 있으면 자동 등록 — SHAKE 슬라이더/패널 밀치기 대상
  if (scene.__worldToys && typeof scene.__worldToys.register === 'function') {
    scene.__worldToys.register(btn);
  }
  return btn;
}

function spawnGraffiti(scene, x, y, str) {
  const t = scene.add.text(x, y, str, {
    fontFamily: 'Georgia, serif', fontSize: '13px', fontStyle: 'italic', color: '#b09a6d',
  }).setOrigin(0.5).setDepth(D_WORD).setAlpha(0).setAngle(Phaser.Math.FloatBetween(-2, 2));
  scene.tweens.add({ targets: t, alpha: 0.85, delay: 650, duration: 420 });
  return t;
}

// ---------------------------------------------------------------------------
// 4단계: [E] 홀드 삭제 — 게이지 / 글리치 / 해금 배너 / 디졸브
// ---------------------------------------------------------------------------

function hookUpdate(scene, st) {
  if (st.updateHooked) return;
  st.updateHooked = true;
  st.input = (scene.keys && scene.keys.isDown && scene.keys)
    || (scene.keysIn && scene.keysIn.isDown && scene.keysIn)
    || createInput(scene);
  st.onUpdate = (time, deltaMs) => updateIntrusion(scene, st, time, deltaMs);
  scene.events.on(Phaser.Scenes.Events.UPDATE, st.onUpdate);
}

function unhookUpdate(scene, st) {
  if (!st.updateHooked) return;
  st.updateHooked = false;
  if (st.onUpdate) scene.events.off(Phaser.Scenes.Events.UPDATE, st.onUpdate);
  st.onUpdate = null;
}

function wordOverlapsPlayer(scene, st) {
  if (!st.word || !st.word.visible || !scene.player || !scene.player.body) return false;
  const body = scene.player.body;
  const playerRect = new Phaser.Geom.Rectangle(body.x, body.y, body.width, body.height);
  const wordRect = Phaser.Geom.Rectangle.Inflate(
    Phaser.Geom.Rectangle.Clone(st.word.getBounds()), 10, 14,
  );
  return Phaser.Geom.Intersects.RectangleToRectangle(playerRect, wordRect);
}

function updateIntrusion(scene, st, time, deltaMs) {
  if (st.dead || st.erasing || !st.wordActive) return;
  const player = scene.player;
  if (!player || !player.body || !player.body.enable || scene.__dying) {
    if (st.gauge) st.gauge.clear();
    if (st.prompt) st.prompt.setVisible(false);
    return;
  }

  const overlapping = wordOverlapsPlayer(scene, st);
  const holding = overlapping && st.input.isDown('interact');
  if (st.prompt) st.prompt.setVisible(overlapping && !holding);

  if (holding) {
    st.eraseMs = Math.min(ERASE_HOLD_MS, st.eraseMs + deltaMs);
    const p = st.eraseMs / ERASE_HOLD_MS;

    // 단어가 붕괴하기 시작한다
    const jitter = p * 3.4;
    st.word.setX(st.wordBaseX + Phaser.Math.FloatBetween(-jitter, jitter));
    st.word.setAlpha(1 - p * 0.35 + Phaser.Math.FloatBetween(-0.08, 0.08) * p);

    if (scene.time.now >= st.glitchAt) {
      st.glitchAt = scene.time.now + 65;
      glitchBurst(scene, st, st.word.getBounds(), 2 + Math.floor(p * 4));
    }

    // 원형 게이지
    const gx = player.x;
    const gy = player.y - 96;
    st.gauge.clear();
    st.gauge.lineStyle(4, 0x2c2f33, 0.85).strokeCircle(gx, gy, 21);
    st.gauge.lineStyle(5, 0xe4b65a, 1);
    st.gauge.beginPath();
    st.gauge.arc(gx, gy, 21, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * p);
    st.gauge.strokePath();
    st.gauge.fillStyle(0xe4b65a, 0.25 + p * 0.4).fillCircle(gx, gy, 7);

    if (st.eraseMs >= ERASE_HOLD_MS) performErase(scene, st);
  } else {
    if (st.eraseMs > 0) {
      st.eraseMs = Math.max(0, st.eraseMs - deltaMs * 3);
      if (st.eraseMs === 0 && st.word.visible) {
        st.word.setX(st.wordBaseX).setAlpha(1);
      }
    }
    st.gauge.clear();
  }
}

function glitchBurst(scene, st, bounds, n) {
  if (!st.glitchEmitter) return;
  for (let i = 0; i < n; i += 1) {
    st.glitchEmitter.emitParticleAt(
      bounds.x + Math.random() * bounds.width,
      bounds.y + Math.random() * bounds.height,
      1,
    );
  }
}

function performErase(scene, st) {
  if (st.erasing) return;
  st.erasing = true;
  st.gauge.clear();
  if (st.prompt) st.prompt.setVisible(false);
  if (scene.player && scene.player.body && scene.player.body.enable) scene.player.setVelocityX(0);

  // 붕괴 이펙트 — 플레이어 머리 위에서 짧게 흩어진다
  if (st.scatterEmitter && scene.player) {
    for (let i = 0; i < 26; i += 1) {
      st.scatterEmitter.emitParticleAt(
        scene.player.x + Phaser.Math.Between(-60, 60),
        scene.player.y - 60 + Phaser.Math.Between(-30, 30),
        1,
      );
    }
  }
  if (st.word) {
    scene.tweens.killTweensOf(st.word);
    st.word.setVisible(false);
  }
  if (st.wordGlow) {
    scene.tweens.killTweensOf(st.wordGlow);
    scene.tweens.add({ targets: st.wordGlow, alpha: 0, duration: 350 });
  }

  safeSfx('erase');
  scene.cameras.main.shake(200, 0.007);
  st.flash.setAlpha(0.9);
  scene.tweens.add({ targets: st.flash, alpha: 0, duration: 430, ease: 'Cubic.easeOut' });

  // 기록 갱신 — 규칙 무력화
  const runState = getRunState(scene);
  runState.erased[st.cfg.word] = true;
  saveRunState(scene, runState);

  // 해금 (SPIKES → shake 포함)
  const freshUnlock = st.cfg.unlock && !store.isUnlocked(st.cfg.unlock);
  if (st.cfg.unlock) store.unlock(st.cfg.unlock);

  emitState({
    mode: hudMode(scene),
    chapter: 'SYSTEM // INTRUSION',
    objective: '규칙 삭제됨.',
    rule: st.cfg.ruleAfter,
    deaths: st.deaths,
    hint: st.cfg.afterHint || undefined,
  });

  if (freshUnlock) delay(scene, st, 420, () => showUnlockBanner(scene, st));
  delay(scene, st, freshUnlock ? 2100 : 800, () => dissolve(scene, st));
}

function showUnlockBanner(scene, st) {
  safeSfx('unlock');
  const banner = scene.add.container(480, 200).setScrollFactor(0).setDepth(D_BANNER);

  const glow = scene.add.image(0, 16, 'glow-orb')
    .setBlendMode(Phaser.BlendModes.ADD).setTint(st.cfg.accent).setScale(7, 2.6).setAlpha(0.3);
  const line1 = scene.add.text(0, -34, 'PERMISSION GRANTED', {
    fontFamily: 'monospace', fontSize: '13px', color: '#71d98b', letterSpacing: 6,
  }).setOrigin(0.5);
  const line2 = scene.add.text(0, 8, st.cfg.permission, {
    fontFamily: 'monospace', fontSize: '42px', fontStyle: 'bold',
    color: st.cfg.accentCss, letterSpacing: 8,
  }).setOrigin(0.5).setShadow(0, 4, '#000000', 10, true, true);
  const line3 = scene.add.text(0, 52, '[ESC] 설정', {
    fontFamily: 'Georgia, serif', fontSize: '13px', color: '#9b8d7a',
  }).setOrigin(0.5);
  banner.add([glow, line1, line2, line3]);

  banner.setAlpha(0);
  line2.setScale(1.5);
  scene.tweens.add({ targets: banner, alpha: 1, duration: 160 });
  scene.tweens.add({ targets: line2, scaleX: 1, scaleY: 1, duration: 340, ease: 'Back.easeOut' });

  if (scene.textures.exists('white-pixel')) {
    const confetti = scene.add.particles(0, 0, 'white-pixel', {
      x: 480, y: 190,
      speed: { min: 80, max: 260 },
      angle: { min: 230, max: 310 },
      lifespan: { min: 500, max: 1100 },
      scale: { start: 2, end: 0 },
      alpha: { start: 1, end: 0 },
      tint: [st.cfg.accent, 0xffffff],
      gravityY: 520,
      emitting: false,
    }).setScrollFactor(0).setDepth(D_BANNER - 1);
    confetti.explode(26);
    delay(scene, st, 1400, () => confetti.destroy());
  }

  // 배너는 스스로 걷힌다 (씬은 계속 진행 중)
  delay(scene, st, 1500, () => {
    scene.tweens.add({
      targets: banner, alpha: 0, y: 184, duration: 320,
      onComplete: () => banner.destroy(),
    });
  });
}

function dissolve(scene, st) {
  if (st.dissolved) return;
  st.dissolved = true;
  st.wordActive = false;
  st.active = false;
  st.done = true;
  scene.__truce = false;
  unhookUpdate(scene, st);

  // 죽음의 렌즈가 걷힌다
  if (st.lens && st.lens.active) {
    scene.tweens.add({
      targets: st.lens, alpha: 0, duration: 900, ease: 'Sine.easeInOut',
      onComplete: () => {
        if (st.lens && st.lens.active) st.lens.destroy();
        st.lens = null;
      },
    });
  }

  // 장식 요소는 소멸
  [st.wordGlow, st.prompt, ...st.graffiti].forEach((obj) => {
    if (!obj || !obj.active) return;
    scene.tweens.killTweensOf(obj);
    scene.tweens.add({ targets: obj, alpha: 0, duration: 420, onComplete: () => obj.destroy() });
  });
  if (st.word && st.word.active) st.word.destroy();
  if (st.gauge) st.gauge.clear();

  // 잔해(글자 발판/버튼/시체)는 남는다 — 실패는 건축 재료다. 글리치 플리커 후 정착.
  st.debris.forEach((obj, i) => {
    if (!obj || !obj.active || !obj.setAlpha) return;
    scene.tweens.add({
      targets: obj, alpha: 0.5, duration: 70, yoyo: true, repeat: 1, delay: i * 30,
      onComplete: () => {
        if (obj.active) obj.setAlpha(1);
      },
    });
  });
  safeSfx('ui');
}

// ---------------------------------------------------------------------------
// 정리 — SHUTDOWN/RESTART(전 씬 stop)에서 완전 해제
// ---------------------------------------------------------------------------

function ensureCleanupHook(scene) {
  if (scene.__intrusionCleanupHooked) return;
  scene.__intrusionCleanupHooked = true;
  const run = () => {
    scene.events.off(Phaser.Scenes.Events.SHUTDOWN, run);
    scene.events.off(Phaser.Scenes.Events.DESTROY, run);
    scene.__intrusionCleanupHooked = false;
    teardownIntrusion(scene);
  };
  scene.events.once(Phaser.Scenes.Events.SHUTDOWN, run);
  scene.events.once(Phaser.Scenes.Events.DESTROY, run);
}

function teardownIntrusion(scene) {
  scene.__truce = false;
  scene.__dying = false;
  if (scene.physics && scene.physics.world) scene.physics.world.timeScale = 1;
  const st = scene.__intrusion;
  if (!st) return;
  st.dead = true;
  st.wordActive = false;
  for (const t of st.timers) {
    try {
      t.remove(false);
    } catch {
      // 이미 소거된 타이머
    }
  }
  st.timers.length = 0;
  if (st.onUpdate) scene.events.off(Phaser.Scenes.Events.UPDATE, st.onUpdate);
  st.onUpdate = null;
  scene.__intrusion = null;
  // GameObject/그룹/트윈은 씬 SHUTDOWN이 일괄 파괴한다.
}

// ---------------------------------------------------------------------------
// 사망 파티클 (shared.killPlayer의 연출과 동일 규격 — 자족 복제)
// ---------------------------------------------------------------------------

function deathBurst(scene, x, y) {
  if (!scene.textures.exists('white-pixel')) return;
  const burst = scene.add.particles(x, y, 'white-pixel', {
    speed: { min: 70, max: 300 },
    angle: { min: 180, max: 360 },
    quantity: 22,
    lifespan: { min: 320, max: 780 },
    scale: { start: 2.4, end: 0 },
    alpha: { start: 1, end: 0 },
    tint: [0xef4d5b, 0xd9d2c1, 0x8d262f],
    gravityY: 640,
    emitting: false,
  }).setDepth(D_FX);
  burst.explode(22);
  scene.time.delayedCall(1000, () => burst.destroy());
}

// ---------------------------------------------------------------------------
// 텍스처 — RETRY 버튼(DeathspaceScene과 동일 알고리즘/키, 낡음 단계 공유) + 커서
// ---------------------------------------------------------------------------

function ensureRetryTexture(scene, wear) {
  const key = `retry-btn-${wear}`;
  if (scene.textures.exists(key)) return key;

  const rand = seededRng(wear + 7);
  const g = scene.make.graphics({ add: false });

  // 그림자 밑판 / 몸통 / 상단 베벨 / 내부 면
  g.fillStyle(0x0b0d10, 1).fillRoundedRect(0, 5, BTN_W, BTN_H - 5, 8);
  g.fillStyle(0x24272d, 1).fillRoundedRect(0, 0, BTN_W, BTN_H - 6, 8);
  g.fillStyle(0x4a505b, 1).fillRoundedRect(2, 2, BTN_W - 4, 9, { tl: 7, tr: 7, bl: 0, br: 0 });
  g.fillStyle(0x181b20, 1).fillRoundedRect(6, 9, BTN_W - 12, BTN_H - 24, 6);
  g.lineStyle(1, 0x565d68, 0.55).strokeRoundedRect(1, 1, BTN_W - 2, BTN_H - 8, 8);

  // 낡음: 스크래치
  g.lineStyle(1, 0x0e0f12, 0.85);
  for (let i = 0; i < wear * 2; i += 1) {
    const sx = 8 + rand() * (BTN_W - 30);
    const sy = 8 + rand() * (BTN_H - 22);
    g.lineBetween(sx, sy, sx + 6 + rand() * 18, sy + (rand() - 0.5) * 8);
  }
  // 낡음: 모서리 치핑
  g.fillStyle(0x030405, 1);
  for (let i = 0; i < wear; i += 1) {
    const edgeX = rand() < 0.5 ? rand() * 16 : BTN_W - 16 + rand() * 14;
    const edgeY = rand() < 0.5 ? rand() * 8 : BTN_H - 14 + rand() * 8;
    g.fillRect(edgeX, edgeY, 3 + rand() * 5, 2 + rand() * 4);
  }
  // 낡음: 얼룩
  g.fillStyle(0x101216, 0.6);
  for (let i = 0; i < wear; i += 1) {
    g.fillEllipse(14 + rand() * (BTN_W - 28), 12 + rand() * (BTN_H - 26), 10 + rand() * 14, 5 + rand() * 6);
  }
  // 심하게 낡으면 균열
  if (wear >= 4) {
    g.lineStyle(1, 0x05060a, 1);
    let cx = 20 + rand() * 40;
    let cy = 4;
    g.beginPath();
    g.moveTo(cx, cy);
    for (let i = 0; i < 5; i += 1) {
      cx += (rand() - 0.3) * 26;
      cy += 7 + rand() * 6;
      g.lineTo(cx, cy);
    }
    g.strokePath();
  }

  const labelColor = wear >= 3 ? '#a9a294' : '#d9d2c1';
  const labelText = wear >= 5 ? 'RETR' : 'RETRY';
  const label = scene.make.text({
    x: 0, y: 0, add: false,
    text: labelText,
    style: {
      fontFamily: 'monospace', fontSize: '17px', fontStyle: 'bold',
      color: labelColor, letterSpacing: 4,
    },
  });
  label.setAlpha(Math.max(0.5, 1 - wear * 0.08));
  label.setAngle((wear % 2 ? -1 : 1) * wear * 0.7);

  const rt = scene.make.renderTexture({ width: BTN_W, height: BTN_H, add: false });
  rt.draw(g, 0, 0);
  rt.draw(label, BTN_W / 2 - label.width / 2, (BTN_H - 6) / 2 - label.height / 2);
  if (wear >= 5) {
    const fallen = scene.make.text({
      x: 0, y: 0, add: false,
      text: 'Y',
      style: { fontFamily: 'monospace', fontSize: '15px', fontStyle: 'bold', color: '#6f6a5f' },
    });
    fallen.setAngle(38);
    rt.draw(fallen, BTN_W - 26, BTN_H - 20);
    fallen.destroy();
  }
  rt.saveTexture(key);
  rt.destroy();
  g.destroy();
  label.destroy();
  return key;
}
