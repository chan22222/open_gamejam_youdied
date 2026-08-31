// ESC/APE — Phaser 게임 생성 + EV.RESTART 전역 처리 (A2 core-engine)

import Phaser from 'phaser';
import { BootScene } from './scenes/BootScene.js';
import { Stage0Scene } from './scenes/Stage0Scene.js';
import { Stage1Scene } from './scenes/Stage1Scene.js';
import { Stage2Scene } from './scenes/Stage2Scene.js';
import { BossScene } from './scenes/BossScene.js';
import { DeathspaceScene } from './scenes/DeathspaceScene.js';
import { EndingScene } from './scenes/EndingScene.js';
import { EV, on } from './events.js';
import { store } from './settingsStore.js';
import { audio } from './audio.js';
import { defaultRunState } from './shared.js';

export function createGame(parent) {
  const game = new Phaser.Game({
    type: Phaser.AUTO,
    parent,
    width: 960,
    height: 540,
    backgroundColor: '#050708',
    pixelArt: true,
    render: {
      antialias: false,
      roundPixels: true,
      powerPreference: 'high-performance',
    },
    scale: {
      mode: Phaser.Scale.FIT,
      autoCenter: Phaser.Scale.CENTER_BOTH,
    },
    physics: {
      default: 'arcade',
      arcade: {
        gravity: { x: 0, y: 1750 },
        debug: false,
      },
    },
    scene: [BootScene, Stage0Scene, Stage1Scene, Stage2Scene, BossScene, DeathspaceScene, EndingScene],
  });

  // EV.RESTART 전역 리스너 — 게임당 정확히 1회 등록, destroy 시 해제.
  const offRestart = on(EV.RESTART, () => {
    if (!game.isBooted) return;
    try {
      audio.stopMusic();
    } catch {
      // 오디오 실패는 재시작을 막지 않는다.
    }
    for (const scene of game.scene.getScenes(true)) {
      game.scene.stop(scene.sys.settings.key);
    }
    store.resetRun();
    game.registry.set('runState', defaultRunState());
    game.registry.set('corpses', []);
    game.scene.start('BootScene');
  });

  game.events.once(Phaser.Core.Events.DESTROY, offRestart);
  return game;
}
