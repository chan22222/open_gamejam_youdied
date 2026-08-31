// ESC/APE — 시체 시스템 (A2 core-engine)
// 죽은 자리마다 시체가 영구히 남고, 시체는 밟을 수 있는 발판이 된다.
// registry 'corpses' 배열: [{ sceneKey, x, y }, ...]

import Phaser from 'phaser';

export function addCorpse(scene, sceneKey, x, y) {
  const corpses = scene.registry.get('corpses') || [];
  corpses.push({ sceneKey, x: Math.round(x), y: Math.round(y) });
  scene.registry.set('corpses', corpses);
}

// 해당 씬에서 죽은 시체들을 static physics group으로 생성해 반환 (player collider용).
export function spawnCorpses(scene, sceneKey) {
  const group = scene.physics.add.staticGroup();
  const corpses = (scene.registry.get('corpses') || []).filter((c) => c.sceneKey === sceneKey);

  corpses.forEach((c, index) => {
    const corpse = group.create(c.x, c.y, 'cat-dead');
    corpse.setScale(2.65).setOrigin(0.5, 1).setDepth(18);
    corpse.setFlipX(index % 2 === 1);
    corpse.setTint(0xaab6b2); // 희미하게 바랜 회색 — 죽음의 시간차
    corpse.refreshBody();

    // 누워 있는 몸통만 발판이 되도록 납작한 히트박스로 교체
    const body = corpse.body;
    const bw = 58;
    const bh = 18;
    body.setSize(bw, bh);
    body.position.x = c.x - bw / 2;
    body.position.y = c.y - bh;
    if (body.updateCenter) body.updateCenter();

    // 시체 위로 피어오르는 희미한 넋
    if (scene.textures.exists('white-pixel')) {
      const soul = scene.add.image(c.x, c.y - 28, 'white-pixel')
        .setTint(0x9fe8d8)
        .setAlpha(0)
        .setScale(2)
        .setDepth(19)
        .setBlendMode(Phaser.BlendModes.ADD);
      scene.tweens.add({
        targets: soul,
        y: c.y - 64,
        alpha: { from: 0.45, to: 0 },
        duration: Phaser.Math.Between(2300, 3100),
        repeat: -1,
        delay: index * 420 + Phaser.Math.Between(0, 600),
      });
    }
  });

  return group;
}

export function corpseCount(scene) {
  return (scene.registry.get('corpses') || []).length;
}
