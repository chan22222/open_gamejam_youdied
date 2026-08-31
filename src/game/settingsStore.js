// ESC/APE — settingsStore (A1 core-store)
// React와 Phaser가 공유하는 프레임워크 무관 옵저버블 스토어.
// 의존성 0 — Phaser/React import 금지. (ARCHITECTURE.md 1절)

export const SETTING_LIMITS = {
  brightness: { min: 40, max: 160, def: 62 }, // %
  volume: { min: 0, max: 100, def: 70 }, // %
  display: { min: 55, max: 100, def: 100 }, // % → 카메라 줌 = display/100
  shake: { min: 0, max: 100, def: 0 }, // % → 세계 진동 강도 (0 = 정지)
};

const UNLOCK_KEYS = ['brightness', 'volume', 'display', 'shake', 'controls'];

const SETTABLE_KEYS = new Set([
  ...Object.keys(SETTING_LIMITS),
  'panelOpen',
  'panelRect',
  'integrity',
  'corrupted',
]);

function defaultState() {
  return {
    // 밝기/음량/화면은 처음부터 사용 가능 — 설정 퍼즐은 죽음 없이 체험한다.
    // 죽음 해금(shake)은 3번째 맵의 가시부터.
    unlocked: { brightness: true, volume: true, display: true, shake: false, controls: false },
    brightness: SETTING_LIMITS.brightness.def,
    volume: SETTING_LIMITS.volume.def,
    display: SETTING_LIMITS.display.def,
    shake: SETTING_LIMITS.shake.def,
    bindings: { left: 'A', right: 'D', jump: 'SPACE', interact: 'E', disguise: 'Q', dash: null },
    panelOpen: false,
    panelRect: null, // {x,y,w,h} — 게임 내부좌표(960×540). 패널 닫힘/파괴 시 null
    integrity: 100, // 보스전 패널 내구도
    corrupted: false, // true면 패널 산산조각(렌더 불가)
    revoked: {}, // 예: { brightness: true }
  };
}

let state = defaultState();
const listeners = new Set();

function emit(type, key, value) {
  const event = { type, key, value, state };
  for (const listener of [...listeners]) {
    try {
      listener(event);
    } catch (err) {
      // 한 구독자의 예외가 다른 구독자/게임 루프를 죽이면 안 된다.
      console.error('[settingsStore] listener error:', err);
    }
  }
}

function clampNumber(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, Math.round(n)));
}

// 방향키 ←/→/↑ 는 엔진(shared.js createInput)이 이동/점프 별칭으로 영구 배정한다.
// 이 키를 다른 액션에 바인딩하면 동일 Key 인스턴스가 두 액션에 물려 입력이 충돌하므로
// (예: dash를 UP에 묶으면 점프 분기가 JustDown을 먼저 소비해 대시가 절대 발동하지 않음)
// 예약 별칭과 다른 액션의 조합은 중복 키로 간주해 거부한다.
const RESERVED_ALIASES = { LEFT: 'left', RIGHT: 'right', UP: 'jump' };

function sameRect(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

export const store = {
  // 반환값은 직접 변경 금지 (읽기 전용으로 취급).
  getState() {
    return state;
  },

  set(key, value) {
    if (!SETTABLE_KEYS.has(key)) {
      console.warn('[settingsStore] set: unknown key', key);
      return;
    }

    if (key === 'panelRect') {
      const next = value
        ? { x: Number(value.x) || 0, y: Number(value.y) || 0, w: Number(value.w) || 0, h: Number(value.h) || 0 }
        : null;
      if (sameRect(state.panelRect, next)) return;
      state.panelRect = next;
      emit('change', key, next);
      return;
    }

    let next = value;
    if (SETTING_LIMITS[key]) {
      const { min, max } = SETTING_LIMITS[key];
      next = clampNumber(value, min, max);
      if (next === null) return;
    } else if (key === 'integrity') {
      next = clampNumber(value, 0, 100);
      if (next === null) return;
    } else {
      // panelOpen | corrupted
      next = !!value;
    }

    if (state[key] === next) return;
    state[key] = next;
    emit('change', key, next);
  },

  unlock(key) {
    if (!UNLOCK_KEYS.includes(key)) {
      console.warn('[settingsStore] unlock: unknown key', key);
      return;
    }
    if (state.unlocked[key]) return;
    state.unlocked[key] = true;
    emit('unlock', key, true);
  },

  isUnlocked(key) {
    return !!state.unlocked[key];
  },

  // keyName: 대문자 문자열('K','SHIFT','ENTER'…) 또는 null(언바인딩).
  // 다른 액션이 이미 쓰는 키면 false를 반환하고 아무것도 바꾸지 않는다.
  rebind(action, keyName) {
    if (!Object.prototype.hasOwnProperty.call(state.bindings, action)) return false;
    const next = keyName == null ? null : String(keyName).toUpperCase();
    if (next !== null) {
      if (RESERVED_ALIASES[next] && RESERVED_ALIASES[next] !== action) return false;
      for (const other of Object.keys(state.bindings)) {
        if (other !== action && state.bindings[other] === next) return false;
      }
    }
    if (state.bindings[action] === next) return true;
    state.bindings[action] = next;
    emit('rebind', action, next);
    return true;
  },

  revoke(key) {
    if (state.revoked[key]) return;
    state.revoked[key] = true;
    emit('revoke', key, true);
  },

  restore(key) {
    if (!state.revoked[key]) return;
    delete state.revoked[key];
    emit('restore', key, false);
  },

  // listener({ type:'change'|'unlock'|'rebind'|'revoke'|'restore'|'reset', key, value, state })
  subscribe(listener) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },

  // 새 게임: 전부 초기값 (bindings 포함).
  resetRun() {
    state = defaultState();
    emit('reset', null, null);
  },
};

// revoke된 설정은 세계에 효과가 없어야 한다:
// revoke 시 해당 설정의 def값을, 아니면 현재값을 반환.
export function effective(key) {
  if (state.revoked[key] && SETTING_LIMITS[key]) return SETTING_LIMITS[key].def;
  return state[key];
}
