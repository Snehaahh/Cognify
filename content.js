// Cognify - Content Script
// Tracks backspace ratio and mouse erratic movement on every page

(function () {
    'use strict';

    // ─── State ────────────────────────────────────────────────────────────────
    let keyLog = [];          // { time, isBackspace }
    let mouseLog = [];        // { time, x, y } sampled positions
    let enabled = true;

    // ─── Keyboard Tracking (Backspace Ratio) ─────────────────────────────────
    document.addEventListener('keydown', (e) => {
        if (!enabled) return;
        const now = Date.now();
        keyLog.push({ time: now, isBackspace: e.key === 'Backspace' });

        // Rolling 60-second window
        const cutoff = now - 60000;
        keyLog = keyLog.filter(k => k.time > cutoff);
    }, true);

    // ─── Mouse Tracking (Erratic Movement / Jitter) ───────────────────────────
    let lastMouseSample = 0;
    document.addEventListener('mousemove', (e) => {
        if (!enabled) return;
        const now = Date.now();
        if (now - lastMouseSample < 100) return; // Sample at ~10Hz
        lastMouseSample = now;

        mouseLog.push({ time: now, x: e.clientX, y: e.clientY });

        // Rolling 15-second window
        const cutoff = now - 15000;
        mouseLog = mouseLog.filter(m => m.time > cutoff);
    }, true);

    // ─── Compute Backspace Ratio ──────────────────────────────────────────────
    function computeBackspaceRatio() {
        if (keyLog.length < 5) return 0;
        const backspaces = keyLog.filter(k => k.isBackspace).length;
        return backspaces / keyLog.length;
    }

    // ─── Compute Mouse Jitter Score ───────────────────────────────────────────
    // Measures average direction change (angular velocity) — high = erratic
    function computeMouseJitter() {
        if (mouseLog.length < 6) return 0;

        let totalAngleChange = 0;
        let count = 0;

        for (let i = 2; i < mouseLog.length; i++) {
            const p0 = mouseLog[i - 2];
            const p1 = mouseLog[i - 1];
            const p2 = mouseLog[i];

            const dx1 = p1.x - p0.x;
            const dy1 = p1.y - p0.y;
            const dx2 = p2.x - p1.x;
            const dy2 = p2.y - p1.y;

            const mag1 = Math.sqrt(dx1 * dx1 + dy1 * dy1);
            const mag2 = Math.sqrt(dx2 * dx2 + dy2 * dy2);

            if (mag1 < 2 || mag2 < 2) continue; // ignore near-stationary

            const dot = (dx1 * dx2 + dy1 * dy2) / (mag1 * mag2);
            const angle = Math.acos(Math.max(-1, Math.min(1, dot)));
            totalAngleChange += angle;
            count++;
        }

        if (count === 0) return 0;
        const avgAngle = totalAngleChange / count; // radians
        // Normalize to 0–10 scale (π/4 = jitter threshold for score of 10)
        return Math.min(10, (avgAngle / (Math.PI / 4)) * 10);
    }

    // ─── Send Signals to Background ──────────────────────────────────────────
    setInterval(() => {
        if (!enabled) return;
        const backspaceRatio = computeBackspaceRatio();
        const mouseJitter = computeMouseJitter();

        chrome.runtime.sendMessage({
            type: 'CONTENT_SIGNALS',
            backspaceRatio,
            mouseJitter
        }).catch(() => { });
    }, 5000);

    // ─── Message Listener ────────────────────────────────────────────────────
    chrome.runtime.onMessage.addListener((msg) => {
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
        <div class="cog-timer" id="cog-timer">60</div>
        <div class="cog-timer-label">seconds</div>
        <p class="cog-instruction">Close your eyes. Take slow, deep breaths.<br>Let your mind reset.</p>
        <div class="cog-progress-ring">
          <svg viewBox="0 0 120 120" width="120" height="120">
            <circle class="cog-ring-bg" cx="60" cy="60" r="54" />
            <circle class="cog-ring-fill" id="cog-ring-fill" cx="60" cy="60" r="54"
              stroke-dasharray="339.292" stroke-dashoffset="0" />
          </svg>
        </div>
        <button id="cog-skip-btn">Skip Reset</button>
      </div>
      <style>
        #cognify-overlay {
          position: fixed;
          inset: 0;
          z-index: 2147483647;
          background: rgba(10, 5, 30, 0.97);
          display: flex;
          align-items: center;
          justify-content: center;
          animation: cog-fade-in 0.5s ease;
          backdrop-filter: blur(8px);
        }
        @keyframes cog-fade-in {
          from { opacity: 0; } to { opacity: 1; }
        }
        .cog-overlay-box {
          text-align: center;
          color: white;
          font-family: 'Segoe UI', system-ui, sans-serif;
          position: relative;
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 12px;
        }
        .cog-overlay-logo {
          font-size: 18px;
          color: #a78bfa;
          font-weight: 700;
          letter-spacing: 1px;
          margin-bottom: 8px;
        }
        .cog-timer {
          font-size: 80px;
          font-weight: 800;
          color: #c4b5fd;
          line-height: 1;
          background: linear-gradient(135deg, #a78bfa, #60a5fa);
          -webkit-background-clip: text;
          -webkit-text-fill-color: transparent;
          position: absolute;
          top: 50%;
          left: 50%;
          transform: translate(-50%, -50%);
          width: 120px;
          text-align: center;
          margin-top: 80px;
        }
        .cog-timer-label {
          color: #6d7caa;
          font-size: 13px;
          letter-spacing: 2px;
          text-transform: uppercase;
          margin-top: 145px;
        }
        .cog-progress-ring {
          position: relative;
          margin: 10px 0;
        }
        .cog-ring-bg {
          fill: none;
          stroke: rgba(124,58,237,0.15);
          stroke-width: 8;
        }
        .cog-ring-fill {
          fill: none;
          stroke: url(#cog-gradient);
          stroke-width: 8;
          stroke-linecap: round;
          transform: rotate(-90deg);
          transform-origin: 60px 60px;
          transition: stroke-dashoffset 1s linear;
        }
        .cog-instruction {
          color: #94a3b8;
          font-size: 15px;
          line-height: 1.6;
          margin: 0;
          max-width: 300px;
        }
        #cog-skip-btn {
          background: rgba(255,255,255,0.07);
          color: #a78bfa;
          border: 1px solid rgba(167,139,250,0.3);
          border-radius: 8px;
          padding: 10px 24px;
          font-size: 13px;
          cursor: pointer;
          margin-top: 8px;
          transition: background 0.2s;
        }
        #cog-skip-btn:hover { background: rgba(255,255,255,0.14); }
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
                clearDistractionUI();
            }
        }, 1000);

        overlayEl.querySelector('#cog-skip-btn').addEventListener('click', () => {
            clearInterval(interval);
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
