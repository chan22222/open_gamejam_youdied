import { useEffect, useRef, useState } from 'react';
import { createGame } from './game/createGame.js';
import { EV, emit, on } from './game/events.js';
import { store, effective } from './game/settingsStore.js';
import { audio } from './game/audio.js';
import SettingsPanel from './ui/SettingsPanel.jsx';

// ---------------------------------------------------------------------------
// ESC/APE — React 셸 (A4 ui-shell)
// Phaser가 세계를 소유하고, 이 셸은 CRT 프레임/HUD/타이틀/엔딩만 담당한다.
// 설정 UI는 전부 SettingsPanel(A1)의 몫 — 여기서는 항상 마운트만 한다.
// ---------------------------------------------------------------------------

const INITIAL_UI = {
  mode: 'title',
  chapter: 'SYSTEM BOOT',
  objective: '죽음으로 권한을 증명하라.',
  rule: 'NO PERMISSIONS',
  deaths: 0,
  hint: '',
};

const KO_COUNT = [
  '영', '한', '두', '세', '네', '다섯', '여섯', '일곱', '여덟', '아홉', '열',
  '열한', '열두', '열세', '열네', '열다섯', '열여섯', '열일곱', '열여덟', '열아홉', '스무',
];

/** 7 → "일곱 번", 23 → "23번" */
function koBuilds(n) {
  const count = Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
  return count <= 20 ? `${KO_COUNT[count]} 번` : `${count}번`;
}

function readShell() {
  const state = store.getState();
  return {
    bindings: { ...state.bindings },
    panelOpen: state.panelOpen,
    corrupted: state.corrupted,
    brightness: effective('brightness'),
  };
}

export default function App() {
  const gameHost = useRef(null);
  const modeRef = useRef(INITIAL_UI.mode);
  const timersRef = useRef({ static: 0, restore: 0 });

  const [ui, setUi] = useState(INITIAL_UI);
  const [shell, setShell] = useState(readShell);
  const [launching, setLaunching] = useState(false);
  const [hitSeq, setHitSeq] = useState(0);
  const [bossFx, setBossFx] = useState(null); // null | 'corrupt' | 'shatter' | 'restored'
  const [staticOn, setStaticOn] = useState(false);
  const [hintLen, setHintLen] = useState(0);
  const [hintFade, setHintFade] = useState(true);
  const [frameAlert, setFrameAlert] = useState(false);
  const [wobbleSeq, setWobbleSeq] = useState(0);
  const frameFxCount = useRef(0); // 리사이즈 장난 발동 횟수 (세션당 최대 2)

  modeRef.current = ui.mode;

  // --- Phaser 게임 + 게임→셸 이벤트 배선 ------------------------------------
  useEffect(() => {
    const timers = timersRef.current;
    const game = createGame(gameHost.current);

    // events.on()은 리스너를 fn(detail, event) 형태로 호출한다 — 첫 인자가 payload.
    const offState = on(EV.STATE, (detail) => {
      const next = detail || {};
      setUi((current) => ({ ...current, ...next }));
    });

    const offHit = on(EV.PANEL_HIT, () => {
      setHitSeq((seq) => seq + 1);
    });

    const offBoss = on(EV.BOSS, (detail) => {
      const phase = detail?.phase;
      if (phase === 'corrupt') {
        setBossFx('corrupt');
      } else if (phase === 'shatter') {
        setBossFx('shatter');
        clearTimeout(timers.static);
        setStaticOn(true);
        timers.static = setTimeout(() => setStaticOn(false), 900);
      } else if (phase === 'restored') {
        setBossFx('restored');
        clearTimeout(timers.restore);
        timers.restore = setTimeout(() => setBossFx(null), 1500);
      }
    });

    return () => {
      offState();
      offHit();
      offBoss();
      clearTimeout(timers.static);
      clearTimeout(timers.restore);
      game.destroy(true);
    };
  }, []);

  // --- 설정 스토어 구독 (밝기 필터 / 바인딩 푸터 / 패널 상태) ----------------
  useEffect(() => store.subscribe(() => setShell(readShell())), []);

  // --- ESC = 세계 파라미터 토글 ---------------------------------------------
  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key !== 'Escape' || event.repeat) return;
      const mode = modeRef.current;
      if (mode === 'title' || mode === 'ending') return;
      event.preventDefault();
      audio.sfx('ui');
      store.set('panelOpen', !store.getState().panelOpen);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // --- 브라우저 창 리사이즈 = 외부의 프레임 편집 (세션당 2회) ----------------
  useEffect(() => {
    let debounce = 0;
    let hide = 0;
    const onResize = () => {
      if (frameFxCount.current >= 2) return;
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        if (frameFxCount.current >= 2) return;
        frameFxCount.current += 1;
        setWobbleSeq((seq) => seq + 1);
        setFrameAlert(true);
        audio.sfx('ui');
        clearTimeout(hide);
        hide = setTimeout(() => setFrameAlert(false), 3000);
      }, 400);
    };
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      clearTimeout(debounce);
      clearTimeout(hide);
    };
  }, []);

  // --- 씬 전환에 맞춘 셸 정리 -----------------------------------------------
  useEffect(() => {
    if (ui.mode !== 'title') setLaunching(false);
    if (ui.mode === 'title' || ui.mode === 'ending') {
      setBossFx(null);
      setStaticOn(false);
    }
  }, [ui.mode]);

  // --- 힌트 타자기 -----------------------------------------------------------
  useEffect(() => {
    const text = typeof ui.hint === 'string' ? ui.hint : '';
    setHintLen(0);
    if (!text) {
      setHintFade(true);
      return undefined;
    }
    setHintFade(false);
    let i = 0;
    const typing = setInterval(() => {
      i += 1;
      setHintLen(i);
      if (i % 3 === 1) audio.sfx('type');
      if (i >= text.length) clearInterval(typing);
    }, 26);
    const fade = setTimeout(() => setHintFade(true), 26 * text.length + 6500);
    return () => {
      clearInterval(typing);
      clearTimeout(fade);
    };
  }, [ui.hint]);

  // --- 액션 ------------------------------------------------------------------
  const startGame = () => {
    if (launching) return;
    setLaunching(true);
    audio.init();
    audio.sfx('ui');
    emit(EV.START);
  };

  const restartGame = () => {
    audio.sfx('ui');
    emit(EV.RESTART);
  };

  const togglePanel = () => {
    audio.sfx('ui');
    store.set('panelOpen', !store.getState().panelOpen);
  };

  // --- 파생 값 ---------------------------------------------------------------
  const inGame = ui.mode !== 'title' && ui.mode !== 'ending';
  const bindings = shell.bindings || {};
  const hintText = typeof ui.hint === 'string' ? ui.hint : '';
  const viewportFilter = `brightness(${(0.75 + (0.25 * shell.brightness) / 100).toFixed(4)})`;

  const appClass = [
    'app',
    `mode-${ui.mode}`,
    bossFx ? `fx-${bossFx}` : '',
    shell.panelOpen ? 'panel-open' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const shellClass = ['game-shell', hitSeq > 0 ? `hit-${hitSeq % 2}` : '']
    .filter(Boolean)
    .join(' ');

  const viewportClass = ['viewport-wrap', wobbleSeq > 0 ? `wobble-${wobbleSeq % 2}` : '']
    .filter(Boolean)
    .join(' ');

  return (
    <main className={appClass}>
      <div className="ambient ambient-a" />
      <div className="ambient ambient-b" />

      <section className={shellClass} aria-label="ESC/APE 게임 화면">
        <header className="hud hud-top">
          <div className="brand-lockup">
            <span className="brand-mark">ESC</span>
            <div>
              <strong>
                ESC<i>/</i>APE
              </strong>
              <span>{ui.chapter}</span>
            </div>
          </div>

          <div className="rule-readout">
            <span>CURRENT RULE</span>
            <strong>{ui.rule}</strong>
          </div>

          {inGame ? (
            <button
              type="button"
              className={`system-button ${shell.panelOpen ? 'is-open' : ''}`}
              onClick={togglePanel}
            >
              SYS://CONFIG <kbd>ESC</kbd>
            </button>
          ) : (
            <span className="system-button is-ghost">SYS://LOCKED</span>
          )}
        </header>

        <div className={viewportClass} style={{ filter: viewportFilter }}>
          <div className="viewport" ref={gameHost} />
          <div className="vignette" />
          <div className="scanlines" />
          <div className="corner corner-tl" />
          <div className="corner corner-tr" />
          <div className="corner corner-bl" />
          <div className="corner corner-br" />

          {staticOn && <div className="static-flash" aria-hidden="true" />}
          {bossFx === 'restored' && <div className="stabilize-sweep" aria-hidden="true" />}

          {frameAlert && (
            <div className="hint-bar is-frame" role="status">
              <span className="hint-mark">!!</span>
              <span className="hint-text">EXTERNAL FRAME EDIT DETECTED</span>
            </div>
          )}

          {!frameAlert && hintText && (
            <div className={`hint-bar ${hintFade ? 'is-fading' : ''}`} role="status">
              <span className="hint-mark">&gt;&gt;</span>
              <span className="hint-text">{hintText.slice(0, hintLen)}</span>
              <span className="hint-caret" aria-hidden="true" />
            </div>
          )}

          {ui.mode === 'title' && (
            <div className="title-screen">
              <h1 className="logo" aria-label="ESC/APE">
                <span className="logo-key">ESC</span>
                <span className="logo-ape" aria-hidden="true">
                  <span className="logo-cap">A</span>
                  <span className="logo-cap">P</span>
                  <span className="logo-cap">E</span>
                </span>
              </h1>
              <button type="button" className="primary-action" onClick={startGame} disabled={launching}>
                <span>{launching ? 'LOADING...' : 'RUN'}</span>
                <i>→</i>
              </button>
              <div className="title-controls" aria-label="조작 안내">
                <span className="tc">
                  <kbd>A/D</kbd>이동
                </span>
                <span className="tc">
                  <kbd>SPACE</kbd>점프
                </span>
                <span className="tc tc-esc">
                  <kbd>ESC</kbd>설정
                </span>
              </div>
              <small>NO PERMISSIONS — 죽음으로 증명하라.</small>
            </div>
          )}

          {ui.mode === 'ending' && (
            <div className="ending-band">
              <span className="ending-eyebrow">RUN ARCHIVED — YOU.</span>
              <div className="ending-stat">
                <strong>DEATHS: {String(ui.deaths ?? 0).padStart(2, '0')}</strong>
                <em>— {koBuilds(ui.deaths ?? 0)}의 건축.</em>
              </div>
              <p>당신은 실패하지 않았다. 실패를 쌓아 올렸다.</p>
              <button type="button" className="primary-action" onClick={restartGame}>
                <span>REWRITE AGAIN</span>
                <i>→</i>
              </button>
            </div>
          )}

          <SettingsPanel />
        </div>

        <footer className="hud hud-bottom">
          <div className="objective">
            <span>DIRECTIVE</span>
            <strong>{ui.objective}</strong>
          </div>

          <div className="controls" aria-label="조작법">
            <kbd>{`${bindings.left ?? 'A'} ${bindings.right ?? 'D'}`}</kbd>
            <span>이동</span>
            <kbd>{bindings.jump ?? 'SPACE'}</kbd>
            <span>점프</span>
            <kbd>{bindings.interact ?? 'E'}</kbd>
            <span>상호작용</span>
            <kbd>{bindings.disguise ?? 'Q'}</kbd>
            <span>위장</span>
            {bindings.dash && (
              <>
                <kbd className="kbd-dash">{bindings.dash}</kbd>
                <span className="lbl-dash">대시</span>
              </>
            )}
            <kbd className="kbd-esc">ESC</kbd>
            <span className="lbl-esc">설정</span>
          </div>

          <div className="death-count">
            <span>DEATHS</span>
            <strong>{String(ui.deaths ?? 0).padStart(2, '0')}</strong>
          </div>
        </footer>
      </section>
    </main>
  );
}
