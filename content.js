// Cognify - Content Script
// Tracks backspace ratio, mouse jitter, scroll velocity, and typing activity

(function () {
  'use strict';

  // ─── State ────────────────────────────────────────────────────────────────
  let keyLog = [];   // { time, isBackspace }
  let mouseLog = [];   // { time, x, y }
  let scrollLog = [];   // { time, y } — page scroll positions
  let enabled = true;

  // ─── Keyboard Tracking ────────────────────────────────────────────────────
  document.addEventListener('keydown', (e) => {
    if (!enabled) return;
    const now = Date.now();
    keyLog.push({ time: now, isBackspace: e.key === 'Backspace' });
    const cutoff = now - 60000;
    keyLog = keyLog.filter(k => k.time > cutoff);
  }, true);

  // ─── Mouse Tracking ───────────────────────────────────────────────────────
  let lastMouseSample = 0;
  document.addEventListener('mousemove', (e) => {
    if (!enabled) return;
    const now = Date.now();
    if (now - lastMouseSample < 100) return;
    lastMouseSample = now;
    mouseLog.push({ time: now, x: e.clientX, y: e.clientY });
    const cutoff = now - 15000;
    mouseLog = mouseLog.filter(m => m.time > cutoff);
  }, true);

  // ─── Scroll Tracking ──────────────────────────────────────────────────────
  // Records scroll positions so we can compute velocity (px/sec).
  // Slow scroll (<150px/s) = reading. Fast scroll = aimless browsing.
  document.addEventListener('scroll', () => {
    if (!enabled) return;
    scrollLog.push({ time: Date.now(), y: window.scrollY });
    const cutoff = Date.now() - 10000;
    scrollLog = scrollLog.filter(s => s.time > cutoff);
  }, true);

  // ─── Compute Backspace Ratio ──────────────────────────────────────────────
  function computeBackspaceRatio() {
    if (keyLog.length < 2) return 0;
    const backspaces = keyLog.filter(k => k.isBackspace).length;
    return backspaces / keyLog.length;
  }

  // ─── Compute Mouse Jitter Score ───────────────────────────────────────────
  function computeMouseJitter() {
    if (mouseLog.length < 3) return 0;
    let totalAngleChange = 0, count = 0;
    for (let i = 2; i < mouseLog.length; i++) {
      const p0 = mouseLog[i - 2], p1 = mouseLog[i - 1], p2 = mouseLog[i];
      const dx1 = p1.x - p0.x, dy1 = p1.y - p0.y;
      const dx2 = p2.x - p1.x, dy2 = p2.y - p1.y;
      const mag1 = Math.sqrt(dx1 * dx1 + dy1 * dy1);
      const mag2 = Math.sqrt(dx2 * dx2 + dy2 * dy2);
      if (mag1 < 2 || mag2 < 2) continue;
      const dot = (dx1 * dx2 + dy1 * dy2) / (mag1 * mag2);
      totalAngleChange += Math.acos(Math.max(-1, Math.min(1, dot)));
      count++;
    }
    if (count === 0) return 0;
    return Math.min(10, (totalAngleChange / count) / (Math.PI / 4) * 10);
  }

  // ─── Compute Scroll Velocity (px/sec) ────────────────────────────────────
  function computeScrollVelocity() {
    if (scrollLog.length < 2) return 0;
    const first = scrollLog[0], last = scrollLog[scrollLog.length - 1];
    const deltaY = Math.abs(last.y - first.y);
    const deltaSec = (last.time - first.time) / 1000;
    return deltaSec > 0 ? deltaY / deltaSec : 0;
  }

  // ─── Context Helpers ──────────────────────────────────────────────────────
  // isTypingRecently: productive keystrokes (non-backspace) in last 15s
  function isTypingRecently() {
    const cutoff = Date.now() - 15000;
    return keyLog.some(k => k.time > cutoff && !k.isBackspace);
  }

  // isScrollingRecently: any scroll events in last 10s
  function isScrollingRecently() {
    const cutoff = Date.now() - 10000;
    return scrollLog.some(s => s.time > cutoff);
  }

  // ─── Send Signals to Background ──────────────────────────────────────────
  const signalInterval = setInterval(() => {
    if (!enabled) return;
    try {
      chrome.runtime.sendMessage({
        type: 'CONTENT_SIGNALS',
        backspaceRatio: computeBackspaceRatio(),
        mouseJitter: computeMouseJitter(),
        scrollVelocity: computeScrollVelocity(),
        isTypingRecently: isTypingRecently(),
        isScrollingRecently: isScrollingRecently()
      }).catch(() => { });
    } catch (e) {
      // Extension was reloaded — this content script is orphaned, stop polling
      clearInterval(signalInterval);
    }
  }, 5000);


  // ─── Message Listener ────────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg) => {
    console.log('[Cognify] Message received in content script:', msg.type);
    if (msg.type === 'DISTRACTION_DETECTED') {
      applyDistractionUI(msg.mode);
    }
    if (msg.type === 'CLEAR_INTERVENTIONS') {
      clearDistractionUI();
    }
    if (msg.type === 'SET_ENABLED') {
      enabled = msg.enabled;
      if (!enabled) clearDistractionUI();
    }
  });

  // ─── Distraction UI ──────────────────────────────────────────────────────
  let uiInjected = false;
  let grayscaleStyle = null;
  let notifStyle = null;
  let bannerEl = null;
  let overlayEl = null;
  let autoClearTimer = null;

  function applyDistractionUI(mode) {
    if (uiInjected) return;
    uiInjected = true;

    applyGrayscale();
    hideNotifications();
    injectResetBanner();

    // Auto-clear after 5 minutes
    autoClearTimer = setTimeout(() => clearDistractionUI(), 5 * 60 * 1000);
  }

  function applyGrayscale() {
    grayscaleStyle = document.createElement('style');
    grayscaleStyle.id = 'cognify-grayscale';
    grayscaleStyle.textContent = `
      html {
        filter: grayscale(100%) !important;
        transition: filter 1s ease !important;
      }
    `;
    document.head.appendChild(grayscaleStyle);
  }

  function hideNotifications() {
    notifStyle = document.createElement('style');
    notifStyle.id = 'cognify-hide-notifs';
    notifStyle.textContent = `
      /* YouTube / Google notifications */
      #masthead-ad, ytd-banner-promo-renderer, ytd-statement-banner-renderer,
      /* Gmail promotions bar */
      .bsU .dw, .Bs .bAr,
      /* Generic cookie banners / GDPR */
      [class*="cookie-banner"], [id*="cookie-banner"],
      [class*="gdpr"], [id*="gdpr"],
      [class*="consent"], [id*="consent"],
      /* Social media notifications */
      [aria-label*="notification" i]:not(button),
      [class*="notification-banner"],
      [class*="toast"]:not([class*="focus"]),
      [class*="snackbar"],
      [role="alert"]:not([class*="cognify"]) {
        display: none !important;
        visibility: hidden !important;
      }
    `;
    document.head.appendChild(notifStyle);
  }

  function injectResetBanner() {
    bannerEl = document.createElement('div');
    bannerEl.id = 'cognify-banner';
    bannerEl.innerHTML = `
      <div class="cog-banner-inner">
        <div class="cog-logo">🧠 Cognify</div>
        <div class="cog-message">
          <span class="cog-title">Focus drift detected</span>
          <span class="cog-subtitle">Take a 60-second reset to recharge</span>
        </div>
        <div class="cog-actions">
          <button id="cog-reset-btn">▶ Start Reset</button>
          <button id="cog-dismiss-btn">✕</button>
        </div>
      </div>
      <style>
        #cognify-banner {
          position: fixed;
          top: 0; left: 0; right: 0;
          z-index: 2147483647;
          background: linear-gradient(135deg, #1a0533 0%, #0d1b4b 100%);
          border-bottom: 2px solid #7c3aed;
          font-family: 'Segoe UI', system-ui, sans-serif;
          animation: cog-slide-down 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275);
        }
        @keyframes cog-slide-down {
          from { transform: translateY(-100%); opacity: 0; }
          to   { transform: translateY(0);    opacity: 1; }
        }
        .cog-banner-inner {
          display: flex;
          align-items: center;
          gap: 16px;
          padding: 12px 20px;
          max-width: 100%;
        }
        .cog-logo {
          font-size: 20px;
          font-weight: 700;
          color: #a78bfa;
          white-space: nowrap;
          letter-spacing: 0.5px;
        }
        .cog-message {
          flex: 1;
          display: flex;
          flex-direction: column;
          gap: 2px;
        }
        .cog-title {
          color: #f0e6ff;
          font-size: 14px;
          font-weight: 600;
        }
        .cog-subtitle {
          color: #a78bfa;
          font-size: 12px;
        }
        .cog-actions {
          display: flex;
          gap: 8px;
          align-items: center;
        }
        #cog-reset-btn {
          background: linear-gradient(135deg, #7c3aed, #4f46e5);
          color: white;
          border: none;
          border-radius: 8px;
          padding: 8px 18px;
          font-size: 13px;
          font-weight: 600;
          cursor: pointer;
          white-space: nowrap;
          transition: transform 0.15s, box-shadow 0.15s;
          box-shadow: 0 2px 12px rgba(124,58,237,0.4);
        }
        #cog-reset-btn:hover {
          transform: translateY(-1px);
          box-shadow: 0 4px 20px rgba(124,58,237,0.6);
        }
        #cog-dismiss-btn {
          background: rgba(255,255,255,0.08);
          color: #a78bfa;
          border: 1px solid rgba(167,139,250,0.3);
          border-radius: 8px;
          padding: 7px 12px;
          font-size: 13px;
          cursor: pointer;
          transition: background 0.2s;
        }
        #cog-dismiss-btn:hover { background: rgba(255,255,255,0.15); }
      </style>
    `;
    document.body.appendChild(bannerEl);

    document.getElementById('cog-reset-btn').addEventListener('click', startResetSession);
    document.getElementById('cog-dismiss-btn').addEventListener('click', clearDistractionUI);
  }

  function startResetSession() {
    chrome.runtime.sendMessage({ type: 'RESET_SESSION_STARTED' }).catch(() => { });
    if (bannerEl) bannerEl.remove();
    bannerEl = null;
    injectResetOverlay();
  }

  function injectResetOverlay() {
    overlayEl = document.createElement('div');
    overlayEl.id = 'cognify-overlay';
    let secondsLeft = 60;

    overlayEl.innerHTML = `
      <div class="cog-overlay-box">
        <div class="cog-overlay-logo">🧠 Cognify Reset</div>
        
        <div class="cog-timer-wrapper">
          <div class="cog-progress-ring">
            <svg viewBox="0 0 120 120" width="160" height="160">
              <circle class="cog-ring-bg" cx="60" cy="60" r="54" />
              <circle class="cog-ring-fill" id="cog-ring-fill" cx="60" cy="60" r="54"
                stroke-dasharray="339.292" stroke-dashoffset="0" />
            </svg>
          </div>
          <div class="cog-timer" id="cog-timer">60</div>
        </div>

        <div class="cog-timer-label">seconds</div>
        <p class="cog-instruction">Close your eyes. Take slow, deep breaths.<br>Let your mind reset.</p>
        <button id="cog-skip-btn">Skip Reset</button>
      </div>
      <style>
        #cognify-overlay {
          position: fixed;
          inset: 0;
          z-index: 2147483647;
          background: rgba(10, 5, 30, 0.98);
          display: flex;
          align-items: center;
          justify-content: center;
          animation: cog-fade-in 0.5s ease;
          backdrop-filter: blur(12px);
        }
        @keyframes cog-fade-in {
          from { opacity: 0; } to { opacity: 1; }
        }
        .cog-overlay-box {
          text-align: center;
          color: white;
          font-family: 'Segoe UI', system-ui, sans-serif;
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 20px;
        }
        .cog-overlay-logo {
          font-size: 16px;
          color: #a78bfa;
          font-weight: 700;
          letter-spacing: 2px;
          text-transform: uppercase;
          opacity: 0.8;
        }
        .cog-timer-wrapper {
          position: relative;
          width: 160px;
          height: 160px;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .cog-timer {
          font-size: 64px;
          font-weight: 800;
          color: white;
          line-height: 1;
          margin: 0;
          z-index: 2;
        }
        .cog-timer-label {
          color: #6d7caa;
          font-size: 13px;
          letter-spacing: 3px;
          text-transform: uppercase;
          margin-top: -10px;
        }
        .cog-progress-ring {
          position: absolute;
          inset: 0;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .cog-ring-bg {
          fill: none;
          stroke: rgba(124,58,237,0.1);
          stroke-width: 6;
        }
        .cog-ring-fill {
          fill: none;
          stroke: url(#cog-gradient);
          stroke-width: 6;
          stroke-linecap: round;
          transform: rotate(-90deg);
          transform-origin: 60px 60px;
          transition: stroke-dashoffset 1s linear;
        }
        .cog-instruction {
          color: #94a3b8;
          font-size: 16px;
          line-height: 1.6;
          margin: 0;
          max-width: 280px;
        }
        #cog-skip-btn {
          background: rgba(255,255,255,0.05);
          color: #a78bfa;
          border: 1px solid rgba(167,139,250,0.2);
          border-radius: 12px;
          padding: 12px 32px;
          font-size: 14px;
          font-weight: 600;
          cursor: pointer;
          transition: all 0.2s;
        }
        #cog-skip-btn:hover { 
          background: rgba(255,255,255,0.1);
          border-color: rgba(167,139,250,0.4);
        }
      </style>
    `;
    document.body.appendChild(overlayEl);

    // SVG gradient for ring
    const svg = overlayEl.querySelector('svg');
    const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    defs.innerHTML = `
      <linearGradient id="cog-gradient" x1="0%" y1="0%" x2="100%" y2="0%">
        <stop offset="0%" stop-color="#7c3aed"/>
        <stop offset="100%" stop-color="#3b82f6"/>
      </linearGradient>`;
    svg.prepend(defs);

    const timerEl = overlayEl.querySelector('#cog-timer');
    const ringEl = overlayEl.querySelector('#cog-ring-fill');
    const circumference = 339.292;
    ringEl.style.strokeDashoffset = '0';

    const interval = setInterval(() => {
      secondsLeft--;
      if (timerEl) timerEl.textContent = secondsLeft;
      const progress = (60 - secondsLeft) / 60;
      ringEl.style.strokeDashoffset = circumference * progress;

      if (secondsLeft <= 0) {
        clearInterval(interval);
        chrome.runtime.sendMessage({ type: 'CLOSE_TAB' }).catch(() => { });
        clearDistractionUI();
      }
    }, 1000);

    overlayEl.querySelector('#cog-skip-btn').addEventListener('click', () => {
      clearInterval(interval);
      chrome.runtime.sendMessage({ type: 'CLOSE_TAB' }).catch(() => { });
      clearDistractionUI();
    });
  }

  function clearDistractionUI() {
    if (autoClearTimer) { clearTimeout(autoClearTimer); autoClearTimer = null; }
    if (grayscaleStyle) { grayscaleStyle.remove(); grayscaleStyle = null; }
    if (notifStyle) { notifStyle.remove(); notifStyle = null; }
    if (bannerEl) { bannerEl.remove(); bannerEl = null; }
    if (overlayEl) { overlayEl.remove(); overlayEl = null; }
    uiInjected = false;
  }
})();
