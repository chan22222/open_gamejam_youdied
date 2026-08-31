// ESC/APE — 로컬 저장 (이어하기)
// runState + 시체 + 설정 스냅샷을 localStorage에 보관한다.
// localStorage는 언제든 실패할 수 있으므로 전부 try/catch — 저장이 게임을 막지 않는다.

import { store } from './settingsStore.js';

const KEY = 'escape-save-v1';

export function saveProgress(runState, corpses) {
  try {
    const s = store.getState();
    localStorage.setItem(KEY, JSON.stringify({
      runState,
      corpses: corpses || [],
      settings: {
        unlocked: s.unlocked,
        brightness: s.brightness,
        volume: s.volume,
        display: s.display,
        shake: s.shake,
        bindings: s.bindings,
      },
    }));
  } catch {
    // 저장 불가 환경 — 무시
  }
}

export function loadProgress() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data || !data.runState || !data.runState.stage) return null;
    return data;
  } catch {
    return null;
  }
}

export function hasSave() {
  return loadProgress() !== null;
}

export function clearSave() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // 무시
  }
}

// 저장된 설정 스냅샷을 store에 복원한다 (이어하기 진입 직전에 호출).
export function applySavedSettings(saved) {
  if (!saved || !saved.settings) return;
  const st = saved.settings;
  try {
    Object.keys(st.unlocked || {}).forEach((key) => {
      if (st.unlocked[key]) store.unlock(key);
    });
    ['brightness', 'volume', 'display', 'shake'].forEach((key) => {
      if (typeof st[key] === 'number') store.set(key, st[key]);
    });
    // 순환 치환(좌우 스왑 등)도 복원되도록 전부 비운 뒤 다시 바인딩한다
    const actions = Object.keys(st.bindings || {});
    actions.forEach((action) => store.rebind(action, null));
    actions.forEach((action) => {
      if (st.bindings[action] != null) store.rebind(action, st.bindings[action]);
    });
  } catch {
    // 복원 실패 시 기본값으로 진행
  }
}
