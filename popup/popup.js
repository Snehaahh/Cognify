// Cognify - Popup Script

const $ = id => document.getElementById(id);

let currentMode = 'deep-work';
let isEnabled = true;

// ─── Init ─────────────────────────────────────────────────────────────────────
async function init() {
    const stored = await chrome.storage.local.get(['focusMode', 'enabled']);
    if (stored.focusMode) setMode(stored.focusMode, false);
    if (stored.enabled === false) applyEnabledState(false);

    // Request an immediate metrics update from background
    chrome.runtime.sendMessage({ type: 'GET_METRICS' }).catch(() => { });
}

// ─── Mode Switcher ────────────────────────────────────────────────────────────
document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        const mode = btn.dataset.mode;
        setMode(mode, true);
    });
});

function setMode(mode, sendMessage) {
    currentMode = mode;
    document.querySelectorAll('.mode-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.mode === mode);
    });
    if (sendMessage) {
        chrome.runtime.sendMessage({ type: 'SET_MODE', mode });
    }
}

// ─── Enable Toggle ────────────────────────────────────────────────────────────
$('enableToggle').addEventListener('change', (e) => {
    isEnabled = e.target.checked;
    applyEnabledState(isEnabled);
    chrome.runtime.sendMessage({ type: 'SET_ENABLED', enabled: isEnabled });
});

function applyEnabledState(enabled) {
    isEnabled = enabled;
    $('enableToggle').checked = enabled;
    document.body.classList.toggle('disabled', !enabled);
}

// ─── Metrics Listener ─────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type !== 'METRICS_UPDATE') return;
    updateUI(msg);
});

function updateUI(m) {
    // Sync mode in case it changed
    if (m.mode && m.mode !== currentMode) setMode(m.mode, false);

    // Sync enabled state
    if (m.enabled !== undefined && m.enabled !== isEnabled) applyEnabledState(m.enabled);

    // Status bar
    const isDistracted = m.isDistracted;
    const bar = document.querySelector('.status-bar');
    bar.classList.toggle('focused', !isDistracted);
    bar.classList.toggle('distracted', isDistracted);

    $('statusLabel').textContent = isDistracted ? 'DRIFT DETECTED' : 'FOCUSED';
    $('signalNum').textContent = m.activeSignalCount || 0;

    // Individual signal rows
    updateSignalRow('sig-idle', 'dot-idle', 'val-idle',
        m.signals?.idle, `${m.idleSecs}s`);
    updateSignalRow('sig-tab', 'dot-tab', 'val-tab',
        m.signals?.tabSwitch, `${m.tabSwitches} / min`);
    updateSignalRow('sig-backspace', 'dot-backspace', 'val-backspace',
        m.signals?.backspace, `${m.backspaceRatio}%`);
    updateSignalRow('sig-jitter', 'dot-jitter', 'val-jitter',
        m.signals?.jitter, `${m.mouseJitter}`);

    // Stats
    const stats = m.stats || {};
    $('stat-distractions').textContent = stats.distractionsDetected ?? 0;
    $('stat-resets').textContent = stats.resetSessions ?? 0;
    const idleMins = Math.floor((stats.totalIdleSeconds || 0) / 60);
    $('stat-idle').textContent = idleMins >= 60
        ? `${Math.floor(idleMins / 60)}h ${idleMins % 60}m`
        : `${idleMins}m`;
}

function updateSignalRow(rowId, dotId, valId, isActive, value) {
    const row = $(rowId);
    const val = $(valId);
    if (row) row.classList.toggle('active', !!isActive);
    if (val) val.textContent = value;
}

// ─── Settings Panel ───────────────────────────────────────────────────────────
const gearBtn = $('gearBtn');
const settingsPanel = $('settingsPanel');

gearBtn.addEventListener('click', () => {
    const isOpen = settingsPanel.classList.toggle('open');
    gearBtn.classList.toggle('active', isOpen);
});

// Domain storage keys
let customProductive = [];
let customDistraction = [];

async function loadCustomDomains() {
    const stored = await chrome.storage.local.get(['customProductive', 'customDistraction']);
    customProductive = stored.customProductive || [];
    customDistraction = stored.customDistraction || [];
    renderTags('productiveTags', customProductive, 'customProductive');
    renderTags('distractionTags', customDistraction, 'customDistraction');
}

function renderTags(containerId, domains, storageKey) {
    const container = $(containerId);
    container.innerHTML = '';
    domains.forEach(domain => {
        const tag = document.createElement('span');
        tag.className = 'domain-tag';
        tag.innerHTML = `${domain}<button class="remove-tag" data-domain="${domain}">\u00d7</button>`;
        tag.querySelector('.remove-tag').addEventListener('click', () => {
            removeDomain(domain, storageKey);
        });
        container.appendChild(tag);
    });
}

function addDomain(inputId, storageKey) {
    const input = $(inputId);
    let domain = input.value.trim().toLowerCase();
    if (!domain) return;

    // Clean up: remove protocol and www
    domain = domain.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
    if (!domain) return;

    const list = storageKey === 'customProductive' ? customProductive : customDistraction;
    if (list.includes(domain)) { input.value = ''; return; } // already exists

    list.push(domain);
    chrome.storage.local.set({ [storageKey]: list });
    renderTags(
        storageKey === 'customProductive' ? 'productiveTags' : 'distractionTags',
        list, storageKey
    );
    input.value = '';

    // Notify background.js to reload custom domains
    chrome.runtime.sendMessage({ type: 'UPDATE_CUSTOM_DOMAINS' }).catch(() => { });
}

function removeDomain(domain, storageKey) {
    const list = storageKey === 'customProductive' ? customProductive : customDistraction;
    const idx = list.indexOf(domain);
    if (idx > -1) list.splice(idx, 1);
    chrome.storage.local.set({ [storageKey]: list });
    renderTags(
        storageKey === 'customProductive' ? 'productiveTags' : 'distractionTags',
        list, storageKey
    );
    chrome.runtime.sendMessage({ type: 'UPDATE_CUSTOM_DOMAINS' }).catch(() => { });
}

// Wire up add buttons + Enter key
$('addProductiveBtn').addEventListener('click', () => addDomain('productiveInput', 'customProductive'));
$('addDistractionBtn').addEventListener('click', () => addDomain('distractionInput', 'customDistraction'));

$('productiveInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addDomain('productiveInput', 'customProductive');
});
$('distractionInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addDomain('distractionInput', 'customDistraction');
});

// ─── Start ────────────────────────────────────────────────────────────────────
loadCustomDomains();
init();
