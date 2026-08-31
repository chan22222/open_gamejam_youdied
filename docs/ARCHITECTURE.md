# ESC/APE — 구현 계약서 (ARCHITECTURE CONTRACT)

이 문서는 병렬 작업하는 모든 구현 에이전트가 따라야 하는 **단일 진실 공급원**이다.
여기 정의된 파일 경로·export 이름·이벤트 이름·데이터 형태는 **정확히 그대로** 구현한다.
자기 소유가 아닌 파일은 절대 수정하지 않는다. 기획 의도는 `docs/GAME_DESIGN.md` 참조.

- 스택: Vite + React 19 + Phaser 3.90 (Arcade Physics). ES Modules, JS만 사용(TS 금지).
- 게임 내부 해상도: **960×540** (`VIEW_WIDTH`, `VIEW_HEIGHT`).
- 에셋: `public/assets/**` 의 기존 파일만 사용. 외부 URL·신규 바이너리 금지.
  나머지 그래픽은 Phaser Graphics 생성 텍스처, 사운드는 전부 WebAudio 합성.
- 주석·게임 내 텍스트는 한국어+영문 혼용 가능. 시스템 텍스트는 영문 모노스페이스 톤 유지.

## 0. 파일 소유권 맵

| 파일 | 소유자 |
|---|---|
| `src/game/settingsStore.js`, `src/ui/SettingsPanel.jsx`, `src/ui/settings.css` | **A1 core-store** |
| `src/game/events.js`, `src/game/createGame.js`, `src/game/shared.js`, `src/game/corpses.js`, `src/game/scenes/BootScene.js` | **A2 core-engine** |
| `src/game/audio.js` | **A3 core-audio** |
| `src/App.jsx`, `src/styles.css`, `index.html`, `README.md` | **A4 ui-shell** |
| `src/game/scenes/Stage0Scene.js` | **B1** |
| `src/game/scenes/Stage1Scene.js` | **B2** |
| `src/game/scenes/Stage2Scene.js` | **B3** |
| `src/game/scenes/BossScene.js`, `src/game/scenes/EndingScene.js` | **B4** |
| `src/game/scenes/DeathspaceScene.js` | **B5** |
| 구 `src/game/scenes/WorldScene.js` 삭제, 빌드/배선 수정 | **통합자** |

`src/main.jsx`, `vite.config.js`, `package.json` 은 변경 금지.

---

## 1. `src/game/settingsStore.js` (A1)

React와 Phaser가 공유하는 프레임워크 무관 옵저버블 스토어. **의존성 0** (Phaser/React import 금지).

```js
export const SETTING_LIMITS = {
  brightness: { min: 40, max: 160, def: 62 },   // %
  volume:     { min: 0,  max: 100, def: 70 },   // %
  display:    { min: 55, max: 100, def: 100 },  // % → 카메라 줌 = display/100
};

// 내부 state 형태 (getState()가 반환; 반환값은 직접 변경 금지)
{
  unlocked: { brightness:false, volume:false, display:false, controls:false },
  brightness: 62, volume: 70, display: 100,
  bindings: { left:'A', right:'D', jump:'SPACE', interact:'E', disguise:'Q', dash:null },
  panelOpen: false,
  panelRect: null,        // {x,y,w,h} — 게임 내부좌표(960×540 기준). 패널 닫힘/파괴 시 null
  integrity: 100,         // 보스전 패널 내구도
  corrupted: false,       // true면 패널 산산조각(렌더 불가) 상태
  revoked: {},            // 예: { brightness: true } — 보스가 회수한 권한
}

export const store = {
  getState(),
  set(key, value),          // 숫자값은 LIMITS로 클램프. 'panelOpen'|'panelRect'|'integrity'|'corrupted' 도 이걸로
  unlock(key),              // 'brightness'|'volume'|'display'|'controls'
  isUnlocked(key),
  rebind(action, keyName),  // keyName: 대문자 ('K','SHIFT','ENTER'…) 또는 null. 중복키면 false 반환
  revoke(key), restore(key),// revoked 맵 토글
  subscribe(listener),      // listener({ type:'change'|'unlock'|'rebind'|'revoke'|'restore'|'reset', key, value, state }) → unsub 함수 반환
  resetRun(),               // 새 게임: 전부 초기값 (bindings 포함)
};
```

규칙: revoke 된 설정은 **세계에 효과 없음** (구독자가 `revoked[key]` 확인).
`effective(key)` 헬퍼도 export: revoke 시 해당 설정의 def값을 반환, 아니면 현재값.

## 2. `src/game/events.js` (A2)

window CustomEvent 래퍼. React↔Phaser 통신 전용.

```js
export const EV = {
  STATE: 'escape:state',        // Phaser→React HUD 갱신
  START: 'escape:start',        // React→Phaser 게임 시작
  RESTART: 'escape:restart',    // React→Phaser 처음부터
  PANEL_HIT: 'escape:panel-hit',// Phaser→React 방패 피격 (패널 흔들림 연출)
  BOSS: 'escape:boss',          // Phaser→React { phase: 'corrupt'|'shatter'|'restored' }
};
export function emit(name, detail);
export function on(name, fn);        // → unsub 함수 반환
export function emitState(detail);   // emit(EV.STATE, detail)
```

`EV.STATE` payload: `{ mode, chapter, objective, rule, deaths, hint }`
- `mode`: `'title'|'world'|'dying'|'deathspace'|'boss'|'ending'`
- `rule`: 현재 지배 규칙 문자열 (예: `'DARKNESS = DEATH'` → 삭제 후 `'DARKNESS = ______'`)
- `hint`: 선택적 짧은 힌트 (없으면 생략)

## 3. `src/game/audio.js` (A3)

WebAudio 싱글턴. `store` 구독해 마스터 게인 = `(effective('volume')/100)^1.5` 실시간 반영.
외부 파일 금지 — 전부 오실레이터/노이즈 합성. AudioContext는 `init()` 첫 호출에서 생성.

```js
export const audio = {
  init(),                 // 최초 사용자 제스처에서 호출 (React 시작 버튼)
  sfx(name),              // 'jump','land','death','erase','unlock','ui','collect','shield','shot','dash','win','rumble','type'
  setStage(key),          // 'stage0'|'stage1'|'stage2'|'boss'|'deathspace'|'ending'|null → 스테이지별 앰비언트 루프 교체
  stopMusic(),
};
```

각 스테이지 앰비언트는 2~4개 오실레이터의 짧은 시퀀스 루프(레트로/불길한 톤).
볼륨 0이면 완전 무음(감시자 취침 연출과 일치). 음질보다 **안정성**: 예외는 전부 try/catch.

## 4. `src/game/shared.js` (A2)

```js
export const VIEW_WIDTH = 960, VIEW_HEIGHT = 540;
export function preloadShared(scene);            // BootScene 전용 (기존 에셋 로드, 기존 코드 참조)
export function createSharedTextures(scene);     // 'earth','death-stone','white-pixel' + 필요 텍스처
export function createAnimations(scene);         // 기존 애님 키 유지: cat-idle-anim, cat-run-anim, cat-jump-anim, cat-fall-anim, cat-ghost-anim, cat-canvas-anim, seeker-idle-anim, seeker-run-anim
export function createPlayer(scene, x, y, ghost = false);
export function createInput(scene);
// → input 객체: { isDown(action), justPressed(action), destroy() }
//   action: 'left'|'right'|'jump'|'interact'|'disguise'|'dash'
//   store의 bindings를 따르고, 'rebind' 이벤트 시 자동 재구성. 방향키 ←→↑는 left/right/jump 별칭 고정.
export function updatePlayer(scene, player, input, controller, options = {});
// options: { speed=265, jumpVelocity=-665, ghost=false, allowDisguise=false, allowDash=true }
// 반환: { onGround, disguised, dashing }
// 대시: store.bindings.dash 가 있고 runState.dashFound 일 때만. 속도 620, 지속 160ms, 쿨다운 700ms, 잔상 이펙트, audio.sfx('dash')
export function createStaticPlatform(scene, group, x, y, w, h = 32, texture = 'earth', tint = 0xffffff);
export function addFloatingMote(scene, x, y, color, scrollFactor);
export function addDarkness(scene, { max = 0.94 } = {});
// 화면 전체 어둠 오버레이(depth 90, scrollFactor 0). alpha = max * (1 - norm(effective('brightness')))
// brightness 62 → 거의 암흑(윤곽만), 125+ → 0. store 구독, SHUTDOWN에서 자동 해제. 오버레이 GameObject 반환.
export function registerHidden(scene, gameObject, { threshold = 125, body = null } = {});
// brightness < threshold-35 → alpha 0 / threshold 근처에서 페이드 인 / ≥ threshold → alpha 1 + body(StaticBody) enable
export function registerOffFrame(scene, gameObject, { threshold = 70, body = null } = {});
// display > threshold → 반투명 유령(alpha 0.25, body off) / ≤ threshold → 실체화 트윈 + body on
export function bindCameraDisplay(scene);        // 카메라 줌 = effective('display')/100, store 구독 + 자동 해제
export function drawFrameBorder(scene, x, y, w, h, color = 0x65dad5); // 빛나는 스테이지 프레임 (줌아웃 시 "원래 화면"의 경계 표시용)
export function worldToUi(scene, x, y);          // 월드좌표 → 960×540 UI 좌표 {x,y} (cam.scrollX/Y, zoom 반영)
export function killPlayer(scene, cause);
// 표준 사망 시퀀스: runState.deaths+=1, addCorpse(scene.scene.key, x, y), 슬로모+플래시+audio.sfx('death'),
// emitState({mode:'dying', ...}), 500ms 후 scene.start('DeathspaceScene', { cause, returnScene: scene.scene.key })
export function getRunState(scene); export function saveRunState(scene, runState);
```

`runState` (Phaser registry 키 `'runState'`):
```js
{ started:false, stage:'Stage0Scene', deaths:0, erased:{}, dashFound:false, bossPhase:0 }
```
`erased` 키: `'DARKNESS'|'SOUND'|'FRAME'|'GRAVITY'|'ADMIN'|'DIED'` (true면 그 규칙 무력화).

## 5. `src/game/corpses.js` (A2)

```js
export function addCorpse(scene, sceneKey, x, y);   // registry 'corpses' 배열에 {sceneKey,x,y} push
export function spawnCorpses(scene, sceneKey);      // 해당 씬의 시체들을 static physics group으로 생성해 반환 (player collider용). 텍스처: 'cat-dead' (6_Cat_dead.png, BootScene에서 로드)
export function corpseCount(scene);
```

## 6. `src/game/createGame.js` + `BootScene` (A2)

- 기존 config 유지(960×540, FIT, gravity 1750, pixelArt).
- scene 배열: `[BootScene, Stage0Scene, Stage1Scene, Stage2Scene, BossScene, DeathspaceScene, EndingScene]`
- `BootScene`: `preloadShared` + `cat-dead` 이미지 로드 + 텍스처/애님 생성 → registry 초기화
  (`runState`, `corpses:[]`) → `emitState({mode:'title',…})` → `EV.START` 수신 시
  `runState.started=true` 후 `Stage0Scene` 시작. `EV.RESTART` 는 **모든 씬에서** 전역 처리:
  registry 리셋 + `store.resetRun()` + BootScene부터 재시작 (createGame에서 전역 리스너 1회 등록).

## 7. 씬 공통 규약 (B1~B5)

- 클래스명 = 파일명 = 씬 키 (`Stage0Scene` 등). `preload()` 없음 (Boot이 전부 로드).
- 생성 직후 `audio.setStage(...)`, `emitState({...})` 호출. 필수 HUD 문구는 각 씬이 소유.
- store 구독은 반드시 `this.events.once(Phaser.Scenes.Events.SHUTDOWN, unsub)` 로 해제.
- 사망은 반드시 `killPlayer(this, CAUSE)` 사용. 낙사 캐즘의 cause는 `'GRAVITY'`
  (단, `runState.erased.GRAVITY` 면 낙사 시 사망 대신 스폰 지점 복귀 + 카메라 플래시).
- 시체: `spawnCorpses(this, this.scene.key)` 로 생성해 player와 collider (밟는 발판).
- 위장(Q): Stage1에서만 의미. 힌트 낙서는 월드 내 텍스트로.
- 클리어 시 `runState.stage = '<다음씬>'` 저장 후 `scene.start('<다음씬>')`.

### 스테이지별 필수 비트 (세부 레이아웃은 씬 소유자 재량, 반드시 클리어 가능해야 함)

**Stage0Scene (B1)** — 어두운 방
- `addDarkness` 로 암흑. 이동/점프만 가능. 방 중앙에 구덩이(어두울 땐 안 보임) → 낙하 시 `killPlayer(this,'DARKNESS')` (erased.DARKNESS 후엔 구덩이가 보이고, 떨어져도 GRAVITY 규칙 적용).
- 낙서: `"ESC — 빛은 메뉴 안에 있다"` (죽기 전엔 흐릿, 복귀 후 선명).
- `registerHidden` 문(브라이트니스 ≥125에서 실체화) → 문에서 E 홀드 → Stage1로.
- 최초 진입 시 erased.DARKNESS면 어둠 max 0.55로 완화.

**Stage1Scene (B2)** — 소리의 정원
- SEEKER 감시자 1~2기 순찰. 청각 반경 = `140 + 340*(effective('volume')/100)` px, 발소리 링 이펙트가 이동 시 방출(크기도 볼륨 비례).
- 반경 내에서 이동(속도>10)하면 발각 → `killPlayer(this,'SOUND')`. `erased.SOUND` 면 감시자가 소리 무시(시각 원뿔만 유지, Q 위장으로 회피 가능).
- `volume === 0` → 감시자 수면(zZ 파티클, 시야 원뿔 소멸) — 그냥 걸어서 통과 가능.
- 볼륨 슬라이더 미해금 상태의 최초 조우는 사실상 강제 사망이 되도록 배치.
- 출구 문 → Stage2.

**Stage2Scene (B3)** — 프레임의 끝
- `drawFrameBorder` 로 "원래 화면" 프레임 표시, `bindCameraDisplay` 적용.
- 대협곡 + `registerOffFrame` 발판들(프레임 밖에 유령처럼 보임). 프레임 밖 접촉/추락 → `killPlayer(this,'FRAME')` (erased.FRAME 후엔 GRAVITY 규칙).
- display ≤ 70 에서 발판 실체화 → 협곡 횡단 가능.
- 중반: `DASH MODULE` 오브젝트(E 홀드) → `runState.dashFound=true; store.unlock('controls')` → HUD 힌트 "설정에서 키를 바인딩하라".
- 마지막 간격은 대시 없이는 불가능한 폭. 클리어 → BossScene.

**BossScene (B4)** — SYS_ADMIN (거대 SEEKER 틴트)
- 페이즈1: 음파탄 발사(3~5발 주기). 탄이 `worldToUi` 좌표로 `store.panelRect` 와 겹치고 `panelOpen` 이면 차단: 탄 소멸 + `emit(EV.PANEL_HIT)` + `store.set('integrity', -12씩)` + audio.sfx('shield'). 패널로 안 막으면 플레이어 피격 = `killPlayer(this,'ADMIN')`… 단 **페이즈1~3 사망도 정상 사망 루프** (사망공간 다녀오면 bossPhase 유지 재도전). 탄 8회 차단 → 페이즈2.
- 페이즈2: `store.revoke('brightness')` + 암흑. 패널이 광원: panelRect 중심 주변만 밝음(어둠 오버레이에 구멍). 아레나 반대편 브레이커에 E 홀드 → `store.restore('brightness')` → 페이즈3.
- 페이즈3: `emit(EV.BOSS,{phase:'shatter'})` + `store.set('corrupted', true)`. 아레나에 UI 조각 5개(슬라이더 노브, 토글, 타이틀바, 닫기버튼, 게이지) 스폰 — E로 수집. 5개 모으면 `store.set('corrupted', false)` + `emit(EV.BOSS,{phase:'restored'})` → 페이즈4.
- 페이즈4: 연출 후 회피 불가 빔 → `killPlayer(this,'ADMIN')` (이때 `runState.bossPhase=4` 라서 DeathspaceScene이 최종 탑 변형으로 진입).
- `runState.bossPhase` 로 페이즈 저장/복원.
- **EndingScene (B4)**: `YOU ?` → `YOU.` 타이핑 연출, 고양이 귀가, 시체들 기립 손인사, `DEATHS: NN — N번의 건축`, `emitState({mode:'ending'})`, audio 'win'.

**DeathspaceScene (B5)** — 실패 공간
- 진입 데이터: `{ cause, returnScene }`.
- CAUSE 테이블 (씬 내부 상수):

| cause | 지울 단어 | 해금 | 비고 |
|---|---|---|---|
| DARKNESS | DARKNESS | `store.unlock('brightness')` | 튜토리얼 안내 낙서 포함 |
| SOUND | SOUND | `store.unlock('volume')` | |
| FRAME | FRAME | `store.unlock('display')` | |
| GRAVITY | GRAVITY | 없음 (erased.GRAVITY → 낙사 무해화) | |
| ADMIN(bossPhase<4) | ADMIN | 없음 — 지우면 즉시 복귀(보스 재도전) | |
| ADMIN(bossPhase=4) | **DIED** | 최종: `YOU DIED?` 타이틀의 DIED 삭제 → `EndingScene` | 탑 변형 |

- 공통 지형: 거대한 `YOU DIED?` 활자 발판(기존 구현 참조) + `KILLED BY: <WORD>` 문구가 높은 곳에.
- **RETRY 버튼 = 미는 상자**: deaths 수만큼 쌓임(최대 6). E → "NOT RESPONDING" 흔들림. 밀어서 계단.
- 이전 시체들 표시 (밟기 가능).
- 단어 삭제: 단어와 겹친 상태로 E 홀드 1초(진행 게이지) → 글리치 파티클 + audio.sfx('erase') → 이미 해금 대상이면 해금 연출(`store.unlock`) → `runState.erased[word]=true` → 1.2초 후 `scene.start(returnScene)`.
- 최종 탑 변형(bossPhase=4): 축적된 모든 버튼+시체가 수직으로 쌓인 타워, 최상단 `YOU DIED?` 의 `DIED` 만 삭제 가능 → 백색 페이드 → `EndingScene`.
- 낙하 시 사망 없음: 바닥 리스폰(기존 구현과 동일).

## 8. React 셸 (A4) & 설정 패널 (A1)

**App.jsx (A4)**
- `EV.STATE` 구독 HUD(챕터/목표/규칙/사망수), 타이틀 스크린(시작 버튼 → `audio.init()` + `emit(EV.START)`), 엔딩 오버레이(`emit(EV.RESTART)` 버튼), CRT 프레임/스캔라인 유지.
- ESC keydown → `store.set('panelOpen', !panelOpen)` (mode 'title'/'ending' 제외). `preventDefault` 필수.
- `<SettingsPanel />` 를 항상 마운트 (표시 여부는 패널이 store로 스스로 결정).
- 밝기 실감: `.viewport-wrap` 에 `style={{filter: brightness(0.75 + 0.25*effective('brightness')/100)}}` 정도의 **보조** 효과 (주 효과는 인게임 어둠 오버레이).
- 조작 안내 푸터는 현재 bindings를 실시간 반영.

**SettingsPanel.jsx (A1)**
- `store` 구독. `panelOpen && !corrupted` 일 때 렌더. 타이틀바 드래그 이동(pointer events).
- **열려 있거나 드래그 중일 때 매 프레임/이동마다 `panelRect` 를 게임 내부좌표로 갱신**:
  캔버스(`.viewport canvas`)의 `getBoundingClientRect()` 대비 패널 rect를 960×540 공간으로 변환해 `store.set('panelRect', rect)`. 닫히면 null.
- 미해금 항목은 목록에 아예 없음. 전부 미해금이면: `NO PERMISSIONS — 권한이 없습니다. 죽음으로 증명하십시오.`
- 항목: BRIGHTNESS/VOLUME/DISPLAY 슬라이더(해금 시), CONTROLS 탭(해금 시): 각 액션 현재 키 + `[변경]` → "PRESS ANY KEY" 캡처 → `store.rebind`. dash는 미바인딩 시 `UNBOUND` 강조.
- revoke 된 항목은 `REVOKED BY ADMIN` 표시로 비활성화. integrity < 100 → 금 간 오버레이, `EV.PANEL_HIT` 수신 시 흔들림. corrupted → 렌더 안 함.
- 게임은 패널이 열려도 **멈추지 않는다**.

## 9. 완료 기준 (전 에이전트 공통)

1. `npm run build` 통과 (통합자가 최종 확인, 각자는 본인 파일 문법 완결 책임).
2. 계약된 export 이름·시그니처와 정확히 일치. 소유 외 파일 무수정.
3. 모든 이벤트/store 구독은 씬 SHUTDOWN 또는 React cleanup에서 해제 (중복 리스너 = 버그).
4. 게임 텍스트 톤: 시스템은 영문 모노스페이스, 서사는 한국어. 이모지 금지.
5. 모든 퍼즐은 계약된 해법으로 실제 클리어 가능해야 하며, 소프트락 금지
   (죽음이 항상 탈출구: 어디서든 죽을 수 있으면 진행 가능).
