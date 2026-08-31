// ESC/APE — BossScene (B4)
// STAGE 3 // SYS_ADMIN — 당신이 죽음으로 쌓아 올린 설정을, 관리자가 회수하러 온다.
// 페이즈1: 설정 창 = 방패 / 페이즈2: 설정 창 = 광원 / 페이즈3: UI 재조립 / 페이즈4: 예정된 죽음.
// runState.bossPhase 로 페이즈 저장/복원 — 사망 후 해당 페이즈부터 재도전.
// PATCH2: 페이즈1~3 사망은 in-scene 침입(__truce 중 재사망 없음), 낙사 폐지(구덩이=복귀),
//         UI 조각은 dynamic body — SHAKE 슬라이더/패널 드래그의 장난감이 된다.

import Phaser from 'phaser';
import { EV, emit, emitState } from '../events.js';
import { store } from '../settingsStore.js';
import { audio } from '../audio.js';
import { spawnCorpses } from '../corpses.js';
import { attachWorldToys } from '../worldToys.js';
import {
  VIEW_WIDTH,
  VIEW_HEIGHT,
  addFloatingMote,
  bindCameraDisplay,
  createInput,
  createPlayer,
  createStaticPlatform,
  getRunState,
  killPlayer,
  saveRunState,
  updatePlayer,
  worldToUi,
} from '../shared.js';

const ARENA_W = 1440; // 좌우 폐쇄형 1.5화면
const GROUND_Y = 522; // 지면 플랫폼 중심 (top = 502)
const GROUND_TOP = 502;
const PIT_1 = { left: 432, right: 528 }; // 페이즈2에 열리는 구덩이
const PIT_2 = { left: 912, right: 1008 };
const BRK_X = 1398; // 브레이커(배전반) 위치
const SPAWN = { x: 90, y: 498 };
const CHAPTER = 'STAGE 3 // SYS_ADMIN';
const BLOCKS_NEEDED = 8;
const SHOT_SPEED = 300;
const HOMER_SPEED = 145;
const LIGHT_RADIUS = 170; // 패널 광원 반경 (화면 px)
const BREAKER_HOLD_MS = 1150;
const HINT_SHIELD = '설정 창을 드래그해 막아라';
const HINT_LIGHT = '설정 창이 광원이다 — 브레이커로';

// interact가 리바인딩됐을 수 있으므로 키 안내 문구는 현재 바인딩을 읽어 조합한다.
function interactKeyName() {
  return store.getState().bindings.interact || 'E';
}
function hintFrag() {
  return `UI 조각 5개 — [${interactKeyName()}]`;
}

const FRAGMENT_DEFS = [
  { name: 'SLIDER KNOB', x: 150, y: 478 },
  { name: 'TOGGLE', x: 250, y: 366 },
  { name: 'TITLEBAR', x: 720, y: 366 },
  { name: 'CLOSE BUTTON', x: 1180, y: 366 },
  { name: 'GAUGE', x: 1360, y: 478 },
];

function sfx(name) {
  try {
    audio.sfx(name);
  } catch {
    // 오디오는 절대 보스전을 멈추지 않는다.
  }
}

export class BossScene extends Phaser.Scene {
  constructor() {
    super('BossScene');
  }

  create() {
    this.phase = 0;
    this.cine = true; // true인 동안 보스는 공격하지 않는다 (플레이어 이동은 자유)
    this.transitioning = false;
    this.blockCount = 0;
    this.fragCount = 0;
    this.breakerProgress = 0;
    this.breakerDone = false;
    this.respawnLockUntil = 0;
    this.nextGlitchAt = 0;
    this.fragments = [];
    this.hatches = [];
    this.darkG = null;
    this.holeG = null;
    this.lightGlow = null;
    this.pipsG = null;
    this.pipsLabel = null;
    this.volleyEvent = null;
    this.homerEvent = null;

    const rs = getRunState(this);
    const entryPhase = Phaser.Math.Clamp(rs.bossPhase || 0, 0, 4);

    audio.setStage('boss');
    emit(EV.BOSS, { phase: 'corrupt' }); // HUD RGB 분리 글리치 — 관리자의 존재감

    this.cameras.main.setBackgroundColor('#05070c');
    this.physics.world.setBounds(0, 0, ARENA_W, 820);
    this.cameras.main.setBounds(0, 0, ARENA_W, VIEW_HEIGHT);

    this.buildArena(entryPhase);

    this.player = createPlayer(this, SPAWN.x, SPAWN.y);
    this.player.setCollideWorldBounds(true);
    this.pctrl = { lastGroundedAt: -1000, jumpBufferedAt: -1000 };
    this.keysIn = createInput(this);

    this.physics.add.collider(this.player, this.platforms);
    this.corpseGroup = spawnCorpses(this, 'BossScene');
    this.physics.add.collider(this.player, this.corpseGroup);

    // PATCH2 2절: SHAKE/패널 밀치기 — UI 조각은 스폰 시 register, intrusion 버튼은 코어가 자동 등록
    attachWorldToys(this, { pushables: [] });

    this.cameras.main.startFollow(this.player, true, 0.12, 0.12);
    bindCameraDisplay(this);

    this.buildBoss();

    this.shots = this.physics.add.group({ allowGravity: false });
    this.homers = this.physics.add.group({ allowGravity: false });
    this.physics.add.overlap(this.player, this.shots, (_p, shot) => {
      if (this.tryBlock(shot)) return;
      this.onPlayerHit();
    });
    this.physics.add.overlap(this.player, this.homers, () => this.onPlayerHit());
    // 탄막은 지형을 통과한다 — 막을 수 있는 것은 설정 창(UI)뿐이다. (수명 4.2s로 자연 소멸)

    emitState({
      mode: 'boss',
      chapter: CHAPTER,
      objective: 'INTRUDER PROTOCOL // ENGAGED',
      rule: 'ADMIN > USER',
      deaths: rs.deaths,
    });

    if (entryPhase <= 1) {
      this.introCinematic(entryPhase === 1);
    } else if (entryPhase === 2) {
      this.bossRoot.setPosition(720, 200);
      this.time.delayedCall(450, () => this.beginPhase2(true));
    } else if (entryPhase === 3) {
      this.bossRoot.setPosition(720, 250);
      this.time.delayedCall(450, () => this.beginPhase3(true));
    } else {
      this.bossRoot.setPosition(720, 310);
      this.time.delayedCall(650, () => this.beginPhase4(true));
    }

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      if (this.holeG) {
        this.holeG.destroy();
        this.holeG = null;
      }
    });
  }

  // -------------------------------------------------------------------------
  // 아레나 — 서버실 느낌의 폐쇄 공간
  // -------------------------------------------------------------------------

  buildArena(entryPhase) {
    // 배경 (줌아웃 대비 크게)
    this.add.rectangle(ARENA_W / 2, 270, ARENA_W + 1400, 2000, 0x070a10).setDepth(0);

    // 배경 그리드 — 시스템 공간
    const grid = this.add.graphics().setDepth(1);
    grid.lineStyle(1, 0x1c3a44, 0.16);
    for (let x = 0; x <= ARENA_W; x += 96) grid.lineBetween(x, 0, x, 540);
    for (let y = 60; y <= 540; y += 96) grid.lineBetween(0, y, ARENA_W, y);

    // 서버 랙 실루엣 + LED
    const rackColors = [0x18e07a, 0xef4d5b, 0x65dad5, 0xe8c66a];
    for (let i = 0; i < 10; i += 1) {
      const rx = 90 + i * 142 + ((i * 37) % 24);
      const rh = 130 + ((i * 53) % 90);
      this.add.rectangle(rx, GROUND_TOP - rh / 2, 58, rh, 0x0c141c).setDepth(2);
      this.add.rectangle(rx, GROUND_TOP - rh / 2, 58, rh).setStrokeStyle(1, 0x1a2733, 0.9).setDepth(2);
      for (let l = 0; l < 5; l += 1) {
        const led = this.add.rectangle(
          rx - 18 + ((l * 17 + i * 5) % 36),
          GROUND_TOP - 18 - ((l * 31 + i * 13) % (rh - 30)),
          3, 3,
          rackColors[(i + l) % rackColors.length],
        ).setDepth(3).setAlpha(0.7);
        this.tweens.add({
          targets: led,
          alpha: { from: 0.15, to: 0.85 },
          duration: Phaser.Math.Between(380, 1400),
          yoyo: true,
          repeat: -1,
          delay: Phaser.Math.Between(0, 900),
        });
      }
    }

    // 벽 낙서 — 힌트는 세계 안에 있다
    this.add.text(320, 462, 'ADMIN SEES ALL', {
      fontFamily: 'monospace', fontSize: '13px', color: '#67d0c8', letterSpacing: 4,
    }).setOrigin(0.5).setAlpha(0.14).setDepth(3).setAngle(-2);
    this.add.text(1060, 452, '설정은 너의 것이 아니다', {
      fontFamily: 'Georgia, serif', fontSize: '14px', color: '#c98a92',
    }).setOrigin(0.5).setAlpha(0.16).setDepth(3).setAngle(1.5);

    // 지형
    this.platforms = this.physics.add.staticGroup();
    const steel = 0x6f8493;
    createStaticPlatform(this, this.platforms, 216, GROUND_Y, 432, 40, 'earth', steel);
    createStaticPlatform(this, this.platforms, 720, GROUND_Y, 384, 40, 'earth', steel);
    createStaticPlatform(this, this.platforms, 1224, GROUND_Y, 432, 40, 'earth', steel);

    // 지면 하부 채움 + 구덩이 심연
    this.add.rectangle(216, 680, 432, 280, 0x0a1016).setDepth(11);
    this.add.rectangle(720, 680, 384, 280, 0x0a1016).setDepth(11);
    this.add.rectangle(1224, 680, 432, 280, 0x0a1016).setDepth(11);
    for (const pit of [PIT_1, PIT_2]) {
      const cx = (pit.left + pit.right) / 2;
      this.add.rectangle(cx, 700, pit.right - pit.left, 320, 0x04060a).setDepth(10);
      const glow = this.add.rectangle(cx, 810, pit.right - pit.left, 90, 0x35090f).setDepth(10).setAlpha(0.8);
      this.tweens.add({ targets: glow, alpha: { from: 0.4, to: 0.9 }, duration: 1200, yoyo: true, repeat: -1 });
    }

    // 부유 플랫폼
    createStaticPlatform(this, this.platforms, 250, 404, 150, 26, 'earth', 0x7d8f9c);
    createStaticPlatform(this, this.platforms, 720, 404, 170, 26, 'earth', 0x7d8f9c);
    createStaticPlatform(this, this.platforms, 1180, 404, 150, 26, 'earth', 0x7d8f9c);
    createStaticPlatform(this, this.platforms, 480, 300, 110, 24, 'earth', 0x8d9fab);
    createStaticPlatform(this, this.platforms, 960, 300, 110, 24, 'earth', 0x8d9fab);

    // 해치 — 페이즈1에서 구덩이를 덮고 있다가 페이즈2에 붕괴
    if (entryPhase < 2) {
      for (const pit of [PIT_1, PIT_2]) {
        const cx = (pit.left + pit.right) / 2;
        const hatch = createStaticPlatform(this, this.platforms, cx, 512, pit.right - pit.left + 8, 20, 'earth', 0x8c7a55);
        const stripe = this.add.graphics().setDepth(13);
        stripe.fillStyle(0xe8c66a, 0.5);
        for (let sx = pit.left - 2; sx < pit.right; sx += 18) stripe.fillRect(sx, 503, 9, 3);
        hatch.__stripe = stripe;
        this.hatches.push(hatch);
      }
    } else {
      this.buildPitMarkers();
    }

    // 좌우 폐쇄 벽
    const wallG = this.add.graphics().setDepth(14);
    for (const [wx, dir] of [[0, 1], [ARENA_W, -1]]) {
      wallG.fillStyle(0x0d1620, 1).fillRect(wx - (dir < 0 ? 26 : 0), 0, 26, 540);
      wallG.fillStyle(0xe8c66a, 0.35);
      for (let y = 20; y < 540; y += 46) {
        wallG.fillRect(wx + (dir < 0 ? -22 : 4), y, 18, 8);
      }
      wallG.fillStyle(0xef4d5b, 0.25);
      for (let y = 43; y < 540; y += 46) {
        wallG.fillRect(wx + (dir < 0 ? -22 : 4), y, 18, 8);
      }
    }

    this.buildBreaker();

    for (let i = 0; i < 16; i += 1) {
      addFloatingMote(this, Phaser.Math.Between(60, ARENA_W - 60), Phaser.Math.Between(90, 480), 0x5a1f2a, 1);
    }
  }

  buildPitMarkers() {
    // 구덩이 가장자리 표식 — 어둠(depth 90) 위에서도 희미하게 보인다
    this.pitMarkers = [];
    for (const pit of [PIT_1, PIT_2]) {
      for (const px of [pit.left, pit.right]) {
        const m = this.add.rectangle(px, 505, 5, 5, 0xef4d5b).setDepth(92).setAlpha(0.28);
        this.tweens.add({ targets: m, alpha: { from: 0.1, to: 0.38 }, duration: 900, yoyo: true, repeat: -1 });
        this.pitMarkers.push(m);
      }
    }
  }

  buildBreaker() {
    const bx = BRK_X;
    const by = GROUND_TOP - 24;
    const g = this.add.graphics().setDepth(15);
    g.fillStyle(0x101c26, 1).fillRect(bx - 15, by - 22, 30, 44);
    g.lineStyle(2, 0x3a5a66, 1).strokeRect(bx - 15, by - 22, 30, 44);
    // 번개 글리프
    g.lineStyle(2, 0xe8c66a, 0.9);
    g.beginPath();
    g.moveTo(bx + 4, by - 14);
    g.lineTo(bx - 5, by + 1);
    g.lineTo(bx + 1, by + 1);
    g.lineTo(bx - 4, by + 14);
    g.strokePath();
    this.add.text(bx, by + 32, 'BRK-01', {
      fontFamily: 'monospace', fontSize: '8px', color: '#67d0c8', letterSpacing: 2,
    }).setOrigin(0.5).setAlpha(0.55).setDepth(15);

    // 스파크 — 페이즈2부터 방출 (어둠 위 depth 92: 어둠 속 등대)
    this.breakerSparks = this.add.particles(bx, by - 20, 'white-pixel', {
      speed: { min: 50, max: 170 },
      angle: { min: 230, max: 310 },
      gravityY: 520,
      quantity: 2,
      frequency: 130,
      lifespan: { min: 220, max: 520 },
      scale: { start: 1.7, end: 0 },
      alpha: { start: 1, end: 0 },
      tint: [0xffe08a, 0x9fe8ec],
      emitting: false,
    }).setDepth(92);

    this.breakerBarG = this.add.graphics().setDepth(93);
    this.breakerPrompt = this.add.text(bx, by - 52, `[${interactKeyName()}] HOLD`, {
      fontFamily: 'monospace', fontSize: '11px', color: '#ffe08a', letterSpacing: 2,
    }).setOrigin(0.5).setDepth(93).setVisible(false);
    this.tweens.add({ targets: this.breakerPrompt, alpha: { from: 1, to: 0.35 }, duration: 460, yoyo: true, repeat: -1 });
  }

  // -------------------------------------------------------------------------
  // 보스 — 거대 SEEKER, 어두운 틴트 + 주기적 글리치
  // -------------------------------------------------------------------------

  buildBoss() {
    this.bossRoot = this.add.container(760, -180).setDepth(40);
    this.bossAura = this.add.image(0, -86, 'glow-orb')
      .setScale(5.2)
      .setTint(0x8a1f33)
      .setAlpha(0.4)
      .setBlendMode(Phaser.BlendModes.ADD);
    this.bossSprite = this.add.sprite(0, 0, 'seeker-idle')
      .setOrigin(0.5, 1)
      .setScale(5.6)
      .setTint(0x5a2f45);
    this.bossSprite.anims.play('seeker-idle-anim');
    this.bossRoot.add([this.bossAura, this.bossSprite]);

    // 눈 — 컨테이너 밖 depth 92: 페이즈2의 어둠 속에서도 빛난다
    this.eyeA = this.add.image(0, 0, 'glow-orb').setScale(0.26).setTint(0xff2440)
      .setBlendMode(Phaser.BlendModes.ADD).setDepth(92);
    this.eyeB = this.add.image(0, 0, 'glow-orb').setScale(0.26).setTint(0xff2440)
      .setBlendMode(Phaser.BlendModes.ADD).setDepth(92);

    // 부유 (컨테이너 이동 트윈과 충돌하지 않도록 스프라이트 로컬 y로)
    this.tweens.add({
      targets: this.bossSprite,
      y: { from: 0, to: -14 },
      duration: 1700,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut',
    });
  }

  bossMuzzle() {
    return { x: this.bossRoot.x, y: this.bossRoot.y + this.bossSprite.y - 95 };
  }

  bossSay(text, onDone) {
    if (this.sayT) this.sayT.destroy();
    this.sayT = this.add.text(this.bossRoot.x, Math.max(70, this.bossRoot.y - 230), '', {
      fontFamily: 'monospace',
      fontSize: '15px',
      color: '#ffb0b8',
      align: 'center',
      lineSpacing: 6,
    }).setOrigin(0.5).setDepth(95);
    this.typeText(this.sayT, text, 34, () => {
      this.time.delayedCall(750, () => {
        if (this.sayT) {
          this.tweens.add({
            targets: this.sayT,
            alpha: 0,
            duration: 420,
            onComplete: () => { if (this.sayT) { this.sayT.destroy(); this.sayT = null; } },
          });
        }
        if (onDone) onDone();
      });
    });
  }

  typeText(target, full, msPerChar, onDone) {
    target.setText('');
    let i = 0;
    return this.time.addEvent({
      delay: msPerChar,
      repeat: full.length - 1,
      callback: () => {
        i += 1;
        if (target.active) {
          target.setText(full.slice(0, i));
          const ch = full[i - 1];
          if (ch && ch !== ' ' && ch !== '\n' && i % 2 === 0) sfx('type');
        }
        // 텍스트가 파괴돼도 진행 콜백은 반드시 전달한다 — 연출 체인 유실 방지
        if (i >= full.length && onDone) onDone();
      },
    });
  }

  introCinematic(reentry) {
    this.cine = true;
    // 강림
    sfx('rumble');
    this.tweens.add({
      targets: this.bossRoot,
      y: 330,
      duration: 1250,
      ease: 'Quad.easeIn',
      onComplete: () => {
        this.cameras.main.shake(260, 0.008);
        this.cameras.main.flash(120, 140, 30, 45);
        sfx('rumble');
        this.glitchBurst();
        const line = reentry
          ? 'RESUME: ENFORCEMENT.\n또 왔습니까.'
          : 'UNAUTHORIZED SETTINGS DETECTED.\n권한을 회수합니다.';
        this.bossSay(line, () => {
          this.time.delayedCall(400, () => this.beginPhase1());
        });
      },
    });
  }

  glitchBurst() {
    for (let k = 0; k < 3; k += 1) {
      this.time.delayedCall(k * 70, () => {
        if (!this.bossSprite || !this.bossSprite.active) return;
        const ghost = this.add.image(
          this.bossRoot.x + Phaser.Math.Between(-12, 12),
          this.bossRoot.y + this.bossSprite.y,
          this.bossSprite.texture.key,
          this.bossSprite.frame.name,
        )
          .setOrigin(0.5, 1)
          .setScale(5.6)
          .setFlipX(this.bossSprite.flipX)
          .setTint(k % 2 === 0 ? 0x22e0e0 : 0xff3355)
          .setAlpha(0.35)
          .setBlendMode(Phaser.BlendModes.ADD)
          .setDepth(39);
        this.time.delayedCall(70, () => ghost.destroy());
      });
    }
    if (this.bossSprite && this.bossSprite.active) {
      this.bossSprite.setTintFill(0xffffff);
      this.time.delayedCall(50, () => {
        if (this.bossSprite && this.bossSprite.active) this.bossSprite.setTint(0x5a2f45);
      });
    }
  }

  driftBoss() {
    if (this.__dying || this.transitioning) return;
    let range = null;
    if (this.phase === 1) range = { x: [880, 1280], y: [250, 380] };
    else if (this.phase === 3) range = { x: [380, 1100], y: [210, 300] };
    if (!range) return;
    this.tweens.add({
      targets: this.bossRoot,
      x: Phaser.Math.Between(range.x[0], range.x[1]),
      y: Phaser.Math.Between(range.y[0], range.y[1]),
      duration: Phaser.Math.Between(1500, 2200),
      ease: 'Sine.easeInOut',
      onComplete: () => this.time.delayedCall(Phaser.Math.Between(300, 800), () => this.driftBoss()),
    });
  }

  setBossPhase(n) {
    const rs = getRunState(this);
    rs.bossPhase = n;
    saveRunState(this, rs);
  }

  // -------------------------------------------------------------------------
  // 공통 연출 헬퍼
  // -------------------------------------------------------------------------

  showBanner(text, color) {
    const cont = this.add.container(VIEW_WIDTH / 2, 170).setScrollFactor(0).setDepth(96);
    const style = { fontFamily: 'monospace', fontSize: '27px', letterSpacing: 8 };
    const ghostR = this.add.text(2, 1, text, { ...style, color: '#ff5560' }).setOrigin(0.5).setAlpha(0.45);
    const ghostC = this.add.text(-2, -1, text, { ...style, color: '#65dad5' }).setOrigin(0.5).setAlpha(0.45);
    const main = this.add.text(0, 0, text, { ...style, color }).setOrigin(0.5);
    cont.add([ghostR, ghostC, main]);
    cont.setScale(1.3).setAlpha(0);
    this.tweens.add({ targets: cont, scale: 1, alpha: 1, duration: 140, ease: 'Cubic.easeOut' });
    for (let k = 1; k <= 5; k += 1) {
      this.time.delayedCall(140 + k * 90, () => {
        if (cont.active) cont.x = VIEW_WIDTH / 2 + Phaser.Math.Between(-3, 3);
      });
    }
    this.time.delayedCall(1650, () => {
      if (!cont.active) return;
      this.tweens.add({ targets: cont, alpha: 0, duration: 340, onComplete: () => cont.destroy() });
    });
    return cont;
  }

  bannerSmall(text) {
    const t = this.add.text(VIEW_WIDTH / 2, 74, text, {
      fontFamily: 'monospace', fontSize: '14px', color: '#9fe8ec', letterSpacing: 4,
    }).setOrigin(0.5).setScrollFactor(0).setDepth(96).setAlpha(0);
    this.tweens.add({ targets: t, alpha: 1, y: 68, duration: 160, ease: 'Cubic.easeOut' });
    this.time.delayedCall(1400, () => {
      if (!t.active) return;
      this.tweens.add({ targets: t, alpha: 0, duration: 320, onComplete: () => t.destroy() });
    });
  }

  floatText(x, y, text, color) {
    const t = this.add.text(x, y, text, {
      fontFamily: 'monospace', fontSize: '11px', color, letterSpacing: 2,
    }).setOrigin(0.5).setDepth(94);
    this.tweens.add({ targets: t, y: y - 26, alpha: 0, duration: 820, ease: 'Cubic.easeOut', onComplete: () => t.destroy() });
  }

  burst(x, y, tint, quantity = 10, speedMax = 180) {
    if (!this.textures.exists('white-pixel')) return;
    const p = this.add.particles(x, y, 'white-pixel', {
      speed: { min: 40, max: speedMax },
      quantity,
      lifespan: { min: 200, max: 520 },
      scale: { start: 1.9, end: 0 },
      alpha: { start: 0.95, end: 0 },
      tint,
      emitting: false,
    }).setDepth(60);
    p.explode(quantity);
    this.time.delayedCall(650, () => p.destroy());
  }

  // -------------------------------------------------------------------------
  // 페이즈 1 — 음파탄 vs 설정 창 방패
  // -------------------------------------------------------------------------

  beginPhase1() {
    this.phase = 1;
    this.cine = false;
    this.setBossPhase(1);
    store.set('integrity', 100); // 재도전 시 패널 내구도 리셋
    this.blockCount = 0;
    this.drawPips();
    this.showBanner('ENFORCEMENT // SONIC ROUNDS', '#ff8a94');
    emitState({
      mode: 'boss',
      chapter: CHAPTER,
      objective: `INTERCEPTED 0/${BLOCKS_NEEDED}`,
      rule: 'ADMIN > USER',
      deaths: getRunState(this).deaths,
      hint: HINT_SHIELD,
    });
    this.tweens.add({ targets: this.bossRoot, x: 1120, y: 300, duration: 1100, ease: 'Sine.easeInOut' });
    this.time.delayedCall(1200, () => this.driftBoss());
    this.volleyEvent = this.time.addEvent({ delay: 4400, loop: true, callback: () => this.startVolley() });
    this.time.delayedCall(1400, () => this.startVolley());
  }

  drawPips() {
    if (!this.pipsG) {
      this.pipsG = this.add.graphics().setScrollFactor(0).setDepth(95);
      this.pipsLabel = this.add.text(VIEW_WIDTH / 2, 30, 'SONIC INTERCEPT', {
        fontFamily: 'monospace', fontSize: '9px', color: '#67d0c8', letterSpacing: 4,
      }).setOrigin(0.5).setScrollFactor(0).setDepth(95).setAlpha(0.8);
    }
    const g = this.pipsG;
    g.clear();
    const x0 = VIEW_WIDTH / 2 - (BLOCKS_NEEDED * 16) / 2;
    for (let i = 0; i < BLOCKS_NEEDED; i += 1) {
      if (i < this.blockCount) {
        g.fillStyle(0x65dad5, 1).fillRect(x0 + i * 16, 40, 10, 10);
      } else {
        g.lineStyle(1, 0x2e5a52, 1).strokeRect(x0 + i * 16, 40, 10, 10);
      }
    }
  }

  startVolley() {
    if (this.phase !== 1 || this.cine || this.__dying || this.__truce || this.transitioning) return;
    const n = Phaser.Math.Between(3, 5);
    for (let i = 0; i < n; i += 1) {
      this.time.delayedCall(i * 680, () => this.telegraphShot());
    }
  }

  telegraphShot() {
    if (this.phase !== 1 || this.__dying || this.__truce || this.transitioning || !this.player) return;
    const m = this.bossMuzzle();
    const target = {
      x: this.player.x + this.player.body.velocity.x * 0.2 + Phaser.Math.Between(-14, 14),
      y: this.player.y - 30 + Phaser.Math.Between(-10, 10),
    };
    // 조준선 텔레그래프 0.6초
    const g = this.add.graphics().setDepth(55).setAlpha(0.25);
    g.lineStyle(2, 0xff5560, 0.55).lineBetween(m.x, m.y, target.x, target.y);
    g.lineStyle(1, 0xff5560, 0.8).strokeCircle(target.x, target.y, 11);
    this.tweens.add({ targets: g, alpha: { from: 0.25, to: 0.9 }, duration: 95, yoyo: true, repeat: 2 });
    this.time.delayedCall(580, () => {
      g.destroy();
      this.fireShot(m, target);
    });
  }

  fireShot(m, target) {
    if (this.phase !== 1 || this.__dying || this.transitioning) return;
    sfx('shot');
    const flash = this.add.image(m.x, m.y, 'glow-orb').setScale(1.4).setTint(0xff7580)
      .setBlendMode(Phaser.BlendModes.ADD).setDepth(48);
    this.tweens.add({ targets: flash, scale: 0.2, alpha: 0, duration: 180, onComplete: () => flash.destroy() });

    const shot = this.shots.create(m.x, m.y, 'glow-orb');
    shot.setScale(0.9).setTint(0xff5f6e).setBlendMode(Phaser.BlendModes.ADD).setDepth(50);
    shot.body.setCircle(14, 18, 18);
    const ang = Phaser.Math.Angle.Between(m.x, m.y, target.x, target.y);
    shot.body.setVelocity(Math.cos(ang) * SHOT_SPEED, Math.sin(ang) * SHOT_SPEED);
    shot.bornAt = this.time.now;
    // 동심원 링
    shot.ring = this.add.ellipse(m.x, m.y, 44, 44)
      .setStrokeStyle(2, 0xffa2ab, 0.9)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setDepth(49);
    this.tweens.add({
      targets: shot.ring,
      scaleX: { from: 0.35, to: 1.55 },
      scaleY: { from: 0.35, to: 1.55 },
      alpha: { from: 0.9, to: 0 },
      duration: 620,
      repeat: -1,
    });
  }

  destroyShot(shot, impact) {
    if (!shot || !shot.active) return;
    if (shot.ring) {
      this.tweens.killTweensOf(shot.ring);
      shot.ring.destroy();
      shot.ring = null;
    }
    if (impact) this.burst(shot.x, shot.y, 0xff5f6e, 7, 140);
    shot.destroy();
  }

  clearShots() {
    for (const shot of [...this.shots.getChildren()]) this.destroyShot(shot, false);
    for (const orb of [...this.homers.getChildren()]) this.destroyHomer(orb, false);
  }

  // 설정 창(=panelRect)과 겹치면 차단. 유리 파편 + 내구도 감소 + HUD 흔들림.
  tryBlock(shot) {
    if (!shot || !shot.active) return false;
    const s = store.getState();
    if (!s.panelOpen || !s.panelRect || s.corrupted) return false;
    const ui = worldToUi(this, shot.x, shot.y);
    const m = 14; // 관용 마진
    const r = s.panelRect;
    if (ui.x < r.x - m || ui.x > r.x + r.w + m || ui.y < r.y - m || ui.y > r.y + r.h + m) return false;
    this.onBlock(shot);
    return true;
  }

  onBlock(shot) {
    const sx = shot.x;
    const sy = shot.y;
    this.glassBurst(sx, sy);
    this.destroyShot(shot, false);
    sfx('shield');
    emit(EV.PANEL_HIT);
    store.set('integrity', store.getState().integrity - 12);
    this.blockCount += 1;
    this.drawPips();
    this.floatText(sx, sy - 18, `INTERCEPT ${this.blockCount}/${BLOCKS_NEEDED}`, '#9fe8ec');
    this.cameras.main.shake(55, 0.0022);
    emitState({
      mode: 'boss',
      chapter: CHAPTER,
      objective: `INTERCEPTED ${this.blockCount}/${BLOCKS_NEEDED}`,
      rule: 'ADMIN > USER',
      deaths: getRunState(this).deaths,
      hint: HINT_SHIELD,
    });
    if (this.blockCount >= BLOCKS_NEEDED && !this.transitioning) {
      this.transitioning = true;
      if (this.volleyEvent) { this.volleyEvent.remove(); this.volleyEvent = null; }
      this.clearShots();
      this.time.delayedCall(750, () => {
        this.transitioning = false;
        this.beginPhase2(false);
      });
    }
  }

  glassBurst(x, y) {
    // 유리 깨지는 파편
    for (let i = 0; i < 8; i += 1) {
      const shard = this.add.rectangle(
        x, y,
        2 + Phaser.Math.Between(0, 3),
        7 + Phaser.Math.Between(0, 7),
        0xd6f3f7,
      ).setDepth(60).setAngle(Phaser.Math.Between(0, 180));
      this.tweens.add({
        targets: shard,
        x: x + Phaser.Math.Between(-90, 90),
        y: y + Phaser.Math.Between(-50, 120),
        angle: shard.angle + Phaser.Math.Between(-540, 540),
        alpha: 0,
        duration: 460 + Phaser.Math.Between(0, 200),
        ease: 'Cubic.easeOut',
        onComplete: () => shard.destroy(),
      });
    }
    this.burst(x, y, 0x9fe8ec, 12, 200);
  }

  // -------------------------------------------------------------------------
  // 페이즈 2 — REVOKE: BRIGHTNESS. 설정 창이 광원이다.
  // -------------------------------------------------------------------------

  beginPhase2(reentry) {
    this.phase = 2;
    this.cine = false;
    this.setBossPhase(2);
    if (this.volleyEvent) { this.volleyEvent.remove(); this.volleyEvent = null; }
    this.clearShots();
    if (this.pipsG) { this.pipsG.destroy(); this.pipsG = null; }
    if (this.pipsLabel) { this.pipsLabel.destroy(); this.pipsLabel = null; }

    store.revoke('brightness');
    this.showBanner('REVOKE: BRIGHTNESS', '#ff5560');
    sfx('rumble');
    this.cameras.main.shake(420, 0.006);

    // 해치 붕괴 — 구덩이가 열린다
    if (this.hatches.length) {
      for (const hatch of this.hatches) {
        hatch.body.enable = false;
        if (hatch.__stripe) hatch.__stripe.destroy();
        this.burst(hatch.x, hatch.y - 8, 0x8c7a55, 10, 130);
        this.tweens.add({
          targets: hatch,
          y: hatch.y + 420,
          angle: Phaser.Math.Between(-50, 50),
          alpha: 0,
          duration: 900,
          ease: 'Quad.easeIn',
          onComplete: () => hatch.destroy(),
        });
      }
      this.hatches = [];
      this.buildPitMarkers();
    }

    // 보스는 어둠 뒤로 물러난다 — 눈만 남는다
    this.tweens.add({ targets: this.bossRoot, x: 720, y: 200, duration: 1400, ease: 'Sine.easeInOut' });

    // 암전
    this.createDarknessLayer();
    this.tweens.add({ targets: this.darkG, alpha: 0.93, duration: reentry ? 450 : 1500, ease: 'Sine.easeIn' });

    this.breakerProgress = 0;
    this.breakerDone = false;
    this.breakerSparks.start();

    emitState({
      mode: 'boss',
      chapter: CHAPTER,
      objective: `RESTORE: BREAKER // ${interactKeyName()}-HOLD`,
      rule: 'REVOKED: BRIGHTNESS',
      deaths: getRunState(this).deaths,
      hint: HINT_LIGHT,
    });
  }

  createDarknessLayer() {
    if (this.darkG) return;
    this.darkG = this.add.rectangle(VIEW_WIDTH / 2, VIEW_HEIGHT / 2, 2600, 1600, 0x03040a)
      .setScrollFactor(0)
      .setDepth(90)
      .setAlpha(0);
    this.holeG = this.make.graphics({ add: false });
    const mask = this.holeG.createGeometryMask();
    mask.setInvertAlpha(true); // 그린 원 = 구멍
    this.darkG.setMask(mask);
    this.lightGlow = this.add.image(0, 0, 'glow-orb')
      .setTint(0xfff2cf)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setDepth(91)
      .setVisible(false);
  }

  updateLightHole(time) {
    if (!this.holeG || !this.darkG) return;
    const s = store.getState();
    this.holeG.clear();
    if (s.panelOpen && s.panelRect && !s.corrupted) {
      const cam = this.cameras.main;
      const cx = s.panelRect.x + s.panelRect.w / 2;
      const cy = s.panelRect.y + s.panelRect.h / 2;
      const wx = cam.worldView.x + cx / cam.zoom;
      const wy = cam.worldView.y + cy / cam.zoom;
      const r = LIGHT_RADIUS / cam.zoom;
      this.holeG.fillStyle(0xffffff, 1).fillCircle(wx, wy, r);
      this.lightGlow
        .setPosition(wx, wy)
        .setScale((r * 2) / 64 * 1.3)
        .setAlpha(0.3 + Math.sin(time * 0.013) * 0.06)
        .setVisible(true);
    } else if (this.lightGlow) {
      this.lightGlow.setVisible(false);
    }
  }

  updateBreaker(delta) {
    if (this.breakerDone || !this.player) return;
    const near = Math.abs(this.player.x - BRK_X) < 52 && this.player.y > 420;
    this.breakerPrompt.setVisible(near);
    if (near && this.keysIn.isDown('interact')) {
      this.breakerProgress = Math.min(BREAKER_HOLD_MS, this.breakerProgress + delta);
      if (this.breakerProgress >= BREAKER_HOLD_MS) {
        this.completeBreaker();
        return;
      }
    } else {
      this.breakerProgress = Math.max(0, this.breakerProgress - delta * 2);
    }
    const g = this.breakerBarG;
    g.clear();
    if (this.breakerProgress > 0) {
      const w = 60;
      const t = this.breakerProgress / BREAKER_HOLD_MS;
      g.fillStyle(0x0a1016, 0.9).fillRect(BRK_X - w / 2 - 2, GROUND_TOP - 70, w + 4, 10);
      g.fillStyle(0xffe08a, 1).fillRect(BRK_X - w / 2, GROUND_TOP - 68, w * t, 6);
      g.lineStyle(1, 0xffe08a, 0.7).strokeRect(BRK_X - w / 2 - 2, GROUND_TOP - 70, w + 4, 10);
    }
  }

  completeBreaker() {
    if (this.breakerDone) return;
    this.breakerDone = true;
    this.breakerBarG.clear();
    this.breakerPrompt.setVisible(false);
    sfx('unlock');
    this.breakerSparks.explode(26);
    this.breakerSparks.stop();
    this.cameras.main.flash(500, 255, 240, 200);
    store.restore('brightness');
    this.showBanner('POWER REROUTED // BRIGHTNESS RESTORED', '#8de8a0');
    if (this.darkG) {
      this.tweens.add({
        targets: this.darkG,
        alpha: 0,
        duration: 850,
        onComplete: () => {
          if (this.darkG) { this.darkG.clearMask(true); this.darkG.destroy(); this.darkG = null; }
          if (this.holeG) { this.holeG.destroy(); this.holeG = null; }
          if (this.lightGlow) { this.lightGlow.destroy(); this.lightGlow = null; }
        },
      });
    }
    this.time.delayedCall(1150, () => this.beginPhase3(false));
  }

  // -------------------------------------------------------------------------
  // 페이즈 3 — 패널 파괴, UI 조각 재조립
  // -------------------------------------------------------------------------

  beginPhase3(reentry) {
    this.phase = 3;
    this.cine = false;
    this.setBossPhase(3);
    this.fragCount = 0;
    this.breakerSparks.stop();

    const lastRect = store.getState().panelRect;
    emit(EV.BOSS, { phase: 'shatter' });
    store.set('corrupted', true);
    sfx('erase');
    this.cameras.main.flash(200, 255, 255, 255);
    this.cameras.main.shake(350, 0.009);
    this.panelShatterFx(lastRect);
    this.showBanner('PANEL // SHATTERED', '#ff5560');

    this.tweens.add({ targets: this.bossRoot, x: 700, y: 240, duration: 1200, ease: 'Sine.easeInOut' });
    this.time.delayedCall(1300, () => this.driftBoss());

    // 조각 낙하 (스태거)
    this.time.delayedCall(700, () => {
      FRAGMENT_DEFS.forEach((def, i) => {
        this.time.delayedCall(i * 170, () => this.spawnFragment(def));
      });
    });

    this.homerEvent = this.time.addEvent({ delay: 2600, loop: true, callback: () => this.spawnHomer() });

    emitState({
      mode: 'boss',
      chapter: CHAPTER,
      objective: 'REASSEMBLE: UI 0/5',
      rule: 'PANEL // SHATTERED',
      deaths: getRunState(this).deaths,
      hint: hintFrag(),
    });
  }

  panelShatterFx(rect) {
    // 화면공간 파열 — 마지막 패널 위치(없으면 중앙)에서 조각이 튄다
    const cx = rect ? rect.x + rect.w / 2 : VIEW_WIDTH / 2;
    const cy = rect ? rect.y + rect.h / 2 : VIEW_HEIGHT / 2;
    for (let i = 0; i < 14; i += 1) {
      const shard = this.add.rectangle(
        cx + Phaser.Math.Between(-30, 30),
        cy + Phaser.Math.Between(-20, 20),
        3 + Phaser.Math.Between(0, 5),
        8 + Phaser.Math.Between(0, 10),
        i % 3 === 0 ? 0x65dad5 : 0xd6f3f7,
      ).setScrollFactor(0).setDepth(96).setAngle(Phaser.Math.Between(0, 180));
      this.tweens.add({
        targets: shard,
        x: shard.x + Phaser.Math.Between(-260, 260),
        y: shard.y + Phaser.Math.Between(-140, 260),
        angle: shard.angle + Phaser.Math.Between(-720, 720),
        alpha: 0,
        duration: 700 + Phaser.Math.Between(0, 350),
        ease: 'Cubic.easeOut',
        onComplete: () => shard.destroy(),
      });
    }
  }

  spawnFragment(def) {
    if (this.phase !== 3) return;
    const cont = this.add.container(def.x, -60).setDepth(45);
    const glow = this.add.image(0, 0, 'glow-orb').setScale(1.4).setTint(0x65dad5)
      .setAlpha(0.4).setBlendMode(Phaser.BlendModes.ADD);
    const g = this.add.graphics();
    this.drawFragment(g, def.name);
    cont.add([glow, g]);
    cont.setScale(1.55);

    // PATCH2: 조각 = dynamic body — 물리로 낙하하고, SHAKE 임펄스/패널 드래그에 밀린다
    cont.setSize(46, 30);
    this.physics.add.existing(cont);
    cont.body.setBounce(0.3, 0.25);
    cont.body.setDrag(140, 0);
    cont.body.setMaxVelocity(420, 980);
    cont.body.setCollideWorldBounds(true);
    this.physics.add.collider(cont, this.platforms);
    this.physics.add.collider(cont, this.corpseGroup);
    if (this.__worldToys) this.__worldToys.register(cont);

    const prompt = this.add.text(def.x, def.y - 46, `[${interactKeyName()}]`, {
      fontFamily: 'monospace', fontSize: '11px', color: '#9fe8ec',
    }).setOrigin(0.5).setDepth(93).setVisible(false);
    this.tweens.add({ targets: prompt, alpha: { from: 1, to: 0.35 }, duration: 420, yoyo: true, repeat: -1 });
    this.tweens.add({ targets: glow, alpha: { from: 0.25, to: 0.55 }, duration: 900, yoyo: true, repeat: -1 });

    this.fragments.push({
      name: def.name, cont, glow, prompt, homeX: def.x, homeY: def.y, collected: false, landed: false,
    });
  }

  // 실제 UI 부품처럼 그린다 — 슬라이더 노브 / 토글 / 타이틀바 / X버튼 / 게이지
  drawFragment(g, name) {
    if (name === 'SLIDER KNOB') {
      g.fillStyle(0x24333d, 1).fillRect(-20, -2, 40, 4);
      g.fillStyle(0x65dad5, 1).fillRect(-20, -2, 22, 4);
      g.fillStyle(0xdfe9ec, 1).fillRoundedRect(-3, -10, 10, 20, 3);
      g.lineStyle(1, 0x65dad5, 1).strokeRoundedRect(-3, -10, 10, 20, 3);
    } else if (name === 'TOGGLE') {
      g.fillStyle(0x2f7a5c, 1).fillRoundedRect(-17, -8, 34, 16, 8);
      g.lineStyle(1, 0x65dad5, 0.9).strokeRoundedRect(-17, -8, 34, 16, 8);
      g.fillStyle(0xf2f6f4, 1).fillCircle(8, 0, 7);
    } else if (name === 'TITLEBAR') {
      g.fillStyle(0x13242b, 1).fillRect(-28, -7, 56, 14);
      g.lineStyle(1, 0x65dad5, 1).strokeRect(-28, -7, 56, 14);
      g.fillStyle(0xef4d5b, 1).fillCircle(-21, 0, 2.5);
      g.fillStyle(0xe8c66a, 1).fillCircle(-13, 0, 2.5);
      g.fillStyle(0x3f5a63, 1).fillRect(-4, -2, 26, 4);
    } else if (name === 'CLOSE BUTTON') {
      g.fillStyle(0x30161c, 1).fillRect(-9, -9, 18, 18);
      g.lineStyle(1, 0xef4d5b, 1).strokeRect(-9, -9, 18, 18);
      g.lineStyle(2, 0xef4d5b, 1);
      g.beginPath();
      g.moveTo(-4, -4); g.lineTo(4, 4);
      g.moveTo(-4, 4); g.lineTo(4, -4);
      g.strokePath();
    } else { // GAUGE
      g.lineStyle(1, 0x65dad5, 1).strokeRect(-24, -6, 48, 12);
      for (let i = 0; i < 5; i += 1) {
        g.fillStyle(0xe8c66a, i < 3 ? 1 : 0.28).fillRect(-22 + i * 9, -4, 7, 8);
      }
    }
  }

  updateFragments() {
    if (!this.player) return;
    for (const frag of this.fragments) {
      if (frag.collected || !frag.cont.active) continue;
      const cont = frag.cont;
      if (!frag.landed && cont.body && (cont.body.blocked.down || cont.body.touching.down)) {
        frag.landed = true;
        this.burst(cont.x, cont.y + 12, 0x65dad5, 6, 90);
      }
      // 구덩이에 빠진 조각은 회수된다 — 재조립은 절대 막히지 않는다 (소프트락 금지)
      if (cont.y > 620 && cont.body) {
        cont.body.reset(frag.homeX, 60);
        frag.landed = false;
        this.burst(frag.homeX, 100, 0x65dad5, 5, 90);
      }
      frag.prompt.setPosition(cont.x, cont.y - 44);
      const near = Math.abs(this.player.x - cont.x) < 44 && Math.abs(this.player.y - cont.y) < 74;
      frag.prompt.setVisible(near && frag.landed);
      if (near && frag.landed && this.keysIn.isDown('interact')) this.collectFragment(frag);
    }
  }

  collectFragment(frag) {
    if (frag.collected) return;
    frag.collected = true;
    const cont = frag.cont;
    if (cont.body) cont.body.enable = false;
    if (this.__worldToys) this.__worldToys.unregister(cont);
    frag.prompt.destroy();
    sfx('collect');
    this.burst(cont.x, cont.y, 0x9fe8ec, 14, 190);
    this.tweens.killTweensOf(cont);
    this.tweens.add({
      targets: cont,
      y: cont.y - 42,
      scale: 2.1,
      alpha: 0,
      duration: 340,
      ease: 'Cubic.easeOut',
      onComplete: () => cont.destroy(),
    });
    this.fragCount += 1;
    this.bannerSmall(`RESTORED: ${frag.name}`);
    emitState({
      mode: 'boss',
      chapter: CHAPTER,
      objective: `REASSEMBLE: UI ${this.fragCount}/5`,
      rule: 'PANEL // SHATTERED',
      deaths: getRunState(this).deaths,
      hint: hintFrag(),
    });
    if (this.fragCount >= 5) this.completeRestore();
  }

  completeRestore() {
    if (this.homerEvent) { this.homerEvent.remove(); this.homerEvent = null; }
    this.clearShots();
    store.set('corrupted', false);
    store.set('integrity', 100);
    emit(EV.BOSS, { phase: 'restored' });
    sfx('unlock');
    this.cameras.main.flash(300, 141, 232, 160);
    this.showBanner('PANEL // RESTORED', '#8de8a0');
    emitState({
      mode: 'boss',
      chapter: CHAPTER,
      objective: 'PANEL RESTORED',
      rule: 'ADMIN // FURIOUS',
      deaths: getRunState(this).deaths,
    });
    // PATCH2: intrusion(truce)이 걷힌 뒤에만 최종 연출 — killPlayer가 무시되는 소프트락 방지
    this.time.delayedCall(1600, () => this.whenSafe(() => this.beginPhase4(false)));
  }

  // intrusion 활성(__truce) / 사망 연출(__dying)이 끝날 때까지 콜백을 미룬다.
  // 어떤 이유로든 플래그가 안 풀리면(연출 체인 유실 등) 강제로 걷어내고 진행한다 — 절대 멈추지 않는다.
  whenSafe(cb, deadline = 14) {
    if (!this.__truce && !this.__dying) {
      cb();
      return;
    }
    if (deadline <= 0) {
      this.__truce = false;
      this.__dying = false;
      cb();
      return;
    }
    this.time.delayedCall(300, () => this.whenSafe(cb, deadline - 1));
  }

  spawnHomer() {
    if (this.phase !== 3 || this.__dying || this.__truce || !this.player) return;
    if (this.homers.countActive(true) >= 3) return;
    sfx('shot');
    const m = this.bossMuzzle();
    const orb = this.homers.create(m.x, m.y, 'glow-orb');
    orb.setScale(1.05).setTint(0xc77dff).setBlendMode(Phaser.BlendModes.ADD).setDepth(50);
    orb.body.setCircle(13, 19, 19);
    const ang = Phaser.Math.Angle.Between(m.x, m.y, this.player.x, this.player.y - 28);
    orb.body.setVelocity(Math.cos(ang) * HOMER_SPEED, Math.sin(ang) * HOMER_SPEED);
    orb.bornAt = this.time.now;
    orb.trail = this.add.particles(0, 0, 'white-pixel', {
      follow: orb,
      speed: { min: 5, max: 25 },
      lifespan: 420,
      quantity: 1,
      frequency: 35,
      scale: { start: 1.6, end: 0 },
      alpha: { start: 0.5, end: 0 },
      tint: 0xc77dff,
    }).setDepth(49);
  }

  destroyHomer(orb, pop) {
    if (!orb || !orb.active) return;
    if (orb.trail) { orb.trail.destroy(); orb.trail = null; }
    if (pop) this.burst(orb.x, orb.y, 0xc77dff, 8, 130);
    orb.destroy();
  }

  updateHomers(time, delta) {
    if (!this.player) return;
    for (const orb of [...this.homers.getChildren()]) {
      if (!orb.active) continue;
      if (time > orb.bornAt + 8000) {
        this.destroyHomer(orb, true);
        continue;
      }
      const b = orb.body;
      const targetAng = Math.atan2(this.player.y - 28 - orb.y, this.player.x - orb.x);
      const cur = Math.atan2(b.velocity.y, b.velocity.x);
      const next = Phaser.Math.Angle.RotateTo(cur, targetAng, 0.028 * (delta / 16.6));
      b.setVelocity(Math.cos(next) * HOMER_SPEED, Math.sin(next) * HOMER_SPEED);
    }
  }

  // -------------------------------------------------------------------------
  // 페이즈 4 — 예정된 죽음. 회피 불가 전면 빔.
  // -------------------------------------------------------------------------

  beginPhase4(reentry) {
    this.phase = 4;
    this.cine = true;
    this.setBossPhase(4); // DeathspaceScene이 최종 탑 변형으로 진입한다
    if (this.volleyEvent) { this.volleyEvent.remove(); this.volleyEvent = null; }
    if (this.homerEvent) { this.homerEvent.remove(); this.homerEvent = null; }
    this.clearShots();
    this.tweens.killTweensOf(this.bossRoot);

    emitState({
      mode: 'boss',
      chapter: CHAPTER,
      objective: 'FINAL DIRECTIVE // INESCAPABLE',
      rule: 'ADMIN OVERRIDE',
      deaths: getRunState(this).deaths,
      hint: '피할 수 없다',
    });

    sfx('rumble');
    this.tweens.add({
      targets: this.bossRoot,
      x: 720,
      y: 310,
      duration: reentry ? 700 : 1250,
      ease: 'Sine.easeInOut',
    });
    this.tweens.add({ targets: this.bossSprite, scaleX: 6.1, scaleY: 6.1, duration: 1250 });

    this.buildWarningOverlay();

    const sayDelay = reentry ? 800 : 1350;
    this.time.delayedCall(sayDelay, () => {
      if (this.__dying) return;
      // 죽기 직전 대사
      this.bossSay('설정할 수 없는 것이 하나 남았다.', () => this.chargeBeam(reentry));
    });
  }

  buildWarningOverlay() {
    this.warnG = this.add.graphics().setScrollFactor(0).setDepth(96).setAlpha(0);
    this.warnG.fillStyle(0xef4d5b, 0.22);
    this.warnG.fillRect(-820, -430, 2600, 460); // 상
    this.warnG.fillRect(-820, 510, 2600, 460); // 하
    this.warnG.fillRect(-820, -430, 850, 1400); // 좌
    this.warnG.fillRect(930, -430, 850, 1400); // 우
    this.warnG.lineStyle(3, 0xef4d5b, 0.85).strokeRect(34, 34, VIEW_WIDTH - 68, VIEW_HEIGHT - 68);
    this.tweens.add({ targets: this.warnG, alpha: { from: 0.15, to: 0.75 }, duration: 420, yoyo: true, repeat: -1 });

    this.warnT = this.add.text(VIEW_WIDTH / 2, 96, 'WARNING // FINAL DIRECTIVE: DELETE USER', {
      fontFamily: 'monospace', fontSize: '17px', color: '#ff5560', letterSpacing: 5,
    }).setOrigin(0.5).setScrollFactor(0).setDepth(96);
    this.tweens.add({ targets: this.warnT, alpha: { from: 1, to: 0.2 }, duration: 330, yoyo: true, repeat: -1 });

    for (let i = 0; i < 3; i += 1) this.time.delayedCall(i * 900, () => sfx('rumble'));
  }

  chargeBeam(reentry) {
    if (this.__dying) return;
    const chargeMs = reentry ? 1500 : 2100;
    this.cameras.main.shake(chargeMs, 0.003);

    // 수렴하는 빛 — 화면 사방에서 보스에게 빨려든다
    const converge = reentry ? 7 : 11;
    for (let i = 0; i < converge; i += 1) {
      this.time.delayedCall(i * (chargeMs / converge), () => {
        if (this.__dying || !this.bossRoot) return;
        const ang = Phaser.Math.FloatBetween(0, Math.PI * 2);
        const dist = Phaser.Math.Between(260, 480);
        const gx = this.bossRoot.x + Math.cos(ang) * dist;
        const gy = this.bossRoot.y - 90 + Math.sin(ang) * dist;
        const spark = this.add.image(gx, gy, 'glow-orb')
          .setScale(0.7).setTint(0xffb0b8).setAlpha(0)
          .setBlendMode(Phaser.BlendModes.ADD).setDepth(55);
        this.tweens.add({
          targets: spark,
          x: this.bossRoot.x,
          y: this.bossRoot.y - 90,
          alpha: { from: 0.9, to: 0 },
          scale: 0.2,
          duration: 420,
          ease: 'Cubic.easeIn',
          onComplete: () => spark.destroy(),
        });
      });
    }

    // 보스 백열 — 점점 빨라지는 명멸
    for (let i = 0; i < 6; i += 1) {
      this.time.delayedCall((chargeMs * 0.35) + i * (chargeMs * 0.1), () => this.glitchBurst());
    }

    this.time.delayedCall(chargeMs, () => this.fireBeam());
  }

  fireBeam() {
    if (this.__dying) return;
    sfx('shot');
    sfx('rumble');
    // 전면 빔 — 세로 기둥이 화면 전체로 팽창한다
    const beam = this.add.rectangle(this.bossRoot.x, 270, 70, 2000, 0xffe9ec)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setDepth(96)
      .setAlpha(0.95)
      .setScaleX(0.15);
    this.tweens.add({ targets: beam, scaleX: 44, duration: 300, ease: 'Expo.easeIn' });
    const white = this.add.rectangle(VIEW_WIDTH / 2, VIEW_HEIGHT / 2, 2600, 1600, 0xfff4f4)
      .setScrollFactor(0)
      .setDepth(97)
      .setAlpha(0);
    this.tweens.add({ targets: white, alpha: 0.9, duration: 300, ease: 'Expo.easeIn' });
    this.cameras.main.shake(500, 0.02);
    this.cameras.main.flash(300, 255, 230, 235);
    this.time.delayedCall(260, () => this.finalKill());
  }

  // 최종 일격 — truce가 살아 있으면 걷힐 때까지 재시도한다 (killPlayer는 truce 중 no-op)
  finalKill(tries = 0) {
    if (this.__dying) return;
    if (this.__truce) {
      if (tries < 8) {
        this.time.delayedCall(350, () => this.finalKill(tries + 1));
        return;
      }
      this.__truce = false; // 재시도 한계 — 강제로 걷어내고 최종 연출 진행
    }
    killPlayer(this, 'ADMIN');
  }

  // -------------------------------------------------------------------------
  // 피격 / 낙하 / 프레임 업데이트
  // -------------------------------------------------------------------------

  onPlayerHit() {
    // PATCH2: __truce(침입 활성) 중 재사망 없음 — 탄/빔 판정 공용 가드
    if (this.__dying || this.__truce) return;
    killPlayer(this, 'ADMIN');
  }

  handleFall(time) {
    if (time < this.respawnLockUntil) return;
    // PATCH2: 낙사 사망 폐지(GRAVITY 폐지) — 구덩이는 입구로 되돌려보낼 뿐이다
    this.respawnLockUntil = time + 600;
    this.player.setPosition(SPAWN.x, SPAWN.y);
    this.player.setVelocity(0, 0);
    this.cameras.main.flash(160, 190, 220, 255);
    sfx('ui');
  }

  updateBossFx(time) {
    if (!this.bossRoot || !this.bossSprite || !this.bossSprite.active) return;
    this.bossSprite.setFlipX(this.player.x < this.bossRoot.x);
    const flip = this.bossSprite.flipX ? -1 : 1;
    const headX = this.bossRoot.x + flip * 14;
    const headY = this.bossRoot.y + this.bossSprite.y - 130;
    const pulse = 0.24 + Math.sin(time * 0.01) * 0.05;
    this.eyeA.setPosition(headX - 9, headY).setScale(pulse);
    this.eyeB.setPosition(headX + 9, headY).setScale(pulse);

    if (time > this.nextGlitchAt && this.phase !== 2) {
      this.nextGlitchAt = time + Phaser.Math.Between(1500, 3200);
      this.glitchBurst();
    }
  }

  updateShots(time) {
    for (const shot of [...this.shots.getChildren()]) {
      if (!shot.active) continue;
      if (shot.ring) shot.ring.setPosition(shot.x, shot.y);
      if (time > shot.bornAt + 4200) {
        this.destroyShot(shot, false);
        continue;
      }
      this.tryBlock(shot);
    }
  }

  update(time, delta) {
    if (!this.player || !this.player.body) return;
    updatePlayer(this, this.player, this.keysIn, this.pctrl, { allowDisguise: false, allowDash: true });
    if (!this.__dying && this.player.y > 660) this.handleFall(time);
    this.updateShots(time);
    this.updateHomers(time, delta);
    this.updateBossFx(time);
    if (this.phase === 2) {
      this.updateLightHole(time);
      this.updateBreaker(delta);
    }
    if (this.phase === 3) this.updateFragments();
  }
}
