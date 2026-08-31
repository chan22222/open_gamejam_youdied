// ESC/APE — 공유 엔진 유틸 (A2 core-engine)
// ARCHITECTURE.md 4절의 계약 export를 정확히 구현한다.
// 설정(store)이 곧 물리 법칙이다: 밝기=어둠 오버레이, 디스플레이=카메라 줌, 바인딩=입력.

import Phaser from 'phaser';
import { store, effective } from './settingsStore.js';
import { audio } from './audio.js';
import { addCorpse } from './corpses.js';
import { emitState } from './events.js';
import { saveProgress } from './persistence.js';
// 순환 참조 주의: deathIntrusion은 이 모듈의 함수를 런타임에만 사용한다 (모듈 평가 시점 미사용 — 안전).
import { triggerDeathIntrusion } from './deathIntrusion.js';

export const VIEW_WIDTH = 960;
export const VIEW_HEIGHT = 540;

const DASH_SPEED = 620;
const DASH_DURATION = 160; // ms
const DASH_COOLDOWN = 700; // ms
const COYOTE_MS = 115;
const JUMP_BUFFER_MS = 115;
const PLAYER_SCALE = 2.65;

function safeSfx(name) {
  try {
    audio.sfx(name);
  } catch {
    // 오디오는 절대 게임을 멈추지 않는다.
  }
}

// 씬 정리 공통 훅. scene.stop()은 SHUTDOWN을, game.destroy(true)는 SHUTDOWN 없이
// DESTROY만 emit하므로(Phaser Systems.destroy) 양쪽 모두에 걸어 store 구독 누수를 막는다.
// (React StrictMode 이중 마운트에서 1번째 게임 인스턴스가 destroy될 때 필수.)
function onSceneTeardown(scene, fn) {
  const run = () => {
    scene.events.off(Phaser.Scenes.Events.SHUTDOWN, run);
    scene.events.off(Phaser.Scenes.Events.DESTROY, run);
    fn();
  };
  scene.events.once(Phaser.Scenes.Events.SHUTDOWN, run);
  scene.events.once(Phaser.Scenes.Events.DESTROY, run);
}

// ---------------------------------------------------------------------------
// 에셋 로드 / 텍스처 / 애니메이션 (BootScene 전용)
// ---------------------------------------------------------------------------

export function preloadShared(scene) {
  const root = '/assets';
  scene.load.spritesheet('cat-idle', `${root}/character/HIDER/gray/1_Cat_Idle-Sheet.png`, { frameWidth: 32, frameHeight: 32 });
  scene.load.spritesheet('cat-run', `${root}/character/HIDER/gray/2_Cat_Run-Sheet.png`, { frameWidth: 32, frameHeight: 32 });
  scene.load.spritesheet('cat-jump', `${root}/character/HIDER/gray/3_Cat_Jump-Sheet.png`, { frameWidth: 32, frameHeight: 32 });
  scene.load.spritesheet('cat-fall', `${root}/character/HIDER/gray/4_Cat_Fall-Sheet.png`, { frameWidth: 32, frameHeight: 32 });
  scene.load.spritesheet('cat-ghost', `${root}/character/HIDER/lemon/1_Cat_Idle-Sheet.png`, { frameWidth: 32, frameHeight: 32 });
  scene.load.spritesheet('cat-canvas', `${root}/character/HIDER/gray/5_Cat_Canvas-Sheet.png`, { frameWidth: 32, frameHeight: 32 });
  scene.load.spritesheet('seeker-idle', `${root}/character/SEEKER/1_Cat_Idle-Sheet.png`, { frameWidth: 32, frameHeight: 32 });
  scene.load.spritesheet('seeker-run', `${root}/character/SEEKER/2_Cat_Run-Sheet.png`, { frameWidth: 32, frameHeight: 32 });
  scene.load.image('grass-tiles', `${root}/map/SproutLands/Tilesets/Grass.png`);
  scene.load.image('hills-tiles', `${root}/map/SproutLands/Tilesets/Hills.png`);
  scene.load.image('water-tiles', `${root}/map/SproutLands/Tilesets/Water.png`);
  scene.load.image('bridge-object', `${root}/map/SproutLands/Objects/Wood_Bridge.png`);
  scene.load.image('chicken-house', `${root}/map/SproutLands/Objects/Free_Chicken_House.png`);
  scene.load.image('crosshair', `${root}/ui/crosshairs.png`);
}

export function createSharedTextures(scene) {
  if (!scene.textures.exists('earth')) {
    const earth = scene.make.graphics({ add: false });
    earth.fillStyle(0x173326).fillRect(0, 0, 64, 32);
    earth.fillStyle(0x274936).fillRect(0, 4, 64, 28);
    earth.fillStyle(0x356b3f).fillRect(0, 0, 64, 7);
    earth.fillStyle(0x86b968).fillRect(0, 0, 64, 2);
    earth.fillStyle(0x1c3b2c, 0.8);
    for (let x = 5; x < 64; x += 13) earth.fillRect(x, 15 + ((x * 7) % 9), 5, 3);
    earth.generateTexture('earth', 64, 32);
    earth.destroy();
  }

  if (!scene.textures.exists('death-stone')) {
    const stone = scene.make.graphics({ add: false });
    stone.fillStyle(0x171b1d).fillRect(0, 0, 64, 18);
    stone.fillStyle(0xd9d2c1).fillRect(0, 0, 64, 3);
    stone.fillStyle(0x746f68).fillRect(0, 14, 64, 2);
    stone.fillStyle(0x8d262f, 0.5).fillRect(8, 7, 18, 1);
    stone.generateTexture('death-stone', 64, 18);
    stone.destroy();
  }

  if (!scene.textures.exists('white-pixel')) {
    const pixel = scene.make.graphics({ add: false });
    pixel.fillStyle(0xffffff).fillRect(0, 0, 2, 2);
    pixel.generateTexture('white-pixel', 2, 2);
    pixel.destroy();
  }

  // 부드러운 발광 원 — 광원/대시/영혼 이펙트용
  if (!scene.textures.exists('glow-orb')) {
    const orb = scene.make.graphics({ add: false });
    for (let r = 32; r >= 2; r -= 2) {
      orb.fillStyle(0xffffff, 0.05).fillCircle(32, 32, r);
    }
    orb.generateTexture('glow-orb', 64, 64);
    orb.destroy();
  }
}

export function createAnimations(scene) {
  const make = (key, texture, end, frameRate) => {
    if (!scene.anims.exists(key)) {
      scene.anims.create({ key, frames: scene.anims.generateFrameNumbers(texture, { start: 0, end }), frameRate, repeat: -1 });
    }
  };
  make('cat-idle-anim', 'cat-idle', 7, 7);
  make('cat-run-anim', 'cat-run', 9, 14);
  make('cat-jump-anim', 'cat-jump', 3, 9);
  make('cat-fall-anim', 'cat-fall', 3, 9);
  make('cat-ghost-anim', 'cat-ghost', 7, 6);
  make('cat-canvas-anim', 'cat-canvas', 3, 7);
  make('seeker-idle-anim', 'seeker-idle', 7, 6);
  make('seeker-run-anim', 'seeker-run', 9, 11);
}

// ---------------------------------------------------------------------------
// 플레이어
// ---------------------------------------------------------------------------

export function createPlayer(scene, x, y, ghost = false) {
  const player = scene.physics.add.sprite(x, y, ghost ? 'cat-ghost' : 'cat-idle');
  player.setScale(PLAYER_SCALE).setOrigin(0.5, 1).setDepth(30);
  player.setMaxVelocity(290, 1100).setDragX(1750);
  player.body.setSize(17, 26).setOffset(7.5, 5.5);
  if (ghost) player.setAlpha(0.88).setTint(0xd8fff4);
  return player;
}

// ---------------------------------------------------------------------------
// 입력 — store.bindings 기반, rebind 시 자동 재구성
// ---------------------------------------------------------------------------

const INPUT_ACTIONS = ['left', 'right', 'jump', 'interact', 'disguise', 'dash'];
const ARROW_ALIASES = { left: 'LEFT', right: 'RIGHT', jump: 'UP' }; // 방향키 별칭 고정
const KEY_NAME_FIXES = {
  ' ': 'SPACE',
  SPACEBAR: 'SPACE',
  CONTROL: 'CTRL',
  ESCAPE: 'ESC',
  RETURN: 'ENTER',
  ARROWLEFT: 'LEFT',
  ARROWRIGHT: 'RIGHT',
  ARROWUP: 'UP',
  ARROWDOWN: 'DOWN',
  0: 'ZERO', 1: 'ONE', 2: 'TWO', 3: 'THREE', 4: 'FOUR',
  5: 'FIVE', 6: 'SIX', 7: 'SEVEN', 8: 'EIGHT', 9: 'NINE',
};

function keyCodeFor(name) {
  if (!name) return null;
  const upper = String(name).toUpperCase();
  const fixed = KEY_NAME_FIXES[upper] ?? upper;
  const code = Phaser.Input.Keyboard.KeyCodes[fixed];
  if (code !== undefined) return code;
  if (fixed.length === 1) {
    const ch = fixed.charCodeAt(0);
    if (ch >= 48 && ch <= 90) return ch;
  }
  return null;
}

export function createInput(scene) {
  const keyboard = scene.input.keyboard;
  let keys = {};
  let destroyed = false;
  const justCache = {}; // action -> { frame, value } : 같은 프레임 내 다중 조회 일관성 보장

  const destroyKeys = () => {
    for (const list of Object.values(keys)) {
      for (const key of list) {
        try { keyboard.removeKey(key, true); } catch { /* 이미 해제됨 */ }
      }
    }
    keys = {};
  };

  const build = () => {
    destroyKeys();
    const { bindings } = store.getState();
    for (const action of INPUT_ACTIONS) {
      keys[action] = [];
      const names = [];
      if (bindings[action]) names.push(bindings[action]);
      if (ARROW_ALIASES[action]) names.push(ARROW_ALIASES[action]);
      for (const name of names) {
        const code = keyCodeFor(name);
        if (code === null) continue;
        try { keys[action].push(keyboard.addKey(code)); } catch { /* 미지원 키는 무시 */ }
      }
    }
  };

  build();

  const unsub = store.subscribe((event) => {
    if (destroyed) return;
    if (event.type === 'rebind' || event.type === 'reset') build();
  });

  const input = {
    isDown(action) {
      const list = keys[action];
      if (!list) return false;
      for (const key of list) if (key.isDown) return true;
      return false;
    },
    justPressed(action) {
      const frame = scene.game.loop.frame;
      const cached = justCache[action];
      if (cached && cached.frame === frame) return cached.value;
      let value = false;
      const list = keys[action] || [];
      for (const key of list) {
        // 별칭 키의 JustDown 플래그가 다음 프레임으로 이월되지 않도록 전부 소비한다.
        if (Phaser.Input.Keyboard.JustDown(key)) value = true;
      }
      justCache[action] = { frame, value };
      return value;
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      unsub();
      destroyKeys();
    },
  };

  onSceneTeardown(scene, () => input.destroy());
  return input;
}

// ---------------------------------------------------------------------------
// 플레이어 이동 — 코요테 점프 + 점프 버퍼 + 대시(잔상)
// controller: 씬이 보관하는 평범한 객체 { lastGroundedAt:-1000, jumpBufferedAt:-1000 }
// ---------------------------------------------------------------------------

export function updatePlayer(scene, player, input, controller, options = {}) {
  const speed = options.speed ?? 265;
  const jumpVelocity = options.jumpVelocity ?? -665;
  const ghost = options.ghost ?? false;
  const allowDisguise = options.allowDisguise ?? false;
  const allowDash = options.allowDash ?? true;

  const body = player.body;
  // 사망(killPlayer가 body 비활성) 이후에는 시체 상태를 건드리지 않는다.
  if (!body || !body.enable) return { onGround: false, disguised: false, dashing: false };

  const now = scene.time.now;
  if (controller.dashUntil === undefined) {
    controller.dashUntil = -1;
    controller.dashReadyAt = -1;
    controller.dashDir = 1;
    controller.baseMaxX = body.maxVelocity.x;
    controller.trailAt = 0;
    controller.wasDashing = false;
    controller.wasOnGround = false;
    controller.prevFallSpeed = 0;
    controller.stretchTween = null;
  }

  const onGround = body.blocked.down || body.touching.down;
  const leftDown = input.isDown('left');
  const rightDown = input.isDown('right');
  if (input.justPressed('jump')) controller.jumpBufferedAt = now;
  if (onGround) controller.lastGroundedAt = now;

  // 착지 임팩트
  if (onGround && !controller.wasOnGround && controller.prevFallSpeed > 430) {
    safeSfx('land');
    scene.cameras.main.shake(60, 0.0012);
    spawnDust(scene, player.x, player.y);
  }

  let dashing = now < controller.dashUntil;
  const runState = getRunState(scene);
  const dashBound = Boolean(store.getState().bindings.dash);
  const disguised = Boolean(allowDisguise && !dashing && onGround && input.isDown('disguise'));

  // --- 대시 발동: 모듈 획득 + 키 바인딩이 모두 있어야 한다 (설정이 곧 능력)
  if (!dashing && !disguised && allowDash && dashBound && runState.dashFound
    && now >= controller.dashReadyAt && input.justPressed('dash')) {
    dashing = true;
    controller.dashUntil = now + DASH_DURATION;
    controller.dashReadyAt = now + DASH_COOLDOWN;
    controller.dashDir = leftDown ? -1 : rightDown ? 1 : (player.flipX ? -1 : 1);
    controller.baseMaxX = body.maxVelocity.x;
    controller.trailAt = 0;
    body.maxVelocity.x = DASH_SPEED + 40;
    body.allowGravity = false;
    player.setFlipX(controller.dashDir < 0);
    safeSfx('dash');
    scene.cameras.main.shake(70, 0.0018);
  }

  if (dashing) {
    player.setVelocity(controller.dashDir * DASH_SPEED, 0);
    player.anims.play('cat-run-anim', true);
    player.setTint(0x9ff2e6).setAlpha(0.96);
    if (now >= controller.trailAt) {
      controller.trailAt = now + 30;
      spawnDashGhost(scene, player);
    }
  } else {
    if (controller.wasDashing) {
      // 대시 종료 — 물리 복원
      body.allowGravity = true;
      body.maxVelocity.x = controller.baseMaxX;
      player.setVelocityX(Phaser.Math.Clamp(body.velocity.x, -speed, speed));
    }

    if (disguised) {
      player.setVelocityX(0);
    } else if (leftDown) {
      player.setVelocityX(-speed).setFlipX(true);
    } else if (rightDown) {
      player.setVelocityX(speed).setFlipX(false);
    } else {
      player.setVelocityX(0);
    }

    const canCoyoteJump = now - controller.lastGroundedAt < COYOTE_MS;
    const hasBufferedJump = now - controller.jumpBufferedAt < JUMP_BUFFER_MS;
    if (hasBufferedJump && canCoyoteJump && !disguised) {
      player.setVelocityY(jumpVelocity);
      controller.jumpBufferedAt = -1000;
      controller.lastGroundedAt = -1000;
      safeSfx('jump');
      spawnDust(scene, player.x, player.y);
      jumpStretch(scene, player, controller);
    }

    if (disguised) {
      player.anims.play('cat-canvas-anim', true);
      player.setTint(0x7ca46f).setAlpha(0.72);
    } else {
      player.clearTint().setAlpha(ghost ? 0.88 : 1);
      if (!onGround) player.anims.play(body.velocity.y < 0 ? 'cat-jump-anim' : 'cat-fall-anim', true);
      else if (Math.abs(body.velocity.x) > 12) player.anims.play(ghost ? 'cat-ghost-anim' : 'cat-run-anim', true);
      else player.anims.play(ghost ? 'cat-ghost-anim' : 'cat-idle-anim', true);
    }
  }

  controller.wasDashing = dashing;
  controller.wasOnGround = onGround;
  controller.prevFallSpeed = body.velocity.y;
  return { onGround, disguised, dashing };
}

function jumpStretch(scene, player, controller) {
  if (controller.stretchTween) controller.stretchTween.stop();
  player.setScale(PLAYER_SCALE);
  controller.stretchTween = scene.tweens.add({
    targets: player,
    scaleX: PLAYER_SCALE - 0.22,
    scaleY: PLAYER_SCALE + 0.26,
    duration: 95,
    yoyo: true,
    ease: 'Sine.easeOut',
    onComplete: () => {
      player.setScale(PLAYER_SCALE);
      controller.stretchTween = null;
    },
  });
}

function spawnDashGhost(scene, player) {
  const ghost = scene.add.image(player.x, player.y, player.texture.key, player.frame.name)
    .setOrigin(player.originX, player.originY)
    .setScale(player.scaleX, player.scaleY)
    .setFlipX(player.flipX)
    .setDepth((player.depth || 30) - 1)
    .setTint(0x74f0e4)
    .setAlpha(0.5)
    .setBlendMode(Phaser.BlendModes.ADD);
  scene.tweens.add({
    targets: ghost,
    alpha: 0,
    duration: 240,
    ease: 'Cubic.easeOut',
    onComplete: () => ghost.destroy(),
  });
}

function spawnDust(scene, x, y) {
  if (!scene.textures.exists('white-pixel')) return;
  const dust = scene.add.particles(x, y, 'white-pixel', {
    speedX: { min: -75, max: 75 },
    speedY: { min: -95, max: -15 },
    quantity: 6,
    lifespan: { min: 180, max: 380 },
    scale: { start: 1.6, end: 0 },
    alpha: { start: 0.5, end: 0 },
    tint: 0xc9d6c7,
    emitting: false,
  }).setDepth(26);
  dust.explode(6);
  scene.time.delayedCall(500, () => dust.destroy());
}

// ---------------------------------------------------------------------------
// 지형 / 배경 소품
// ---------------------------------------------------------------------------

export function createStaticPlatform(scene, group, x, y, w, h = 32, texture = 'earth', tint = 0xffffff) {
  const platform = group.create(x, y, texture);
  platform.setDisplaySize(w, h).setTint(tint).refreshBody().setDepth(12);
  return platform;
}

export function addFloatingMote(scene, x, y, color = 0x8bbf73, scrollFactor = 1) {
  const mote = scene.add.image(x, y, 'white-pixel')
    .setTint(color)
    .setAlpha(Phaser.Math.FloatBetween(0.18, 0.48))
    .setDepth(8)
    .setScrollFactor(scrollFactor);
  scene.tweens.add({
    targets: mote,
    y: y - Phaser.Math.Between(24, 68),
    x: x + Phaser.Math.Between(-12, 12),
    alpha: 0,
    duration: Phaser.Math.Between(2200, 5200),
    repeat: -1,
    delay: Phaser.Math.Between(0, 2000),
  });
  return mote;
}

// ---------------------------------------------------------------------------
// 설정 = 물리 법칙 (store 구독 + SHUTDOWN 자동 해제)
// ---------------------------------------------------------------------------

// 화면 전체 어둠 오버레이. alpha = max * (1 - norm(effective('brightness')))
// brightness 62(기본) -> 거의 암흑(윤곽만), 125 이상 -> 완전히 걷힘.
export function addDarkness(scene, { max = 0.94 } = {}) {
  // 줌아웃(display 55%)에도 화면을 다 덮도록 크게 만든다. scrollFactor 0.
  const overlay = scene.add.rectangle(VIEW_WIDTH / 2, VIEW_HEIGHT / 2, 2400, 1400, 0x020304)
    .setScrollFactor(0)
    .setDepth(90);
  const apply = () => {
    const brightness = effective('brightness');
    const darkness = Phaser.Math.Clamp((125 - brightness) / 70, 0, 1);
    overlay.setAlpha(max * darkness);
  };
  apply();
  const unsub = store.subscribe((event) => {
    if (event.type === 'change' && event.key !== 'brightness') return;
    apply();
  });
  onSceneTeardown(scene, unsub);
  return overlay;
}

// 밝기에 반응해 실체화되는 오브젝트 (숨겨진 문/발판).
// brightness < threshold-35 -> alpha 0 / threshold 근처 페이드 인 / >= threshold -> alpha 1 + body 활성.
export function registerHidden(scene, gameObject, { threshold = 125, body = null } = {}) {
  let materialized = null;
  const apply = () => {
    const brightness = effective('brightness');
    const t = Phaser.Math.Clamp((brightness - (threshold - 35)) / 35, 0, 1);
    const active = brightness >= threshold;
    gameObject.setAlpha(t);
    if (body && body.enable !== active) body.enable = active;
    if (materialized === null) { materialized = active; return; }
    if (active === materialized) return;
    materialized = active;
    if (active) {
      materializeBurst(scene, gameObject, 0xd8f7d0);
      safeSfx('ui');
    }
  };
  apply();
  const unsub = store.subscribe((event) => {
    if (event.type === 'change' && event.key !== 'brightness') return;
    apply();
  });
  onSceneTeardown(scene, unsub);
  return gameObject;
}

// 프레임 밖 발판: display > threshold -> 반투명 유령(body off) / <= threshold -> 실체화 트윈 + body on.
export function registerOffFrame(scene, gameObject, { threshold = 70, body = null } = {}) {
  let solid = null;
  const apply = () => {
    const display = effective('display');
    const active = display <= threshold;
    if (active === solid) return;
    const first = solid === null;
    solid = active;
    if (body) body.enable = active;
    scene.tweens.killTweensOf(gameObject);
    if (first) {
      gameObject.setAlpha(active ? 1 : 0.25);
      return;
    }
    if (active) {
      scene.tweens.add({ targets: gameObject, alpha: { from: 0.25, to: 1 }, duration: 300, ease: 'Cubic.easeOut' });
      materializeBurst(scene, gameObject, 0x8fd8f0);
      safeSfx('ui');
    } else {
      scene.tweens.add({ targets: gameObject, alpha: 0.25, duration: 220, ease: 'Sine.easeOut' });
    }
  };
  apply();
  const unsub = store.subscribe((event) => {
    if (event.type === 'change' && event.key !== 'display') return;
    apply();
  });
  onSceneTeardown(scene, unsub);
  return gameObject;
}

function centerOf(gameObject) {
  if (typeof gameObject.getCenter === 'function') {
    const c = gameObject.getCenter();
    return { x: c.x, y: c.y };
  }
  return { x: gameObject.x ?? 0, y: gameObject.y ?? 0 };
}

function materializeBurst(scene, gameObject, color) {
  const { x, y } = centerOf(gameObject);
  const ring = scene.add.ellipse(x, y, 18, 18).setStrokeStyle(2, color, 0.9).setDepth(85);
  scene.tweens.add({
    targets: ring,
    scaleX: 4.2,
    scaleY: 4.2,
    alpha: 0,
    duration: 420,
    ease: 'Cubic.easeOut',
    onComplete: () => ring.destroy(),
  });
  if (scene.textures.exists('white-pixel')) {
    const burst = scene.add.particles(x, y, 'white-pixel', {
      speed: { min: 40, max: 170 },
      quantity: 10,
      lifespan: { min: 200, max: 480 },
      scale: { start: 1.8, end: 0 },
      alpha: { start: 0.9, end: 0 },
      tint: color,
      emitting: false,
    }).setDepth(85);
    burst.explode(10);
    scene.time.delayedCall(600, () => burst.destroy());
  }
}

// 카메라 줌 = effective('display') / 100. store 구독 + 자동 해제.
export function bindCameraDisplay(scene) {
  const cam = scene.cameras.main;
  let zoomTween = null;
  const apply = (animate) => {
    const zoom = effective('display') / 100;
    if (zoomTween) { zoomTween.stop(); zoomTween = null; }
    if (!animate || Math.abs(cam.zoom - zoom) < 0.002) {
      cam.setZoom(zoom);
      return;
    }
    zoomTween = scene.tweens.add({
      targets: cam,
      zoom,
      duration: 160,
      ease: 'Sine.easeOut',
      onComplete: () => { zoomTween = null; },
    });
  };
  apply(false);
  const unsub = store.subscribe((event) => {
    if (event.type === 'change' && event.key !== 'display') return;
    apply(true);
  });
  onSceneTeardown(scene, unsub);
  return cam;
}

// 빛나는 스테이지 프레임 — 줌아웃 시 "원래 화면"의 경계 표시.
export function drawFrameBorder(scene, x, y, w, h, color = 0x65dad5) {
  const bright = Phaser.Display.Color.IntegerToColor(color).brighten(30).color;
  const container = scene.add.container(0, 0).setDepth(60);

  const glow = scene.add.graphics();
  for (let i = 0; i < 4; i += 1) {
    glow.lineStyle(9 - i * 2, color, 0.03 + i * 0.022);
    const pad = 6 - i * 1.5;
    glow.strokeRect(x - pad, y - pad, w + pad * 2, h + pad * 2);
  }

  const line = scene.add.graphics();
  line.lineStyle(2, color, 0.92).strokeRect(x, y, w, h);
  line.lineStyle(1, 0xffffff, 0.18).strokeRect(x + 3, y + 3, w - 6, h - 6);

  // 모서리 브래킷 + 스터드 + 변 중앙 틱
  const corners = scene.add.graphics();
  corners.lineStyle(3, bright, 1);
  const len = 20;
  const anchors = [
    [x, y, 1, 1],
    [x + w, y, -1, 1],
    [x, y + h, 1, -1],
    [x + w, y + h, -1, -1],
  ];
  for (const [cx, cy, dx, dy] of anchors) {
    corners.beginPath();
    corners.moveTo(cx + dx * len, cy);
    corners.lineTo(cx, cy);
    corners.lineTo(cx, cy + dy * len);
    corners.strokePath();
    corners.fillStyle(bright, 0.95).fillRect(cx - 3, cy - 3, 6, 6);
  }
  corners.fillStyle(color, 0.75);
  corners.fillRect(x + w / 2 - 16, y - 2, 32, 4);
  corners.fillRect(x + w / 2 - 16, y + h - 2, 32, 4);
  corners.fillRect(x - 2, y + h / 2 - 12, 4, 24);
  corners.fillRect(x + w - 2, y + h / 2 - 12, 4, 24);

  container.add([glow, line, corners]);
  scene.tweens.add({ targets: glow, alpha: { from: 0.45, to: 1 }, duration: 1500, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' });
  scene.tweens.add({ targets: corners, alpha: { from: 0.7, to: 1 }, duration: 950, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' });
  return container;
}

// 월드 좌표 -> 960x540 UI 좌표 (카메라 스크롤/줌 반영). 보스전 panelRect 판정용.
export function worldToUi(scene, x, y) {
  const cam = scene.cameras.main;
  return {
    x: (x - cam.worldView.x) * cam.zoom,
    y: (y - cam.worldView.y) * cam.zoom,
  };
}

// 960x540 UI 좌표 -> 월드 좌표 (worldToUi의 역변환). 패널 드래그로 월드를 만질 때 사용 (PATCH2 2절).
export function uiToWorld(scene, x, y) {
  const cam = scene.cameras.main;
  return {
    x: cam.worldView.x + x / cam.zoom,
    y: cam.worldView.y + y / cam.zoom,
  };
}

// ---------------------------------------------------------------------------
// 표준 사망 분기 (PATCH2 1절)
// - ADMIN && bossPhase>=4 → 기존 그대로 DeathspaceScene(최종 탑) 씬 전환
// - 그 외 모든 사망 → 씬 전환 없는 in-scene 침입 (deathIntrusion.triggerDeathIntrusion)
// 시그니처 불변. intrusion 활성(__truce) 중 재사망 없음.
// ---------------------------------------------------------------------------

export function killPlayer(scene, cause) {
  if (scene.__dying || scene.__truce) return;

  const preState = getRunState(scene);
  if (!(cause === 'ADMIN' && preState.bossPhase >= 4)) {
    triggerDeathIntrusion(scene, cause);
    return;
  }

  // --- 최종 탑 전용: 기존 사망 시퀀스 — 슬로모 + 셰이크 + 시체 + Deathspace 진입 ---
  scene.__dying = true;

  const runState = getRunState(scene);
  runState.deaths += 1;
  saveRunState(scene, runState);

  const player = scene.player;
  const px = player ? player.x : VIEW_WIDTH / 2;
  const py = player ? player.y : VIEW_HEIGHT / 2;
  addCorpse(scene, scene.scene.key, px, py);

  if (player) {
    if (player.anims) player.anims.stop();
    player.setTint(0xef4d5b);
    if (player.body) {
      player.setVelocity(0, 0);
      player.body.enable = false;
    }
  }

  const cam = scene.cameras.main;
  scene.physics.world.timeScale = 3.5; // 슬로모 (값이 클수록 느려짐)
  cam.shake(150, 0.009);
  cam.flash(90, 239, 77, 91);
  cam.zoomTo(cam.zoom * 1.07, 480, 'Sine.easeOut');
  deathBurst(scene, px, py - 26);
  safeSfx('death');

  emitState({
    mode: 'dying',
    chapter: 'SYSTEM // FAILURE',
    objective: `KILLED BY: ${cause}`,
    rule: 'LIFE // TERMINATED',
    deaths: runState.deaths,
  });

  // 어떤 경로로 씬이 닫혀도 슬로모/사망 락이 남지 않게 한다.
  // (물리 플러그인이 먼저 SHUTDOWN을 처리해 world가 이미 파괴됐을 수 있음)
  scene.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
    if (scene.physics && scene.physics.world) scene.physics.world.timeScale = 1;
    scene.__dying = false;
  });

  scene.time.delayedCall(500, () => {
    scene.scene.start('DeathspaceScene', { cause, returnScene: scene.scene.key });
  });
}

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
  }).setDepth(88);
  burst.explode(22);
  scene.time.delayedCall(1000, () => burst.destroy());
}

// ---------------------------------------------------------------------------
// runState (Phaser registry 키 'runState')
// ---------------------------------------------------------------------------

export function defaultRunState() {
  return {
    started: false,
    stage: 'Stage0Scene',
    deaths: 0,
    erased: {}, // 'DARKNESS'|'SOUND'|'FRAME'|'SPIKES'|'ADMIN'|'DIED' -> true (PATCH2: GRAVITY 폐지)
    dashFound: false,
    bossPhase: 0,
  };
}

export function getRunState(scene) {
  let runState = scene.registry.get('runState');
  if (!runState) {
    runState = defaultRunState();
    scene.registry.set('runState', runState);
  }
  return runState;
}

export function saveRunState(scene, runState) {
  scene.registry.set('runState', runState);
  // 진행 자동 저장 — 타이틀의 이어하기가 여기서 복원된다.
  if (runState.started) saveProgress(runState, scene.registry.get('corpses') || []);
}
