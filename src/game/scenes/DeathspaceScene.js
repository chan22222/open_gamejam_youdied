// ESC/APE — DeathspaceScene (B5, PATCH2에서 C가 정리)
// 실패 공간. PATCH2 이후 killPlayer는 ADMIN && bossPhase>=4 (최종 탑) 만 이 씬으로 보낸다 —
// 일반 사망은 전부 in-scene 침입(deathIntrusion.js)으로 처리된다.
// 일반 변형 코드는 방어적 레거시로 보존 (계약: 파일 대부분 보존, GRAVITY 진입 경로만 제거).

import Phaser from 'phaser';
import { emitState } from '../events.js';
import { audio } from '../audio.js';
import { store } from '../settingsStore.js';
import { spawnCorpses } from '../corpses.js';
import {
  addFloatingMote,
  createInput,
  createPlayer,
  createStaticPlatform,
  getRunState,
  saveRunState,
  updatePlayer,
} from '../shared.js';

const ERASE_HOLD_MS = 1000;
const BTN_W = 148;
const BTN_H = 52;
const CORPSE_SCALE = 2.65;

// interact가 리바인딩됐을 수 있으므로 프롬프트 문구는 현재 바인딩을 읽어 조합한다.
function interactKeyName() {
  return store.getState().bindings.interact || 'E';
}

// cause -> 연출/해금 테이블 (계약 7절)
const CAUSES = {
  DARKNESS: {
    word: 'DARKNESS',
    unlock: 'brightness',
    permission: 'BRIGHTNESS',
    accent: 0xe4b65a,
    accentCss: '#e4b65a',
    koSign: '어둠이 바닥을 감췄다.',
    objective: '단어 위에서 [E] 길게 — 지워라.',
    hint: '버튼은 밀어서 계단으로.',
    ruleBefore: 'DARKNESS = DEATH',
    ruleAfter: 'DARKNESS = ______',
    afterHint: 'ESC → BRIGHTNESS',
  },
  SOUND: {
    word: 'SOUND',
    unlock: 'volume',
    permission: 'VOLUME',
    accent: 0x71d98b,
    accentCss: '#71d98b',
    koSign: '발소리가 너를 팔아넘겼다.',
    objective: '단어 위에서 [E] 길게 — 지워라.',
    hint: null,
    ruleBefore: 'SOUND = DETECTION',
    ruleAfter: 'SOUND = ______',
    afterHint: 'VOLUME 0 = 감시자 수면',
  },
  FRAME: {
    word: 'FRAME',
    unlock: 'display',
    permission: 'DISPLAY',
    accent: 0x8fd8f0,
    accentCss: '#8fd8f0',
    koSign: '화면 밖은 존재하지 않았다.',
    objective: '단어 위에서 [E] 길게 — 지워라.',
    hint: null,
    ruleBefore: 'FRAME = BOUNDARY',
    ruleAfter: 'FRAME = ______',
    afterHint: 'DISPLAY ↓ = 바깥이 들어온다',
  },
  SPIKES: {
    word: 'SPIKES',
    unlock: 'shake',
    permission: 'SHAKE',
    accent: 0xd97f4a,
    accentCss: '#d97f4a',
    koSign: '가시는 어둠보다 정직하다.',
    objective: '단어 위에서 [E] 길게 — 지워라.',
    hint: null,
    ruleBefore: 'SPIKES = DEATH',
    ruleAfter: 'SPIKES = ______',
    afterHint: 'ESC → SHAKE',
  },
  ADMIN: {
    word: 'ADMIN',
    unlock: null,
    permission: null,
    accent: 0xef4d5b,
    accentCss: '#ef4d5b',
    koSign: '관리자 권한으로 실행이 종료되었다.',
    objective: '단어 위에서 [E] 길게 — 지워라.',
    hint: null,
    ruleBefore: 'ADMIN = ROOT',
    ruleAfter: 'ADMIN = ______',
    afterHint: null,
  },
};

// 최종 탑 변형 (cause=ADMIN && bossPhase>=4): 지울 단어는 사인이 아니라 DIED다.
const FINAL_CAUSE = {
  word: 'DIED',
  unlock: null,
  permission: null,
  accent: 0xe9e2d2,
  accentCss: '#e9e2d2',
  koSign: 'FINAL RECORD',
  objective: '탑을 올라 DIED를 지워라.',
  hint: null,
  ruleBefore: 'YOU = DIED?',
  ruleAfter: 'YOU = ?',
  afterHint: null,
};

function seededRng(seed) {
  let s = (seed * 16807 + 11) % 2147483647;
  if (s <= 0) s += 2147483645;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

function safeSfx(name) {
  try {
    audio.sfx(name);
  } catch {
    // 오디오는 절대 진행을 막지 않는다.
  }
}

export class DeathspaceScene extends Phaser.Scene {
  constructor() {
    super('DeathspaceScene');
  }

  init(data) {
    // PATCH2: killPlayer는 ADMIN(bossPhase>=4)만 이 씬으로 보낸다 — 기본값도 ADMIN.
    const cause = data && data.cause;
    this.cause = Object.prototype.hasOwnProperty.call(CAUSES, cause) ? cause : 'ADMIN';
    this.returnScene = (data && data.returnScene) || 'Stage0Scene';
  }

  create() {
    this.runState = getRunState(this);
    this.isFinal = this.cause === 'ADMIN' && this.runState.bossPhase >= 4;
    this.cfg = this.isFinal ? FINAL_CAUSE : CAUSES[this.cause];
    this.deaths = this.runState.deaths;

    this.ready = false;
    this.erasing = false;
    this.leaving = false;
    this.eraseMs = 0;
    this.glitchAt = 0;
    this.halfwayRumbled = false;
    this.controller = { lastGroundedAt: -1000, jumpBufferedAt: -1000 };

    try {
      audio.setStage('deathspace');
    } catch {
      // noop
    }

    // ---- 월드 크기: 일반 변형은 가로형, 최종 탑은 세로형(~2100px) ----
    if (this.isFinal) {
      this.worldW = 960;
      this.worldH = 2150;
      this.spawnPoint = { x: 130, y: 2080 };
    } else {
      this.worldW = 1900;
      this.worldH = 960;
      this.spawnPoint = { x: 120, y: 826 };
    }
    this.physics.world.setBounds(0, 0, this.worldW, this.worldH);
    this.physics.world.gravity.y = 1480;
    this.cameras.main.setBounds(0, 0, this.worldW, this.worldH).setBackgroundColor('#030405');

    this.createVoid();
    this.platforms = this.physics.add.staticGroup();
    this.corpseGroup = this.physics.add.staticGroup();
    this.buttons = this.physics.add.group();

    if (this.isFinal) {
      this.buildTower();
    } else {
      this.buildGameOverArchitecture();
      this.buildKilledByPhrase();
      this.spawnRetryButtons();
      this.placeCorpses();
      this.paintGraffiti();
    }

    // ---- 플레이어 (유령 형태) ----
    this.player = createPlayer(this, this.spawnPoint.x, this.spawnPoint.y, true);
    this.player.setAlpha(0);
    this.player.setCollideWorldBounds(true);
    this.keys = createInput(this);

    this.physics.add.collider(this.player, this.platforms);
    this.physics.add.collider(this.player, this.corpseGroup);
    this.physics.add.collider(this.player, this.buttons);
    this.physics.add.collider(this.buttons, this.platforms);
    this.physics.add.collider(this.buttons, this.corpseGroup);
    this.physics.add.collider(this.buttons, this.buttons);
    // 계약 규약: 씬 키 기준 시체 스폰 (사망공간 내 사망은 없어 항상 빈 그룹이지만 규약을 지킨다)
    this.legacyCorpses = spawnCorpses(this, this.scene.key);
    this.physics.add.collider(this.player, this.legacyCorpses);

    // ---- 파티클 이미터 (홀드 글리치 / 완파 산란 / 해금 축포) ----
    this.glitchEmitter = this.add.particles(0, 0, 'white-pixel', {
      speed: { min: 20, max: 95 },
      lifespan: { min: 130, max: 340 },
      scale: { start: 1.8, end: 0 },
      alpha: { start: 0.9, end: 0 },
      tint: [this.cfg.accent, 0xffffff],
      blendMode: Phaser.BlendModes.ADD,
      gravityY: 0,
      emitting: false,
    }).setDepth(86);

    this.scatterEmitter = this.add.particles(0, 0, 'white-pixel', {
      speed: { min: 50, max: 270 },
      lifespan: { min: 420, max: 950 },
      scale: { start: 2.4, end: 0 },
      alpha: { start: 1, end: 0 },
      tint: [this.cfg.accent, 0xffffff, 0xd9d2c1],
      gravityY: 430,
      emitting: false,
    }).setDepth(86);

    this.gauge = this.add.graphics().setDepth(130);
    this.whiteRect = this.add.rectangle(480, 270, 2400, 1400, 0xffffff)
      .setScrollFactor(0).setDepth(240).setAlpha(0);

    // 단어 위 프롬프트
    this.wordPrompt = this.add.text(this.word.x, this.word.y + 46, `[${interactKeyName()}] HOLD TO DELETE`, {
      fontFamily: 'monospace', fontSize: '10px', color: '#d9d2c1', letterSpacing: 2,
    }).setOrigin(0.5).setDepth(120).setAlpha(0);
    this.tweens.add({
      targets: this.wordPrompt, alpha: { from: 0.25, to: 0.85 },
      duration: 620, yoyo: true, repeat: -1, ease: 'Sine.easeInOut', paused: false,
    });
    this.wordPrompt.setVisible(false);

    this.spawnAmbient();

    // ---- 카메라 ----
    const cam = this.cameras.main;
    if (this.isFinal) {
      cam.centerOn(480, 330); // 탑 꼭대기의 타이틀에서 시작
    } else {
      cam.setZoom(1.3);
      cam.startFollow(this.player, true, 0.1, 0.08, -40, 30);
      cam.setDeadzone(200, 110);
    }

    // ---- HUD ----
    const nn = String(this.deaths).padStart(2, '0');
    emitState({
      mode: 'deathspace',
      chapter: this.isFinal ? `THE TOWER // FINAL RECORD ${nn}` : `FAILURE SPACE // RECORD ${nn}`,
      objective: this.cfg.objective.replace('[E]', `[${interactKeyName()}]`),
      rule: this.cfg.ruleBefore,
      deaths: this.deaths,
      hint: this.cfg.hint,
    });

    this.physics.pause();
    this.createIntroOverlay();
  }

  // -------------------------------------------------------------------------
  // 진입 시네마틱 — 평범한 게임오버처럼 보였다가, 그것이 공간이었음이 드러난다
  // -------------------------------------------------------------------------

  createIntroOverlay() {
    this.blackout = this.add.rectangle(480, 270, 2400, 1400, 0x030405)
      .setScrollFactor(0).setDepth(290);

    this.flatTitle = this.add.text(480, 218, 'YOU DIED?', {
      fontFamily: 'Georgia, "Times New Roman", serif',
      fontSize: '108px',
      fontStyle: 'bold',
      color: '#e9e2d2',
      stroke: '#321217',
      strokeThickness: 2,
    }).setOrigin(0.5).setScrollFactor(0).setDepth(300)
      .setShadow(0, 16, '#000000', 22, true, true);

    this.flatCause = this.add.text(480, 318, `KILLED BY: ${this.cause}`, {
      fontFamily: 'monospace', fontSize: '15px', color: '#ef4d5b', letterSpacing: 5,
    }).setOrigin(0.5).setScrollFactor(0).setDepth(300);

    this.flatKo = this.add.text(480, 352, this.cfg.koSign, {
      fontFamily: 'Georgia, serif', fontSize: '13px', color: '#9b8d7a',
    }).setOrigin(0.5).setScrollFactor(0).setDepth(300).setAlpha(0);

    // 사인 문구는 반 박자 늦게 타박하듯 나타난다
    this.flatCause.setAlpha(0);
    this.tweens.add({ targets: this.flatCause, alpha: 1, delay: 240, duration: 180 });
    this.tweens.add({ targets: this.flatKo, alpha: 0.9, delay: 430, duration: 260 });
    this.tweens.add({
      targets: this.flatTitle, scaleX: 1.012, scaleY: 1.012,
      duration: 800, yoyo: true, repeat: -1, ease: 'Sine.easeInOut',
    });

    this.time.delayedCall(820, () => this.revealSpace());
  }

  revealSpace() {
    const cam = this.cameras.main;
    safeSfx('rumble');
    this.tweens.killTweensOf(this.flatTitle);

    // 정적 화면이 "뒤로 빠지며" 구조물이 된다
    this.tweens.add({
      targets: this.flatTitle,
      scaleX: 1.65, scaleY: 1.65, alpha: 0,
      duration: 720, ease: 'Cubic.easeIn',
      onComplete: () => this.flatTitle.setVisible(false),
    });
    this.tweens.add({
      targets: [this.flatCause, this.flatKo], alpha: 0, y: '-=18', duration: 420,
      onComplete: () => { this.flatCause.setVisible(false); this.flatKo.setVisible(false); },
    });
    this.tweens.add({
      targets: this.blackout, alpha: 0, duration: 780, ease: 'Sine.easeInOut',
      onComplete: () => this.blackout.setVisible(false),
    });

    this.time.delayedCall(320, () => cam.shake(260, 0.0032));

    if (this.isFinal) {
      // 탑: 타이틀에서 아래로 길게 팬 — 실패의 높이를 보여준다
      this.time.delayedCall(420, () => {
        cam.pan(this.player.x + 120, this.player.y - 150, 1750, 'Sine.easeInOut');
        cam.once(Phaser.Cameras.Scene2D.Events.PAN_COMPLETE, () => {
          cam.startFollow(this.player, true, 0.1, 0.09, 0, 40);
          cam.setDeadzone(180, 130);
          this.beginTraversal();
        });
      });
    } else {
      cam.zoomTo(1, 950, 'Sine.easeInOut');
      this.revealArchitecture();
      this.time.delayedCall(760, () => this.beginTraversal());
    }
  }

  revealArchitecture() {
    // 활자/발판이 층층이 자리잡는다
    (this.revealTargets || []).forEach((obj, i) => {
      const targetAlpha = obj.getData && obj.getData('revealAlpha') !== undefined
        ? obj.getData('revealAlpha') : 1;
      this.tweens.add({
        targets: obj,
        alpha: targetAlpha,
        y: obj.y,
        duration: 430,
        delay: 80 + i * 46,
        ease: 'Quad.easeOut',
      });
    });
  }

  beginTraversal() {
    if (this.ready) return;
    this.ready = true;
    this.physics.resume();
    this.tweens.add({ targets: this.player, alpha: 0.88, duration: 320 });
    safeSfx('ui');
  }

  // -------------------------------------------------------------------------
  // 배경 — 비유클리드 기억 공간
  // -------------------------------------------------------------------------

  createVoid() {
    this.add.rectangle(this.worldW / 2, this.worldH / 2, this.worldW, this.worldH, 0x030405).setDepth(-30);
    const grid = this.add.graphics().setDepth(-24);
    grid.lineStyle(1, 0x762b34, 0.08);
    for (let x = 0; x <= this.worldW; x += 64) grid.lineBetween(x, 0, x, this.worldH);
    for (let y = 0; y <= this.worldH; y += 64) grid.lineBetween(0, y, this.worldW, y);

    const headline = this.isFinal
      ? 'THE TOWER / ACCUMULATED FAILURE'
      : 'FAILURE SPACE / NON-EUCLIDEAN MEMORY';
    this.add.text(55, this.isFinal ? this.worldH - 120 : 65, headline, {
      fontFamily: 'monospace', fontSize: '10px', color: '#76464a', letterSpacing: 3,
    }).setDepth(-10);
    this.add.text(this.worldW - 320, this.isFinal ? this.worldH - 96 : 85,
      `RECORD ${String(this.deaths).padStart(2, '0')} // CAUSE: ${this.cause}`, {
        fontFamily: 'monospace', fontSize: '11px', color: '#76464a', letterSpacing: 3,
      }).setDepth(-10);

    const moteCount = this.isFinal ? 80 : 52;
    for (let i = 0; i < moteCount; i += 1) {
      addFloatingMote(
        this,
        Phaser.Math.Between(0, this.worldW),
        Phaser.Math.Between(140, this.worldH - 60),
        i % 3 ? 0x9b8d7a : this.cfg.accent,
        1,
      );
    }
  }

  // -------------------------------------------------------------------------
  // 일반 변형 — YOU DIED? 활자 건축 + KILLED BY 문구
  // -------------------------------------------------------------------------

  buildGameOverArchitecture() {
    this.revealTargets = [];

    // 연속 바닥 (낙사 없음 — 실패 공간의 바닥은 언제나 받아준다)
    for (let i = 0; i < 6; i += 1) {
      createStaticPlatform(this, this.platforms, 160 + i * 322, 850, 322, 34, 'death-stone');
    }

    // 시작 계단
    const s1 = createStaticPlatform(this, this.platforms, 348, 774, 120, 20, 'death-stone');
    const s2 = createStaticPlatform(this, this.platforms, 485, 696, 120, 20, 'death-stone');
    this.markReveal(s1);
    this.markReveal(s2);

    // 검증된 활자 발판 배치 (구버전 계승)
    const letters = [
      ['Y', 590, 592, 148], ['O', 750, 590, 155], ['U', 920, 588, 155],
      ['D', 1090, 562, 156], ['I', 1240, 520, 104], ['E', 1380, 468, 145],
      ['D', 1535, 412, 152], ['?', 1700, 340, 126],
    ];
    letters.forEach(([char, x, y, width], index) => {
      const glyph = this.add.text(x, y + 12, char, {
        fontFamily: 'Georgia, "Times New Roman", serif',
        fontSize: index < 3 ? '142px' : '152px',
        fontStyle: 'bold',
        color: index % 2 ? '#bdb5a5' : '#ddd5c4',
        stroke: '#272326',
        strokeThickness: 2,
      }).setOrigin(0.5, 0).setDepth(8).setShadow(0, 12, '#000000', 12, true, true);
      const ledge = createStaticPlatform(this, this.platforms, x, y, width, 18, 'death-stone');
      this.markReveal(glyph);
      this.markReveal(ledge);
    });
  }

  buildKilledByPhrase() {
    const wordY = 296;
    this.word = this.add.text(1700, wordY, this.cfg.word, {
      fontFamily: 'Georgia, "Times New Roman", serif',
      fontSize: '46px',
      fontStyle: 'bold',
      color: this.cfg.accentCss,
      stroke: '#3a2c14',
      strokeThickness: 3,
    }).setOrigin(0.5).setDepth(40);
    this.wordBaseX = this.word.x;

    this.wordGlow = this.add.image(this.word.x, wordY, 'glow-orb')
      .setBlendMode(Phaser.BlendModes.ADD)
      .setTint(this.cfg.accent)
      .setScale(Math.max(3, this.word.width / 44), 1.7)
      .setAlpha(0.24)
      .setDepth(39);
    this.tweens.add({
      targets: this.wordGlow, alpha: { from: 0.14, to: 0.3 },
      duration: 1100, yoyo: true, repeat: -1, ease: 'Sine.easeInOut',
    });

    this.killedByLabel = this.add.text(
      this.word.x - this.word.width / 2 - 14, wordY, 'KILLED BY:', {
        fontFamily: 'monospace', fontSize: '19px', color: '#d9d2c1', letterSpacing: 3,
      }).setOrigin(1, 0.5).setDepth(40);

    this.markReveal(this.word);
    this.markReveal(this.killedByLabel);
    this.markReveal(this.wordGlow, 0.24);
  }

  // -------------------------------------------------------------------------
  // RETRY 버튼 — 낡은 UI 버튼 텍스처 + 밀 수 있는 상자 물리
  // -------------------------------------------------------------------------

  ensureRetryTexture(wear) {
    const key = `retry-btn-${wear}`;
    if (this.textures.exists(key)) return key;

    const rand = seededRng(wear + 7);
    const g = this.make.graphics({ add: false });

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
    const label = this.make.text({
      x: 0, y: 0, add: false,
      text: labelText,
      style: {
        fontFamily: 'monospace', fontSize: '17px', fontStyle: 'bold',
        color: labelColor, letterSpacing: 4,
      },
    });
    label.setAlpha(Math.max(0.5, 1 - wear * 0.08));
    label.setAngle((wear % 2 ? -1 : 1) * wear * 0.7);

    const rt = this.make.renderTexture({ width: BTN_W, height: BTN_H, add: false });
    rt.draw(g, 0, 0);
    rt.draw(label, BTN_W / 2 - label.width / 2, (BTN_H - 6) / 2 - label.height / 2);
    if (wear >= 5) {
      // 떨어져 나간 마지막 글자
      const fallen = this.make.text({
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

  makeButton(x, y, wear) {
    const key = this.ensureRetryTexture(Phaser.Math.Clamp(wear, 0, 5));
    const btn = this.physics.add.sprite(x, y, key);
    btn.setDepth(22).setPushable(true);
    btn.body.setSize(BTN_W - 6, BTN_H - 10).setOffset(3, 5);
    btn.setDragX(1500).setMaxVelocity(240, 980).setBounce(0);
    btn.setCollideWorldBounds(true);
    btn.setData('bubbleAt', -10000);
    this.buttons.add(btn);
    return btn;
  }

  spawnRetryButtons() {
    const count = Phaser.Math.Clamp(this.deaths, 1, 6);
    // 세 기둥에 최대 2단 스택 — 스폰 겹침 없이(버튼 폭 148) 자연스럽게 쌓인 더미
    const xs = [660, 920, 1170];
    for (let i = 0; i < count; i += 1) {
      // 최신 죽음일수록 덜 낡았다 — 마지막 스폰이 wear 0
      const wear = Phaser.Math.Clamp(count - 1 - i, 0, 5);
      this.makeButton(xs[i % xs.length], 800 - Math.floor(i / xs.length) * 62, wear);
    }
  }

  showNotResponding(btn) {
    const now = this.time.now;
    if (now - btn.getData('bubbleAt') < 1100) return;
    btn.setData('bubbleAt', now);
    safeSfx('ui');

    // 버튼 부르르
    this.tweens.add({
      targets: btn, angle: { from: -3, to: 3 },
      duration: 46, yoyo: true, repeat: 4,
      onComplete: () => btn.setAngle(0),
    });

    const bx = btn.x;
    const by = btn.y - 48;
    const bubble = this.add.container(bx, by).setDepth(140);
    const g = this.add.graphics();
    g.fillStyle(0x101214, 0.95).fillRoundedRect(-74, -15, 148, 30, 6);
    g.lineStyle(1, 0xef4d5b, 0.8).strokeRoundedRect(-74, -15, 148, 30, 6);
    g.fillStyle(0x101214, 0.95).fillTriangle(-7, 15, 7, 15, 0, 24);
    g.lineStyle(1, 0xef4d5b, 0.8).lineBetween(-7, 15, 0, 24);
    g.lineBetween(0, 24, 7, 15);
    const text = this.add.text(0, 0, 'NOT RESPONDING', {
      fontFamily: 'monospace', fontSize: '11px', color: '#ef4d5b', letterSpacing: 1,
    }).setOrigin(0.5);
    bubble.add([g, text]);
    bubble.setAlpha(0).setScale(0.85);
    this.tweens.add({ targets: bubble, alpha: 1, scaleX: 1, scaleY: 1, duration: 110, ease: 'Back.easeOut' });
    this.tweens.add({
      targets: bubble, alpha: 0, y: by - 12, delay: 820, duration: 260,
      onComplete: () => bubble.destroy(),
    });
  }

  // -------------------------------------------------------------------------
  // 시체 — 이전 실패들 + 방금의 죽음
  // -------------------------------------------------------------------------

  addCorpseProp(x, footY, { flip = false, tint = 0xaab6b2, fresh = false, alpha = 1 } = {}) {
    const corpse = this.corpseGroup.create(x, footY, 'cat-dead');
    corpse.setScale(CORPSE_SCALE).setOrigin(0.5, 1).setDepth(18)
      .setFlipX(flip).setTint(tint).setAlpha(alpha);
    corpse.refreshBody();
    // 몸통만 밟는 납작 슬래브 (corpses.js와 동일 규격)
    const body = corpse.body;
    const bw = 58;
    const bh = 18;
    body.setSize(bw, bh);
    body.position.x = x - bw / 2;
    body.position.y = footY - bh;
    if (body.updateCenter) body.updateCenter();

    if (fresh) this.decorateFreshCorpse(x, footY);
    return corpse;
  }

  decorateFreshCorpse(x, footY) {
    // 방금 죽은 자세 — 붉은 잔광과 아직 떠나지 못한 넋
    const glow = this.add.image(x, footY - 12, 'glow-orb')
      .setBlendMode(Phaser.BlendModes.ADD)
      .setTint(0xef4d5b)
      .setScale(1.7)
      .setAlpha(0.32)
      .setDepth(17);
    this.tweens.add({
      targets: glow, alpha: { from: 0.32, to: 0.08 }, scaleX: 2.1, scaleY: 2.1,
      duration: 1500, yoyo: true, repeat: -1, ease: 'Sine.easeInOut',
    });

    const soul = this.add.image(x, footY - 26, 'white-pixel')
      .setTint(0xffd9d0).setScale(2.4).setDepth(19)
      .setBlendMode(Phaser.BlendModes.ADD).setAlpha(0);
    this.tweens.add({
      targets: soul, y: footY - 84, alpha: { from: 0.7, to: 0 },
      duration: 2100, repeat: -1, ease: 'Sine.easeOut',
    });

    this.add.text(x, footY - 78, '', {
      fontFamily: 'Georgia, serif', fontSize: '11px', color: '#8d6a6a',
    }).setOrigin(0.5).setDepth(19).setAlpha(0.85);
  }

  placeCorpses() {
    // 이번 사인 위치: 방금 죽은 시체
    this.addCorpseProp(250, 833, { fresh: true, tint: 0xd9b8b4 });

    // 이전 실패들 (밟기 가능)
    const spots = [
      [640, 833, true], [1030, 833, false], [348, 764, true],
      [1250, 833, false], [485, 686, true], [920, 579, false],
      [1470, 833, true], [1380, 459, false],
    ];
    const olderCount = Phaser.Math.Clamp(this.deaths - 1, 0, spots.length);
    for (let i = 0; i < olderCount; i += 1) {
      const [x, y, flip] = spots[i];
      this.addCorpseProp(x, y, { flip, tint: 0x93a19c });
    }
  }

  // -------------------------------------------------------------------------
  // 낙서 — 힌트는 세계 안에 존재한다
  // -------------------------------------------------------------------------

  graffiti(x, y, textString, color = '#76464a', size = 12) {
    const t = this.add.text(x, y, textString, {
      fontFamily: 'Georgia, serif', fontSize: `${size}px`, fontStyle: 'italic', color,
    }).setOrigin(0.5).setDepth(4).setAlpha(0.82);
    t.setAngle(Phaser.Math.FloatBetween(-2, 2));
    return t;
  }

  paintGraffiti() {
    if (this.cause === 'DARKNESS') {
      // 튜토리얼 낙서 (계약 명시) — 조작만, 최소한으로
      this.graffiti(770, 760, '"버튼은 밀어라"', '#9b8d7a', 13);
      this.graffiti(1520, 232, `"단어 위에서 [${interactKeyName()}] 길게"`, '#b09a6d', 13);
    }
  }

  // -------------------------------------------------------------------------
  // 최종 탑 (bossPhase=4) — 축적된 실패의 수직 등반
  // -------------------------------------------------------------------------

  buildTower() {
    this.revealTargets = [];

    // 바닥
    for (let i = 0; i < 3; i += 1) {
      createStaticPlatform(this, this.platforms, 160 + i * 322, 2101, 322, 34, 'death-stone');
    }

    // 무너진 탑 — 버튼/시체/석판이 지그재그로 쌓여 있다 (전부 등반 경로)
    const steps = [
      [2010, 300, 'button'], [1915, 505, 'corpse'], [1822, 690, 'button'],
      [1728, 846, 'stone'], [1635, 656, 'button'], [1540, 470, 'corpse'],
      [1448, 270, 'button'], [1355, 120, 'stone'], [1262, 300, 'button'],
      [1168, 505, 'corpse'], [1075, 690, 'button'], [982, 845, 'stone'],
      [888, 640, 'button'], [795, 440, 'corpse'], [700, 255, 'button'],
      [606, 130, 'stone'], [540, 300, 'button'],
    ];
    let wearCursor = 0;
    steps.forEach(([topY, x, type], i) => {
      if (type === 'stone') {
        createStaticPlatform(this, this.platforms, x, topY + 10, 130, 20, 'death-stone');
      } else if (type === 'corpse') {
        this.addCorpseProp(x, topY + 18, { flip: i % 2 === 0, tint: 0x8d9a95 });
      } else {
        const key = this.ensureRetryTexture(wearCursor % 6);
        wearCursor += 1;
        const piece = this.platforms.create(x, topY + BTN_H / 2, key);
        piece.setAngle(((i % 2) ? -1 : 1) * Phaser.Math.Between(2, 9)).setDepth(20);
      }
    });

    // 정상 발판
    createStaticPlatform(this, this.platforms, 480, 455, 460, 20, 'death-stone');

    // 거대한 YOU DIED? — DIED만 발광하며, 그것만 지울 수 있다
    const titleStyle = {
      fontFamily: 'Georgia, "Times New Roman", serif',
      fontSize: '112px',
      fontStyle: 'bold',
      stroke: '#191512',
      strokeThickness: 3,
    };
    const you = this.add.text(0, 352, 'YOU ', { ...titleStyle, color: '#7d766a' })
      .setOrigin(0, 0.5).setDepth(8).setShadow(0, 14, '#000000', 18, true, true);
    this.word = this.add.text(0, 352, 'DIED', { ...titleStyle, color: this.cfg.accentCss, stroke: '#4a3518' })
      .setOrigin(0, 0.5).setDepth(9).setShadow(0, 14, '#000000', 18, true, true);
    this.towerQ = this.add.text(0, 352, '?', { ...titleStyle, color: '#7d766a' })
      .setOrigin(0, 0.5).setDepth(8).setShadow(0, 14, '#000000', 18, true, true);

    const total = you.width + this.word.width + this.towerQ.width;
    const startX = 480 - total / 2;
    you.setX(startX);
    this.word.setX(startX + you.width);
    this.towerQ.setX(startX + you.width + this.word.width);
    this.towerYou = you;
    this.wordBaseX = this.word.x;

    this.wordGlow = this.add.image(this.word.x + this.word.width / 2, 352, 'glow-orb')
      .setBlendMode(Phaser.BlendModes.ADD)
      .setTint(0xe4b65a)
      .setScale(6.2, 3)
      .setAlpha(0.2)
      .setDepth(7);
    this.tweens.add({
      targets: this.wordGlow, alpha: { from: 0.12, to: 0.26 },
      duration: 1300, yoyo: true, repeat: -1, ease: 'Sine.easeInOut',
    });

    this.add.text(480, 236, 'FINAL RECORD // KILLED BY: ADMIN', {
      fontFamily: 'monospace', fontSize: '12px', color: '#76464a', letterSpacing: 4,
    }).setOrigin(0.5).setDepth(8).setAlpha(0.7);

    // 지난 사인들 — 취소선이 그어진 채 벽에 떠 있다
    const erasedWords = ['DARKNESS', 'SOUND', 'FRAME', 'SPIKES', 'ADMIN']
      .filter((w) => this.runState.erased && this.runState.erased[w]);
    const wall = erasedWords.length ? erasedWords : ['DARKNESS', 'SOUND', 'FRAME'];
    const slots = [[150, 1960], [810, 1620], [150, 1290], [810, 960], [150, 640]];
    wall.slice(0, slots.length).forEach((w, i) => {
      const [x, y] = slots[i];
      const t = this.add.text(x, y, w, {
        fontFamily: 'Georgia, serif', fontSize: '30px', fontStyle: 'bold',
        color: '#b09a6d', stroke: '#1a140c', strokeThickness: 2,
      }).setOrigin(0.5).setDepth(5).setAlpha(0.42);
      const strike = this.add.rectangle(x, y, t.width + 16, 3, 0xef4d5b, 0.8).setDepth(6).setAlpha(0.6);
      this.tweens.add({
        targets: [t, strike], y: `-=${8 + (i % 3) * 3}`,
        duration: 2200 + i * 340, yoyo: true, repeat: -1, ease: 'Sine.easeInOut',
      });
    });

    // 장식 시체/버튼 — 탑의 잔해 (충돌 없음)
    const rand = seededRng(this.deaths + 3);
    const corpseTotal = (this.registry.get('corpses') || []).length;
    const debrisCorpses = Phaser.Math.Clamp(corpseTotal - 6, 0, 8);
    for (let i = 0; i < debrisCorpses; i += 1) {
      this.add.image(120 + rand() * 720, 900 + rand() * 1150, 'cat-dead')
        .setScale(CORPSE_SCALE).setOrigin(0.5, 1)
        .setAngle((rand() - 0.5) * 44)
        .setTint(0x5f6a66).setAlpha(0.5).setDepth(3);
    }
    const debrisButtons = Phaser.Math.Clamp(this.deaths - 8, 0, 6);
    for (let i = 0; i < debrisButtons; i += 1) {
      const key = this.ensureRetryTexture(Math.floor(rand() * 6));
      this.add.image(140 + rand() * 680, 1000 + rand() * 1000, key)
        .setAngle((rand() - 0.5) * 60).setAlpha(0.42).setDepth(3);
    }

    // 바닥의 미는 버튼 두 개 — 마지막까지 장난감은 남는다
    this.makeButton(600, 2050, 1);
    this.makeButton(760, 2050, 4);

  }

  // -------------------------------------------------------------------------
  // 사인별 앰비언트
  // -------------------------------------------------------------------------

  spawnAmbient() {
    if (this.isFinal) {
      // 오르는 재 — 중력을 거스르는 입자들
      this.time.addEvent({
        delay: 260,
        loop: true,
        callback: () => {
          const p = this.add.image(
            Phaser.Math.Between(40, this.worldW - 40),
            this.cameras.main.worldView.bottom + 40,
            'white-pixel',
          ).setTint(0x9b8d7a).setAlpha(0.4).setScale(1.6).setDepth(2);
          this.tweens.add({
            targets: p, y: p.y - Phaser.Math.Between(220, 420), alpha: 0,
            duration: Phaser.Math.Between(2400, 4200),
            onComplete: () => p.destroy(),
          });
        },
      });
      return;
    }

    if (this.cause === 'SOUND') {
      this.time.addEvent({
        delay: 2700,
        loop: true,
        callback: () => {
          const ring = this.add.ellipse(
            Phaser.Math.Between(200, this.worldW - 200),
            Phaser.Math.Between(220, 760), 20, 20,
          ).setStrokeStyle(2, this.cfg.accent, 0.35).setDepth(2);
          this.tweens.add({
            targets: ring, scaleX: 6, scaleY: 6, alpha: 0, duration: 1600,
            ease: 'Cubic.easeOut', onComplete: () => ring.destroy(),
          });
        },
      });
    } else if (this.cause === 'FRAME') {
      this.time.addEvent({
        delay: 3300,
        loop: true,
        callback: () => {
          const r = this.add.rectangle(
            Phaser.Math.Between(200, this.worldW - 200),
            Phaser.Math.Between(200, 700),
            Phaser.Math.Between(80, 180), Phaser.Math.Between(50, 110),
          ).setStrokeStyle(1, this.cfg.accent, 0.25).setDepth(2);
          this.tweens.add({
            targets: r, y: r.y - 36, alpha: 0, duration: 2600,
            onComplete: () => r.destroy(),
          });
        },
      });
    } else if (this.cause === 'ADMIN') {
      this.time.addEvent({
        delay: 1900,
        loop: true,
        callback: () => {
          const y = Phaser.Math.Between(100, this.worldH - 120);
          const bar = this.add.rectangle(this.worldW / 2, y, this.worldW, Phaser.Math.Between(2, 6), 0xef4d5b, 0.14)
            .setDepth(2).setBlendMode(Phaser.BlendModes.ADD);
          this.time.delayedCall(90, () => bar.destroy());
          if (Math.random() < 0.4) this.cameras.main.shake(50, 0.0008);
        },
      });
    }
    // DARKNESS: 단어의 등불 펄스(buildKilledByPhrase의 wordGlow)로 충분 — 어둠 속 유일한 빛
  }

  // -------------------------------------------------------------------------
  // 단어 삭제 — E 홀드 1초, 원형 게이지, 글리치, 백색 펄스
  // -------------------------------------------------------------------------

  wordOverlapsPlayer() {
    if (!this.word || !this.word.visible) return false;
    const body = this.player.body;
    const playerRect = new Phaser.Geom.Rectangle(body.x, body.y, body.width, body.height);
    const wordRect = Phaser.Geom.Rectangle.Inflate(
      Phaser.Geom.Rectangle.Clone(this.word.getBounds()), 10, 14,
    );
    return Phaser.Geom.Intersects.RectangleToRectangle(playerRect, wordRect);
  }

  updateErase(delta) {
    const overlapping = this.wordOverlapsPlayer();
    const holding = overlapping && this.keys.isDown('interact');

    this.wordPrompt.setVisible(overlapping && !holding && !this.erasing);
    if (this.wordPrompt.visible && this.isFinal) {
      this.wordPrompt.setPosition(this.word.x + this.word.width / 2, this.word.y + this.word.height / 2 + 30);
    }

    if (holding) {
      this.eraseMs = Math.min(ERASE_HOLD_MS, this.eraseMs + delta);
      const p = this.eraseMs / ERASE_HOLD_MS;

      // 단어가 붕괴하기 시작한다
      const jitter = p * 3.4;
      this.word.setX(this.wordBaseX + Phaser.Math.FloatBetween(-jitter, jitter));
      this.word.setAlpha(1 - p * 0.35 + Phaser.Math.FloatBetween(-0.08, 0.08) * p);

      if (this.time.now >= this.glitchAt) {
        this.glitchAt = this.time.now + 65;
        const b = this.word.getBounds();
        const n = 2 + Math.floor(p * 4);
        for (let i = 0; i < n; i += 1) {
          this.glitchEmitter.emitParticleAt(
            b.x + Math.random() * b.width,
            b.y + Math.random() * b.height,
            1,
          );
        }
      }

      // 원형 게이지
      const gx = this.player.x;
      const gy = this.player.y - 96;
      this.gauge.clear();
      this.gauge.lineStyle(4, 0x2c2f33, 0.85).strokeCircle(gx, gy, 21);
      this.gauge.lineStyle(5, this.cfg.accent, 1);
      this.gauge.beginPath();
      this.gauge.arc(gx, gy, 21, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * p);
      this.gauge.strokePath();
      this.gauge.fillStyle(this.cfg.accent, 0.25 + p * 0.4).fillCircle(gx, gy, 7);

      if (this.eraseMs >= ERASE_HOLD_MS) this.performErase();
    } else {
      if (this.eraseMs > 0) {
        this.eraseMs = Math.max(0, this.eraseMs - delta * 3);
        if (this.eraseMs === 0 && this.word.visible) {
          this.word.setX(this.wordBaseX).setAlpha(1);
        }
      }
      this.gauge.clear();
    }
  }

  performErase() {
    if (this.erasing) return;
    this.erasing = true;
    this.gauge.clear();
    this.wordPrompt.setVisible(false);
    this.player.setVelocityX(0);

    // 글자가 픽셀 단위로 흩어진다
    const b = this.word.getBounds();
    for (let px = b.x; px < b.x + b.width; px += 7) {
      for (let py = b.y; py < b.y + b.height; py += 7) {
        if (Math.random() < 0.55) this.scatterEmitter.emitParticleAt(px, py, 1);
      }
    }
    this.word.setVisible(false);
    if (this.wordGlow) {
      this.tweens.killTweensOf(this.wordGlow);
      this.tweens.add({ targets: this.wordGlow, alpha: 0, duration: 350 });
    }

    // 백색 펄스 + 셰이크 + erase
    safeSfx('erase');
    this.cameras.main.shake(200, 0.007);
    this.whiteRect.setAlpha(0.95);
    this.tweens.add({ targets: this.whiteRect, alpha: 0, duration: this.isFinal ? 620 : 430, ease: 'Cubic.easeOut' });

    // 기록 갱신
    this.runState.erased[this.cfg.word] = true;
    saveRunState(this, this.runState);

    const nn = String(this.deaths).padStart(2, '0');

    if (this.isFinal) {
      this.finishTower(nn);
      return;
    }

    // 빈칸이 남는다
    this.add.text(this.wordBaseX, this.word.y, '______', {
      fontFamily: 'monospace', fontSize: '30px', color: '#d9d2c1', letterSpacing: 3,
    }).setOrigin(0.5).setDepth(40).setAlpha(0.35);

    emitState({
      mode: 'deathspace',
      chapter: `FAILURE SPACE // RECORD ${nn}`,
      objective: '규칙 삭제됨.',
      rule: this.cfg.ruleAfter,
      deaths: this.deaths,
      hint: this.cfg.afterHint || undefined,
    });

    // 해금 대상이면 해금 배너 — 없으면 즉시 복귀 (계약: 1.2초)
    const freshUnlock = this.cfg.unlock && !store.isUnlocked(this.cfg.unlock);
    if (this.cfg.unlock) store.unlock(this.cfg.unlock);

    const leaveDelay = freshUnlock ? 2400 : 1200;
    if (freshUnlock) {
      this.time.delayedCall(520, () => this.showUnlockBanner());
    }
    this.time.delayedCall(leaveDelay - 380, () => {
      this.cameras.main.fadeOut(360, 3, 4, 5);
    });
    this.time.delayedCall(leaveDelay, () => {
      if (this.leaving) return;
      this.leaving = true;
      this.scene.start(this.returnScene);
    });
  }

  showUnlockBanner() {
    safeSfx('unlock');
    const banner = this.add.container(480, 200).setScrollFactor(0).setDepth(250);

    const glow = this.add.image(0, 16, 'glow-orb')
      .setBlendMode(Phaser.BlendModes.ADD).setTint(this.cfg.accent).setScale(7, 2.6).setAlpha(0.3);
    const line1 = this.add.text(0, -34, 'PERMISSION GRANTED', {
      fontFamily: 'monospace', fontSize: '13px', color: '#71d98b', letterSpacing: 6,
    }).setOrigin(0.5);
    const line2 = this.add.text(0, 8, this.cfg.permission, {
      fontFamily: 'monospace', fontSize: '42px', fontStyle: 'bold',
      color: this.cfg.accentCss, letterSpacing: 8,
    }).setOrigin(0.5).setShadow(0, 4, '#000000', 10, true, true);
    const line3 = this.add.text(0, 52, '[ESC] 설정', {
      fontFamily: 'Georgia, serif', fontSize: '13px', color: '#9b8d7a',
    }).setOrigin(0.5);
    banner.add([glow, line1, line2, line3]);

    banner.setAlpha(0);
    line2.setScale(1.5);
    this.tweens.add({ targets: banner, alpha: 1, duration: 160 });
    this.tweens.add({ targets: line2, scaleX: 1, scaleY: 1, duration: 340, ease: 'Back.easeOut' });
    this.tweens.add({
      targets: glow, alpha: { from: 0.3, to: 0.14 },
      duration: 480, yoyo: true, repeat: -1,
    });

    // 금빛 축포
    const confetti = this.add.particles(0, 0, 'white-pixel', {
      x: 480, y: 190,
      speed: { min: 80, max: 260 },
      angle: { min: 230, max: 310 },
      lifespan: { min: 500, max: 1100 },
      scale: { start: 2, end: 0 },
      alpha: { start: 1, end: 0 },
      tint: [this.cfg.accent, 0xffffff],
      gravityY: 520,
      emitting: false,
    }).setScrollFactor(0).setDepth(249);
    confetti.explode(26);
  }

  finishTower(nn) {
    // DIED가 사라지고 YOU ?만 남는다 — 물음표가 미끄러져 온다
    emitState({
      mode: 'deathspace',
      chapter: `THE TOWER // FINAL RECORD ${nn}`,
      objective: '물음표만 남았다.',
      rule: this.cfg.ruleAfter,
      deaths: this.deaths,
    });

    this.tweens.add({
      targets: this.towerQ,
      x: this.towerYou.x + this.towerYou.width + 6,
      duration: 900,
      delay: 500,
      ease: 'Sine.easeInOut',
    });

    // 긴 백색 페이드 → EndingScene
    this.time.delayedCall(700, () => {
      this.tweens.add({
        targets: this.whiteRect, alpha: 1, duration: 2000, ease: 'Sine.easeIn',
      });
      this.cameras.main.zoomTo(1.25, 2400, 'Sine.easeIn');
    });
    this.time.delayedCall(2900, () => {
      if (this.leaving) return;
      this.leaving = true;
      this.scene.start('EndingScene');
    });
  }

  // -------------------------------------------------------------------------
  // update
  // -------------------------------------------------------------------------

  update(time, delta) {
    if (!this.ready) return;

    updatePlayer(this, this.player, this.keys, this.controller, {
      ghost: true,
      speed: 255,
      jumpVelocity: -690,
    });

    // 낙하 시 사망 없음 — 바닥 리스폰 (안전망)
    if (this.player.y > this.worldH + 40) {
      this.player.setPosition(this.spawnPoint.x, this.spawnPoint.y).setVelocity(0, 0);
      this.cameras.main.flash(110, 120, 35, 45);
      safeSfx('ui');
    }

    if (!this.erasing) {
      this.updateErase(delta);

      // RETRY 버튼 — E 접근 시 NOT RESPONDING (단어 위가 아닐 때만)
      if (this.keys.justPressed('interact') && !this.wordOverlapsPlayer()) {
        let nearest = null;
        let best = 9000;
        this.buttons.getChildren().forEach((btn) => {
          if (!btn.active) return;
          const d = Phaser.Math.Distance.Between(this.player.x, this.player.y - 30, btn.x, btn.y);
          if (d < best) { best = d; nearest = btn; }
        });
        if (nearest && best < 105) this.showNotResponding(nearest);
      }
    }

    // 탑 중턱 — 한 번의 진동
    if (this.isFinal && !this.halfwayRumbled && this.player.y < 1250) {
      this.halfwayRumbled = true;
      safeSfx('rumble');
      this.cameras.main.shake(300, 0.002);
    }
  }

  // -------------------------------------------------------------------------
  // 헬퍼
  // -------------------------------------------------------------------------

  markReveal(obj, targetAlpha) {
    if (obj.setData) obj.setData('revealAlpha', targetAlpha !== undefined ? targetAlpha : 1);
    obj.setAlpha(0);
    this.revealTargets.push(obj);
  }
}
