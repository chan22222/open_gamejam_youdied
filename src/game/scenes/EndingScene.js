// ESC/APE — EndingScene (B4, 전면 재작성)
// 최종 사망공간에서 넘어온다. 백색에서 페이드인 —
// "YOU ?" 의 물음표가 떨리다 사라지고 "YOU." 가 완성된다.
// 고양이는 초원을 걸어 치킨하우스로 돌아가고, 이번 런의 모든 시체가 일어나 손을 흔든다.
// 사망 횟수는 점수다: DEATHS: NN — N번의 건축.

import Phaser from 'phaser';
import { emitState } from '../events.js';
import { audio } from '../audio.js';
import { store } from '../settingsStore.js';
import { clearSave } from '../persistence.js';
import { VIEW_WIDTH, VIEW_HEIGHT, addFloatingMote, getRunState } from '../shared.js';

const WORLD_W = 1280;
const GROUND_TOP = 504;
const HOUSE_X = 1050;
const INK = 0x26221c;
const MAX_SILHOUETTES = 18;

function sfx(name) {
  try {
    audio.sfx(name);
  } catch {
    // 에필로그에서 소리가 죽어도 귀가는 계속된다.
  }
}

// 사망 횟수의 한국어 수사 — "일곱 번의 건축"
function koCount(n) {
  const units = ['', '한', '두', '세', '네', '다섯', '여섯', '일곱', '여덟', '아홉'];
  if (n <= 0) return '영';
  if (n < 10) return units[n];
  if (n === 10) return '열';
  if (n < 20) return `열${units[n - 10]}`;
  if (n === 20) return '스물';
  if (n < 30) return `스물${units[n - 20]}`;
  if (n === 30) return '서른';
  if (n < 40) return `서른${units[n - 30]}`;
  return String(n);
}

export class EndingScene extends Phaser.Scene {
  constructor() {
    super('EndingScene');
  }

  create() {
    const runState = getRunState(this);
    this.deaths = runState.deaths;
    clearSave(); // 런 완주 — 이어하기 저장 폐기

    // 시스템 상태 정리 — 관리자는 패배했고, 설정은 온전히 너의 것이다
    store.set('panelOpen', false);
    store.set('corrupted', false);
    store.restore('brightness');

    audio.setStage('ending');
    emitState({
      mode: 'ending',
      chapter: 'EPILOGUE // HOME',
      objective: '집으로 돌아간다.',
      rule: 'YOU.',
      deaths: this.deaths,
    });

    this.cameras.main.setBackgroundColor('#101b14');
    this.cameras.main.setBounds(0, 0, WORLD_W, VIEW_HEIGHT);
    this.physics.world.pause(); // 순수 시네마틱 — 물리 없음

    this.buildMeadow();
    this.buildSilhouettes();

    // 고양이 — 초원에 서 있다 (걷기는 백색이 걷힌 뒤)
    this.cat = this.add.sprite(120, GROUND_TOP + 2, 'cat-idle')
      .setScale(2.65)
      .setOrigin(0.5, 1)
      .setDepth(30);
    this.cat.anims.play('cat-idle-anim');
    this.walking = false;
    this.arrived = false;

    // 백색 커버 — 최종 사망공간의 백색 페이드에서 그대로 이어진다
    this.whiteCover = this.add.rectangle(VIEW_WIDTH / 2, VIEW_HEIGHT / 2, 2600, 1600, 0xffffff)
      .setScrollFactor(0)
      .setDepth(300);

    this.buildYouText();
    this.runTextSequence();
  }

  // -------------------------------------------------------------------------
  // 초원 — 노을빛 귀갓길
  // -------------------------------------------------------------------------

  buildMeadow() {
    // 하늘 그라데이션 (밴드)
    const skyBands = [0xf7d9a8, 0xefc490, 0xe0a97d, 0xc98f74];
    skyBands.forEach((color, i) => {
      this.add.rectangle(WORLD_W / 2, 60 + i * 120, WORLD_W + 1400, 130, color).setDepth(0);
    });

    // 태양 + 발광
    this.add.image(820, 118, 'glow-orb').setScale(6.5).setTint(0xffe9b8)
      .setAlpha(0.75).setBlendMode(Phaser.BlendModes.ADD).setDepth(1);
    const sun = this.add.circle(820, 118, 56, 0xfff0c8).setDepth(1);
    this.tweens.add({ targets: sun, alpha: { from: 1, to: 0.85 }, duration: 2600, yoyo: true, repeat: -1 });

    // 원경 언덕
    this.add.ellipse(240, 520, 900, 260, 0x9dae6d).setDepth(2);
    this.add.ellipse(1000, 540, 1100, 300, 0x8aa261).setDepth(2);
    this.add.ellipse(620, 560, 800, 220, 0x7c9457).setDepth(3);

    // 지면
    this.add.rectangle(WORLD_W / 2, 522, WORLD_W + 1400, 40, 0x5f7c46).setDepth(10);
    this.add.rectangle(WORLD_W / 2, GROUND_TOP + 2, WORLD_W + 1400, 5, 0x86b968).setDepth(10);
    this.add.rectangle(WORLD_W / 2, 620, WORLD_W + 1400, 160, 0x3d5232).setDepth(10);

    // 치킨하우스 — 집
    this.house = this.add.image(HOUSE_X, GROUND_TOP + 4, 'chicken-house')
      .setScale(5)
      .setOrigin(0.5, 1)
      .setTint(0xf0c27b)
      .setDepth(20);
    this.houseGlow = this.add.image(HOUSE_X, GROUND_TOP - 60, 'glow-orb')
      .setScale(3.2)
      .setTint(0xffd9a0)
      .setAlpha(0.28)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setDepth(19);
    this.tweens.add({ targets: this.houseGlow, alpha: { from: 0.2, to: 0.4 }, duration: 1800, yoyo: true, repeat: -1 });

    // 따뜻한 부유 입자
    for (let i = 0; i < 22; i += 1) {
      addFloatingMote(this, Phaser.Math.Between(40, WORLD_W - 40), Phaser.Math.Between(120, 490), 0xf0d9a0, 1);
    }

    // 노을 필터
    this.add.rectangle(WORLD_W / 2, 270, WORLD_W + 1400, 1200, 0xff9a4d, 0.07)
      .setBlendMode(Phaser.BlendModes.ADD).setDepth(40);
  }

  // -------------------------------------------------------------------------
  // 시체 실루엣 — 이번 런에서 죽은 수만큼, 배경에서 일어나 손을 흔든다
  // -------------------------------------------------------------------------

  buildSilhouettes() {
    const corpses = this.registry.get('corpses') || [];
    const count = Math.min(corpses.length || this.deaths, MAX_SILHOUETTES);
    this.silhouettes = [];
    if (count <= 0) return;

    const left = 240;
    const right = 940;
    for (let i = 0; i < count; i += 1) {
      const t = count === 1 ? 0.5 : i / (count - 1);
      const x = left + (right - left) * t + Phaser.Math.Between(-16, 16);
      const y = 470 + ((i % 3) - 1) * 9; // 원근 지그재그
      const s = this.add.sprite(x, y, 'cat-dead')
        .setScale(2.0 - (i % 3) * 0.15)
        .setOrigin(0.5, 1)
        .setDepth(8 + (i % 3))
        .setTint(0x3c4a44)
        .setAlpha(0.85)
        .setFlipX(i % 2 === 1);
      this.silhouettes.push({ sprite: s, x, risen: false });
    }
  }

  riseSilhouette(sil, index) {
    if (sil.risen) return;
    sil.risen = true;
    const s = sil.sprite;
    // 넋 반짝임과 함께 일어난다
    const soul = this.add.image(s.x, s.y - 20, 'glow-orb')
      .setScale(0.8).setTint(0x9fe8d8).setAlpha(0.7)
      .setBlendMode(Phaser.BlendModes.ADD).setDepth(9);
    this.tweens.add({ targets: soul, y: s.y - 58, alpha: 0, scale: 0.2, duration: 700, onComplete: () => soul.destroy() });
    sfx(index % 3 === 0 ? 'ui' : 'type');

    s.setTexture('cat-idle');
    s.anims.play('cat-idle-anim');
    this.tweens.add({ targets: s, y: s.y - 6, duration: 260, ease: 'Back.easeOut' });
    // 손 흔들기 — 작은 기울임 반복 + 이따금 폴짝
    this.tweens.add({
      targets: s,
      angle: { from: -7, to: 7 },
      duration: 340,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut',
      delay: Phaser.Math.Between(0, 250),
    });
    this.time.addEvent({
      delay: Phaser.Math.Between(1800, 3200),
      loop: true,
      callback: () => {
        if (!s.active) return;
        this.tweens.add({ targets: s, y: s.y - 12, duration: 170, yoyo: true, ease: 'Quad.easeOut' });
      },
    });
  }

  // -------------------------------------------------------------------------
  // "YOU ?" -> "YOU."
  // -------------------------------------------------------------------------

  buildYouText() {
    const cx = VIEW_WIDTH / 2;
    const cy = VIEW_HEIGHT / 2 - 14;
    const style = {
      fontFamily: 'Georgia, serif',
      fontSize: '96px',
      fontStyle: 'bold',
      color: '#26221c',
    };
    this.youT = this.add.text(cx, cy, 'YOU', style).setOrigin(0.5).setScrollFactor(0).setDepth(310).setAlpha(0);
    this.qT = this.add.text(cx, cy, '?', style).setOrigin(0.5).setScrollFactor(0).setDepth(310).setAlpha(0);
    this.dotT = this.add.text(cx, cy, '.', style).setOrigin(0.5).setScrollFactor(0).setDepth(310).setAlpha(0);

    // 실제 폭 기준 정렬: [YOU][간격][?]를 화면 중앙에
    const gap = 42;
    const total = this.youT.width + gap + this.qT.width;
    this.youT.x = cx - total / 2 + this.youT.width / 2;
    this.qT.x = this.youT.x + this.youT.width / 2 + gap + this.qT.width / 2;
    this.dotT.x = this.qT.x;
    this.dotT.y = cy + 26; // 물음표의 점 위치로
  }

  runTextSequence() {
    // 1) "YOU ?" 페이드 인
    this.time.delayedCall(450, () => {
      sfx('ui');
      this.tweens.add({ targets: [this.youT, this.qT], alpha: 1, duration: 750, ease: 'Sine.easeOut' });
    });

    // 2) 물음표가 떨린다
    this.time.delayedCall(1900, () => {
      this.tweens.add({
        targets: this.qT,
        angle: { from: -4, to: 4 },
        duration: 58,
        yoyo: true,
        repeat: 11,
      });
      const baseX = this.qT.x;
      for (let k = 0; k < 10; k += 1) {
        this.time.delayedCall(k * 82, () => {
          if (this.qT.active) this.qT.x = baseX + Phaser.Math.Between(-3 - Math.floor(k / 3), 3 + Math.floor(k / 3));
          if (k % 3 === 0) sfx('type');
        });
      }
    });

    // 3) 물음표 소멸
    this.time.delayedCall(2950, () => {
      sfx('erase');
      const p = this.add.particles(this.qT.x, this.qT.y, 'white-pixel', {
        speed: { min: 30, max: 150 },
        quantity: 18,
        lifespan: { min: 260, max: 640 },
        scale: { start: 2.2, end: 0 },
        alpha: { start: 0.9, end: 0 },
        tint: INK,
        gravityY: 220,
        emitting: false,
      }).setScrollFactor(0).setDepth(311);
      p.explode(18);
      this.time.delayedCall(800, () => p.destroy());
      this.tweens.add({ targets: this.qT, alpha: 0, duration: 140 });
    });

    // 4) 마침표 — "YOU." 완성 (타이핑 사운드)
    this.time.delayedCall(3650, () => {
      sfx('type');
      this.dotT.setAlpha(1);
      this.tweens.add({
        targets: [this.youT, this.dotT],
        scale: { from: 1, to: 1.045 },
        duration: 260,
        yoyo: true,
        ease: 'Sine.easeOut',
      });
    });

    // 5) 백색이 걷히고 초원이 드러난다
    this.time.delayedCall(4900, () => {
      sfx('win');
      this.tweens.add({ targets: this.whiteCover, alpha: 0, duration: 1900, ease: 'Sine.easeInOut' });
      this.tweens.add({
        targets: [this.youT, this.dotT],
        alpha: 0,
        duration: 1500,
        delay: 900,
        ease: 'Sine.easeIn',
      });
    });

    // 6) 귀가 — 고양이가 걷기 시작한다
    this.time.delayedCall(5500, () => this.startWalk());
  }

  // -------------------------------------------------------------------------
  // 귀가
  // -------------------------------------------------------------------------

  startWalk() {
    this.walking = true;
    this.cat.anims.play('cat-run-anim');
    this.cat.setFlipX(false);
    this.cameras.main.startFollow(this.cat, true, 0.05, 0.05);
    this.tweens.add({
      targets: this.cat,
      x: HOUSE_X - 78,
      duration: 6200,
      ease: 'Linear',
      onComplete: () => this.arriveHome(),
    });
  }

  arriveHome() {
    this.arrived = true;
    this.cat.anims.play('cat-idle-anim');
    sfx('collect');
    // 도착의 작은 폴짝
    this.tweens.add({ targets: this.cat, y: this.cat.y - 20, duration: 220, yoyo: true, ease: 'Quad.easeOut' });
    // 문가의 온기
    const warm = this.add.particles(HOUSE_X - 40, GROUND_TOP - 30, 'white-pixel', {
      speedY: { min: -40, max: -12 },
      speedX: { min: -14, max: 14 },
      quantity: 1,
      frequency: 220,
      lifespan: { min: 900, max: 1600 },
      scale: { start: 1.6, end: 0 },
      alpha: { start: 0.6, end: 0 },
      tint: [0xffd9a0, 0xffe9b8],
    }).setDepth(21);
    this.tweens.add({ targets: this.houseGlow, alpha: 0.55, scale: 3.8, duration: 900, ease: 'Sine.easeOut' });
    this.time.delayedCall(600, () => this.showStats());
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => warm.destroy());
  }

  // -------------------------------------------------------------------------
  // 최종 통계 — 사망 횟수는 점수다
  // -------------------------------------------------------------------------

  showStats() {
    const nn = String(this.deaths).padStart(2, '0');
    const line1 = `DEATHS: ${nn}`;
    const line2 = `${koCount(this.deaths)} 번의 건축.`;

    const t1 = this.add.text(VIEW_WIDTH / 2, 132, '', {
      fontFamily: 'monospace',
      fontSize: '24px',
      color: '#e8c66a',
      letterSpacing: 7,
    }).setOrigin(0.5).setScrollFactor(0).setDepth(320);
    t1.setShadow(0, 2, '#4a3a20', 4, true, true);

    const t2 = this.add.text(VIEW_WIDTH / 2, 178, line2, {
      fontFamily: 'Georgia, serif',
      fontSize: '30px',
      color: '#fff6e4',
    }).setOrigin(0.5).setScrollFactor(0).setDepth(320).setAlpha(0);
    t2.setShadow(0, 3, '#3a2c1a', 6, true, true);

    // 타자기 통계
    let i = 0;
    this.time.addEvent({
      delay: 60,
      repeat: line1.length - 1,
      callback: () => {
        i += 1;
        if (!t1.active) return;
        t1.setText(line1.slice(0, i));
        if (line1[i - 1] !== ' ') sfx('type');
        if (i >= line1.length) {
          this.tweens.add({ targets: t2, alpha: 1, y: 172, duration: 800, ease: 'Sine.easeOut', delay: 300 });
        }
      },
    });

    // 에필로그의 마지막 낙서
    const closing = this.add.text(VIEW_WIDTH / 2, 226, 'GAME OVER ≠ THE END', {
      fontFamily: 'monospace',
      fontSize: '11px',
      color: '#c9e8c2',
      letterSpacing: 5,
    }).setOrigin(0.5).setScrollFactor(0).setDepth(320).setAlpha(0);
    this.tweens.add({ targets: closing, alpha: 0.75, duration: 900, delay: 2200 });
  }

  update() {
    // 고양이가 지나가면 시체들이 차례로 일어나 손을 흔든다
    if (!this.walking || !this.silhouettes) return;
    this.silhouettes.forEach((sil, i) => {
      if (!sil.risen && this.cat.x > sil.x - 150) this.riseSilhouette(sil, i);
    });
  }
}
