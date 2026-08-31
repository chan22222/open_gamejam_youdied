// ESC/APE — SettingsPanel (A1 core-store)
// store만 구독해 스스로 표시를 결정하는 시스템 설정 패널.
// panelOpen && !corrupted 일 때 렌더. 타이틀바 드래그 이동,
// 열려 있는 동안 rAF로 panelRect(960×540 게임 내부좌표)를 store에 동기화.
// 권한 0개에서 열면 패널 대신 ACCESS DENIED 글리치 카드 → 0.9초 후 자동 닫힘.

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { EV, on } from '../game/events.js';
import { SETTING_LIMITS, store } from '../game/settingsStore.js';
import './settings.css';

const GAME_W = 960;
const GAME_H = 540;
const UNLOCK_KEYS = ['brightness', 'volume', 'display', 'shake', 'controls'];

const SLIDERS = [
  { key: 'brightness', label: 'BRIGHTNESS', ko: '숨은 것을 드러낸다.' },
  { key: 'volume', label: 'VOLUME', ko: '발소리 크기. 0 = 침묵.' },
  { key: 'display', label: 'DISPLAY', ko: '줄이면 바깥이 들어온다.' },
  { key: 'shake', label: 'SHAKE', ko: '세계를 흔든다.' },
];

const ACTIONS = [
  { key: 'left', label: 'MOVE LEFT', ko: '좌측 이동' },
  { key: 'right', label: 'MOVE RIGHT', ko: '우측 이동' },
  { key: 'jump', label: 'JUMP', ko: '점프' },
  { key: 'interact', label: 'INTERACT', ko: '상호작용 / 삭제' },
  { key: 'disguise', label: 'DISGUISE', ko: '배경 위장' },
  { key: 'dash', label: 'DASH', ko: '대시 모듈' },
];

const KEY_ALIASES = {
  ARROWLEFT: 'LEFT',
  ARROWRIGHT: 'RIGHT',
  ARROWUP: 'UP',
  ARROWDOWN: 'DOWN',
  CONTROL: 'CTRL',
  SPACEBAR: 'SPACE',
};

const SPECIAL_KEYS = new Set([
  'SPACE', 'SHIFT', 'ENTER', 'TAB', 'CTRL', 'ALT', 'BACKSPACE',
  'LEFT', 'RIGHT', 'UP', 'DOWN', 'HOME', 'END', 'INSERT', 'DELETE',
]);

function normalizeKey(event) {
  if (event.key === ' ') return 'SPACE';
  const up = String(event.key).toUpperCase();
  const name = KEY_ALIASES[up] || up;
  if (/^[A-Z0-9]$/.test(name)) return name;
  if (SPECIAL_KEYS.has(name)) return name;
  return null;
}

// 패널은 absolute — 좌표계는 offsetParent(.viewport-wrap) 기준.
function containerRect(el) {
  const parent = el ? el.offsetParent : null;
  if (parent) return parent.getBoundingClientRect();
  return { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
}

function clampPos(x, y, w, h, bounds) {
  const bw = bounds ? bounds.width : window.innerWidth;
  const bh = bounds ? bounds.height : window.innerHeight;
  return {
    x: Math.round(Math.max(0, Math.min(x, bw - w))),
    y: Math.round(Math.max(0, Math.min(y, bh - h))),
  };
}

function findCanvas() {
  return document.querySelector('.viewport canvas');
}

function SettingsPanel() {
  const [, force] = useReducer((c) => c + 1, 0);
  const [pos, setPos] = useState(null); // {x,y} 뷰포트 px — 세션 동안 위치 기억
  const [tab, setTab] = useState('system');
  const [capture, setCapture] = useState(null); // { action } | null
  const [captureError, setCaptureError] = useState(null);
  const [errTick, setErrTick] = useState(0);

  const panelRef = useRef(null);
  const dragRef = useRef(null); // { id, dx, dy }
  const lastRectRef = useRef(null);
  const seenRef = useRef(new Set()); // 이미 등장 연출을 마친 해금 항목

  const st = store.getState();
  const visible = st.panelOpen && !st.corrupted;
  // 전 항목 상시 표시 — 미해금 항목은 LOCKED로 비활성화되어 보인다.
  const panelActive = visible;

  // ---- store 구독: 모든 변화에 리렌더 + 해금/리셋 처리 ----
  useEffect(() => {
    const unsub = store.subscribe((event) => {
      if (event.type === 'unlock' && event.key === 'controls') setTab('controls');
      if (event.type === 'reset') {
        seenRef.current.clear();
        setTab('system');
        setCapture(null);
        setCaptureError(null);
      }
      force();
    });
    return unsub;
  }, []);

  // ---- EV.PANEL_HIT → 흔들림 (클래스 재부착으로 애니메이션 재시작) ----
  useEffect(() => on(EV.PANEL_HIT, () => {
    const el = panelRef.current;
    if (!el) return;
    el.classList.remove('esc-hit');
    void el.offsetWidth; // reflow로 애니메이션 리셋
    el.classList.add('esc-hit');
  }), []);

  // ---- panelRect → 960×540 게임 내부좌표 동기화 ----
  const pushPanelRect = useCallback(() => {
    const el = panelRef.current;
    const canvas = findCanvas();
    if (!el || !canvas) {
      lastRectRef.current = null;
      if (store.getState().panelRect !== null) store.set('panelRect', null);
      return;
    }
    const c = canvas.getBoundingClientRect();
    if (c.width < 2 || c.height < 2) {
      lastRectRef.current = null;
      if (store.getState().panelRect !== null) store.set('panelRect', null);
      return;
    }
    const p = el.getBoundingClientRect();
    const sx = GAME_W / c.width;
    const sy = GAME_H / c.height;
    const rect = {
      x: Math.round((p.left - c.left) * sx * 10) / 10,
      y: Math.round((p.top - c.top) * sy * 10) / 10,
      w: Math.round(p.width * sx * 10) / 10,
      h: Math.round(p.height * sy * 10) / 10,
    };
    const last = lastRectRef.current;
    if (
      last &&
      Math.abs(last.x - rect.x) < 0.5 &&
      Math.abs(last.y - rect.y) < 0.5 &&
      Math.abs(last.w - rect.w) < 0.5 &&
      Math.abs(last.h - rect.h) < 0.5
    ) {
      return;
    }
    lastRectRef.current = rect;
    store.set('panelRect', rect);
  }, []);

  useEffect(() => {
    if (!panelActive) {
      lastRectRef.current = null;
      if (store.getState().panelRect !== null) store.set('panelRect', null);
      return undefined;
    }
    let raf = requestAnimationFrame(function tick() {
      pushPanelRect();
      raf = requestAnimationFrame(tick);
    });
    return () => {
      cancelAnimationFrame(raf);
      lastRectRef.current = null;
      if (store.getState().panelRect !== null) store.set('panelRect', null);
    };
  }, [panelActive, pushPanelRect]);

  // ---- 열릴 때 위치 결정: 최초엔 기본 위치(캔버스 우상단 부근), 이후엔
  // 기억된 pos를 현재 뷰포트 안으로 재클램프 (닫힌 사이 리사이즈로 화면 밖에
  // 남은 패널이 overflow:hidden에 통째로 잘리는 문제 방지) ----
  useEffect(() => {
    if (!panelActive) return;
    const el = panelRef.current;
    const pw = el ? el.offsetWidth : 342;
    const ph = el ? el.offsetHeight : 330;
    const box = containerRect(el);
    if (pos) {
      const next = clampPos(pos.x, pos.y, pw, ph, box);
      if (next.x !== pos.x || next.y !== pos.y) setPos(next);
      return;
    }
    const canvas = findCanvas();
    let x;
    let y;
    if (canvas) {
      const c = canvas.getBoundingClientRect();
      x = c.left - box.left + c.width * 0.55;
      y = c.top - box.top + Math.max(20, c.height * 0.1);
    } else {
      x = (box.width - pw) / 2;
      y = (box.height - ph) / 2;
    }
    setPos(clampPos(x, y, pw, ph, box));
  }, [panelActive, pos]);

  // ---- 창 리사이즈 시 뷰포트 안으로 클램프 ----
  useEffect(() => {
    if (!panelActive) return undefined;
    const onResize = () => {
      const el = panelRef.current;
      if (!el) return;
      setPos((p) => (p ? clampPos(p.x, p.y, el.offsetWidth, el.offsetHeight, containerRect(el)) : p));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [panelActive]);

  // ---- PRESS ANY KEY 캡처 리바인딩 ----
  useEffect(() => {
    if (!capture) return undefined;
    const onKey = (event) => {
      // 캡처 중엔 게임/앱에 키가 새지 않게 전부 삼킨다.
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.key === 'Escape') {
        setCapture(null);
        setCaptureError(null);
        return;
      }
      const name = normalizeKey(event);
      if (!name) {
        setCaptureError('UNSUPPORTED KEY');
        setErrTick((t) => t + 1);
        return;
      }
      if (!store.rebind(capture.action, name)) {
        setCaptureError('KEY IN USE');
        setErrTick((t) => t + 1);
        return;
      }
      setCapture(null);
      setCaptureError(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [capture]);

  // 패널이 사라지면 진행 중이던 캡처도 취소.
  useEffect(() => {
    if (!visible && capture) {
      setCapture(null);
      setCaptureError(null);
    }
  }, [visible, capture]);

  // ---- 등장 연출을 한 번만: 표시된 해금 항목을 잠시 후 seen 처리 ----
  useEffect(() => {
    if (!panelActive) return undefined;
    const t = setTimeout(() => {
      const unlocked = store.getState().unlocked;
      for (const key of UNLOCK_KEYS) {
        if (unlocked[key]) seenRef.current.add(key);
      }
    }, 1000);
    return () => clearTimeout(t);
  });

  // ---- 타이틀바 드래그 ----
  const onTitlePointerDown = (event) => {
    if (event.button !== 0) return;
    const el = panelRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    dragRef.current = { id: event.pointerId, dx: event.clientX - r.left, dy: event.clientY - r.top };
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch (err) { /* capture 미지원 환경 무시 */ }
    el.classList.add('esc-dragging');
    event.preventDefault();
  };

  const onTitlePointerMove = (event) => {
    const drag = dragRef.current;
    if (!drag || drag.id !== event.pointerId) return;
    const el = panelRef.current;
    if (!el) return;
    const box = containerRect(el);
    setPos(clampPos(
      event.clientX - drag.dx - box.left,
      event.clientY - drag.dy - box.top,
      el.offsetWidth,
      el.offsetHeight,
      box,
    ));
  };

  const endDrag = (event) => {
    const drag = dragRef.current;
    if (!drag || drag.id !== event.pointerId) return;
    dragRef.current = null;
    const el = panelRef.current;
    if (el) el.classList.remove('esc-dragging');
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch (err) { /* 이미 해제됨 */ }
  };

  if (!visible) return null;

  const activeTab = st.unlocked.controls && tab === 'controls' ? 'controls' : 'system';
  const integrity = st.integrity;
  const cracked = integrity < 100;
  const crackLevel = integrity > 60 ? 1 : integrity > 25 ? 2 : 3;

  return (
    <aside
      ref={panelRef}
      className="esc-panel"
      role="dialog"
      aria-label="SYSTEM SETTINGS"
      style={{
        left: pos ? pos.x : 0,
        top: pos ? pos.y : 0,
        visibility: pos ? 'visible' : 'hidden',
      }}
    >
      <header
        className="esc-titlebar"
        onPointerDown={onTitlePointerDown}
        onPointerMove={onTitlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <span className="esc-dot" aria-hidden="true" />
        <b className="esc-title">SYS://SETTINGS</b>
        {cracked && (
          <em className="esc-integrity" data-low={integrity <= 36 || undefined}>
            INTEGRITY {integrity}%
          </em>
        )}
        <button
          type="button"
          className="esc-close"
          aria-label="닫기"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => store.set('panelOpen', false)}
        >
          [X]
        </button>
      </header>

      {cracked && (
        <div className="esc-integrity-bar" style={{ '--esc-int': `${integrity}%` }} aria-hidden="true" />
      )}

      <nav className="esc-tabs" aria-label="설정 탭">
        <button
          type="button"
          className={activeTab === 'system' ? 'is-active' : ''}
          onClick={() => setTab('system')}
        >
          SYSTEM
        </button>
        <button
          type="button"
          disabled={!st.unlocked.controls}
          className={`${activeTab === 'controls' ? 'is-active' : ''} ${st.unlocked.controls && !seenRef.current.has('controls') ? 'esc-item-new' : ''}`}
          onClick={() => setTab('controls')}
        >
          {st.unlocked.controls ? 'CONTROLS' : 'CONTROLS ▩'}
        </button>
      </nav>

      <div className="esc-body">
        {activeTab === 'system' && (
          <>
            <div className="esc-sect">WORLD PARAMETERS</div>
            {SLIDERS.map((s) => {
              const lim = SETTING_LIMITS[s.key];
              const value = st[s.key];
              const locked = !st.unlocked[s.key];
              const revoked = !!st.revoked[s.key];
              const isNew = !locked && !seenRef.current.has(s.key);
              const fill = ((value - lim.min) / (lim.max - lim.min)) * 100;
              return (
                <div
                  key={s.key}
                  className={`esc-item${locked ? ' esc-locked' : ''}${revoked ? ' esc-revoked' : ''}${isNew ? ' esc-item-new' : ''}`}
                >
                  <div className="esc-item-head">
                    <b>{s.label}</b>
                    <em>{locked ? 'LOCKED' : revoked ? 'NULL' : `${value}%`}</em>
                  </div>
                  <input
                    type="range"
                    className="esc-slider"
                    min={lim.min}
                    max={lim.max}
                    step="1"
                    value={value}
                    disabled={locked || revoked}
                    aria-label={s.label}
                    style={{ '--esc-fill': `${fill}%` }}
                    onChange={(event) => store.set(s.key, Number(event.target.value))}
                    // 게임은 패널이 열려도 진행된다 — 슬라이더에 포커스가 남으면
                    // 방향키 이동(고정 별칭 ←/→/↑) 때마다 설정값이 함께 흘러간다.
                    // 마우스 조작이 끝나면 포커스를 풀고, 키 입력이 오면 즉시 포커스를
                    // 해제해 이후의 키가 게임에만 전달되게 한다.
                    // (preventDefault는 금지 — Phaser가 defaultPrevented 키를 무시해
                    //  슬라이더 포커스 중 이동/점프가 죽는다.)
                    onPointerUp={(event) => event.currentTarget.blur()}
                    onKeyDown={(event) => event.currentTarget.blur()}
                  />
                  <small>{s.ko}</small>
                  {revoked && <span className="esc-revoked-stamp">REVOKED BY ADMIN</span>}
                </div>
              );
            })}
          </>
        )}

        {activeTab === 'controls' && (
          <div className="esc-controls">
            <div className="esc-sect">INPUT MAP</div>
            {ACTIONS.map((a) => {
              const bound = st.bindings[a.key];
              const unbound = bound == null;
              const capturing = capture !== null && capture.action === a.key;
              return (
                <div
                  key={a.key}
                  className={`esc-krow${capturing ? ' esc-capturing' : ''}${unbound && a.key === 'dash' ? ' esc-unbound' : ''}`}
                >
                  <div className="esc-krow-name">
                    <b>{a.label}</b>
                    <small>{a.ko}</small>
                  </div>
                  {capturing ? (
                    <div className="esc-capture">
                      {captureError && (
                        <em key={errTick} className="esc-reject">
                          {captureError}
                        </em>
                      )}
                      <span className="esc-capture-blink">PRESS ANY KEY</span>
                      <small>ESC 취소</small>
                    </div>
                  ) : (
                    <div className="esc-krow-val">
                      <kbd className={unbound ? 'esc-kbd-unbound' : ''}>{unbound ? 'UNBOUND' : bound}</kbd>
                      <button
                        type="button"
                        className="esc-mini"
                        onClick={() => {
                          setCaptureError(null);
                          setCapture({ action: a.key });
                        }}
                      >
                        [변경]
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
            <p className="esc-controls-note">
              {st.bindings.dash == null ? 'DASH — 키를 지정하라.' : 'ALL SYSTEMS BOUND'}
            </p>
          </div>
        )}
      </div>

      <footer className="esc-foot">
        <span>ESC — CLOSE</span>
        <span>변경은 즉시 세계에 적용된다</span>
      </footer>

      {cracked && <div className={`esc-cracks esc-cracks-l${crackLevel}`} aria-hidden="true" />}
    </aside>
  );
}

export default SettingsPanel;
export { SettingsPanel };
