// ESC/APE — BootScene (A2 core-engine)
// 에셋 로드 + 텍스처/애님 생성 + registry 초기화.
// EV.START 1회 수신 시 Stage0Scene으로. (EV.RESTART 전역 처리는 createGame.js 담당)

import Phaser from 'phaser';
import { EV, emitState, on } from '../events.js';
import {
  VIEW_WIDTH,
  VIEW_HEIGHT,
  addFloatingMote,
  createAnimations,
  createSharedTextures,
  defaultRunState,
  preloadShared,
} from '../shared.js';

export class BootScene extends Phaser.Scene {
  constructor() {
    super('BootScene');
  }

  init() {
    this.launched = false;
    this.created = false;
    this.pendingStart = false;

    // React 타이틀의 RUN 버튼은 에셋 로드가 끝나기 전에도 눌릴 수 있다.
    // create()에서야 구독하면 그 사이의 EV.START가 수신자 없이 소실되어
    // 셸이 'LOADING...' 상태로 영구 고정된다 — init에서 즉시 구독하고,
    // 로드 완료 전에 수신하면 플래그로 보관했다가 create()에서 소비한다.
    this.offStart = on(EV.START, () => {
      if (this.created) this.beginRun();
      else this.pendingStart = true;
    });

    // game.destroy(true)는 씬에 SHUTDOWN 없이 DESTROY만 emit하므로
    // (React StrictMode 이중 마운트 등) 양쪽 모두에서 정리한다.
    const teardown = () => {
      this.events.off(Phaser.Scenes.Events.SHUTDOWN, teardown);
      this.events.off(Phaser.Scenes.Events.DESTROY, teardown);
      if (this.offStart) {
        this.offStart();
        this.offStart = null;
      }
      if (this.load) this.load.off(Phaser.Loader.Events.PROGRESS);
    };
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, teardown);
    this.events.once(Phaser.Scenes.Events.DESTROY, teardown);
  }

  preload() {
    this.cameras.main.setBackgroundColor('#050708');
    const cx = VIEW_WIDTH / 2;
    const cy = VIEW_HEIGHT / 2;
    const barWidth = 320;

    this.bootTitle = this.add.text(cx, cy - 46, 'ESC/APE', {
      fontFamily: 'monospace',
      fontSize: '20px',
      color: '#65dad5',
      letterSpacing: 10,
    }).setOrigin(0.5);
    this.bootLabel = this.add.text(cx, cy + 30, 'SYS://LOADING 0%', {
      fontFamily: 'monospace',
      fontSize: '11px',
      color: '#71d98b',
      letterSpacing: 3,
    }).setOrigin(0.5);
    this.bootFrame = this.add.rectangle(cx, cy, barWidth + 10, 16, 0x000000, 0)
      .setStrokeStyle(1, 0x2e5a52, 1);
    this.bootBar = this.add.rectangle(cx - barWidth / 2, cy, 1, 6, 0x65dad5).setOrigin(0, 0.5);

    this.load.on(Phaser.Loader.Events.PROGRESS, (value) => {
      this.bootBar.width = Math.max(1, barWidth * value);
      this.bootLabel.setText(`SYS://LOADING ${Math.round(value * 100)}%`);
    });

    preloadShared(this);
    this.load.image('cat-dead', '/assets/character/HIDER/gray/6_Cat_dead.png');
  }

  create() {
    createSharedTextures(this);
    createAnimations(this);

    // 새 부트 = 새 런 (RESTART 경로도 여기로 돌아온다)
    this.registry.set('runState', defaultRunState());
    this.registry.set('corpses', []);

    this.bootLabel.setText('SYSTEM READY // AWAITING START SIGNAL');
    this.tweens.add({
      targets: this.bootLabel,
      alpha: { from: 1, to: 0.25 },
      duration: 760,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut',
    });
    this.tweens.add({ targets: [this.bootBar, this.bootFrame], alpha: 0.35, duration: 900, ease: 'Sine.easeOut' });

    for (let i = 0; i < 18; i += 1) {
      addFloatingMote(
        this,
        Phaser.Math.Between(40, VIEW_WIDTH - 40),
        Phaser.Math.Between(60, VIEW_HEIGHT - 30),
        0x2f6b5e,
        0,
      );
    }

    emitState({
      mode: 'title',
      chapter: 'ESC/APE // BOOT',
      objective: '죽어라. 그래야 열린다.',
      rule: 'NO PERMISSIONS',
      deaths: 0,
    });

    // 로드 중에 이미 START 신호를 받았다면 즉시 소비.
    this.created = true;
    if (this.pendingStart) {
      this.pendingStart = false;
      this.beginRun();
    }
  }

  beginRun() {
    if (this.launched) return;
    this.launched = true;
    if (this.offStart) {
      this.offStart();
      this.offStart = null;
    }

    const runState = this.registry.get('runState') || defaultRunState();
    runState.started = true;
    this.registry.set('runState', runState);

    this.cameras.main.flash(240, 101, 218, 213);
    this.bootLabel.setText('SIGNAL ACCEPTED // WAKE UP');
    this.time.delayedCall(260, () => this.scene.start('Stage0Scene'));
  }
}
