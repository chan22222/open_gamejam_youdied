// ESC/APE — Stage1Scene (B2) : 소리의 정원
// 청각 감시자(LISTENER) 2기가 순찰하는 옆스크롤 정원.
// 청각 반경 = 140 + 340 * (effective('volume') / 100) — 설정 슬라이더가 곧 위협의 크기다.
// volume 0 → 감시자 수면(zZ). erased.SOUND → 청각 무시(귀에 취소선), 시각 원뿔만 남는다.

import Phaser from 'phaser';
import { emitState } from '../events.js';
import { store, effective } from '../settingsStore.js';
import { audio } from '../audio.js';
import { spawnCorpses } from '../corpses.js';
import { attachWorldToys } from '../worldToys.js';
import {
  addFloatingMote,
  createInput,
  createPlayer,
  createStaticPlatform,
  getRunState,
  killPlayer,
  saveRunState,
  updatePlayer,
  VIEW_WIDTH,
  VIEW_HEIGHT,
} from '../shared.js';

const WORLD_W = 2400;
const SEEKER_SCALE = 2.7;
const HEAR_BASE = 140;
const HEAR_SCALE = 340;
const STEP_INTERVAL = 235; // ms — 발소리 링 방출 주기
const DOOR_X = 2290;
const DOOR_GROUND = 560;

function hearRadius() {
  return HEAR_BASE + HEAR_SCALE * (effective('volume') / 100);
}

// 발소리 링의 도달 반경 — volume 비례. 0이면 소리 자체가 없다.
function stepReach() {
  const vol = effective('volume');
  if (vol <= 0) return 0;
  return 34 + 300 * (vol / 100);
}

function lerpColor(a, b, t) {
  const ar = (a >> 16) & 0xff; const ag = (a >> 8) & 0xff; const ab = a & 0xff;
  const br = (b >> 16) & 0xff; const bg = (b >> 8) & 0xff; const bb = b & 0xff;
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  return (r << 16) | (g << 8) | bl;
}

// 의심도 s(0..1) → 초록(평온) → 호박(경계) → 적색(발각 직전)
function suspicionColor(s) {
  if (s < 0.5) return lerpColor(0x71d98b, 0xe4b65a, s * 2);
  return lerpColor(0xe4b65a, 0xef4d5b, (s - 0.5) * 2);
}

export class Stage1Scene extends Phaser.Scene {
  constructor() {
    super('Stage1Scene');
  }

  create() {
    this.runState = getRunState(this);
    this.finished = false;
    this.lastHudJson = '';
    this.controller = { lastGroundedAt: -1000, jumpBufferedAt: -1000 };
    this.stepAt = 0;
    this.landNoiseUntil = 0;
    this.prevOnGround = true;
    this.fallSpeedPrev = 0;
    this.doorProgress = 0;

    audio.setStage('stage1');

    this.physics.world.setBounds(0, 0, WORLD_W, 1200);
    this.cameras.main.setBounds(0, 0, WORLD_W, 720).setBackgroundColor('#0a1512');

    this.createSky();
    this.platforms = this.physics.add.staticGroup();
    this.createTerrain();
    this.createGraffiti();
    this.createSeekers();
    this.createExit();

    // 진입 시점의 수면 상태를 연출 없이 반영 (volume 0으로 재진입하는 경우)
    this.wasSleeping = effective('volume') === 0;
    if (this.wasSleeping) this.applySleepTransition(true);

    this.player = createPlayer(this, 120, 560);
    this.player.setCollideWorldBounds(true);
    this.physics.add.collider(this.player, this.platforms);
    this.corpseGroup = spawnCorpses(this, this.scene.key);
    this.physics.add.collider(this.player, this.corpseGroup);

    this.keys = createInput(this);
    attachWorldToys(this, { pushables: [] });
    this.cameras.main.startFollow(this.player, true, 0.09, 0.08, -60, 30);
    this.cameras.main.setDeadzone(180, 90);
    this.cameras.main.fadeIn(420, 6, 12, 11);

    // 청각/시각 시각화 레이어
    this.hearingGfx = this.add.graphics().setDepth(16).setBlendMode(Phaser.BlendModes.ADD);
    this.visionGfx = this.add.graphics().setDepth(19).setBlendMode(Phaser.BlendModes.ADD);
    this.doorGfx = this.add.graphics().setDepth(46);
    this.crosshair = this.add.image(0, 0, 'crosshair').setScale(2).setDepth(80).setTint(0xef4d5b).setAlpha(0);

    // zZ + 코골이 (마스터 볼륨이 0이라 코골이는 사실상 들리지 않는다 — 그것이 침묵의 농담이다)
    this.time.addEvent({
      delay: 1100,
      loop: true,
      callback: () => {
        if (effective('volume') === 0 && !this.finished) {
          for (const sk of this.seekers) this.spawnZ(sk);
        }
      },
    });
    this.time.addEvent({
      delay: 3000,
      loop: true,
      callback: () => {
        if (effective('volume') === 0 && !this.finished) {
          try { audio.sfx('rumble'); } catch { /* noop */ }
        }
      },
    });

    // HUD — volume 변경/해금/리셋에서만 갱신 (panelRect 등 고빈도 이벤트 무시)
    const unsub = store.subscribe((ev) => {
      if (ev.type === 'change' && ev.key !== 'volume') return;
      this.refreshHud();
    });
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, unsub);

    this.refreshHud();
  }

  // -------------------------------------------------------------------------
  // 배경 — 황혼의 정원
  // -------------------------------------------------------------------------

  createSky() {
    this.add.rectangle(VIEW_WIDTH / 2, VIEW_HEIGHT / 2, 2400, 1400, 0x0a1512)
      .setScrollFactor(0).setDepth(-30);
    this.add.rectangle(VIEW_WIDTH / 2, 130, 2400, 300, 0x11241d, 0.65)
      .setScrollFactor(0).setDepth(-29);

    // 이지러진 달
    this.add.circle(760, 86, 46, 0xd8e0c8, 0.9).setScrollFactor(0.03).setDepth(-28);
    this.add.circle(742, 76, 46, 0x0a1512, 0.94).setScrollFactor(0.03).setDepth(-27);

    // 원경 침엽수
    const far = this.add.graphics().setDepth(-24).setScrollFactor(0.14);
    far.fillStyle(0x10241f, 0.9);
    for (let x = -80; x < WORLD_W + 400; x += 105) {
      const h = 120 + ((x * 17) % 95);
      far.fillTriangle(x, 520, x + 52, 520 - h, x + 104, 520);
    }

    // 중경 생울타리 실루엣
    const hedge = this.add.graphics().setDepth(-18).setScrollFactor(0.38);
    hedge.fillStyle(0x0d2019, 0.95);
    hedge.fillRect(-100, 560, WORLD_W + 800, 220);
    for (let x = -60; x < WORLD_W + 500; x += 64) {
      hedge.fillCircle(x, 560, 34 + ((x * 11) % 22));
    }

    const mist = this.add.graphics().setDepth(-14).setScrollFactor(0.5);
    mist.fillStyle(0x7ca69a, 0.045).fillRect(-100, 430, WORLD_W + 400, 130);

    for (let i = 0; i < 44; i += 1) {
      addFloatingMote(this, Phaser.Math.Between(0, WORLD_W), Phaser.Math.Between(220, 600), 0x8bbf73, 0.5);
    }
    for (let i = 0; i < 12; i += 1) {
      this.addFirefly(Phaser.Math.Between(80, WORLD_W - 80), Phaser.Math.Between(320, 560));
    }
  }

  addFirefly(x, y) {
    const fly = this.add.image(x, y, 'glow-orb')
      .setScale(0.17).setTint(0xe4b65a).setAlpha(0)
      .setBlendMode(Phaser.BlendModes.ADD).setDepth(6);
    this.tweens.add({
      targets: fly,
      alpha: { from: 0, to: 0.55 },
      duration: Phaser.Math.Between(900, 1700),
      yoyo: true,
      repeat: -1,
      delay: Phaser.Math.Between(0, 1400),
      ease: 'Sine.easeInOut',
    });
    this.tweens.add({
      targets: fly,
      x: x + Phaser.Math.Between(-26, 26),
      y: y + Phaser.Math.Between(-18, 18),
      duration: Phaser.Math.Between(2400, 4200),
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut',
    });
  }

  // -------------------------------------------------------------------------
  // 지형 — 단차 있는 정원 (약 2.5 화면)
  // -------------------------------------------------------------------------

  createTerrain() {
    // 연속 지면 (구멍 없음 — 이 정원의 위협은 중력이 아니라 소리다)
    createStaticPlatform(this, this.platforms, 280, 650, 560, 100);           // A: 진입 정원 (top 600)
    createStaticPlatform(this, this.platforms, 920, 650, 720, 100);           // B: LISTENER_01 구역 (top 600)
    createStaticPlatform(this, this.platforms, 1605, 620, 650, 200, 'earth', 0xd9e6cf); // C: 상단 테라스 (top 520)
    createStaticPlatform(this, this.platforms, 2165, 630, 470, 140);          // D: 출구 정원 (top 560)

    // B 구역 상공 — 감시자 머리 위를 건너뛰는 발판
    createStaticPlatform(this, this.platforms, 740, 505, 130, 26, 'earth', 0xbcd4b4);
    createStaticPlatform(this, this.platforms, 950, 433, 120, 26, 'earth', 0xbcd4b4);
    createStaticPlatform(this, this.platforms, 1160, 505, 130, 26, 'earth', 0xbcd4b4);

    // C 구역 상공
    createStaticPlatform(this, this.platforms, 1440, 425, 120, 26, 'earth', 0xbcd4b4);
    createStaticPlatform(this, this.platforms, 1640, 361, 120, 26, 'earth', 0xbcd4b4);
    createStaticPlatform(this, this.platforms, 1830, 425, 110, 26, 'earth', 0xbcd4b4);

    // 수풀 (위장 스팟 — Q를 웅크릴 자리)
    const bushes = [
      [430, 600, 1.3, 0x5f8f5c, 10],
      [600, 600, 1.15, 0x527d57, 10],
      [1240, 600, 1.3, 0x6b9464, 34],
      [1335, 520, 1.2, 0x527d57, 10],
      [1880, 520, 1.25, 0x5f8f5c, 34],
      [2100, 560, 1.2, 0x608c5f, 10],
    ];
    for (const [x, y, scale, tint, depth] of bushes) {
      this.add.image(x, y, 'biome-objects')
        .setOrigin(0.5, 1).setScale(scale).setTint(tint).setDepth(depth)
        .setAlpha(depth > 30 ? 0.92 : 1)
        .setFlipX((x * 7) % 2 === 1);
    }

    // 산책로 표식
    this.add.image(1000, 600, 'bridge-object').setOrigin(0.5, 1).setScale(2.2).setAlpha(0.35).setTint(0x4b6b52).setDepth(4);
  }

  createGraffiti() {
    const style = {
      fontFamily: 'Georgia, serif',
      fontSize: '15px',
      color: '#9db8a8',
      fontStyle: 'italic',
    };
    const g1 = this.add.text(390, 538, '그것은 눈이 없다. 귀뿐이다', style)
      .setOrigin(0.5).setDepth(9).setAlpha(0.78).setAngle(-1.5)
      .setShadow(0, 2, '#04100c', 5, true, true);
    const g2 = this.add.text(1350, 458, '침묵도 설정이다', style)
      .setOrigin(0.5).setDepth(9).setAlpha(0.72).setAngle(1.2)
      .setShadow(0, 2, '#04100c', 5, true, true);
    for (const g of [g1, g2]) {
      this.tweens.add({
        targets: g,
        alpha: { from: g.alpha, to: g.alpha - 0.25 },
        duration: Phaser.Math.Between(1700, 2600),
        yoyo: true,
        repeat: -1,
        ease: 'Sine.easeInOut',
      });
    }
    this.add.text(150, 552, 'GARDEN_01 // KEEP QUIET', {
      fontFamily: 'monospace', fontSize: '10px', color: '#71d98b', letterSpacing: 3,
    }).setOrigin(0.5).setDepth(9).setAlpha(0.5);
  }

  // -------------------------------------------------------------------------
  // 감시자 — 순찰 경로가 서로 다른 LISTENER 2기
  // -------------------------------------------------------------------------

  createSeekers() {
    this.seekers = [
      // 01: 지면의 장거리 순찰자 — 느리고 성실하다. 경로 끝에서 오래 멈춰 '듣는다'.
      this.makeSeeker({
        x: 760, y: 600, minX: 700, maxX: 1150, speed: 42,
        endPause: 1400, midPause: false, label: 'LISTENER_01',
      }),
      // 02: 테라스의 신경질적 순찰자 — 빠르고, 예고 없이 멈춰 선다.
      this.makeSeeker({
        x: 1700, y: 520, minX: 1400, maxX: 1820, speed: 66,
        endPause: 550, midPause: true, label: 'LISTENER_02',
      }),
    ];

    for (const sk of this.seekers) {
      this.add.text((sk.cfg.minX + sk.cfg.maxX) / 2, sk.cfg.y - 128, sk.cfg.label, {
        fontFamily: 'monospace', fontSize: '10px', color: '#d96b72', letterSpacing: 2,
      }).setOrigin(0.5).setDepth(29).setAlpha(0.65);
    }
  }

  makeSeeker(cfg) {
    const sprite = this.add.sprite(cfg.x, cfg.y, 'seeker-idle')
      .setScale(SEEKER_SCALE).setOrigin(0.5, 1).setDepth(28);
    sprite.anims.play('seeker-idle-anim');

    const q = this.add.text(cfg.x, cfg.y - 108, '?', {
      fontFamily: 'monospace', fontSize: '21px', fontStyle: 'bold', color: '#e4b65a',
    }).setOrigin(0.5).setDepth(45).setAlpha(0).setShadow(0, 2, '#120a04', 4, true, true);

    // erased.SOUND — 귀에 취소선: 더 이상 듣지 않는다
    const ear = this.add.container(0, 0).setDepth(44).setVisible(false);
    const eg = this.add.graphics();
    eg.fillStyle(0x0a1214, 0.55).fillCircle(0, 0, 13);
    eg.lineStyle(2.5, 0xb8c4bd, 0.9);
    eg.beginPath();
    eg.arc(0, 0, 9, Phaser.Math.DegToRad(-70), Phaser.Math.DegToRad(110));
    eg.strokePath();
    eg.beginPath();
    eg.arc(-1, 2, 4.5, Phaser.Math.DegToRad(-40), Phaser.Math.DegToRad(120));
    eg.strokePath();
    eg.lineStyle(3, 0xef4d5b, 0.95);
    eg.lineBetween(-11, -11, 11, 11);
    ear.add(eg);
    this.tweens.add({
      targets: ear, alpha: { from: 0.7, to: 1 }, duration: 900, yoyo: true, repeat: -1, ease: 'Sine.easeInOut',
    });

    return {
      cfg,
      sprite,
      q,
      ear,
      dir: 1,
      s: 0,               // 의심도 0..1
      pulse: Math.random(), // 동심원 위상 (개체마다 어긋나게)
      pauseUntil: 0,
      nextMidAt: this.time.now + Phaser.Math.Between(2200, 4200),
      alerted: false,
      zCount: 0,
    };
  }

  spawnZ(sk) {
    sk.zCount += 1;
    const big = sk.zCount % 2 === 1;
    const z = this.add.text(sk.sprite.x + 14, sk.sprite.y - 94, big ? 'Z' : 'z', {
      fontFamily: 'monospace', fontSize: big ? '18px' : '13px', color: '#9fc4e8',
    }).setOrigin(0.5).setDepth(44).setAlpha(0.85);
    this.tweens.add({
      targets: z,
      y: z.y - 46,
      x: z.x + 14,
      angle: 12,
      alpha: 0,
      scale: 1.45,
      duration: 1600,
      ease: 'Sine.easeOut',
      onComplete: () => z.destroy(),
    });
  }

  // -------------------------------------------------------------------------
  // 출구
  // -------------------------------------------------------------------------

  createExit() {
    this.doorGlow = this.add.rectangle(DOOR_X, DOOR_GROUND - 65, 64, 122, 0x65dad5, 0.07)
      .setStrokeStyle(2, 0x65dad5, 0.55).setDepth(15);
    this.add.rectangle(DOOR_X, DOOR_GROUND - 64, 48, 108, 0x061012, 0.9).setDepth(14);
    this.tweens.add({
      targets: this.doorGlow, alpha: { from: 0.5, to: 1 }, duration: 1200, yoyo: true, repeat: -1, ease: 'Sine.easeInOut',
    });
    this.add.text(DOOR_X, 414, 'GATE://STAGE_2', {
      fontFamily: 'monospace', fontSize: '11px', color: '#65dad5', letterSpacing: 3,
    }).setOrigin(0.5).setDepth(15);
    // interact 리바인딩 대응 — 현재 바인딩된 키를 안내한다.
    this.add.text(DOOR_X, 432, `${store.getState().bindings.interact || 'E'} — HOLD`, {
      fontFamily: 'monospace', fontSize: '10px', color: '#4b8b82', letterSpacing: 2,
    }).setOrigin(0.5).setDepth(15).setAlpha(0.8);
  }

  // -------------------------------------------------------------------------
  // HUD
  // -------------------------------------------------------------------------

  refreshHud() {
    // 침입(truce) 중엔 intrusion HUD(SYSTEM // INTRUSION)를 덮어쓰지 않는다
    if (this.finished || this.__truce || this.__dying) return;
    const runState = getRunState(this);
    const silent = effective('volume') === 0;
    const erased = Boolean(runState.erased.SOUND);

    let rule = 'SOUND = DEATH';
    let objective = '정원을 건너라.';
    let hint = null;
    if (silent) {
      rule = 'VOLUME 0 // WORLD MUTED';
      objective = '감시자가 잠들었다.';
    } else if (erased) {
      rule = 'SOUND = ______';
      objective = '시선만 피하라.';
      hint = '[Q] 위장';
    }

    const payload = {
      mode: 'world',
      chapter: 'STAGE 1 // GARDEN OF SOUND',
      objective,
      rule,
      deaths: runState.deaths,
      hint,
    };
    const json = JSON.stringify(payload);
    if (json === this.lastHudJson) return;
    this.lastHudJson = json;
    emitState(payload);
  }

  // -------------------------------------------------------------------------
  // 발소리
  // -------------------------------------------------------------------------

  spawnStepRing(strong) {
    const reach = stepReach();
    if (reach < 6) return;
    const w = reach * 2 * (strong ? 1.28 : 1);
    const ring = this.add.ellipse(this.player.x, this.player.y, w, w * 0.36)
      .setStrokeStyle(strong ? 2 : 1.5, 0xd7efe4, 1)
      .setDepth(21).setAlpha(strong ? 0.6 : 0.42).setScale(0.12)
      .setBlendMode(Phaser.BlendModes.ADD);
    this.tweens.add({
      targets: ring,
      scaleX: 1,
      scaleY: 1,
      alpha: 0,
      duration: strong ? 560 : 470,
      ease: 'Cubic.easeOut',
      onComplete: () => ring.destroy(),
    });
  }

  // -------------------------------------------------------------------------
  // 감시자 갱신
  // -------------------------------------------------------------------------

  updateSeeker(sk, dt, ctx) {
    const { sleeping, erased, hearR, reach, noisy } = ctx;
    const sprite = sk.sprite;
    const now = this.time.now;
    const player = this.player;

    // --- 수면: 순찰/감지 정지
    if (sleeping) {
      sk.s = 0;
      sk.q.setAlpha(Math.max(0, sk.q.alpha - dt / 200));
      sk.ear.setVisible(false);
      sprite.anims.play('seeker-idle-anim', true);
      return;
    }

    // --- 순찰 (의심 중이면 멈춰서 '듣는다')
    const listening = sk.s > 0.25;
    let walking = false;
    if (!listening && now >= sk.pauseUntil) {
      sprite.x += sk.dir * sk.cfg.speed * (dt / 1000);
      walking = true;
      if (sprite.x >= sk.cfg.maxX) {
        sprite.x = sk.cfg.maxX;
        sk.dir = -1;
        sk.pauseUntil = now + sk.cfg.endPause;
      } else if (sprite.x <= sk.cfg.minX) {
        sprite.x = sk.cfg.minX;
        sk.dir = 1;
        sk.pauseUntil = now + sk.cfg.endPause;
      }
      if (sk.cfg.midPause && now >= sk.nextMidAt) {
        sk.pauseUntil = now + 650;
        sk.nextMidAt = now + Phaser.Math.Between(2200, 4200);
      }
    }
    if (listening) {
      // 소리 나는 쪽으로 몸을 돌린다
      sk.dir = player.x >= sprite.x ? 1 : -1;
    }
    sprite.setFlipX(sk.dir < 0);
    sprite.anims.play(walking ? 'seeker-run-anim' : 'seeker-idle-anim', true);

    // --- 의심도
    const chestX = sprite.x;
    const chestY = sprite.y - 40;
    const px = player.x;
    const py = player.y - 33;
    const dist = Phaser.Math.Distance.Between(chestX, chestY, px, py);

    let rise = 0;
    if (!erased && noisy) {
      const range = hearR + reach;
      const prox = Phaser.Math.Clamp((range - dist) / range, 0, 1);
      if (prox > 0) rise = 0.5 + 3.5 * Math.pow(prox, 1.5);
    }

    // 시각 원뿔 — 위장(Q)으로만 피할 수 있다
    const dx = px - sprite.x;
    const inCone = sk.dir * dx > 26 && sk.dir * dx < 340
      && (sprite.y - player.y) < 145 && (player.y - sprite.y) < 26;
    if (inCone && !ctx.disguised) rise = Math.max(rise, 3.4);

    // 침입(truce) 중엔 의심이 쌓이지 않는다 — 재사망 없음 (PATCH2 truce 규칙)
    if (ctx.truce) rise = 0;

    if (rise > 0) sk.s = Math.min(1, sk.s + rise * (dt / 1000));
    else sk.s = Math.max(0, sk.s - 0.75 * (dt / 1000));

    // 밀착 — 몸이 닿으면 끝
    if (!ctx.truce && dist < 46) sk.s = 1;

    // --- '?' 경고
    if (sk.s > 0.15 && !sk.alerted) {
      sk.alerted = true;
      try { audio.sfx('ui'); } catch { /* noop */ }
      sk.q.setScale(1.7);
      this.tweens.add({ targets: sk.q, scale: 1, duration: 220, ease: 'Back.easeOut' });
    }
    if (sk.s < 0.05) sk.alerted = false;

    sk.q.setPosition(sprite.x, sprite.y - 108 - 8 * sk.s);
    if (sk.s > 0.12) {
      sk.q.setAlpha(Math.min(1, (sk.s - 0.12) / 0.25));
      if (sk.s > 0.8) sk.q.setText('!').setColor('#ef4d5b');
      else sk.q.setText('?').setColor('#e4b65a');
    } else {
      sk.q.setAlpha(Math.max(0, sk.q.alpha - dt / 350));
    }

    // 취소선 귀 아이콘
    sk.ear.setVisible(erased);
    if (erased) sk.ear.setPosition(sprite.x + (sk.dir < 0 ? -26 : 26), sprite.y - 92);

    if (sk.s >= 1) this.detect(sk);
  }

  drawHearing(sk, dt, ctx) {
    const gfx = this.hearingGfx;
    const { sleeping, erased, hearR } = ctx;
    if (sleeping) return;

    const cx = sk.sprite.x;
    const cy = sk.sprite.y - 40;

    if (erased) {
      // 무시되는 청각 — 잿빛 점선 원. 반경은 여전히 volume에 비례해 숨쉰다.
      sk.pulse = (sk.pulse + dt / 3400) % 1;
      gfx.lineStyle(1, 0x7b8a86, 0.1);
      const segs = 28;
      for (let k = 0; k < segs; k += 2) {
        const a0 = (k / segs) * Math.PI * 2;
        const a1 = ((k + 1) / segs) * Math.PI * 2;
        gfx.beginPath();
        gfx.arc(cx, cy, hearR, a0, a1);
        gfx.strokePath();
      }
      const p = sk.pulse;
      gfx.lineStyle(1, 0x7b8a86, 0.06 * (1 - p));
      gfx.strokeCircle(cx, cy, Math.max(8, hearR * p));
      return;
    }

    // 살아 있는 청각 — 의심도에 따라 초록 → 호박 → 적색
    const color = suspicionColor(sk.s);
    sk.pulse = (sk.pulse + (dt / 1600) * (1 + sk.s * 1.4)) % 1;

    gfx.fillStyle(color, 0.022 + 0.035 * sk.s);
    gfx.fillCircle(cx, cy, hearR);
    gfx.lineStyle(1.5, color, 0.14 + 0.22 * sk.s);
    gfx.strokeCircle(cx, cy, hearR);

    for (let i = 0; i < 3; i += 1) {
      const p = (sk.pulse + i / 3) % 1;
      const r = Math.max(6, hearR * p);
      const a = Math.pow(1 - p, 2) * (0.17 + 0.28 * sk.s);
      gfx.lineStyle(2 - p, color, a);
      gfx.strokeCircle(cx, cy, r);
    }
  }

  drawVision(sk, ctx) {
    if (ctx.sleeping) return;
    const gfx = this.visionGfx;
    const sprite = sk.sprite;
    const dir = sk.dir;
    const startX = sprite.x + dir * 18;
    const topY = sprite.y - 46;
    const endX = startX + dir * 330;
    const alpha = ctx.disguised ? 0.03 : 0.07;
    const color = sk.s > 0.5 ? 0xef4d5b : 0xd96b72;
    gfx.fillStyle(color, alpha);
    gfx.fillTriangle(startX, topY, endX, sprite.y - 140, endX, sprite.y + 14);
    gfx.lineStyle(1, color, 0.18);
    gfx.strokeTriangle(startX, topY, endX, sprite.y - 140, endX, sprite.y + 14);
  }

  detect(sk) {
    if (this.finished || this.__dying || this.__truce) return;
    if (this.time.now < (this.detectLockUntil || 0)) return;
    this.detectLockUntil = this.time.now + 1400;
    sk.q.setText('!').setColor('#ef4d5b').setAlpha(1).setScale(1.5);
    sk.sprite.setFlipX(this.player.x < sk.sprite.x);
    this.crosshair.setPosition(this.player.x, this.player.y - 34).setAlpha(1).setScale(3.2).setAngle(0);
    this.tweens.add({
      targets: this.crosshair,
      scale: 1.7,
      angle: 90,
      duration: 260,
      ease: 'Cubic.easeOut',
    });
    this.tweens.add({
      targets: this.crosshair,
      alpha: 0,
      delay: 700,
      duration: 400,
    });
    try { audio.sfx('shot'); } catch { /* noop */ }
    // 죽음 없음 — 들키면 입구로 돌려보내기만 한다.
    this.cameras.main.flash(130, 239, 77, 91);
    this.cameras.main.shake(120, 0.006);
    this.player.setPosition(120, 560).setVelocity(0, 0);
    if (sk.s !== undefined) sk.s = 0;
  }

  // -------------------------------------------------------------------------
  // 수면 전환
  // -------------------------------------------------------------------------

  applySleepTransition(sleeping) {
    if (sleeping) {
      for (const sk of this.seekers) {
        sk.s = 0;
        sk.sprite.setTint(0x7286a8);
        sk.sprite.anims.play('seeker-idle-anim', true);
        if (sk.sprite.anims) sk.sprite.anims.timeScale = 0.45;
        this.tweens.add({
          targets: sk.sprite,
          scaleY: SEEKER_SCALE * 0.93,
          scaleX: SEEKER_SCALE * 1.04,
          duration: 420,
          ease: 'Sine.easeOut',
        });
      }
    } else {
      for (const sk of this.seekers) {
        sk.s = 0;
        sk.sprite.clearTint();
        if (sk.sprite.anims) sk.sprite.anims.timeScale = 1;
        this.tweens.add({
          targets: sk.sprite,
          scaleY: SEEKER_SCALE,
          scaleX: SEEKER_SCALE,
          duration: 260,
          ease: 'Back.easeOut',
        });
        // 깨어날 때 잠깐 두리번
        sk.q.setText('?').setColor('#e4b65a').setAlpha(0.9).setScale(1.4);
        this.tweens.add({ targets: sk.q, alpha: 0, scale: 1, duration: 900, ease: 'Sine.easeOut' });
      }
      try { audio.sfx('ui'); } catch { /* noop */ }
    }
    this.wasSleeping = sleeping;
  }

  // -------------------------------------------------------------------------
  // 문 진행
  // -------------------------------------------------------------------------

  updateDoor(dt) {
    const nearDoor = Math.abs(this.player.x - DOOR_X) < 42
      && Math.abs(this.player.y - DOOR_GROUND) < 84;
    if (nearDoor && this.keys.isDown('interact')) {
      this.doorProgress = Math.min(1, this.doorProgress + dt / 650);
    } else {
      this.doorProgress = Math.max(0, this.doorProgress - dt / 300);
    }

    this.doorGfx.clear();
    if (this.doorProgress > 0.01) {
      this.doorGfx.lineStyle(3, 0x65dad5, 0.9);
      this.doorGfx.beginPath();
      this.doorGfx.arc(
        DOOR_X, DOOR_GROUND - 65, 44,
        Phaser.Math.DegToRad(-90),
        Phaser.Math.DegToRad(-90 + 360 * this.doorProgress),
      );
      this.doorGfx.strokePath();
    }

    if (this.doorProgress >= 1) this.finishStage();
  }

  finishStage() {
    if (this.finished) return;
    this.finished = true;
    const runState = getRunState(this);
    runState.stage = 'Stage2Scene';
    saveRunState(this, runState);

    this.player.setVelocity(0, 0);
    this.player.anims.play('cat-idle-anim', true);
    try { audio.sfx('collect'); } catch { /* noop */ }
    this.cameras.main.flash(260, 101, 218, 213);
    this.tweens.add({
      targets: this.doorGlow,
      scaleX: 1.7,
      scaleY: 1.25,
      alpha: 0,
      duration: 480,
      ease: 'Cubic.easeOut',
    });
    this.time.delayedCall(200, () => this.cameras.main.fadeOut(340, 4, 8, 9));
    this.time.delayedCall(560, () => this.scene.start('Stage2Scene'));
  }

  // -------------------------------------------------------------------------
  // 메인 루프
  // -------------------------------------------------------------------------

  update(time, delta) {
    if (this.finished || !this.player) return;

    const st = updatePlayer(this, this.player, this.keys, this.controller, {
      allowDisguise: true,
    });

    if (this.__dying) return; // 사망 시퀀스 중 — 마지막 프레임의 시각화가 그대로 남는다

    const now = this.time.now;
    const runState = getRunState(this);
    const sleeping = effective('volume') === 0;
    const erased = Boolean(runState.erased.SOUND);
    const hearR = hearRadius();
    const reach = stepReach();

    if (this.wasSleeping === null) this.wasSleeping = !sleeping; // 첫 프레임에 전환 강제
    if (sleeping !== this.wasSleeping) this.applySleepTransition(sleeping);

    // --- 발소리
    const body = this.player.body;
    const moving = st.onGround && body.enable && Math.abs(body.velocity.x) > 10;
    const landed = st.onGround && !this.prevOnGround && this.fallSpeedPrev > 280;
    if (landed && reach > 0) {
      this.landNoiseUntil = now + 200;
      this.spawnStepRing(true);
    }
    if (moving && reach > 0 && now >= this.stepAt) {
      this.stepAt = now + STEP_INTERVAL;
      this.spawnStepRing(false);
    }
    const noisy = moving || now < this.landNoiseUntil;

    // --- 감시자
    const ctx = {
      sleeping, erased, hearR, reach, noisy,
      disguised: st.disguised,
      truce: Boolean(this.__truce),
    };
    this.hearingGfx.clear();
    this.visionGfx.clear();
    for (const sk of this.seekers) {
      this.updateSeeker(sk, delta, ctx);
      if (this.__dying) break;
      this.drawHearing(sk, delta, ctx);
      this.drawVision(sk, ctx);
    }
    if (this.__dying) return;

    // --- 출구
    this.updateDoor(delta);

    // --- 낙하 안전망 (지형은 이어져 있어 사실상 불가능 — 낙사는 폐지, 복귀만) (PATCH2)
    if (this.player.y > 900) {
      this.player.setPosition(120, 540).setVelocity(0, 0);
      this.cameras.main.flash(180, 101, 218, 213);
    }

    this.prevOnGround = st.onGround;
    this.fallSpeedPrev = body.enable ? body.velocity.y : 0;
  }
}
