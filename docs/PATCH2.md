# PATCH 2 — 사망 반전 · ESC 기능 강화 · 타이틀 정리 (구현 계약)

`docs/ARCHITECTURE.md` 를 보완하는 패치 계약. 충돌 시 이 문서가 우선.
전 에이전트 공통: **텍스트는 최소한으로** (한 문장 지시어, 키 힌트만 — 주절주절 금지). 이모지 금지. 빌드는 통합자만 실행.

## 파일 소유권 (이번 패치)

| 파일 | 소유자 |
|---|---|
| `src/App.jsx`, `src/styles.css` | **A 셸 디자인** |
| `src/ui/SettingsPanel.jsx`, `src/ui/settings.css`, `src/game/settingsStore.js` | **B 패널 디자인** |
| `src/game/deathIntrusion.js`(신규), `src/game/worldToys.js`(신규), `src/game/shared.js`, `src/game/scenes/DeathspaceScene.js` | **C 코어** |
| `src/game/scenes/Stage0Scene.js`, `src/game/scenes/Stage1Scene.js` | **D 스테이지 전반** |
| `src/game/scenes/Stage2Scene.js`, `src/game/scenes/BossScene.js` | **E 스테이지 후반** |

## 1. 사망 반전 — "죽어도 화면을 떠나지 않는다" (C가 코어, D/E가 씬 적용)

**켄셉**: 죽으면 씬 전환 없이 그 자리에서 가짜 게임오버 UI가 뜨고, 고양이가 다시 일어난다.
실패 화면이 월드에 침입해 물리 오브젝트가 된다.

`killPlayer(scene, cause)` 시그니처 유지, 내부 재작성:
- `cause==='ADMIN' && bossPhase>=4` → 기존 그대로 DeathspaceScene(최종 탑) 씬 전환. **그 외 모든 사망은 in-scene**.
- in-scene 흐름 (`deathIntrusion.js`의 `triggerDeathIntrusion(scene, cause)`):
  1. `scene.__dying=true`, 입력락, deaths+1, `addCorpse`, 고양이 쓰러짐(cat-dead), 사망 연출(기존 슬로모/셰이크 재사용).
  2. **가짜 UI**: 스크린 고정(depth 200) 어두운 배경(alpha 0.8) + 세리프 `YOU DIED?` + `KILLED BY: <WORD>` + 가짜 RETRY 버튼 — 진짜 게임오버처럼 1.1초 정지.
  3. **반전**: 고양이 기상 애니 + 입력 복귀. 배경 어둠은 alpha 0.45로 완화(죽음의 렌즈). 오버레이 글자가 월드로 낙하해 실체화:
     - `YOU DIED` 글자 발판 3개(정적) — 사망 지점 주변, 월드 경계 클램프
     - RETRY 버튼(pushable, 기존 텍스처 스타일) — 사망 횟수만큼 누적, 최대 3
     - `KILLED BY: <WORD>` 의 단어만 금색 부유 — 사망 지점 위 ~170px (글자/버튼 밟고 도달)
  4. 단어 위 [E] 홀드 1초 → 글리치 소멸 → `store.unlock(...)` + `runState.erased[word]=true` + PERMISSION GRANTED 배너(기존 스타일) → 침입 요소 디졸브 + 어둠 걷힘.
- **truce 규칙**: intrusion 활성(2~4단계) 동안 `scene.__truce=true`. 씬들의 모든 kill 체크는 `__truce||__dying` 시 스킵 (D/E가 각 씬에 가드 추가). intrusion 활성 중 재사망 없음.
- 단어를 안 지우고 떠나도 침입 요소는 잔존 — 돌아와서 지울 수 있다.
- 정리: SHUTDOWN/RESTART에서 완전 해제. Stage0 첫 사망의 조작 안내는 침입 요소 옆 초단문 낙서 2개만: `"밀어라"`, `"[E] 길게"`.

### cause 개편 — GRAVITY 폐지, SPIKES 신설
| cause | 단어 | 해금 | 삭제 효과 |
|---|---|---|---|
| DARKNESS | DARKNESS | brightness | (기존) |
| SOUND | SOUND | volume | (기존) |
| FRAME | FRAME | display | (기존) |
| **SPIKES** | SPIKES | **shake** | 가시 무해화(비활성 틴트) |
| ADMIN | (최종 탑 전용) | — | 기존 유지 |

낙사(화면 밖 추락)는 **지형에서 제거**한다 — 죽음은 전부 밟는 장애물로:
- **Stage0 (D)**: 구덩이 삭제, 바닥 연결. 중앙에 어둠 속 가시 구간(어두우면 거의 안 보임, 밝기 올리면 선명+점프로 회피 가능, 폭 ~90px). 밟으면 DARKNESS 사망.
- **Stage2 (E)**: 협곡 바닥을 화면 안 깊이로 올리고 가시밭 배치. 밟으면 SPIKES 사망 → 그 자리 intrusion의 글자/버튼이 협곡 탈출 사다리가 된다(실패=건축 재료). FRAME 사망은 기존 유지. `erased.GRAVITY` 참조 전부 제거.
- Stage1/Boss (D/E): 낙사 지점 있으면 동일 원칙으로 정리, truce 가드 추가.

## 2. ESC 기능 강화 (B 스토어/UI, C 물리, D/E 씬 부착)

- **SHAKE 슬라이더** (B: `SETTING_LIMITS.shake = {min:0,max:100,def:0}`, `unlocked.shake`):
  값>0이면 세계가 흔들린다 — 카메라 미세 진동(강도 비례) + 등록된 pushable(RETRY 버튼, 보스 파편)에 주기적 랜덤 임펄스. 손대지 않고 물건을 옮기는 장난감. SPIKES 삭제로 해금.
- **패널 물리화 전역화** (C: `worldToys.js`): 설정 창을 드래그하면 월드의 pushable을 밀어낼 수 있다(보스전 방패 로직과 별개, dynamic body만). `uiToWorld(scene,x,y)` 헬퍼를 shared.js에 추가.
- C export: `attachWorldToys(scene, { pushables: [] })` — store 구독(shake/panelRect), teardown 자동. D/E는 각 씬 create에서 호출하고 pushable 그룹 전달 (intrusion 버튼은 C가 내부에서 자동 등록).
- **브라우저 리사이즈 장난** (A): 실제 창 리사이즈 감지(디바운스 400ms) → HUD 힌트 1줄 `EXTERNAL FRAME EDIT DETECTED` 잠깐 + 뷰포트 wobble 애니 1회. 과하지 않게, 세션당 최대 2회.

## 3. 타이틀/패널 디자인 (A, B — 디자인 판단은 재량, 방향만 고정)

**A 타이틀**:
- 카피 문단(2줄)과 eyebrow 전부 삭제 — 로고 + RUN 버튼 + 조작칩만.
- 로고: `.logo-ape` 폰트를 `.logo-key`(ESC 키캡)와 **동일한 모노 폰트**로 통일. 시각 완성도는 재량(키캡 3개 연출 등 가능하되 텍스트 추가 금지).
- 타이틀 조작칩에서 **E/Q 제거** — `A/D 이동, SPACE 점프, ESC 설정`만. (인게임 푸터는 유지)
- `NO PERMISSIONS — 죽음으로 증명하라.` 한 줄은 유지 가능.
- 리사이즈 장난(위 2절) 포함.

**B 패널**:
- **권한 0개 상태에서 ESC**: 빈 메뉴가 그냥 떠 있지 않는다. `ACCESS DENIED` 글리치 플래시(짧고 강하게) 후 **0.9초 내 자동 닫힘**(deny 사운드는 audio.sfx('ui') 재사용 가능). 해금 1개 이상이면 기존 정상 패널.
- SHAKE 슬라이더 행 추가(해금 시 노출, ko 설명 한 줄: `세계를 흔든다.`).
- settingsStore에 shake 추가 시 `effective`/`resetRun`/`revoke` 경로 일관성 유지.

## 4. 기타 (해당 소유자)
- **캐릭터 글로우 제거** (D): `Stage0Scene.js` 92, 479-480 `playerGlow` 삭제.
- HUD/낙서 신규 텍스트는 전부 초단문 원칙.

## 완료 기준
소유 파일만 수정. import/export 이름은 이 문서와 정확히 일치. 구독 teardown 필수. 통합자가 `npm run build` 통과시키고 계약 대조.
