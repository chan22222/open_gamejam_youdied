// ESC/APE — worldToys (C 코어 · PATCH2 2절)
// ESC 설정이 세계를 만지는 장난감 채널.
//  - SHAKE 슬라이더(>0): 카메라 미세 진동 + 등록된 pushable에 300~700ms 주기 랜덤 임펄스(강도 비례)
//  - 설정 패널 드래그: panelRect 변화를 uiToWorld로 월드 rect로 바꿔 겹친 pushable을 밀어낸다
//    (보스전 방패 로직과 별개 — dynamic body만)
// attachWorldToys(scene, { pushables }) — store 구독, SHUTDOWN에서 teardown 자동.
// intrusion RETRY 버튼은 deathIntrusion이 scene.__worldToys.register()로 자동 등록한다.

import Phaser from 'phaser';
import { store, effective } from './settingsStore.js';
import { uiToWorld } from './shared.js';

export function attachWorldToys(scene, { pushables = [] } = {}) {
  const sources = (Array.isArray(pushables) ? pushables : [pushables]).filter(Boolean);
  const extras = new Set();
  let detached = false;
  let nextImpulseAt = 0;
  let sparkAt = -10000;

  // shake 강도 0..1 — 스토어에 shake가 아직 없으면 0 (B 패치와 독립적으로 안전)
  const shakeIntensity = () => {
    const state = store.getState();
    if (state.revoked && state.revoked.shake) return 0;
    const v = Number(effective('shake'));
    if (!Number.isFinite(v) || v <= 0) return 0;
    return Phaser.Math.Clamp(v, 0, 100) / 100;
  };

  // dynamic body만 순회 (그룹/단일 오브젝트 혼용 허용)
  const eachPushable = (fn) => {
    const visit = (obj) => {
      if (!obj || !obj.active || !obj.body) return;
      const body = obj.body;
      if (!body.enable || body.immovable || !body.moves) return;
      fn(obj, body);
    };
    for (const src of sources) {
      if (typeof src.getChildren === 'function') {
        for (const child of src.getChildren()) visit(child);
      } else {
        visit(src);
      }
    }
    for (const obj of extras) {
      if (!obj || !obj.active) {
        extras.delete(obj);
        continue;
      }
      visit(obj);
    }
  };

  // --- SHAKE: 매 프레임 미세 진동 + 주기 임펄스 ---
  const onUpdate = (time) => {
    if (detached || !scene.cameras || !scene.cameras.main) return;
    const k = shakeIntensity();
    if (k <= 0) {
      nextImpulseAt = 0;
      return;
    }
    // 진행 중이면 무시되고, 끝나면 즉시 다시 걸린다 — 연속 미세 진동
    scene.cameras.main.shake(220, 0.00035 + 0.0024 * k);

    if (!nextImpulseAt) {
      nextImpulseAt = time + Phaser.Math.Between(300, 700);
      return;
    }
    if (time < nextImpulseAt) return;
    nextImpulseAt = time + Phaser.Math.Between(300, 700);
    eachPushable((obj, body) => {
      body.velocity.x += Phaser.Math.FloatBetween(-1, 1) * 250 * k;
      if (body.blocked.down || body.touching.down) {
        body.velocity.y -= Phaser.Math.FloatBetween(40, 300) * k;
      }
    });
  };

  // --- 패널 드래그 = 물리 밀치기 ---
  const spark = (x, y) => {
    const now = scene.time.now;
    if (now - sparkAt < 300 || !scene.textures.exists('white-pixel')) return;
    sparkAt = now;
    const p = scene.add.particles(x, y, 'white-pixel', {
      speed: { min: 30, max: 120 },
      quantity: 6,
      lifespan: { min: 120, max: 300 },
      scale: { start: 1.4, end: 0 },
      alpha: { start: 0.7, end: 0 },
      tint: 0x9ff2e6,
      emitting: false,
    }).setDepth(95);
    p.explode(6);
    scene.time.delayedCall(400, () => p.destroy());
  };

  const panelPush = (rect) => {
    if (!rect || !scene.cameras || !scene.cameras.main) return;
    const tl = uiToWorld(scene, rect.x, rect.y);
    const br = uiToWorld(scene, rect.x + rect.w, rect.y + rect.h);
    const rcx = (tl.x + br.x) / 2;
    const rcy = (tl.y + br.y) / 2;
    const rw = Math.abs(br.x - tl.x);
    const rh = Math.abs(br.y - tl.y);
    let hitX = 0;
    let hitY = 0;
    let hit = false;

    eachPushable((obj, body) => {
      const overlapX = rw / 2 + body.width / 2 - Math.abs(body.center.x - rcx);
      if (overlapX <= 0) return;
      const overlapY = rh / 2 + body.height / 2 - Math.abs(body.center.y - rcy);
      if (overlapY <= 0) return;
      hit = true;
      hitX = body.center.x;
      hitY = body.center.y;
      if (overlapX < overlapY) {
        const dir = body.center.x >= rcx ? 1 : -1;
        body.velocity.x = dir * Math.max(Math.abs(body.velocity.x), 140 + overlapX * 5);
      } else {
        const dir = body.center.y >= rcy ? 1 : -1;
        if (dir < 0) body.velocity.y = Math.min(body.velocity.y, -(170 + overlapY * 4));
        else body.velocity.y = Math.max(body.velocity.y, 130 + overlapY * 3);
        body.velocity.x += Phaser.Math.FloatBetween(-40, 40);
      }
    });
    if (hit) spark(hitX, hitY);
  };

  const unsub = store.subscribe((event) => {
    if (detached) return;
    if (event.type === 'change' && event.key === 'panelRect' && event.value) {
      const state = store.getState();
      if (state.panelOpen && !state.corrupted) panelPush(event.value);
    } else if (event.type === 'reset') {
      nextImpulseAt = 0;
    }
  });

  scene.events.on(Phaser.Scenes.Events.UPDATE, onUpdate);

  const api = {
    register(obj) {
      if (obj) extras.add(obj);
    },
    unregister(obj) {
      extras.delete(obj);
    },
    detach() {
      if (detached) return;
      detached = true;
      unsub();
      scene.events.off(Phaser.Scenes.Events.UPDATE, onUpdate);
      extras.clear();
      if (scene.__worldToys === api) scene.__worldToys = null;
    },
  };
  scene.__worldToys = api;

  // teardown 자동 — SHUTDOWN/DESTROY 양쪽 (store 구독 누수 방지)
  const run = () => {
    scene.events.off(Phaser.Scenes.Events.SHUTDOWN, run);
    scene.events.off(Phaser.Scenes.Events.DESTROY, run);
    api.detach();
  };
  scene.events.once(Phaser.Scenes.Events.SHUTDOWN, run);
  scene.events.once(Phaser.Scenes.Events.DESTROY, run);

  return api;
}
