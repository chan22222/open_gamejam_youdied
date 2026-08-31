// ESC/APE — React <-> Phaser 통신 채널 (window CustomEvent 래퍼)
// ARCHITECTURE.md 2절. 이 모듈 외의 통신 경로를 만들지 않는다.

export const EV = {
  STATE: 'escape:state', // Phaser -> React : HUD 갱신 { mode, chapter, objective, rule, deaths, hint? }
  START: 'escape:start', // React -> Phaser : 게임 시작 (타이틀 화면의 시작 버튼)
  RESTART: 'escape:restart', // React -> Phaser : 처음부터 (registry + store 리셋)
  PANEL_HIT: 'escape:panel-hit', // Phaser -> React : 설정 패널 방패 피격 (패널 흔들림 연출)
  BOSS: 'escape:boss', // Phaser -> React : { phase: 'corrupt'|'shatter'|'restored' }
};

export function emit(name, detail) {
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

// 리스너는 fn(detail, event) 형태로 호출된다. 반환값 = 해제 함수.
export function on(name, fn) {
  const handler = (event) => fn(event ? event.detail : undefined, event);
  window.addEventListener(name, handler);
  return () => window.removeEventListener(name, handler);
}

// EV.STATE payload: { mode, chapter, objective, rule, deaths, hint? }
// mode: 'title'|'world'|'dying'|'deathspace'|'boss'|'ending'
export function emitState(detail) {
  emit(EV.STATE, detail);
}
