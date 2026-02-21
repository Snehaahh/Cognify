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

// ─── Domain Classification ────────────────────────────────────────────────────
// Built-in lists
const BUILTIN_PRODUCTIVE = new Set([
    'coursera.org', 'udemy.com', 'khanacademy.org', 'edx.org', 'brilliant.org',
    'skillshare.com', 'pluralsight.com', 'duolingo.com',
    'scholar.google.com', 'wikipedia.org', 'arxiv.org', 'pubmed.ncbi.nlm.nih.gov',
    'jstor.org', 'researchgate.net', 'semanticscholar.org', 'sciencedirect.com',
    'springer.com', 'nature.com', 'ieee.org', 'acm.org',
    'github.com', 'stackoverflow.com', 'developer.mozilla.org', 'docs.microsoft.com',
    'devdocs.io', 'w3schools.com', 'leetcode.com', 'hackerrank.com', 'codepen.io',
    'replit.com', 'codesandbox.io', 'vercel.com', 'netlify.com',
    'notion.so', 'obsidian.md', 'roamresearch.com', 'trello.com', 'jira.atlassian.com',
    'figma.com', 'miro.com', 'docs.google.com', 'drive.google.com', 'slides.google.com',
    'bbc.com', 'reuters.com', 'apnews.com', 'theguardian.com'
]);

const BUILTIN_DISTRACTION = new Set([
    'instagram.com', 'facebook.com', 'twitter.com', 'x.com', 'threads.net',
    'snapchat.com', 'tiktok.com', 'tumblr.com', 'pinterest.com', 'bereal.com',
    'youtube.com', 'twitch.tv', 'netflix.com', 'primevideo.com', 'disneyplus.com',
    'hulu.com', 'hbomax.com', 'peacocktv.com', 'crunchyroll.com', 'dailymotion.com',
    'reddit.com', '9gag.com', 'ifunny.co', 'buzzfeed.com', 'boredpanda.com',
    'store.steampowered.com', 'ign.com', 'gamespot.com',
    'whatsapp.com', 'web.telegram.org', 'discord.com'
]);

// User-customizable lists (loaded from chrome.storage)
let customProductive = new Set();
let customDistraction = new Set();

async function loadCustomDomains() {
    const stored = await chrome.storage.local.get(['customProductive', 'customDistraction']);
    customProductive = new Set(stored.customProductive || []);
    customDistraction = new Set(stored.customDistraction || []);
}

function classifyDomain(url) {
    if (!url) return 'UNKNOWN';
    try {
        const host = new URL(url).hostname.replace(/^www\./, '');
        let result = 'UNKNOWN';
        // Custom lists take highest priority (user always wins)
        if (customDistraction.has(host)) result = 'DISTRACTION';
        else if (customProductive.has(host)) result = 'PRODUCTIVE';
        // Then check built-in lists
        else if (BUILTIN_DISTRACTION.has(host)) result = 'DISTRACTION';
        else {
            for (const d of BUILTIN_PRODUCTIVE) {
                if (host === d || host.endsWith('.' + d)) { result = 'PRODUCTIVE'; break; }
            }
        }
        // Academic TLDs
        if (result === 'UNKNOWN' && (host.endsWith('.edu') || host.endsWith('.ac.in') ||
            host.endsWith('.ac.uk') || host.endsWith('.gov'))) result = 'PRODUCTIVE';
        console.log(`[Cognify] classifyDomain: ${host} → ${result}`);
        return result;
    } catch {
        return 'UNKNOWN';
    }
}

// Dwell time threshold (seconds) before distraction site triggers on its own
const DISTRACTION_DWELL_SECS = 30;

// ─── State ────────────────────────────────────────────────────────────────────
let state = {
    enabled: true,
    mode: 'deep-work',
    tabSwitches: [],
    isIdle: false,
    idleStartTime: null,
    distractionScore: 0,
    lastScoreDecay: Date.now(),
    contentSignals: {
        backspaceRatio: 0,
        mouseJitter: 0,
        scrollVelocity: 0,
        isTypingRecently: false,
        isScrollingRecently: false
    },
    // Temporal confirmation: stores last N activity classifications
    // Distraction only fires when the last CONFIRM_CYCLES are all 'DISTRACTED'
    classificationHistory: [],
    // Tab content classification
    previousTabCategory: 'UNKNOWN',
    currentTabCategory: 'UNKNOWN',
    directDistractionSwitch: false,
    distractionDwellStart: null,       // timestamp when user entered a distraction site
    distractionTabId: null,            // tab ID of the distraction site (always send interventions here)
    distractionActive: false,
    stats: {
        date: new Date().toDateString(),
        distractionsDetected: 0,
        resetSessions: 0,
        totalIdleSeconds: 0
    }
};

// How many consecutive DISTRACTED cycles before triggering (each cycle = 5s)
const CONFIRM_CYCLES = 2;

// ─── Init ─────────────────────────────────────────────────────────────────────
async function init() {
    await loadCustomDomains();
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

// ─── Tab Switch Tracking + Content Classification ────────────────────────────
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
    if (!state.enabled) return;
    state.tabSwitches.push(Date.now());
    const cutoff = Date.now() - 60000;
    state.tabSwitches = state.tabSwitches.filter(t => t > cutoff);

    try {
        const tab = await chrome.tabs.get(tabId);
        updateTabCategory(tabId, tab.url);
    } catch (e) { }
});

// ─── URL Change Detection (same-tab navigation) ─────────────────────────────
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (!state.enabled || !tab.active) return;
    if (changeInfo.status === 'complete' || changeInfo.url) {
        updateTabCategory(tabId, tab.url);
    }
});

async function updateTabCategory(tabId, url) {
    if (!url) return;
    const newCategory = classifyDomain(url);
    const wasProductive = state.currentTabCategory === 'PRODUCTIVE';

    // Detect category change
    if (newCategory !== state.currentTabCategory) {
        state.previousTabCategory = state.currentTabCategory;
        state.currentTabCategory = newCategory;

        if (newCategory === 'DISTRACTION') {
            state.distractionDwellStart = Date.now();
            state.distractionTabId = tabId;
            console.log(`[Cognify] Distraction detected on tab ${tabId}: ${url}`);

            // Immediate trigger if switching from productive
            if (wasProductive && !state.distractionActive) {
                console.log('[Cognify] Productive->Distraction switch! Prompt intervention.');
                state.distractionActive = true;
                state.stats.distractionsDetected++;
                saveStats();
                triggerDistraction();
            }
        } else {
            state.distractionDwellStart = null;
        }
    } else if (newCategory === 'DISTRACTION') {
        // Same category (still distraction), but tab might have changed
        state.distractionTabId = tabId;
    }
}

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

// ─── Activity Classifier ──────────────────────────────────────────────────────
// Infers what the user is actually doing before deciding signals are meaningful.
// Returns one of: 'DEEP_FOCUS' | 'READING' | 'WORKING' | 'DISTRACTED' | 'UNCERTAIN'
//
// Context rules (suppress false positives):
//   - Active typing          → suppress idle + jitter (user is producing)
//   - Slow reading scroll    → suppress idle (user is consuming content)
//   - Fast aimless scroll    → amplifies tab-switch signal (channel surfing)
//
function classifyActivity(rawSignals, context, thresholds, currentCategory) {
    // ── Pre-check: Classification-based forced states ───────────────────────────
    if (currentCategory === 'DISTRACTION') return 'DISTRACTED';
    if (currentCategory === 'PRODUCTIVE') return 'FOCUSED';    // Study sites are safe zones

    // ── Behavioral analysis for UNKNOWN sites ───────────────────────────────────
    const s = { ...rawSignals };

    // Context overrides (suppress false positives)
    if (context.isTypingRecently) {
        s.idle = false;
        s.jitter = false;
    }

    if (context.isScrollingRecently && context.scrollVelocity < 150) {
        s.idle = false;
    }

    const aimlessBrowsing = context.scrollVelocity > 600 && s.tabSwitch;

    const activeCount = Object.values(s).filter(Boolean).length
        + (aimlessBrowsing ? 1 : 0);

    // Classify intent
    if (context.isTypingRecently && !s.tabSwitch && !s.backspace) {
        return 'DEEP_FOCUS';
    }
    if (context.isScrollingRecently && context.scrollVelocity < 150 && !s.tabSwitch) {
        return 'READING';
    }
    if (context.isTypingRecently && s.backspace) {
        return 'WORKING';
    }
    if (activeCount >= thresholds.driftSignals) {
        return 'DISTRACTED';
    }
    if (activeCount === 1) {
        return 'UNCERTAIN';
    }
    return 'FOCUSED';
}

// ─── Scoring Cycle ────────────────────────────────────────────────────────────
// 1. Evaluate raw threshold signals
// 2. Pass them through classifyActivity() to understand user context
// 3. Only mark DISTRACTED if that classification is stable over CONFIRM_CYCLES
// 4. Use hysteresis for recovery (separate drift / recovery thresholds)
async function runScoringCycle() {
    if (!state.enabled) return;

    const thresholds = MODE_THRESHOLDS[state.mode] || MODE_THRESHOLDS['deep-work'];

    // ── Distraction dwell-time check ──────────────────────────────────────────
    // If user has been on a distraction site for DISTRACTION_DWELL_SECS,
    // trigger even without other signals
    if (state.distractionDwellStart && !state.distractionActive) {
        const dwellSecs = (Date.now() - state.distractionDwellStart) / 1000;
        if (dwellSecs >= DISTRACTION_DWELL_SECS) {
            console.log(`[Cognify] Dwell time trigger: ${Math.round(dwellSecs)}s on distraction site`);
            state.distractionActive = true;
            state.stats.distractionsDetected++;
            await saveStats();
            triggerDistraction();
        }
    }

    // ── Step 1: Evaluate raw signals ──────────────────────────────────────────
    const cutoff = Date.now() - 60000;
    const recentSwitches = state.tabSwitches.filter(t => t > cutoff).length;
    const idleSecs = (state.isIdle && state.idleStartTime)
        ? (Date.now() - state.idleStartTime) / 1000 : 0;

    const rawSignals = {
        idle: idleSecs >= thresholds.idleSecs,
        tabSwitch: recentSwitches >= thresholds.tabSwitchPerMin,
        backspace: state.contentSignals.backspaceRatio > 0.25,
        jitter: state.contentSignals.mouseJitter > 5
    };

    // ── Step 2: Classify with context ─────────────────────────────────────────
    const context = {
        isTypingRecently: state.contentSignals.isTypingRecently,
        isScrollingRecently: state.contentSignals.isScrollingRecently,
        scrollVelocity: state.contentSignals.scrollVelocity
    };

    const classification = classifyActivity(rawSignals, context, thresholds, state.currentTabCategory);

    // ── Step 3: Temporal confirmation window ──────────────────────────────────
    // Push classification into history; keep only last CONFIRM_CYCLES entries
    state.classificationHistory.push(classification);
    if (state.classificationHistory.length > CONFIRM_CYCLES) {
        state.classificationHistory.shift();
    }

    // Confirmed distracted = every recent cycle independently classified as DISTRACTED
    const confirmedDistracted =
        state.classificationHistory.length === CONFIRM_CYCLES &&
        state.classificationHistory.every(c => c === 'DISTRACTED');

    // Confirmed recovered = no cycle in history is DISTRACTED
    const confirmedRecovered =
        state.classificationHistory.every(c => c !== 'DISTRACTED');

    // Build display score from raw signals (0–10)
    const scorePerSignal = { idle: 2, tabSwitch: 3, backspace: 2, jitter: 3 };
    const rawScore = Object.entries(rawSignals)
        .filter(([, active]) => active)
        .reduce((sum, [key]) => sum + scorePerSignal[key], 0);
    state.distractionScore = Math.min(10, rawScore);

    // ── Step 4: Hysteresis gate ───────────────────────────────────────────────
    if (!state.distractionActive && confirmedDistracted) {
        state.distractionActive = true;
        state.stats.distractionsDetected++;
        await saveStats();
        triggerDistraction();
    } else if (state.distractionActive && confirmedRecovered) {
        state.distractionActive = false;
        // Clear classification history so a fresh confirmation cycle is needed
        state.classificationHistory = [];
    }

    // Broadcast to popup
    const activeCount = Object.values(rawSignals).filter(Boolean).length;
    broadcastMetrics(thresholds, recentSwitches, rawSignals, activeCount, classification);
}

// ─── Trigger Distraction on Distraction Tab ─────────────────────────────────
// Always sends the intervention to the DISTRACTION tab, not whatever tab is active
async function triggerDistraction() {
    let targetTabId = state.distractionTabId;

    // Fallback if no specific distraction tab is known
    if (!targetTabId) {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        targetTabId = tab?.id;
    }

    if (targetTabId) {
        try {
            // Verify tab still exists and is not a restricted URL
            const tab = await chrome.tabs.get(targetTabId);
            if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('edge://')) {
                console.log('[Cognify] Target tab is restricted page, skipping trigger.');
                return;
            }

            console.log('[Cognify] Sending DISTRACTION_DETECTED to:', targetTabId);
            chrome.tabs.sendMessage(targetTabId, {
                type: 'DISTRACTION_DETECTED', mode: state.mode
            }).catch((err) => {
                console.warn('[Cognify] Connection failed. Note: You must refresh the page after extension reload.', err);
            });
        } catch (e) {
            console.warn('[Cognify] Target tab not found or inaccessible.');
        }
    }
}

// ─── Broadcast Metrics ───────────────────────────────────────────────────────
function broadcastMetrics(thresholds, recentSwitches, signals = {}, activeCount = 0, classification = 'FOCUSED') {
    const metrics = {
        type: 'METRICS_UPDATE',
        score: Math.round(state.distractionScore * 10) / 10,
        isDistracted: state.distractionActive,
        activeSignalCount: activeCount,
        classification,                       // e.g. 'READING', 'DISTRACTED', etc.
        signals,
        tabSwitches: recentSwitches,
        tabSwitchLimit: thresholds.tabSwitchPerMin,
        isIdle: state.isIdle,
        idleSecs: state.isIdle && state.idleStartTime
            ? Math.floor((Date.now() - state.idleStartTime) / 1000) : 0,
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
            state.contentSignals.scrollVelocity = msg.scrollVelocity || 0;
            state.contentSignals.isTypingRecently = msg.isTypingRecently || false;
            state.contentSignals.isScrollingRecently = msg.isScrollingRecently || false;
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

        case 'UPDATE_CUSTOM_DOMAINS':
            loadCustomDomains();
            break;

        case 'GET_METRICS':
            const thresholds = MODE_THRESHOLDS[state.mode] || MODE_THRESHOLDS['deep-work'];
            const cutoff = Date.now() - 60000;
            const switches = state.tabSwitches.filter(t => t > cutoff).length;
            broadcastMetrics(thresholds, switches);
            break;

        case 'CLOSE_TAB':
            if (sender.tab && sender.tab.id) {
                chrome.tabs.remove(sender.tab.id).catch(() => { });
            }
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
