// Cognify - Background Service Worker
// Handles tab switching, idle detection, distraction scoring, and mode thresholds

// ─── Mode Thresholds ─────────────────────────────────────────────────────────
// driftSignals   : how many signals must fire simultaneously to ENTER distracted state
// recoverySignals: how many signals must remain active to STAY in distracted state
//                  (must be strictly less than driftSignals — this is the hysteresis gap)
const MODE_THRESHOLDS = {
    'deep-work': { idleSecs: 15, tabSwitchPerMin: 2, driftSignals: 2, recoverySignals: 0 },
    'research': { idleSecs: 45, tabSwitchPerMin: 8, driftSignals: 2, recoverySignals: 0 },
    'casual': { idleSecs: 90, tabSwitchPerMin: 12, driftSignals: 2, recoverySignals: 0 }
};

// ─── State ────────────────────────────────────────────────────────────────────
let state = {
    enabled: true,
    mode: 'deep-work',
    tabSwitches: [],        // timestamps of recent tab switches
    isIdle: false,
    idleStartTime: null,
    distractionScore: 0,
    lastScoreDecay: Date.now(),
    contentSignals: {       // received from content.js
        backspaceRatio: 0,
        mouseJitter: 0
    },
    distractionActive: false,
    stats: {
        date: new Date().toDateString(),
        distractionsDetected: 0,
        resetSessions: 0,
        totalIdleSeconds: 0
    }
};

// ─── Init ─────────────────────────────────────────────────────────────────────
async function init() {
    const stored = await chrome.storage.local.get(['enabled', 'focusMode', 'stats']);
    if (stored.enabled !== undefined) state.enabled = stored.enabled;
    if (stored.focusMode) state.mode = stored.focusMode;

    // Reset stats if it's a new day
    if (stored.stats && stored.stats.date === new Date().toDateString()) {
        state.stats = stored.stats;
    } else {
        await saveStats();
    }

    // Start periodic scoring
    setInterval(runScoringCycle, 5000);
    setInterval(decayScore, 10000);

    // Idle detection
    chrome.idle.setDetectionInterval(15);
    chrome.idle.onStateChanged.addListener(handleIdleStateChange);
}

// ─── Tab Switch Tracking ──────────────────────────────────────────────────────
chrome.tabs.onActivated.addListener(() => {
    if (!state.enabled) return;
    state.tabSwitches.push(Date.now());
    // Keep only last 60 seconds of switches
    const cutoff = Date.now() - 60000;
    state.tabSwitches = state.tabSwitches.filter(t => t > cutoff);
});

// ─── Idle Detection ───────────────────────────────────────────────────────────
function handleIdleStateChange(newState) {
    if (!state.enabled) return;
    if (newState === 'idle' || newState === 'locked') {
        state.isIdle = true;
        state.idleStartTime = Date.now();
    } else {
        if (state.isIdle && state.idleStartTime) {
            const seconds = Math.floor((Date.now() - state.idleStartTime) / 1000);
            state.stats.totalIdleSeconds += seconds;
        }
        state.isIdle = false;
        state.idleStartTime = null;
    }
}

// ─── Score Decay ──────────────────────────────────────────────────────────────
function decayScore() {
    const halfLifeMs = 30000;
    const elapsed = Date.now() - state.lastScoreDecay;
    const decayFactor = Math.pow(0.5, elapsed / halfLifeMs);
    state.distractionScore = Math.max(0, state.distractionScore * decayFactor);
    state.lastScoreDecay = Date.now();
}

// ─── Scoring Cycle ────────────────────────────────────────────────────────────
// Multi-signal validation: distraction only triggers when 2+ signals fire simultaneously.
// No single signal alone can cause an intervention — this eliminates noise.
async function runScoringCycle() {
    if (!state.enabled) return;

    const thresholds = MODE_THRESHOLDS[state.mode] || MODE_THRESHOLDS['deep-work'];

    // Evaluate each signal independently (true/false per signal)
    const cutoff = Date.now() - 60000;
    const recentSwitches = state.tabSwitches.filter(t => t > cutoff).length;

    const idleSecs = (state.isIdle && state.idleStartTime)
        ? (Date.now() - state.idleStartTime) / 1000
        : 0;

    const signals = {
        idle: idleSecs >= thresholds.idleSecs,
        tabSwitch: recentSwitches >= thresholds.tabSwitchPerMin,
        backspace: state.contentSignals.backspaceRatio > 0.25,
        jitter: state.contentSignals.mouseJitter > 5
    };

    // Count how many signals are currently active
    const activeCount = Object.values(signals).filter(Boolean).length;

    // Build a display score (0–10) based on active signals for the popup
    const scorePerSignal = { idle: 2, tabSwitch: 3, backspace: 2, jitter: 3 };
    const rawScore = Object.entries(signals)
        .filter(([, active]) => active)
        .reduce((sum, [key]) => sum + scorePerSignal[key], 0);

    state.distractionScore = Math.min(10, rawScore);

    // ── Hysteresis gate ───────────────────────────────────────────────────────
    // Drift   : enter distracted state only when DRIFT threshold is met
    // Recovery: exit distracted state only when RECOVERY threshold is met
    // The gap between the two prevents rapid flipping near the boundary.
    const driftThreshold = thresholds.driftSignals;    // e.g. 2
    const recoveryThreshold = thresholds.recoverySignals; // e.g. 0

    if (!state.distractionActive && activeCount >= driftThreshold) {
        // ── ENTER distracted state ────────────────────────────────────────────
        state.distractionActive = true;
        state.stats.distractionsDetected++;
        await saveStats();
        triggerDistraction();
    } else if (state.distractionActive && activeCount <= recoveryThreshold) {
        // ── RECOVER — only after signals drop well below the drift threshold ──
        state.distractionActive = false;
    }
    // If activeCount is strictly between recoveryThreshold and driftThreshold,
    // state is locked — no change. This is the intentional hysteresis band.

    // Broadcast metrics to popup
    broadcastMetrics(thresholds, recentSwitches, signals, activeCount);
}

// ─── Trigger Distraction on Active Tab ───────────────────────────────────────
async function triggerDistraction() {
    try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab && tab.id) {
            chrome.tabs.sendMessage(tab.id, { type: 'DISTRACTION_DETECTED', mode: state.mode });
        }
    } catch (e) {
        // Tab may not have content script (e.g. chrome:// pages)
    }
}

// ─── Broadcast Metrics ───────────────────────────────────────────────────────
function broadcastMetrics(thresholds, recentSwitches, signals = {}, activeCount = 0) {
    const metrics = {
        type: 'METRICS_UPDATE',
        score: Math.round(state.distractionScore * 10) / 10,
        scoreTrigger: thresholds.scoreTrigger,
        isDistracted: state.distractionActive,
        activeSignalCount: activeCount,
        signals,                              // { idle, tabSwitch, backspace, jitter }
        tabSwitches: recentSwitches,
        tabSwitchLimit: thresholds.tabSwitchPerMin,
        isIdle: state.isIdle,
        idleSecs: state.isIdle && state.idleStartTime
            ? Math.floor((Date.now() - state.idleStartTime) / 1000)
            : 0,
        idleThreshold: thresholds.idleSecs,
        backspaceRatio: Math.round(state.contentSignals.backspaceRatio * 100),
        mouseJitter: Math.round(state.contentSignals.mouseJitter * 10) / 10,
        mode: state.mode,
        enabled: state.enabled,
        stats: state.stats
    };

    chrome.runtime.sendMessage(metrics).catch(() => { });
}

// ─── Message Handler ──────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    switch (msg.type) {
        case 'CONTENT_SIGNALS':
            state.contentSignals.backspaceRatio = msg.backspaceRatio || 0;
            state.contentSignals.mouseJitter = msg.mouseJitter || 0;
            break;

        case 'RESET_SESSION_STARTED':
            state.stats.resetSessions++;
            state.distractionScore = 0;
            state.distractionActive = false;
            saveStats();
            break;

        case 'SET_MODE':
            state.mode = msg.mode;
            state.distractionScore = 0;
            state.distractionActive = false;
            chrome.storage.local.set({ focusMode: msg.mode });
            break;

        case 'SET_ENABLED':
            state.enabled = msg.enabled;
            chrome.storage.local.set({ enabled: msg.enabled });
            if (!msg.enabled) {
                // Tell active tab to clear interventions
                chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
                    if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: 'CLEAR_INTERVENTIONS' }).catch(() => { });
                });
            }
            break;

        case 'GET_METRICS':
            const thresholds = MODE_THRESHOLDS[state.mode] || MODE_THRESHOLDS['deep-work'];
            const cutoff = Date.now() - 60000;
            const switches = state.tabSwitches.filter(t => t > cutoff).length;
            broadcastMetrics(thresholds, switches);
            break;
    }
});

// ─── Storage ──────────────────────────────────────────────────────────────────
async function saveStats() {
    state.stats.date = new Date().toDateString();
    await chrome.storage.local.set({ stats: state.stats });
}

// ─── Start ────────────────────────────────────────────────────────────────────
init();
