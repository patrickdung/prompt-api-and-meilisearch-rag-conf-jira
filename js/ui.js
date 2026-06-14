/**
 * ui.js — All DOM rendering functions.
 * No fetch calls here. Takes raw data, returns/injects HTML.
 */

// --- Skeleton Loaders ---

export function renderSkeletonLoaders() {
    const aiResponse = document.getElementById('aiResponse');
    const sourceDocs = document.getElementById('sourceDocs');

    // AI panel skeleton
    aiResponse.innerHTML = `
        <div class="space-y-3">
            <div class="skeleton h-4 w-3/4"></div>
            <div class="skeleton h-4 w-full"></div>
            <div class="skeleton h-4 w-5/6"></div>
            <div class="skeleton h-4 w-4/5"></div>
            <div class="skeleton h-4 w-full"></div>
            <div class="skeleton h-4 w-2/3"></div>
        </div>
    `;

    // Source docs skeleton (5 cards)
    sourceDocs.innerHTML = Array.from({ length: 5 }, () => `
        <div class="bg-gray-700/50 rounded-lg p-4 border border-gray-600">
            <div class="skeleton h-5 w-3/4 mb-2"></div>
            <div class="skeleton h-3 w-1/4 mb-3"></div>
            <div class="skeleton h-3 w-full mb-1"></div>
            <div class="skeleton h-3 w-5/6"></div>
        </div>
    `).join('');
}

// --- Search Results ---

/**
 * Render Meilisearch document cards.
 * @param {Array} hits — Meilisearch hit objects
 */
export function renderSearchResults(hits) {
    const container = document.getElementById('sourceDocs');

    if (!hits || hits.length === 0) {
        container.innerHTML = `<p class="text-gray-500 text-sm italic">No documents found.</p>`;
        return;
    }

    console.log('[UI] renderSearchResults hits count:', hits.length);
    if (hits.length > 0) {
        console.log('[UI] First hit keys:', Object.keys(hits[0]));
        console.log('[UI] First hit url:', hits[0].url, 'uri:', hits[0].uri);
    }

    container.innerHTML = hits.map((hit, index) => {
        const sourceId = index + 1;
        const isJira = hit._sourceIndex === 'jira';

        const title = hit.title || 'Untitled';
        const space = isJira ? (hit.project || 'Unknown') : (hit.space || 'Unknown');
        const body = hit.body || '';
        const summary = body.length > 300 ? body.substring(0, 300) + '...' : (body || 'No description provided.');
        const sourcePath = hit.url || hit.uri || '#';

        // Badges
        const sourceTypeBadge = isJira
            ? `<span class="text-xs font-semibold text-green-400 bg-green-400/10 px-2 py-0.5 rounded">JIRA</span>`
            : `<span class="text-xs font-semibold text-blue-400 bg-blue-400/10 px-2 py-0.5 rounded">Confluence</span>`;

        const keyBadge = isJira && hit.key
            ? `<span class="text-xs font-mono text-gray-300 bg-gray-600/50 px-2 py-0.5 rounded">${escapeHtml(hit.key)}</span>`
            : '';

        const metaBadges = isJira
            ? [
                hit.status ? `<span class="text-xs text-gray-400 bg-gray-600/50 px-2 py-0.5 rounded">${escapeHtml(hit.status)}</span>` : '',
                hit.issue_type ? `<span class="text-xs text-gray-400 bg-gray-600/50 px-2 py-0.5 rounded">${escapeHtml(hit.issue_type)}</span>` : ''
              ].filter(Boolean).join('')
            : '';

        return `
            <div class="source-card bg-gray-700/50 rounded-lg p-4 border border-gray-600 hover:border-gray-500"
                 data-source-id="${sourceId}" id="source-card-${sourceId}">
                <div class="flex items-start justify-between mb-2">
                    <span class="text-xs font-mono text-blue-400 bg-blue-400/10 px-2 py-0.5 rounded">
                        [${sourceId}]
                    </span>
                    <div class="flex gap-1 flex-wrap justify-end">
                        ${sourceTypeBadge}
                        ${keyBadge}
                        <span class="text-xs text-gray-400 bg-gray-600/50 px-2 py-0.5 rounded">
                            ${escapeHtml(space)}
                        </span>
                        ${metaBadges}
                    </div>
                </div>
                <a href="${escapeHtml(sourcePath)}" target="_blank"
                   class="text-blue-300 hover:text-blue-200 font-medium text-sm block mb-2 underline">
                    ${escapeHtml(title)}
                </a>
                <p class="text-gray-400 text-xs leading-relaxed">
                    ${escapeHtml(summary)}
                </p>
            </div>
        `;
    }).join('');
}

/**
 * Render source documents returned by Meilisearch chat tool calls.
 * @param {Array} sources — Source objects from _meiliSearchSources
 */
export function renderSearchResultsFromChat(sources) {
    const container = document.getElementById('sourceDocs');

    if (!sources || sources.length === 0) {
        container.innerHTML = `<p class="text-gray-500 text-sm italic">No sources found.</p>`;
        return;
    }

    const normalized = sources.map((src, index) => ({
        sourceId: index + 1,
        title: src.title || 'Untitled',
        space: src.space || 'Unknown',
        body: src.body || '',
        source_path: src.url || src.source_path || '#',
        _sourceIndex: src._sourceIndex || 'confluence',
        key: src.key || '',
        project: src.project || '',
        status: src.status || '',
        issue_type: src.issue_type || ''
    }));

    container.innerHTML = normalized.map((hit) => {
        const isJira = hit._sourceIndex === 'jira';
        const summary = hit.body.length > 300 ? hit.body.substring(0, 300) + '...' : (hit.body || 'No description provided.');

        const sourceTypeBadge = isJira
            ? `<span class="text-xs font-semibold text-green-400 bg-green-400/10 px-2 py-0.5 rounded">JIRA</span>`
            : `<span class="text-xs font-semibold text-blue-400 bg-blue-400/10 px-2 py-0.5 rounded">Confluence</span>`;

        const keyBadge = isJira && hit.key
            ? `<span class="text-xs font-mono text-gray-300 bg-gray-600/50 px-2 py-0.5 rounded">${escapeHtml(hit.key)}</span>`
            : '';

        const space = isJira ? (hit.project || 'Unknown') : hit.space;

        const metaBadges = isJira
            ? [
                hit.status ? `<span class="text-xs text-gray-400 bg-gray-600/50 px-2 py-0.5 rounded">${escapeHtml(hit.status)}</span>` : '',
                hit.issue_type ? `<span class="text-xs text-gray-400 bg-gray-600/50 px-2 py-0.5 rounded">${escapeHtml(hit.issue_type)}</span>` : ''
              ].filter(Boolean).join('')
            : '';

        return `
            <div class="source-card bg-gray-700/50 rounded-lg p-4 border border-gray-600 hover:border-gray-500"
                 data-source-id="${hit.sourceId}" id="source-card-${hit.sourceId}">
                <div class="flex items-start justify-between mb-2">
                    <span class="text-xs font-mono text-blue-400 bg-blue-400/10 px-2 py-0.5 rounded">
                        [${hit.sourceId}]
                    </span>
                    <div class="flex gap-1 flex-wrap justify-end">
                        ${sourceTypeBadge}
                        ${keyBadge}
                        <span class="text-xs text-gray-400 bg-gray-600/50 px-2 py-0.5 rounded">
                            ${escapeHtml(space)}
                        </span>
                        ${metaBadges}
                    </div>
                </div>
                <a href="${escapeHtml(hit.source_path)}" target="_blank"
                   class="text-blue-300 hover:text-blue-200 font-medium text-sm block mb-2 underline">
                    ${escapeHtml(hit.title)}
                </a>
                <p class="text-gray-400 text-xs leading-relaxed">
                    ${escapeHtml(summary)}
                </p>
            </div>
        `;
    }).join('');
}

// --- AI Answer ---

let currentTextNode = null;
let fullAnswerText = '';
let _markdownTimer = null;

/**
 * Initialize the AI answer panel for streaming.
 */
export function initAIAnswer() {
    const aiResponse = document.getElementById('aiResponse');
    fullAnswerText = '';

    // Clear only the content. followUpContainer is now a sibling,
    // so it survives aiResponse.innerHTML = ''.
    aiResponse.innerHTML = '';

    // Create a container for markdown-rendered content
    const mdContainer = document.createElement('div');
    mdContainer.className = 'ai-md-container';
    aiResponse.appendChild(mdContainer);
    currentTextNode = mdContainer;
}

/**
 * Append a chunk of text to the AI answer.
 * Raw text only during streaming — markdown parsed at the end.
 * @param {string} chunk — Raw chunk from the stream
 */
export function appendAIAnswerChunk(chunk) {
    if (!currentTextNode || typeof chunk !== 'string' || !chunk) return;

    const existing = fullAnswerText;
    let newText = chunk;

    if (chunk.length >= existing.length && chunk.startsWith(existing)) {
        // Full-string mode: chunk is the entire response so far
        newText = chunk.slice(existing.length);
        fullAnswerText = chunk;
    } else {
        // Delta mode: chunk is only newly generated text
        fullAnswerText += chunk;
    }
    currentTextNode.dataset.raw = fullAnswerText;

    // Append raw text only — no markdown parsing during streaming
    if (newText) {
        const textNode = document.createTextNode(newText);
        currentTextNode.appendChild(textNode);
    }

    // Auto-scroll to bottom
    const aiResponse = document.getElementById('aiResponse');
    aiResponse.scrollTop = aiResponse.scrollHeight;
}

/**
 * Finalize the AI answer: render markdown and wire citations.
 */
export function finalizeAIAnswer() {
    if (!currentTextNode) return;

    const aiResponse = document.getElementById('aiResponse');
    const finalText = fullAnswerText || currentTextNode.textContent || '';
    fullAnswerText = finalText;

    // Safety net: if the answer is a "not found" fallback (contains contact
    // email), strip all citation markers BEFORE markdown parsing so the UI
    // never sees broken citation links in a "not found" answer.
    let cleanedText = finalText;
    if (/help@example\.com/i.test(finalText)) {
        cleanedText = finalText.replace(/\[\d+\]/g, '');
    }

    // Strip any raw tool JSON fragments the weak LLM may have leaked.
    // This catches both complete JSON objects and partial fragments
    // assembled across multiple streaming chunks.
    cleanedText = cleanedText.replace(/\{[^]*?(?:(?:"call_id"|"function_name"|"function_arguments"|"tool_calls"|"tool_call_id"|"name"|"parameters")\s*:|"_meili")[^]*?\}/gi, '');
    cleanedText = cleanedText.replace(/\{[^]*?"arguments"\s*:[^]*?\}/gi, '');
    // Clean up orphaned braces left after removal
    cleanedText = cleanedText.replace(/\{\s*\}/g, '');

    if (!cleanedText.trim()) {
        cleanedText = 'The chat model returned an invalid structured response. Please try again or switch to On-Device AI.';
    }

    // Parse markdown
    let html = marked.parse(cleanedText);

    // Convert citation markers [1], [2], etc. into clickable spans
    html = html.replace(
        /\[(\d+)\]/g,
        '<span class="citation-link" data-citation="$1">[$1]</span>'
    );

    // followUpContainer is now a sibling, so innerHTML won't touch it.
    aiResponse.innerHTML = html;
}

/**
 * Finalize the AI answer with sources from chat response.
 * Renders markdown, wires citations, then renders source cards.
 * @param {Array} sources — Source documents from chat response
 */
export function finalizeAIAnswerWithSources(sources) {
    finalizeAIAnswer();
    if (sources && sources.length > 0) {
        renderSearchResultsFromChat(sources);
    }
}

export function getFullAnswerText() {
    return fullAnswerText;
}

// --- Model Download Progress ---

/**
 * Show the model download progress banner.
 */
export function showModelProgress() {
    const banner = document.getElementById('modelStatusBanner');
    if (banner) banner.classList.remove('hidden');
}

/**
 * Hide the model download progress banner.
 */
export function hideModelProgress() {
    const banner = document.getElementById('modelStatusBanner');
    if (banner) banner.classList.add('hidden');
}

/**
 * Update model download progress.
 * @param {string} text — Status text (e.g. "Downloading model...")
 * @param {number} percent — 0-100 progress percentage
 */
export function setModelProgress(text, percent) {
    const statusText = document.getElementById('modelStatusText');
    const progressBar = document.getElementById('modelProgressBar');

    if (statusText) statusText.textContent = text;
    if (progressBar) progressBar.style.width = `${percent}%`;
}

// --- Error ---

/**
 * Display an error message.
 * @param {string} message — Error message
 */
export function renderError(message) {
    const aiResponse = document.getElementById('aiResponse');
    aiResponse.innerHTML = `<p class="text-red-400">Error: ${escapeHtml(message)}</p>`;

    showErrorToast(message);
}

/**
 * Append an error message to the current answer container without wiping the panel.
 * Used in chat mode so follow-up form and previous answers are preserved.
 * @param {string} message — Error message
 */
export function appendErrorToAnswer(message) {
    if (!currentTextNode) return;
    const errDiv = document.createElement('div');
    errDiv.className = 'text-red-400 mt-4 p-3 bg-red-900/20 rounded border border-red-700';
    errDiv.textContent = message;
    currentTextNode.appendChild(errDiv);

    showErrorToast(message);
}

function showErrorToast(message) {
    const toast = document.getElementById('errorToast');
    const text = document.getElementById('errorText');
    text.textContent = message;
    toast.classList.remove('hidden');
    toast.classList.add('show');

    setTimeout(() => {
        toast.classList.add('hidden');
        toast.classList.remove('show');
    }, 5000);
}

// --- Citation Highlight ---

/**
 * Highlight a source document card and scroll it into view.
 * @param {string|number} sourceId — The citation number
 */
export function highlightSourceCard(sourceId) {
    // Remove existing highlights
    document.querySelectorAll('.source-card-highlight').forEach(el => {
        el.classList.remove('source-card-highlight');
    });

    const card = document.getElementById(`source-card-${sourceId}`);
    if (card) {
        card.classList.add('source-card-highlight');
        card.scrollIntoView({ behavior: 'smooth', block: 'center' });

        // Remove highlight after animation
        setTimeout(() => {
            card.classList.remove('source-card-highlight');
        }, 2000);
    }
}

// --- Loading Bar ---

export function showLoading() {
    document.getElementById('loadingBar').classList.remove('hidden');
}

export function hideLoading() {
    document.getElementById('loadingBar').classList.add('hidden');
}

// --- API Status ---

export function setApiStatus(status, text) {
    const el = document.getElementById('apiStatus');
    el.textContent = text;

    if (status === 'ready') {
        el.className = 'text-xs text-green-400 shrink-0';
    } else if (status === 'unavailable') {
        el.className = 'text-xs text-red-400 shrink-0';
    } else if (status === 'checking') {
        el.className = 'text-xs text-yellow-400 shrink-0';
    } else if (status === 'mode-prompt-api') {
        el.className = 'text-xs text-green-400 shrink-0';
    } else if (status === 'mode-meilisearch-chat') {
        el.className = 'text-xs text-blue-400 shrink-0';
    } else {
        el.className = 'text-xs text-gray-400 shrink-0';
    }
}

/**
 * Helper: update the mode badge color + text based on selected value.
 */
function _updateModeBadge(selectEl, badgeEl) {
    const mode = selectEl.value;
    if (mode === 'meilisearch-chat') {
        badgeEl.textContent = 'Meilisearch Chat';
        badgeEl.className = 'text-[10px] font-medium px-2 py-0.5 rounded bg-blue-600 text-white';
    } else {
        badgeEl.textContent = 'On-Device AI';
        badgeEl.className = 'text-[10px] font-medium px-2 py-0.5 rounded bg-green-600 text-white';
    }
}

function _updateChatModeHint(mode) {
    const hint = document.getElementById('chatModeHint');
    if (!hint) return;

    if (mode === 'meilisearch-chat') {
        hint.classList.remove('hidden');
    } else {
        hint.classList.add('hidden');
    }
}

export function bindModeSwitch(savedMode = 'prompt-api') {
    const select = document.getElementById('aiModeSelect');
    const badge = document.getElementById('aiModeBadge');

    if (!select || !badge) {
        console.warn('[UI] bindModeSwitch: #aiModeSelect or #aiModeBadge not found. Switch will not function.');
        return;
    }

    if (savedMode) {
        select.value = savedMode;
    }

    _updateModeBadge(select, badge);
    _updateChatModeHint(select.value);

    select.addEventListener('change', (e) => {
        const mode = e.target.value;
        _updateModeBadge(select, badge);
        _updateChatModeHint(mode);
        window.dispatchEvent(new CustomEvent('aiModeChange', { detail: { mode } }));
    });
}

// --- Follow-up UI ---

let followUpSpotlightTimer = null;

export function showFollowUp() {
    const container = document.getElementById('followUpContainer');
    const input = document.getElementById('followUpInput');

    if (!container) return;

    container.classList.remove('hidden');
    container.classList.add('follow-up-spotlight');

    if (followUpSpotlightTimer) {
        clearTimeout(followUpSpotlightTimer);
    }

    followUpSpotlightTimer = window.setTimeout(() => {
        container.classList.remove('follow-up-spotlight');
        followUpSpotlightTimer = null;
    }, 2200);

    if (input) {
        input.focus({ preventScroll: true });
    }
}

export function hideFollowUp() {
    const container = document.getElementById('followUpContainer');
    if (!container) return;

    if (followUpSpotlightTimer) {
        clearTimeout(followUpSpotlightTimer);
        followUpSpotlightTimer = null;
    }

    container.classList.remove('follow-up-spotlight');
    container.classList.add('hidden');
}

export function clearFollowUpInput() {
    const input = document.getElementById('followUpInput');
    if (input) input.value = '';
}

// --- Utility ---

function escapeHtml(str) {
    if (!str) return '';
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}
