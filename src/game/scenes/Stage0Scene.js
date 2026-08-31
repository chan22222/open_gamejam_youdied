// ESC/APE — Stage0Scene (B1 · PATCH2 D)
// 어두운 방: 설정을 배우는 죽음.
// 바닥은 이어져 있다(낙사 없음). 중앙 어둠 속 가시 구간(폭 ~90px)을 밟으면 KILLED BY: DARKNESS.
// 어두우면 희미한 표식만, 밝으면 가시가 선명해져 점프로 피할 수 있다.
// 복귀 후 ESC/BRIGHTNESS로 방이 드러나고, 숨은 문이 벽에서 실체화된다.

import Phaser from 'phaser';
import { store, effective } from '../settingsStore.js';
import { audio } from '../audio.js';
import { emitState } from '../events.js';
import { spawnCorpses } from '../corpses.js';
import { attachWorldToys } from '../worldToys.js';
import {
  addDarkness,
  addFloatingMote,
  bindCameraDisplay,
  createInput,
  createPlayer,
  createStaticPlatform,
  getRunState,
  killPlayer,
  registerHidden,
  saveRunState,
  updatePlayer,
} from '../shared.js';

const ROOM_W = 1440;
const ROOM_H = 720;
const FLOOR_TOP = 480;
const SPIKE_CX = 710;
const SPIKE_W = 90;
const SPIKE_L = SPIKE_CX - SPIKE_W / 2;
const SPIKE_R = SPIKE_CX + SPIKE_W / 2;
const SPAWN_X = 150;
const SPAWN_Y = FLOOR_TOP - 2;
const DOOR_X = 1150;
const DOOR_CY = 428; // 문 중심 (바닥 480, 높이 104)
const GATE_X = 1350;
const LAMP_X = 710;
const HOLD_MS = 900;

const CHAPTER = 'STAGE 0 // 어두운 방';

function safeSfx(name) {
  try {
    audio.sfx(name);
  } catch {
    // 오디오는 진행을 막지 않는다.
  }
}

export class Stage0Scene extends Phaser.Scene {
  constructor() {
    super('Stage0Scene');
  }

  create() {
    const runState = getRunState(this);
    this.erasedDarkness = Boolean(runState.erased.DARKNESS);
    this.leaving = false;
    this.holdProgress = 0;
    this.holdTick = 0;
    this.gateDeniedAt = -1000;
    this.roomRevealed = false;
    this.doorActive = false;
    this.doorGlowTween = null;
    this.controller = { lastGroundedAt: -1000, jumpBufferedAt: -1000 };

    this.physics.world.setBounds(0, 0, ROOM_W, ROOM_H);
    this.cameras.main.setBounds(0, 0, ROOM_W, ROOM_H).setBackgroundColor('#040707');

    this.createLocalTextures();
    this.createRoom();
    this.createDoor();
    this.createGate();
    this.createGraffiti();

    // --- 지형 충돌
    this.player = createPlayer(this, SPAWN_X, SPAWN_Y);
    this.physics.add.collider(this.player, this.platforms);
    this.corpseGroup = spawnCorpses(this, this.scene.key);
    this.physics.add.collider(this.player, this.corpseGroup);
    this.keys = createInput(this);
    attachWorldToys(this, { pushables: [] });

    this.cameras.main.startFollow(this.player, true, 0.09, 0.08);
    this.cameras.main.setDeadzone(110, 70);
    bindCameraDisplay(this);

    // --- 어둠: 삭제 전 0.94(거의 암흑), 삭제 후 0.55로 완화
    this.darkness = addDarkness(this, { max: this.erasedDarkness ? 0.55 : 0.94 });

    // --- 상호작용 게이지 / 프롬프트
    this.gauge = this.add.graphics().setDepth(95);
    this.doorPrompt = this.add.text(DOOR_X, 322, 'HOLD [E] // OPEN', {
      fontFamily: 'monospace',
      fontSize: '12px',
      color: '#9ff2e6',
      letterSpacing: 3,
    }).setOrigin(0.5).setDepth(95).setVisible(false);
    this.tweens.add({
      targets: this.doorPrompt,
      y: 316,
      duration: 900,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut',
    });

    // --- HUD 상태
    this.baseObjective = this.erasedDarkness
      ? 'ESC — 밝기를 되찾아라'
      : 'LOCKED // 문이 응답하지 않는다';
    this.currentObjective = this.baseObjective;

    // --- 밝기 반응 (방 공개 플래시 + 문 실체화 상태 전환)
    this.applyBrightness(true);
    const unsubBrightness = store.subscribe((event) => {
      if (event.type === 'change' && event.key !== 'brightness') return;
      this.applyBrightness(false);
    });
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, unsubBrightness);

    audio.setStage('stage0');
    this.pushState({
      hint: this.erasedDarkness ? 'ESC → BRIGHTNESS ↑' : null,
    });

    this.cameras.main.fadeIn(this.erasedDarkness ? 480 : 800, 2, 4, 4);
    this.scheduleLampFlicker();
  }

  // -------------------------------------------------------------------------
  // 텍스처 (씬 로컬, Graphics 생성)
  // -------------------------------------------------------------------------

  createLocalTextures() {
    if (!this.textures.exists('st0-brick')) {
      const g = this.make.graphics({ add: false });
      g.fillStyle(0x0c1614).fillRect(0, 0, 48, 32);
      g.fillStyle(0x101c18);
      g.fillRect(0, 0, 23, 15);
      g.fillRect(25, 0, 23, 15);
      g.fillRect(-12, 17, 23, 15);
      g.fillRect(13, 17, 23, 15);
      g.fillRect(38, 17, 23, 15);
      g.fillStyle(0x1d3327, 0.55).fillRect(30, 20, 7, 4);
      g.fillStyle(0x16281f, 0.5).fillRect(4, 4, 5, 3);
      g.generateTexture('st0-brick', 48, 32);
      g.destroy();
    }

    if (!this.textures.exists('st0-crate')) {
      const g = this.make.graphics({ add: false });
      g.fillStyle(0x18231e).fillRect(0, 0, 36, 36);
      g.lineStyle(2, 0x2b3a31, 1).strokeRect(1, 1, 34, 34);
      g.lineStyle(2, 0x223129, 1);
      g.beginPath();
      g.moveTo(2, 2);
      g.lineTo(34, 34);
      g.strokePath();
      g.generateTexture('st0-crate', 36, 36);
      g.destroy();
    }

    if (!this.textures.exists('st0-spikes')) {
      const g = this.make.graphics({ add: false });
      for (let i = 0; i < 9; i += 1) {
        const x = i * 10;
        const h = 15 + ((i * 5) % 8);
        g.fillStyle(0x24352e, 1).fillTriangle(x, 24, x + 10, 24, x + 5, 24 - h);
        g.fillStyle(0x47605a, 1).fillTriangle(x + 5, 24, x + 10, 24, x + 5, 24 - h);
        g.fillStyle(0x8d262f, 0.95).fillRect(x + 4, 24 - h, 2, 3);
      }
      g.fillStyle(0x101c17, 1).fillRect(0, 22, SPIKE_W, 2);
      g.generateTexture('st0-spikes', SPIKE_W, 24);
      g.destroy();
    }

    if (!this.textures.exists('st0-door')) {
      const g = this.make.graphics({ add: false });
      g.fillStyle(0x0e1a17).fillRect(0, 0, 66, 104);
      g.lineStyle(2, 0x65dad5, 0.95).strokeRect(1, 1, 64, 102);
      g.lineStyle(1, 0x2e5a52, 1);
      g.strokeRect(8, 10, 50, 38);
      g.strokeRect(8, 56, 50, 38);
      g.fillStyle(0x9ff2e6, 0.9).fillCircle(52, 52, 3);
      g.fillStyle(0x65dad5, 0.25).fillRect(4, 4, 58, 3);
      g.generateTexture('st0-door', 66, 104);
      g.destroy();
    }

    if (!this.textures.exists('st0-gate')) {
      const g = this.make.graphics({ add: false });
      g.fillStyle(0x131c1a).fillRect(0, 0, 88, 124);
      g.lineStyle(3, 0x27332e, 1).strokeRect(2, 2, 84, 120);
      g.lineStyle(2, 0x1d2925, 1);
      g.beginPath();
      g.moveTo(44, 4);
      g.lineTo(44, 120);
      g.strokePath();
      for (let y = 14; y < 120; y += 22) {
        g.fillStyle(0x2c3b34, 1).fillRect(8, y, 4, 4);
        g.fillStyle(0x2c3b34, 1).fillRect(76, y, 4, 4);
      }
      g.fillStyle(0x8d262f, 0.85).fillRect(6, 58, 76, 8);
      g.fillStyle(0x0a0f0d, 0.9).fillRect(30, 60, 28, 4);
      g.generateTexture('st0-gate', 88, 124);
      g.destroy();
    }
  }

  // -------------------------------------------------------------------------
  // 방 구성 — 원룸 + 구덩이 + (숨은) 문
  // -------------------------------------------------------------------------

  createRoom() {
    // 뒷벽 벽돌
    this.add.tileSprite(ROOM_W / 2, 286, ROOM_W, 388, 'st0-brick').setDepth(-18);
    this.add.rectangle(ROOM_W / 2, 286, ROOM_W, 388, 0x03100c, 0.35).setDepth(-17);

    // 천장 배관 + 안개
    const pipe = this.add.graphics().setDepth(-10);
    pipe.fillStyle(0x1c2823, 1).fillRect(0, 96, ROOM_W, 6);
    pipe.fillStyle(0x141e1a, 1).fillRect(0, 102, ROOM_W, 2);
    this.add.rectangle(ROOM_W / 2, 430, ROOM_W, 90, 0x7ca69a, 0.04).setDepth(-8);
    this.add.rectangle(ROOM_W / 2, 300, ROOM_W, 70, 0x65dad5, 0.03).setDepth(-8);

    // 죽은 램프 (가시 구간 바로 위 — 가끔 깜빡이며 어둠 속 가시를 스치듯 비춘다)
    const lamp = this.add.graphics().setDepth(9);
    lamp.lineStyle(2, 0x22302b, 1);
    lamp.beginPath();
    lamp.moveTo(LAMP_X, 98);
    lamp.lineTo(LAMP_X, 198);
    lamp.strokePath();
    lamp.fillStyle(0x22302b, 1).fillTriangle(LAMP_X - 14, 212, LAMP_X + 14, 212, LAMP_X, 194);
    lamp.fillStyle(0x38493f, 1).fillCircle(LAMP_X, 213, 3);
    this.lampGlow = this.add.image(LAMP_X, 330, 'glow-orb')
      .setBlendMode(Phaser.BlendModes.ADD)
      .setDepth(91)
      .setTint(0xcfe8d2)
      .setScale(2.3, 3.4)
      .setAlpha(0);

    // 소품: 낡은 상자들
    this.add.image(92, FLOOR_TOP - 18, 'st0-crate').setDepth(10).setAlpha(0.9);
    this.add.image(112, FLOOR_TOP - 52, 'st0-crate').setDepth(10).setScale(0.8).setAlpha(0.85);
    this.add.image(910, FLOOR_TOP - 15, 'st0-crate').setDepth(10).setScale(0.85).setAngle(7).setAlpha(0.8);

    // 부유 먼지
    for (let i = 0; i < 12; i += 1) {
      addFloatingMote(
        this,
        Phaser.Math.Between(60, ROOM_W - 60),
        Phaser.Math.Between(150, FLOOR_TOP - 30),
        0x3f6b5c,
        1,
      );
    }

    // 지형: 이어진 바닥(낙사 없음) + 벽 + 천장
    this.platforms = this.physics.add.staticGroup();
    createStaticPlatform(this, this.platforms, ROOM_W / 2, FLOOR_TOP + 32, ROOM_W, 64);
    createStaticPlatform(this, this.platforms, 24, 360, 48, ROOM_H, 'earth', 0x39514a);
    createStaticPlatform(this, this.platforms, ROOM_W - 24, 360, 48, ROOM_H, 'earth', 0x39514a);
    createStaticPlatform(this, this.platforms, ROOM_W / 2, 46, ROOM_W, 92, 'earth', 0x2c3f38);
  }

  createSpikes() {
    // 본체 — 어둠 오버레이(depth 90) 아래: 밝기를 올려야 선명해진다
    this.add.image(SPIKE_CX, FLOOR_TOP + 1, 'st0-spikes').setOrigin(0.5, 1).setDepth(13);
    const base = this.add.graphics().setDepth(12);
    base.fillStyle(0x0c1512, 0.9).fillRect(SPIKE_L - 6, FLOOR_TOP - 3, SPIKE_W + 12, 5);

    // 표식 — 어둠 위(depth 91): 암흑 속에서 간신히 읽히는 붉은 끝점들
    this.spikeMarks = this.add.graphics().setDepth(91);
    this.spikeMarks.fillStyle(0xef4d5b, 1);
    for (let i = 0; i < 5; i += 1) {
      this.spikeMarks.fillRect(SPIKE_L + 6 + i * 19, FLOOR_TOP - 20 + ((i * 3) % 6), 2, 2);
    }
    this.spikeMarks.setAlpha(0.15);
  }

  createDoor() {
    // 분필 윤곽선 — 밝기 100에서 먼저 드러난다 (벽 윤곽선 -> 실체화의 1단계)
    const outline = this.add.graphics({ x: DOOR_X, y: DOOR_CY }).setDepth(11);
    outline.lineStyle(1, 0x9ff2e6, 0.65);
    const w = 72;
    const h = 112;
    const dash = 7;
    const gap = 6;
    for (let x = -w / 2; x < w / 2; x += dash + gap) {
      outline.lineBetween(x, -h / 2, Math.min(x + dash, w / 2), -h / 2);
      outline.lineBetween(x, h / 2, Math.min(x + dash, w / 2), h / 2);
    }
    for (let y = -h / 2; y < h / 2; y += dash + gap) {
      outline.lineBetween(-w / 2, y, -w / 2, Math.min(y + dash, h / 2));
      outline.lineBetween(w / 2, y, w / 2, Math.min(y + dash, h / 2));
    }
    registerHidden(this, outline, { threshold: 100 });

    // 문 본체 — 밝기 125에서 실체화 (2단계)
    this.doorGlow = this.add.image(DOOR_X, DOOR_CY + 2, 'glow-orb')
      .setBlendMode(Phaser.BlendModes.ADD)
      .setDepth(11)
      .setTint(0x65dad5)
      .setScale(2.6)
      .setAlpha(0);

    this.doorContainer = this.add.container(DOOR_X, DOOR_CY).setDepth(12);
    const opening = this.add.rectangle(0, 2, 54, 92, 0x02120f);
    this.doorSlab = this.add.image(0, 2, 'st0-door');
    const sign = this.add.text(0, -66, 'EXIT', {
      fontFamily: 'monospace',
      fontSize: '10px',
      color: '#65dad5',
      letterSpacing: 4,
    }).setOrigin(0.5);
    this.doorContainer.add([opening, this.doorSlab, sign]);
    registerHidden(this, this.doorContainer, { threshold: 125 });
  }

  createGate() {
    // 잠긴 정문 — 어떤 상호작용도 통하지 않는다. 붉은 LED만 어둠 속에서 깜빡인다.
    this.gate = this.add.image(GATE_X, FLOOR_TOP - 62, 'st0-gate').setDepth(12);
    this.gateLed = this.add.image(GATE_X, FLOOR_TOP - 100, 'white-pixel')
      .setBlendMode(Phaser.BlendModes.ADD)
      .setDepth(91)
      .setTint(0xef4d5b)
      .setScale(3);
    this.tweens.add({
      targets: this.gateLed,
      alpha: { from: 0.9, to: 0.15 },
      duration: 850,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut',
    });
    this.add.text(GATE_X, FLOOR_TOP - 140, 'LOCKED', {
      fontFamily: 'monospace',
      fontSize: '9px',
      color: '#ef4d5b',
      letterSpacing: 4,
    }).setOrigin(0.5).setDepth(13).setAlpha(0.8);
  }

  createGraffiti() {
    // 낙서는 어둠 위(depth 91)에 둔다 — 암흑에서도 간신히 읽힌다.
    const mainAlpha = this.erasedDarkness ? 0.92 : 0.15;
    this.add.text(330, 356, 'ESC — 빛은 메뉴 안에 있다', {
      fontFamily: 'Georgia, serif',
      fontSize: '21px',
      fontStyle: 'italic',
      color: '#d9d2c1',
    }).setOrigin(0.5).setDepth(91).setAngle(-1.5).setAlpha(mainAlpha);
    const scratch = this.add.graphics().setDepth(91).setAlpha(mainAlpha * 0.6);
    scratch.lineStyle(1, 0xd9d2c1, 0.7);
    scratch.lineBetween(232, 372, 424, 375);

    this.add.text(590, 424, '어둠이 가시를 숨긴다', {
      fontFamily: 'Georgia, serif',
      fontSize: '13px',
      fontStyle: 'italic',
      color: '#8d9c94',
    }).setOrigin(0.5).setDepth(91).setAngle(2).setAlpha(this.erasedDarkness ? 0.6 : 0.13);
  }

  // -------------------------------------------------------------------------
  // 밝기 = 물리 법칙
  // -------------------------------------------------------------------------

  applyBrightness(first) {
    const b = effective('brightness');

    if (!this.roomRevealed && b >= 100) {
      this.roomRevealed = true;
      if (!first) this.cameras.main.flash(320, 186, 224, 209);
    }

    const active = b >= 125;
    if (active === this.doorActive) return;
    this.doorActive = active;

    if (this.doorGlowTween) {
      this.doorGlowTween.stop();
      this.doorGlowTween = null;
    }

    if (active) {
      this.doorGlow.setAlpha(0.18);
      this.doorGlowTween = this.tweens.add({
        targets: this.doorGlow,
        alpha: 0.42,
        duration: 900,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.easeInOut',
      });
      this.currentObjective = 'EXIT MATERIALIZED // 문 앞에서 홀드';
      if (!first && !this.leaving && !this.__dying && !this.__truce) {
        this.cameras.main.shake(120, 0.0018);
        this.pushState({ hint: '문이 벽에서 걸어 나왔다.' });
      }
    } else {
      this.doorGlow.setAlpha(0);
      this.currentObjective = this.baseObjective;
      if (!first && !this.leaving && !this.__dying && !this.__truce) this.pushState();
    }
  }

  pushState(extra = {}) {
    // PATCH2: DARKNESS 삭제가 in-scene에서 일어난다 — 캐시가 아니라 runState를 읽는다.
    const runState = getRunState(this);
    const erased = this.erasedDarkness || Boolean(runState.erased.DARKNESS);
    emitState({
      mode: 'world',
      chapter: CHAPTER,
      objective: this.currentObjective,
      rule: erased ? 'DARKNESS = ______' : 'DARKNESS = DEATH',
      deaths: runState.deaths,
      ...extra,
    });
  }

  // -------------------------------------------------------------------------
  // 램프 깜빡임 — 어둠 속에서 가시를 스치듯 비춘다
  // -------------------------------------------------------------------------

  scheduleLampFlicker() {
    this.time.delayedCall(Phaser.Math.Between(2600, 5200), () => {
      if (this.leaving) return;
      this.tweens.add({
        targets: this.lampGlow,
        alpha: { from: 0, to: 0.55 },
        duration: 65,
        yoyo: true,
        repeat: 2,
        onComplete: () => this.lampGlow.setAlpha(0),
      });
      this.scheduleLampFlicker();
    });
  }

  // -------------------------------------------------------------------------
  // 업데이트 루프
  // -------------------------------------------------------------------------

  update(time, delta) {
    if (!this.player || !this.player.body) return;

    if (this.leaving || this.__dying) {
      this.gauge.clear();
      this.doorPrompt.setVisible(false);
      return;
    }

    updatePlayer(this, this.player, this.keys, this.controller, {
      allowDisguise: false,
      allowDash: false,
    });

    // 가시 표식 — 어둠이 깊을수록 붉은 끝점만 희미하게 남는다 (밝으면 본체가 선명)
    if (this.spikeMarks && this.darkness) {
      this.spikeMarks.setAlpha(Phaser.Math.Clamp(this.darkness.alpha * 0.22, 0, 0.2));
    }

    this.updateSpikes();
    this.updateGate();
    this.updateDoor(delta);
  }

  updateSpikes() {
    // 1스테이지엔 치명 요소 없음 — 밝기 퍼즐만.
  }

  updateGate() {
    const near = Math.abs(this.player.x - GATE_X) < 60 && this.player.y > 380;
    if (!near || !this.keys.justPressed('interact')) return;
    const now = this.time.now;
    if (now - this.gateDeniedAt < 700) return;
    this.gateDeniedAt = now;

    safeSfx('ui');
    this.tweens.add({
      targets: this.gate,
      x: GATE_X + 3,
      duration: 34,
      yoyo: true,
      repeat: 3,
      onComplete: () => this.gate.setX(GATE_X),
    });
    this.tweens.add({
      targets: this.gateLed,
      scale: 4.6,
      duration: 90,
      yoyo: true,
    });
    this.floatText(GATE_X, FLOOR_TOP - 170, 'ACCESS DENIED', '#ef4d5b');
    this.floatText(GATE_X, FLOOR_TOP - 154, '권한이 없습니다', '#8d9c94');
  }

  updateDoor(delta) {
    const near = this.doorActive
      && Math.abs(this.player.x - DOOR_X) < 50
      && this.player.y > 380 && this.player.y <= FLOOR_TOP + 4;

    this.doorPrompt.setVisible(near);
    if (near) {
      const key = store.getState().bindings.interact || 'E';
      this.doorPrompt.setText(`HOLD [${key}] // OPEN`);
    }

    if (near && this.keys.isDown('interact')) {
      const prev = this.holdProgress;
      this.holdProgress = Math.min(1, this.holdProgress + delta / HOLD_MS);
      const quarter = Math.floor(this.holdProgress * 4);
      if (quarter > this.holdTick) {
        this.holdTick = quarter;
        safeSfx('type');
      }
      if (prev < 1 && this.holdProgress >= 1) this.beginExit();
    } else {
      this.holdProgress = Math.max(0, this.holdProgress - delta / 450);
      if (this.holdProgress === 0) this.holdTick = 0;
    }

    this.gauge.clear();
    if (this.holdProgress > 0) {
      const gx = DOOR_X;
      const gy = 348;
      this.gauge.lineStyle(3, 0x0d2622, 0.9);
      this.gauge.beginPath();
      this.gauge.arc(gx, gy, 15, 0, Math.PI * 2);
      this.gauge.strokePath();
      this.gauge.lineStyle(3, 0x9ff2e6, 1);
      this.gauge.beginPath();
      this.gauge.arc(gx, gy, 15, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * this.holdProgress);
      this.gauge.strokePath();
    }
  }

  // -------------------------------------------------------------------------
  // 클리어 — 화이트 플래시 -> Stage1
  // -------------------------------------------------------------------------

  beginExit() {
    if (this.leaving) return;
    this.leaving = true;
    this.player.setVelocity(0, 0);
    this.gauge.clear();
    this.doorPrompt.setVisible(false);
    safeSfx('collect');

    // 문이 열린다 — 슬래브가 사라지고 안쪽의 빛이 쏟아진다
    this.tweens.add({
      targets: this.doorSlab,
      alpha: 0,
      duration: 380,
      ease: 'Sine.easeIn',
    });
    const burst = this.add.image(DOOR_X, DOOR_CY, 'glow-orb')
      .setBlendMode(Phaser.BlendModes.ADD)
      .setDepth(96)
      .setTint(0xf2fff9)
      .setScale(1)
      .setAlpha(0.9);
    this.tweens.add({
      targets: burst,
      scale: 8,
      alpha: 0,
      duration: 760,
      ease: 'Cubic.easeOut',
    });
    if (this.textures.exists('white-pixel')) {
      const sparks = this.add.particles(DOOR_X, DOOR_CY, 'white-pixel', {
        speed: { min: 60, max: 240 },
        quantity: 16,
        lifespan: { min: 260, max: 620 },
        scale: { start: 2, end: 0 },
        alpha: { start: 1, end: 0 },
        tint: [0xf2fff9, 0x9ff2e6, 0x65dad5],
        emitting: false,
      }).setDepth(96);
      sparks.explode(16);
    }

    const white = this.add.rectangle(480, 270, 2400, 1400, 0xffffff)
      .setScrollFactor(0)
      .setDepth(200)
      .setAlpha(0);
    this.tweens.add({
      targets: white,
      alpha: 1,
      delay: 200,
      duration: 560,
      ease: 'Sine.easeIn',
    });
    this.cameras.main.zoomTo(this.cameras.main.zoom * 1.1, 760, 'Sine.easeInOut');

    this.time.delayedCall(820, () => {
      const runState = getRunState(this);
      runState.stage = 'Stage1Scene';
      saveRunState(this, runState);
      this.scene.start('Stage1Scene');
    });
  }

  // -------------------------------------------------------------------------
  // 헬퍼
  // -------------------------------------------------------------------------

  floatText(x, y, str, color) {
    const t = this.add.text(x, y, str, {
      fontFamily: 'monospace',
      fontSize: '11px',
      color,
      letterSpacing: 2,
    }).setOrigin(0.5).setDepth(96).setAlpha(0);
    this.tweens.add({
      targets: t,
      alpha: 1,
      y: y - 6,
      duration: 140,
      ease: 'Sine.easeOut',
      onComplete: () => {
        this.tweens.add({
          targets: t,
          y: y - 30,
          alpha: 0,
          delay: 520,
          duration: 480,
          ease: 'Sine.easeIn',
          onComplete: () => t.destroy(),
        });
      },
    });
  }
}
