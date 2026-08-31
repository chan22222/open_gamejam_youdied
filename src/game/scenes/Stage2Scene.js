// ESC/APE — Stage2Scene (B3) : 프레임의 끝
// "화면은 벽이 아니다. 값이다."
// 스테이지의 "원래 화면"(960x540)이 세계 안에 물리적 경계로 빛난다.
// 프레임 밖 발판은 유령(registerOffFrame) — DISPLAY 슬라이더를 줄여 줌아웃하면 차례로 실체화된다.
// 경계 접촉 = KILLED BY: FRAME (erased.FRAME 이후엔 균열이 가고 무해해진다).
// PATCH2: 낙사 지형 제거(GRAVITY 폐지) — 협곡/최종 간격 바닥은 화면 안의 가시밭(KILLED BY: SPIKES).
// 죽은 자리의 침입 잔해(글자 발판/버튼/시체)가 가시 위 다리와 탈출 사다리가 된다. erased.SPIKES면 가시 무해.
// 중반에서 DASH MODULE 획득 -> CONTROLS 해금 -> 키를 직접 바인딩해야 마지막 380px 간격을 건넌다.

import Phaser from 'phaser';
import { store, effective } from '../settingsStore.js';
import { audio } from '../audio.js';
import { emitState } from '../events.js';
import { spawnCorpses } from '../corpses.js';
import { attachWorldToys } from '../worldToys.js';
import {
  addFloatingMote,
  bindCameraDisplay,
  createInput,
  createPlayer,
  createStaticPlatform,
  drawFrameBorder,
  getRunState,
  killPlayer,
  registerOffFrame,
  saveRunState,
  updatePlayer,
} from '../shared.js';

const WORLD_W = 3260;
const WORLD_H = 1000; // 카메라 바운드 (줌 0.55에서 뷰 높이 ~982)
const FALL_Y = 980;

// PATCH2: 가시밭 — 협곡 바닥/최종 간격 바닥은 화면 안 깊이의 밟는 죽음이다.
// 협곡 깊이 ~176px(우측 림 540): 침입 글자 발판(-58/-118)+버튼+시체로 등반 가능.
const CANYON_PIT = { left: 960, right: 1990, top: 716 };
const GAP_PIT = { left: 2570, right: 2950, top: 960 };

// "원래 화면" — 스테이지 최초의 960x540 프레임 (살짝 인셋해서 경계선이 잘리지 않게)
const FRAME = { x: 4, y: 4, w: 952, h: 532 };
const FRAME_RIGHT = FRAME.x + FRAME.w; // 956

const BASE_SPAWN = { x: 140, y: 498 };
const CHECKPOINT_SPAWN = { x: 2100, y: 796 };
const CHECKPOINT_KEY = 'stage2Checkpoint';

const MODULE_POS = { x: 2140, y: 712 };
const MODULE_HOLD_MS = 850;
const DOOR_POS = { x: 3140, y: 870 }; // 착지 발판 윗면
const DOOR_HOLD_MS = 700;
const FINAL_GAP_LEFT = 2570; // 최종 간격: 2570 -> 2950 (380px)

export class Stage2Scene extends Phaser.Scene {
  constructor() {
    super('Stage2Scene');
  }

  create() {
    this.runState = getRunState(this);
    this.runState.stage = 'Stage2Scene';
    saveRunState(this, this.runState);

    // RESTART로 새 런이 시작됐다면 이전 런의 체크포인트를 무효화한다.
    if (!this.runState.erased.FRAME) this.registry.set(CHECKPOINT_KEY, false);

    this.zapLock = false;
    this.transitionLocked = false;
    this.moduleHold = 0;
    this.doorHold = 0;
    this.offFramePlats = [];
    this.spikeBeds = [];
    this.spikesDisarmed = false;
    this.frameCracked = false;
    this.controller = { lastGroundedAt: -1000, jumpBufferedAt: -1000 };

    audio.setStage('stage2');

    this.cameras.main.setBackgroundColor('#04060a');
    this.cameras.main.setBounds(0, 0, WORLD_W, WORLD_H);
    this.physics.world.setBounds(0, 0, WORLD_W, 1100);

    this.solids = this.physics.add.staticGroup();
    this.ghosts = this.physics.add.staticGroup();

    this.createVoid();
    this.createFrameRoom();
    this.createChasm();
    this.createFarSide();
    this.createModule();
    this.createExitDoor();

    // --- 플레이어 ---
    const spawn = this.spawnPoint();
    this.player = createPlayer(this, spawn.x, spawn.y);
    this.player.setCollideWorldBounds(true);
    this.keys = createInput(this);

    this.physics.add.collider(this.player, this.solids);
    this.physics.add.collider(this.player, this.ghosts);
    // intrusion 코어가 scene.corpseGroup 관례로 버튼 충돌을 배선한다 (deathIntrusion.js 참조)
    this.corpseGroup = spawnCorpses(this, 'Stage2Scene');
    this.physics.add.collider(this.player, this.corpseGroup);

    this.createFrameBoundary();
    this.createSpikeBeds();
    // PATCH2 2절: SHAKE/패널 밀치기 — intrusion RETRY 버튼은 코어가 자동 등록한다
    attachWorldToys(this, { pushables: [] });

    this.cameras.main.startFollow(this.player, true, 0.09, 0.085, -60, 30);
    this.cameras.main.setDeadzone(170, 90);
    bindCameraDisplay(this);
    this.cameras.main.fadeIn(420, 4, 6, 10);

    this.holdArc = this.add.graphics().setDepth(80);

    // DISPLAY를 쓰기 전에는 프레임 오른쪽 세계가 아예 보이지 않는다.
    // 줌아웃(display<=70)하거나 실제로 경계를 넘는 순간 걷히고, 그 뒤로는 다시 덮이지 않는다.
    this.voidCover = this.add.rectangle(
      FRAME_RIGHT + (WORLD_W - FRAME_RIGHT) / 2 + 200, 500,
      WORLD_W - FRAME_RIGHT + 500, 2200, 0x04070c,
    ).setDepth(60);
    this.voidRevealed = this.player.x > FRAME_RIGHT;
    this.voidCover.setAlpha(this.voidRevealed ? 0 : 1);
    // 카메라도 프레임에 갇힌다 — DISPLAY를 써야 세계가 넓어진다.
    if (!this.voidRevealed) this.cameras.main.setBounds(0, 0, FRAME_RIGHT + 4, 540);

    this.bindStoreEffects();
    this.emitStatus();
  }

  // -------------------------------------------------------------------------
  // 스폰 / HUD
  // -------------------------------------------------------------------------

  spawnPoint() {
    // 체크포인트는 프레임을 지운(=협곡을 건널 수 있는) 런에서만 유효.
    // RESTART 시 registry의 체크포인트 키가 남아도 erased.FRAME이 false라 무시된다.
    if (this.registry.get(CHECKPOINT_KEY) && this.runState.erased.FRAME) return CHECKPOINT_SPAWN;
    return BASE_SPAWN;
  }

  emitStatus() {
    const rs = this.runState;
    const dashKey = store.getState().bindings.dash;
    const rule = rs.erased.FRAME ? 'THE FRAME = ______' : 'THE FRAME = DEATH';
    let objective;
    let hint;

    if (!rs.erased.FRAME) {
      objective = '프레임의 끝으로 가라.';
    } else if (!rs.dashFound) {
      objective = '바깥의 발판을 들여라.';
      hint = 'ESC → DISPLAY ↓';
    } else if (!dashKey) {
      objective = '대시 키를 바인딩하라.';
      hint = 'ESC → CONTROLS';
    } else {
      objective = '점프 + 대시.';
      hint = `DASH = [${dashKey}]`;
    }

    const payload = {
      mode: 'world',
      chapter: 'STAGE 2 // EDGE OF THE FRAME',
      objective,
      rule,
      deaths: rs.deaths,
    };
    if (hint) payload.hint = hint;
    emitState(payload);
  }

  // -------------------------------------------------------------------------
  // 배경 — 프레임 밖 공허 / 프레임 안 "원래 화면"
  // -------------------------------------------------------------------------

  createVoid() {
    // 렌더되지 않은 영역: 거의 검정 + 희미한 좌표 그리드
    this.add.rectangle(WORLD_W / 2, 520, WORLD_W + 500, 1500, 0x04070c).setDepth(-40);

    const grid = this.add.graphics().setDepth(-38);
    grid.lineStyle(1, 0x123039, 0.22);
    for (let x = 0; x <= WORLD_W; x += 80) grid.lineBetween(x, 0, x, WORLD_H);
    for (let y = 0; y <= WORLD_H; y += 80) grid.lineBetween(0, y, WORLD_W, y);

    // 공허에 흩어진 미렌더 글리프
    const glyphs = ['NULL', '0x00', 'UNRENDERED', 'NaN', 'VOID', '// no data', '0xFF', '???'];
    for (let i = 0; i < 14; i += 1) {
      const gx = Phaser.Math.Between(1000, WORLD_W - 60);
      const gy = Phaser.Math.Between(60, WORLD_H - 80);
      this.add.text(gx, gy, glyphs[i % glyphs.length], {
        fontFamily: 'monospace',
        fontSize: '10px',
        color: '#1d4048',
        letterSpacing: 2,
      }).setAlpha(0.3).setAngle(Phaser.Math.Between(-8, 8)).setDepth(-36);
    }
    for (let i = 0; i < 26; i += 1) {
      addFloatingMote(this, Phaser.Math.Between(980, WORLD_W - 40), Phaser.Math.Between(80, 900), 0x2a5e66, 1);
    }
  }

  createFrameRoom() {
    // 프레임 안쪽만이 "그려진 세계"다 — 따뜻한 초록.
    this.add.rectangle(FRAME.x + FRAME.w / 2, FRAME.y + FRAME.h / 2, FRAME.w, FRAME.h, 0x0a1a19).setDepth(-30);
    this.add.circle(760, 95, 40, 0xd5dec3, 0.75).setDepth(-27);
    this.add.circle(745, 86, 40, 0x0a1a19, 0.9).setDepth(-26);

    const hills = this.add.graphics().setDepth(-24);
    hills.fillStyle(0x102a24, 0.9);
    for (let x = -20; x < 960; x += 96) {
      const height = 70 + ((x * 11) % 70);
      hills.fillTriangle(x, 500, x + 48, 500 - height, x + 96, 500);
    }
    for (let i = 0; i < 16; i += 1) {
      addFloatingMote(this, Phaser.Math.Between(40, 920), Phaser.Math.Between(120, 480), 0x8bbf73, 1);
    }

    // 지형: 방 바닥 + 소품 점프대
    createStaticPlatform(this, this.solids, 480, 520, 960, 40);
    createStaticPlatform(this, this.solids, 690, 430, 130, 24);
    createStaticPlatform(this, this.solids, 470, 352, 110, 22);
    this.add.rectangle(480, 770, 960, 460, 0x0a141a).setDepth(-6); // 공허 위의 기둥 단면


    // 낙서 (서사 = 한국어 세리프, 시스템 = 영문 모노)
    this.addGraffiti(430, 420, '"화면은 벽이 아니다. 값이다"', { size: 16, color: '#8fae9b', angle: -1.5 });
    this.add.text(858, 468, 'RENDER BOUNDARY >>', {
      fontFamily: 'monospace', fontSize: '10px', color: '#5f8f96', letterSpacing: 2,
    }).setOrigin(0.5).setAlpha(0.8).setDepth(15);
    this.add.text(1210, 372, 'UNRENDERED SECTOR', {
      fontFamily: 'monospace', fontSize: '10px', color: '#33636e', letterSpacing: 3,
    }).setOrigin(0.5).setAlpha(0.4).setDepth(15);

    // 빛나는 프레임 — "스테이지의 원래 화면"
    this.frameBorder = drawFrameBorder(this, FRAME.x, FRAME.y, FRAME.w, FRAME.h);
  }

  // -------------------------------------------------------------------------
  // 대협곡 — 유령 발판 (registerOffFrame)
  // 문턱값을 계단식으로 배치: 슬라이더를 내리는 동안 하나씩 실체화된다.
  // -------------------------------------------------------------------------

  createChasm() {
    // PATCH2: 협곡 바닥은 화면 안이다 — 가시밭 위로 죽음의 잔해가 사다리를 쌓는다
    const midX = (CANYON_PIT.left + CANYON_PIT.right) / 2;
    const width = CANYON_PIT.right - CANYON_PIT.left;
    createStaticPlatform(this, this.solids, midX, CANYON_PIT.top + 20, width, 40, 'earth', 0x5d707c);
    this.add.rectangle(midX, 900, width, 330, 0x0a1218).setDepth(-6);

    // 협곡 벽 밀폐(하부 빈 공간 차단) + 탈출 선반 — 바닥에서 직접 오를 수 있는 106px
    createStaticPlatform(this, this.solids, 949, 628, 22, 176, 'earth', 0x46545e);
    createStaticPlatform(this, this.solids, 2001, 690, 22, 220, 'earth', 0x46545e);
    createStaticPlatform(this, this.solids, 997, 620, 50, 20, 'earth', 0x91a9b5);
    // 우측 탈출 선반 없음 + 우측 림 아래 돌출 차양 — 죽음 잔해로는 오른쪽으로 못 나간다.
    // 협곡 횡단은 DISPLAY로 실체화한 유령 발판만이 길이다. (왼쪽 선반으로 되돌아가는 건 가능)
    createStaticPlatform(this, this.solids, 1860, 600, 260, 34, 'death-stone', 0x3a4750);

    this.createGhostPlatform(1085, 512, 120, 26, 88);
    this.createGhostPlatform(1225, 462, 110, 24, 83);
    this.createGhostPlatform(1390, 500, 110, 24, 78);
    this.createGhostPlatform(1555, 442, 100, 24, 74);
    this.createGhostPlatform(1720, 488, 105, 24, 71);
    this.createGhostPlatform(1860, 522, 130, 26, 70);
    this.pathFormed = this.offFramePlats.every((e) => e.active);
  }

  createGhostPlatform(x, y, w, h, threshold) {
    const plat = createStaticPlatform(this, this.ghosts, x, y, w, h, 'earth', 0x9fe0ea);
    registerOffFrame(this, plat, { threshold, body: plat.body });

    // 점선 윤곽 — 유령일 때만 보인다
    const outline = this.add.graphics().setDepth(13);
    outline.lineStyle(1, 0x74e6f0, 1);
    this.drawDashedRect(outline, x - w / 2, y - h / 2, w, h);

    const active = effective('display') <= threshold;
    if (active) {
      outline.setAlpha(0);
    } else {
      outline.setAlpha(0.35);
      this.pulseOutline(outline);
    }
    this.offFramePlats.push({ outline, threshold, active });
  }

  drawDashedRect(g, x, y, w, h, dash = 9, gap = 7) {
    for (let sx = x; sx < x + w; sx += dash + gap) {
      const ex = Math.min(sx + dash, x + w);
      g.lineBetween(sx, y, ex, y);
      g.lineBetween(sx, y + h, ex, y + h);
    }
    for (let sy = y; sy < y + h; sy += dash + gap) {
      const ey = Math.min(sy + dash, y + h);
      g.lineBetween(x, sy, x, ey);
      g.lineBetween(x + w, sy, x + w, ey);
    }
  }

  pulseOutline(outline) {
    this.tweens.add({
      targets: outline,
      alpha: { from: 0.2, to: 0.5 },
      duration: 1100,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut',
      delay: Phaser.Math.Between(0, 800),
    });
  }

  // -------------------------------------------------------------------------
  // 건너편 절벽 + 세로 낙차 구간 + 모듈 챔버 + 최종 간격
  // -------------------------------------------------------------------------

  createFarSide() {
    const cold = 0x91a9b5;
    // 절벽 상단 (협곡 도착 지점)
    createStaticPlatform(this, this.solids, 2120, 560, 260, 40, 'earth', cold);
    // 낙차 구간 선반들 (내려가고, 되돌아 올라올 수도 있게)
    createStaticPlatform(this, this.solids, 2500, 660, 130, 24, 'earth', cold);
    createStaticPlatform(this, this.solids, 2300, 745, 120, 24, 'earth', cold);
    // 모듈 챔버 바닥 (최종 간격의 왼쪽 끝 = x 2570)
    createStaticPlatform(this, this.solids, 2280, 820, 580, 40, 'earth', cold);
    // 최종 착지 발판 (70px 아래 — 대시+점프 전용)
    createStaticPlatform(this, this.solids, 3095, 890, 290, 40, 'earth', cold);
    // 최종 구덩이 우측 림 아래 차양 — 죽음 잔해로 대시 구간을 우회하지 못하게
    createStaticPlatform(this, this.solids, 2880, 930, 140, 34, 'death-stone', 0x3a4750);

    // PATCH2: 최종 간격 바닥 — 가시 구덩이 (낙사 대신 밟는 죽음, 잔해가 다리가 된다)
    createStaticPlatform(
      this, this.solids,
      (GAP_PIT.left + GAP_PIT.right) / 2, GAP_PIT.top + 20, GAP_PIT.right - GAP_PIT.left, 40,
      'earth', 0x55636e,
    );
    createStaticPlatform(this, this.solids, 2559, 900, 22, 120, 'earth', 0x46545e); // 구덩이 왼벽 밀폐
    this.add.rectangle((GAP_PIT.left + GAP_PIT.right) / 2, 900, GAP_PIT.right - GAP_PIT.left, 200, 0x0a1218).setDepth(-8);

    // 절벽/기둥 단면 비주얼
    this.add.rectangle(2120, 790, 260, 420, 0x0a1218).setDepth(-6);
    this.add.rectangle(2280, 700, 580, 320, 0x081016).setDepth(-8); // 챔버 내벽
    this.add.rectangle(3095, 950, 290, 120, 0x0a1218).setDepth(-6);

    // 낙차 구간 경고
    this.add.text(2210, 512, 'DROP ZONE', {
      fontFamily: 'monospace', fontSize: '9px', color: '#4d7e88', letterSpacing: 3,
    }).setOrigin(0.5).setAlpha(0.7).setDepth(15);

    // 최종 간격 계측 낙서
    this.add.text(2510, 764, 'GAP 380px // VELOCITY INSUFFICIENT', {
      fontFamily: 'monospace', fontSize: '10px', color: '#d95b64', letterSpacing: 1,
    }).setOrigin(0.5).setAlpha(0.85).setDepth(15).setAngle(-2);
  }

  // -------------------------------------------------------------------------
  // 프레임 경계 — 정전기, 접촉 사망, erased.FRAME 이후 균열
  // -------------------------------------------------------------------------

  createFrameBoundary() {
    this.frameCracked = Boolean(this.runState.erased.FRAME);
    if (this.frameCracked) {
      this.addFrameCracks();
      return;
    }
    // 오른쪽 경계 전체를 덮는 사망 존
    this.barrier = this.add.zone(FRAME_RIGHT + 4, FRAME.y + FRAME.h / 2, 12, FRAME.h + 20);
    this.physics.add.existing(this.barrier, true);
    this.physics.add.overlap(this.player, this.barrier, () => this.onBoundaryTouched());

    // 경계를 따라 튀는 상시 정전기
    this.sparkTimer = this.time.addEvent({
      delay: 620,
      loop: true,
      callback: () => this.spawnBorderSpark(),
    });
  }

  spawnBorderSpark() {
    if (this.zapLock || this.__dying) return;
    const g = this.add.graphics().setDepth(62);
    g.lineStyle(1, 0xbdf4ff, 0.85);
    let px = FRAME_RIGHT;
    let py = Phaser.Math.Between(50, FRAME.y + FRAME.h - 40);
    g.beginPath();
    g.moveTo(px, py);
    for (let i = 0; i < 4; i += 1) {
      px = FRAME_RIGHT + Phaser.Math.Between(-7, 7);
      py += Phaser.Math.Between(4, 10);
      g.lineTo(px, py);
    }
    g.strokePath();
    this.tweens.add({ targets: g, alpha: 0, duration: 170, onComplete: () => g.destroy() });
  }

  onBoundaryTouched() {
    // PATCH2: __truce(침입 활성) 중 재사망 없음
    if (this.zapLock || this.__dying || this.__truce || this.transitionLocked) return;
    if (this.runState.erased.FRAME) return;
    this.zapLock = true;

    const player = this.player;
    player.setVelocity(0, 0);
    if (player.body) player.body.enable = false; // 정전기에 붙들린다
    audio.sfx('shield');
    this.cameras.main.flash(110, 140, 230, 255);
    this.cameras.main.shake(360, 0.004);

    // 경계에서 플레이어에게 번개가 꽂힌다 (플리커)
    const bolts = this.add.graphics().setDepth(72);
    const drawBolts = () => {
      bolts.clear();
      for (let b = 0; b < 3; b += 1) {
        bolts.lineStyle(2, b === 0 ? 0xffffff : 0x9fe8ff, 0.9);
        const startY = player.y - Phaser.Math.Between(10, 80);
        bolts.beginPath();
        bolts.moveTo(FRAME_RIGHT, startY);
        for (let i = 1; i <= 5; i += 1) {
          const t = i / 5;
          bolts.lineTo(
            Phaser.Math.Linear(FRAME_RIGHT, player.x, t) + Phaser.Math.Between(-9, 9),
            Phaser.Math.Linear(startY, player.y - 30, t) + Phaser.Math.Between(-9, 9),
          );
        }
        bolts.strokePath();
      }
      player.setTintFill(Math.random() > 0.5 ? 0xbdf4ff : 0xffffff);
    };
    drawBolts();
    const flicker = this.time.addEvent({ delay: 60, repeat: 5, callback: drawBolts });
    this.tweens.add({ targets: player, x: player.x + 3, duration: 34, yoyo: true, repeat: 5 });

    this.time.delayedCall(430, () => {
      flicker.remove();
      bolts.destroy();
      this.player.clearTint();
      killPlayer(this, 'FRAME');
      // PATCH2: 사망이 씬을 재시작하지 않는다 — 잡기 연출 락을 해제해야
      // 침입 기상 후 update()가 다시 돈다 (이후는 __dying/__truce가 가드).
      this.zapLock = false;
    });
  }

  addFrameCracks() {
    // 경계가 깨졌다 — 오른쪽 변에 어두운 파공 + 균열 + 떠다니는 파편
    const g = this.add.graphics().setDepth(61);
    g.fillStyle(0x04060a, 1).fillRect(FRAME_RIGHT - 8, 392, 20, 148); // 통행 가능한 파공
    g.lineStyle(2, 0x65dad5, 0.55);
    this.drawCrack(g, FRAME_RIGHT, 392, FRAME_RIGHT, 540, 9);
    this.drawCrack(g, FRAME_RIGHT, 392, FRAME_RIGHT - 42, 330, 7);
    this.drawCrack(g, FRAME_RIGHT, 460, FRAME_RIGHT + 46, 402, 7);
    g.lineStyle(1, 0xffffff, 0.25);
    this.drawCrack(g, FRAME_RIGHT, 300, FRAME_RIGHT - 20, 208, 8);
    this.drawCrack(g, FRAME_RIGHT, 496, FRAME_RIGHT + 34, 560, 8);
    this.frameBorder.setAlpha(0.55);

    for (let i = 0; i < 4; i += 1) {
      const shard = this.add.rectangle(
        FRAME_RIGHT + Phaser.Math.Between(-14, 20),
        Phaser.Math.Between(400, 530),
        Phaser.Math.Between(3, 6),
        Phaser.Math.Between(3, 6),
        0x65dad5,
      ).setAlpha(0.4).setAngle(Phaser.Math.Between(0, 90)).setDepth(61);
      this.tweens.add({
        targets: shard,
        y: shard.y - Phaser.Math.Between(10, 26),
        angle: shard.angle + 120,
        alpha: 0.12,
        duration: Phaser.Math.Between(2400, 4200),
        yoyo: true,
        repeat: -1,
        ease: 'Sine.easeInOut',
      });
    }

    this.add.text(FRAME_RIGHT + 30, 366, 'BOUNDARY // VOID', {
      fontFamily: 'monospace', fontSize: '9px', color: '#3f7c86', letterSpacing: 2,
    }).setOrigin(0, 0.5).setAlpha(0.7).setDepth(61);
    this.addGraffiti(896, 306, '경계는 값이었다', { size: 12, color: '#6f958f', alpha: 0.75, angle: -2 });
  }

  drawCrack(g, x1, y1, x2, y2, jitter) {
    g.beginPath();
    g.moveTo(x1, y1);
    const steps = 5;
    for (let i = 1; i <= steps; i += 1) {
      const t = i / steps;
      g.lineTo(
        Phaser.Math.Linear(x1, x2, t) + Phaser.Math.Between(-jitter, jitter),
        Phaser.Math.Linear(y1, y2, t) + Phaser.Math.Between(-jitter, jitter),
      );
    }
    g.strokePath();
  }

  // -------------------------------------------------------------------------
  // 가시밭 (PATCH2) — 밟으면 SPIKES 사망 / erased.SPIKES면 무해(틴트 다운)+통과
  // -------------------------------------------------------------------------

  createSpikeBeds() {
    this.spikesDisarmed = false; // 가시는 항상 치명 — 죽음은 반복 가능한 규칙이다
    const defs = [
      { x: (CANYON_PIT.left + CANYON_PIT.right) / 2, y: CANYON_PIT.top, w: CANYON_PIT.right - CANYON_PIT.left },
      { x: (GAP_PIT.left + GAP_PIT.right) / 2, y: GAP_PIT.top, w: GAP_PIT.right - GAP_PIT.left },
    ];
    for (const def of defs) {
      const bed = { g: this.add.graphics().setDepth(14), x: def.x, y: def.y, w: def.w };
      this.drawSpikeBed(bed, !this.spikesDisarmed);
      this.spikeBeds.push(bed);
      // 얇은 상단 스트립만 판정 — 시체(-18)/버튼 위에 서면 닿지 않는다 (잔해 = 가시 위 다리)
      const zone = this.add.zone(def.x, def.y - 7, def.w, 14);
      this.physics.add.existing(zone, true);
      this.physics.add.overlap(this.player, zone, () => this.onSpikesTouched());
    }
  }

  drawSpikeBed(bed, armed) {
    const g = bed.g;
    g.clear();
    const left = bed.x - bed.w / 2;
    const step = 18;
    const count = Math.floor(bed.w / step);
    const pad = (bed.w - count * step) / 2;
    for (let i = 0; i < count; i += 1) {
      const sx = left + pad + i * step;
      const h = 14 + ((i * 7) % 5); // 결정적 들쭉날쭉
      const tipY = bed.y - h;
      g.fillStyle(armed ? 0x27363f : 0x151e25, armed ? 1 : 0.6);
      g.fillTriangle(sx, bed.y, sx + step / 2, tipY, sx + step, bed.y);
      g.fillStyle(armed ? 0xd95b64 : 0x2c3a42, armed ? 0.95 : 0.5);
      g.fillTriangle(sx + step / 2 - 3, tipY + 6, sx + step / 2, tipY, sx + step / 2 + 3, tipY + 6);
    }
    g.fillStyle(armed ? 0x1a262e : 0x111a21, 1).fillRect(left, bed.y - 3, bed.w, 6);
  }

  onSpikesTouched() {
    if (this.__dying || this.__truce || this.zapLock || this.transitionLocked) return;
    killPlayer(this, 'SPIKES');
  }

  disarmSpikes() {
    this.spikesDisarmed = true;
    for (const bed of this.spikeBeds) this.drawSpikeBed(bed, false);
  }

  // -------------------------------------------------------------------------
  // DASH MODULE — 부유 육각 코어 + 궤도 파편, E 홀드 획득
  // -------------------------------------------------------------------------

  createModule() {
    if (this.runState.dashFound) return;

    const { x, y } = MODULE_POS;
    this.module = this.add.container(x, y).setDepth(24);

    const glow = this.add.image(0, 0, 'glow-orb').setScale(2.1).setTint(0x74f0e4).setAlpha(0.55)
      .setBlendMode(Phaser.BlendModes.ADD);

    this.moduleHex = this.add.graphics();
    this.moduleHex.fillStyle(0x0d2b2e, 1).lineStyle(2, 0x74f0e4, 1);
    this.moduleHex.beginPath();
    for (let i = 0; i < 6; i += 1) {
      const a = Math.PI / 6 + (i * Math.PI) / 3;
      const px = Math.cos(a) * 17;
      const py = Math.sin(a) * 17;
      if (i === 0) this.moduleHex.moveTo(px, py);
      else this.moduleHex.lineTo(px, py);
    }
    this.moduleHex.closePath();
    this.moduleHex.fillPath();
    this.moduleHex.strokePath();
    this.moduleHex.fillStyle(0x9ff2e6, 0.95).fillCircle(0, 0, 4);

    this.moduleShards = [];
    for (let i = 0; i < 3; i += 1) {
      const shard = this.add.rectangle(0, 0, 7, 7, 0x9ff2e6).setAlpha(0.9);
      this.moduleShards.push(shard);
    }
    this.module.add([glow, this.moduleHex, ...this.moduleShards]);
    this.tweens.add({ targets: this.module, y: y - 9, duration: 1500, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' });
    this.tweens.add({ targets: glow, alpha: { from: 0.35, to: 0.7 }, duration: 900, yoyo: true, repeat: -1 });

    this.moduleTitle = this.add.text(x, 664, 'DASH MODULE', {
      fontFamily: 'monospace', fontSize: '11px', color: '#74f0e4', letterSpacing: 3,
    }).setOrigin(0.5).setDepth(25);
    this.moduleSub = this.add.text(x, 680, 'KEY NOT BOUND', {
      fontFamily: 'monospace', fontSize: '9px', color: '#ef4d5b', letterSpacing: 2,
    }).setOrigin(0.5).setDepth(25);
    this.tweens.add({ targets: this.moduleSub, alpha: { from: 1, to: 0.25 }, duration: 620, yoyo: true, repeat: -1 });

    // interact 리바인딩 대응 — 현재 바인딩된 키를 안내한다.
    this.modulePrompt = this.add.text(x, 752, `[${store.getState().bindings.interact || 'E'}] HOLD — ACQUIRE MODULE`, {
      fontFamily: 'monospace', fontSize: '10px', color: '#d9d2c1', letterSpacing: 2,
    }).setOrigin(0.5).setAlpha(0).setDepth(25);
  }

  acquireModule() {
    if (!this.module) return;
    const mx = this.module.x;
    const my = this.module.y;

    this.runState.dashFound = true;
    saveRunState(this, this.runState);
    store.unlock('controls');

    audio.sfx('collect');
    this.time.delayedCall(220, () => audio.sfx('unlock'));
    this.cameras.main.flash(160, 116, 240, 228);
    this.cameras.main.shake(140, 0.004);

    // 파열 이펙트 + 상승 텍스트
    if (this.textures.exists('white-pixel')) {
      const burst = this.add.particles(mx, my, 'white-pixel', {
        speed: { min: 60, max: 260 },
        quantity: 18,
        lifespan: { min: 260, max: 640 },
        scale: { start: 2, end: 0 },
        alpha: { start: 1, end: 0 },
        tint: [0x74f0e4, 0x9ff2e6, 0xffffff],
        emitting: false,
      }).setDepth(70);
      burst.explode(18);
      this.time.delayedCall(800, () => burst.destroy());
    }
    const rise = this.add.text(mx, my - 30, 'MODULE ACQUIRED', {
      fontFamily: 'monospace', fontSize: '12px', color: '#9ff2e6', letterSpacing: 3,
    }).setOrigin(0.5).setDepth(71);
    this.tweens.add({ targets: rise, y: my - 78, alpha: 0, duration: 1400, ease: 'Cubic.easeOut', onComplete: () => rise.destroy() });

    this.tweens.killTweensOf(this.module);
    this.tweens.add({
      targets: this.module,
      scaleX: 1.6,
      scaleY: 1.6,
      alpha: 0,
      duration: 260,
      ease: 'Cubic.easeOut',
      onComplete: () => {
        this.module.destroy();
        this.module = null;
        this.moduleHex = null;
      },
    });
    this.moduleTitle.destroy();
    this.moduleSub.destroy();
    this.modulePrompt.destroy();
    this.modulePrompt = null;

    this.moduleHold = 0;
    this.emitStatus();
  }

  // -------------------------------------------------------------------------
  // 출구 — SYS_ADMIN 게이트
  // -------------------------------------------------------------------------

  createExitDoor() {
    const { x, y } = DOOR_POS;
    const gate = this.add.rectangle(x, y - 46, 60, 92, 0x0b1114).setStrokeStyle(2, 0xd95b64, 0.9).setDepth(14);
    this.add.rectangle(x, y - 46, 40, 72, 0x150b0d).setStrokeStyle(1, 0x8d262f, 0.7).setDepth(14);

    // 상단 경고 스트라이프
    const stripes = this.add.graphics().setDepth(15);
    stripes.fillStyle(0xd95b64, 0.75);
    for (let sx = -26; sx < 26; sx += 12) stripes.fillRect(x + sx, y - 96, 6, 5);

    this.add.text(x, y - 134, 'SYS_ADMIN', {
      fontFamily: 'monospace', fontSize: '12px', color: '#ef4d5b', letterSpacing: 4,
    }).setOrigin(0.5).setDepth(15);
    this.add.text(x, y - 118, 'AUTHORIZED FAILURES ONLY', {
      fontFamily: 'monospace', fontSize: '8px', color: '#8a5560', letterSpacing: 2,
    }).setOrigin(0.5).setDepth(15);

    this.tweens.add({ targets: gate, alpha: { from: 0.75, to: 1 }, duration: 780, yoyo: true, repeat: -1 });

    this.doorPrompt = this.add.text(x, y - 106, `[${store.getState().bindings.interact || 'E'}] HOLD — ENTER`, {
      fontFamily: 'monospace', fontSize: '10px', color: '#d9d2c1', letterSpacing: 2,
    }).setOrigin(0.5).setAlpha(0).setDepth(16);
  }

  exitStage() {
    if (this.transitionLocked) return;
    this.transitionLocked = true;
    this.player.setVelocity(0, 0);
    this.runState.stage = 'BossScene';
    saveRunState(this, this.runState);
    audio.sfx('collect');
    this.cameras.main.flash(220, 239, 77, 91);
    this.cameras.main.fadeOut(430, 4, 4, 6);
    this.time.delayedCall(470, () => this.scene.start('BossScene'));
  }

  // -------------------------------------------------------------------------
  // store 구독 — 스태거드 실체화 쿵 + 대시 바인딩 HUD 반영
  // -------------------------------------------------------------------------

  bindStoreEffects() {
    // 문턱 통과 시 발판마다 저음 쿵 + 셰이크 (여러 개 동시 통과면 75ms 간격 스태거)
    const unsubMaterialize = store.subscribe((event) => {
      if (event.type === 'change' && event.key !== 'display') return;
      const display = effective('display');
      let delay = 0;
      for (const entry of this.offFramePlats) {
        const active = display <= entry.threshold;
        if (active === entry.active) continue;
        entry.active = active;
        this.tweens.killTweensOf(entry.outline);
        if (active) {
          const d = delay;
          delay += 75;
          this.time.delayedCall(d, () => {
            entry.outline.setAlpha(0);
            this.cameras.main.shake(85, 0.0019);
            audio.sfx('land');
          });
        } else {
          entry.outline.setAlpha(0.35);
          this.pulseOutline(entry.outline);
        }
      }
      // 전 구간 실체화 — 한 번만 크게 울린다
      const allActive = this.offFramePlats.every((e) => e.active);
      if (allActive && !this.pathFormed) {
        this.pathFormed = true;
        this.time.delayedCall(delay + 90, () => {
          audio.sfx('rumble');
          this.cameras.main.shake(260, 0.003);
          const note = this.add.text(1470, 380, 'PATH MATERIALIZED', {
            fontFamily: 'monospace', fontSize: '12px', color: '#8fd8f0', letterSpacing: 4,
          }).setOrigin(0.5).setAlpha(0).setDepth(70);
          this.tweens.add({ targets: note, alpha: { from: 0, to: 1 }, duration: 260, yoyo: true, hold: 1300, onComplete: () => note.destroy() });
        });
      } else if (!allActive) {
        this.pathFormed = false;
      }
    });

    // 대시 키가 바인딩되는 순간 — 축포 + HUD 갱신
    const unsubRebind = store.subscribe((event) => {
      if (event.type !== 'rebind' || event.key !== 'dash' || !event.value) return;
      if (!this.runState.dashFound) return;
      audio.sfx('collect');
      this.cameras.main.flash(120, 116, 240, 228);
      if (this.player && this.player.body && this.player.body.enable) {
        const ring = this.add.ellipse(this.player.x, this.player.y - 28, 20, 20)
          .setStrokeStyle(2, 0x74f0e4, 0.9).setDepth(70);
        this.tweens.add({
          targets: ring, scaleX: 3.6, scaleY: 3.6, alpha: 0, duration: 460, ease: 'Cubic.easeOut',
          onComplete: () => ring.destroy(),
        });
      }
      this.emitStatus();
    });

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      unsubMaterialize();
      unsubRebind();
    });
  }

  // -------------------------------------------------------------------------
  // 낙사 / 리스폰 / 체크포인트
  // -------------------------------------------------------------------------

  handleFall() {
    // PATCH2: 낙사 지형 제거(GRAVITY 폐지) — 모든 바닥이 화면 안에 있으므로
    // 여기 도달은 물리 이탈뿐이다. 방어적 복귀만 한다.
    const spawn = this.spawnPoint();
    this.player.setVelocity(0, 0);
    this.player.setPosition(spawn.x, spawn.y);
    this.cameras.main.flash(180, 101, 218, 213);
    audio.sfx('ui');
  }

  registerCheckpoint() {
    this.registry.set(CHECKPOINT_KEY, true);
    audio.sfx('ui');
    const note = this.add.text(this.player.x, this.player.y - 74, 'CHECKPOINT // REGISTERED', {
      fontFamily: 'monospace', fontSize: '9px', color: '#71d98b', letterSpacing: 2,
    }).setOrigin(0.5).setAlpha(0).setDepth(70);
    this.tweens.add({
      targets: note,
      alpha: { from: 0, to: 0.9 },
      y: note.y - 16,
      duration: 300,
      yoyo: true,
      hold: 1100,
      onComplete: () => note.destroy(),
    });
  }

  // -------------------------------------------------------------------------
  // update
  // -------------------------------------------------------------------------

  update(time, delta) {
    // 모듈 궤도 파편은 어떤 상태에서도 돈다
    if (this.moduleHex && this.module) {
      this.moduleHex.rotation += 0.0006 * delta;
      for (let i = 0; i < this.moduleShards.length; i += 1) {
        const a = time * 0.0028 + (i * Math.PI * 2) / this.moduleShards.length;
        this.moduleShards[i].setPosition(Math.cos(a) * 28, Math.sin(a) * 13);
        this.moduleShards[i].rotation = a;
      }
    }

    // 오른쪽 세계 공개 — DISPLAY 사용 또는 경계 통과 시 1회
    if (!this.voidRevealed && (effective('display') <= 70 || this.player.x > FRAME_RIGHT)) {
      this.voidRevealed = true;
      this.cameras.main.setBounds(0, 0, WORLD_W, WORLD_H); // 카메라 해방
      this.tweens.add({ targets: this.voidCover, alpha: 0, duration: 900, ease: 'Sine.easeInOut' });
    }

    // PATCH2: 사망이 씬을 재시작하지 않는다 — in-scene 삭제에 실시간 반응
    if (!this.frameCracked && this.runState.erased.FRAME) {
      this.frameCracked = true;
      if (this.sparkTimer) {
        this.sparkTimer.remove();
        this.sparkTimer = null;
      }
      if (this.barrier && this.barrier.body) this.barrier.body.enable = false;
      this.addFrameCracks();
      this.time.delayedCall(2600, () => this.emitStatus());
    }

    if (this.__dying || this.zapLock || this.transitionLocked || !this.player) {
      if (this.holdArc) this.holdArc.clear();
      return;
    }

    const state = updatePlayer(this, this.player, this.keys, this.controller, { allowDisguise: false });
    this.holdArc.clear();
    const interactDown = this.keys.isDown('interact');

    // --- DASH MODULE 획득 (E 홀드) ---
    if (this.module) {
      const near = Phaser.Math.Distance.Between(this.player.x, this.player.y - 24, this.module.x, this.module.y) < 95;
      if (this.modulePrompt) this.modulePrompt.setAlpha(near ? 1 : 0);
      if (near && interactDown) {
        this.moduleHold += delta;
        this.drawHoldArc(this.module.x, this.module.y, this.moduleHold / MODULE_HOLD_MS);
        if (this.moduleHold >= MODULE_HOLD_MS) this.acquireModule();
      } else {
        this.moduleHold = 0;
      }
    }

    // --- 출구 게이트 (E 홀드) ---
    const nearDoor = Math.abs(this.player.x - DOOR_POS.x) < 60 && Math.abs(this.player.y - DOOR_POS.y) < 90;
    this.doorPrompt.setAlpha(nearDoor ? 1 : 0);
    if (nearDoor && interactDown) {
      this.doorHold += delta;
      this.drawHoldArc(DOOR_POS.x, DOOR_POS.y - 46, this.doorHold / DOOR_HOLD_MS);
      if (this.doorHold >= DOOR_HOLD_MS) {
        this.exitStage();
        return;
      }
    } else {
      this.doorHold = 0;
    }

    // --- 체크포인트: 협곡 건너 챔버 착지 ---
    if (
      !this.registry.get(CHECKPOINT_KEY)
      && state.onGround
      && this.player.x > 2010 && this.player.x < 2600
      && this.player.y > 700
    ) {
      this.registerCheckpoint();
    }

    // --- 방어적 복귀 (PATCH2: 낙사 지형 없음 — 물리 이탈 대비) ---
    if (this.player.y > FALL_Y) this.handleFall();
  }

  drawHoldArc(x, y, fraction) {
    const f = Phaser.Math.Clamp(fraction, 0, 1);
    if (f <= 0) return;
    this.holdArc.lineStyle(3, 0x74f0e4, 0.9);
    this.holdArc.beginPath();
    this.holdArc.arc(x, y, 30, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * f);
    this.holdArc.strokePath();
    this.holdArc.lineStyle(1, 0x74f0e4, 0.25);
    this.holdArc.strokeCircle(x, y, 30);
  }

  // -------------------------------------------------------------------------
  // 헬퍼
  // -------------------------------------------------------------------------

  addGraffiti(x, y, text, { size = 13, color = '#7f9c8a', alpha = 0.85, angle = 0 } = {}) {
    return this.add.text(x, y, text, {
      fontFamily: 'Georgia, "Times New Roman", serif',
      fontSize: `${size}px`,
      color,
    }).setOrigin(0.5).setAlpha(alpha).setAngle(angle).setDepth(15)
      .setShadow(0, 2, '#000000', 4, true, true);
  }
}
