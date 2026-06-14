/**
 * app.js — Application orchestrator.
 * Initializes state, wires event listeners, coordinates the RAG flow.
 */

import {
    searchMultiIndex,
    checkPromptAPIAvailability,
    fetchAIAnswer,
    chatWithMeilisearch
} from './api.js';

import { CONFIG } from './config.js';

import {
    renderSkeletonLoaders,
    renderSearchResults,
    renderSearchResultsFromChat,
    bindModeSwitch,
    initAIAnswer,
    appendAIAnswerChunk,
    finalizeAIAnswer,
    finalizeAIAnswerWithSources,
    getFullAnswerText,
    renderError,
    appendErrorToAnswer,
    highlightSourceCard,
    showLoading,
    hideLoading,
    setApiStatus,
    showModelProgress,
    hideModelProgress,
    setModelProgress,
    showFollowUp,
    hideFollowUp,
    clearFollowUpInput
} from './ui.js';

// --- Application State ---

const appState = {
    currentQuery: '',
    loading: false,
    results: [],
    answer: '',
    aiMode: 'prompt-api',      // 'prompt-api' or 'meilisearch-chat'
    messages: []               // In-memory conversation history (cleared on new tab)
};

const WEAK_CHAT_PATTERNS = [
    /available search tool/i,
    /doesn't support filtering/i,
    /does not support filtering/i,
    /year attribute isn't filterable/i,
    /year attribute is not filterable/i,
    /exact year constraints/i
];

const RAW_TOOL_JSON_KEY_PATTERN = /"call_id"|"function_name"|"function_arguments"|"tool_calls"|"tool_call_id"|"_meili"|"arguments"\s*:/i;
const INVALID_CHAT_RESPONSE_MESSAGE = 'The chat model returned an invalid structured response. Please try again or switch to On-Device AI.';

function isRawToolJsonAnswer(text) {
    if (typeof text !== 'string') return false;

    const normalized = text.trim();
    if (!/^\{[\s\S]*\}$/.test(normalized)) {
        return false;
    }

    return RAW_TOOL_JSON_KEY_PATTERN.test(normalized) ||
        (/"name"\s*:/i.test(normalized) && /"parameters"\s*:/i.test(normalized));
}

function getWeakChatReason(answerText, session, contexts = []) {
    const normalized = typeof answerText === 'string' ? answerText.trim() : '';
    if (!normalized) return 'empty-answer';

    if (isRawToolJsonAnswer(normalized)) {
        return 'tool-json-answer';
    }

    if (WEAK_CHAT_PATTERNS.some(pattern => pattern.test(normalized))) {
        return 'meta-tool-refusal';
    }

    const hasContexts = Array.isArray(contexts) && contexts.length > 0;
    const sourceCount = Array.isArray(session?.sources) ? session.sources.length : 0;
    const toolCallCount = session?.toolStats?.callCount || 0;

    if (hasContexts && sourceCount === 0 && toolCallCount === 0 && normalized.length < 120) {
        return 'short-ungrounded-answer';
    }

    return null;
}

function normalizeConversationMessage(message) {
    if (!message || typeof message !== 'object') return null;

    const role = typeof message.role === 'string' ? message.role.trim() : '';
    const content = typeof message.content === 'string' ? message.content.trim() : '';

    if (!['user', 'assistant', 'tool'].includes(role) || !content) {
        return null;
    }

    if (/_meili(SearchSources|SearchProgress|AppendConversationMessage)/i.test(content)) {
        return null;
    }

    return { role, content };
}

function appendConversationMessages(history, messages, logPrefix) {
    if (!Array.isArray(messages) || messages.length === 0) {
        return 0;
    }

    let appendedCount = 0;

    for (const message of messages) {
        const normalized = normalizeConversationMessage(message);
        if (!normalized) {
            console.warn(`[${logPrefix}] Skipped invalid appended message`, message);
            continue;
        }

        history.push(normalized);
        appendedCount += 1;
        console.log(`[${logPrefix}] Appended tool message:`, normalized.role, normalized.content.substring(0, 50));
    }

    return appendedCount;
}

// --- Initialization ---

async function waitForPromptAPI(maxWaitMs = 30000) {
    const start = performance.now();
    while (performance.now() - start < maxWaitMs) {
        const api = (typeof LanguageModel !== 'undefined') ? LanguageModel
            : (window.ai && window.ai.languageModel) ? window.ai.languageModel
            : (window.ai && typeof window.ai.create === 'function') ? window.ai
            : null;
        if (api) return api;
        await new Promise(r => setTimeout(r, 500));
    }
    return null;
}

async function init() {
    // Restore mode from sessionStorage (default: prompt-api)
    const savedMode = sessionStorage.getItem('aiMode');
    if (savedMode === 'meilisearch-chat' || savedMode === 'prompt-api') {
        appState.aiMode = savedMode;
    }

    // Bind behavior to the static mode switch rendered in index.html
    bindModeSwitch(savedMode);

    // Set initial status to show the ACTIVE MODE NAME — no generic "Checking..."
    _updateModeStatus();

    // Listen for mode changes from the switch
    window.addEventListener('aiModeChange', (event) => {
        const mode = event.detail.mode;
        appState.aiMode = mode;
        sessionStorage.setItem('aiMode', mode);
        console.log('[App] AI mode switched to:', mode);
        _updateModeStatus();
    });

    // Wire event listeners FIRST
    const searchForm = document.getElementById('searchForm');
    const searchInput = document.getElementById('searchInput');

    searchForm.addEventListener('submit', handleSearch);
    searchInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            handleSearch(e);
        }
    });

    // Citation click delegation
    document.getElementById('aiResponse').addEventListener('click', (e) => {
        const citation = e.target.closest('.citation-link');
        if (citation) {
            e.preventDefault();
            const sourceId = citation.getAttribute('data-citation');
            highlightSourceCard(sourceId);
        }
    });

    // Follow-up form (for chat mode)
    const followUpForm = document.getElementById('followUpForm');
    if (followUpForm) {
        followUpForm.addEventListener('submit', handleFollowUp);
    }

    // New conversation button
    const newChatBtn = document.getElementById('newChatBtn');
    if (newChatBtn) {
        newChatBtn.addEventListener('click', () => {
            appState.messages = [];
            appState.results = [];
            appState.answer = '';
            hideFollowUp();
            const aiResponse = document.getElementById('aiResponse');
            aiResponse.innerHTML = '<p class="text-gray-500 italic">Enter a question above to get an AI-powered answer based on your wiki and JIRA documents.</p>';
            document.getElementById('sourceDocs').innerHTML = '';
            console.log('[App] New conversation started');
        });
    }

    // Only probe Prompt API if the user explicitly chose that mode.
    // If they chose Meilisearch Chat, we do NOT probe — no 30s background wait.
    if (appState.aiMode === 'prompt-api') {
        // Probe Prompt API in background (still useful to know if model is ready)
        const api = await waitForPromptAPI(30000);
        if (!api) {
            console.warn(
                '%cPrompt API not detected.%c\n' +
                'The on-device model is downloaded, but the JavaScript API is not exposed to this page.\n' +
                'To enable it, check these Chrome flags:\n' +
                '1. chrome://flags/#prompt-api-for-gemini-nano  →  Enable\n' +
                '2. chrome://flags/#optimization-guide-on-device-model  →  Enable\n' +
                '3. chrome://flags/#enable-experimental-web-platform-features  →  Enable\n' +
                '4. Relaunch Chrome and try again.\n\n' +
                'Search results from Meilisearch will still work without the AI.',
                'color: orange; font-weight: bold;',
                'color: inherit;'
            );
        }
    }

    // Listen for model download progress events (only relevant for Prompt API mode)
    window.addEventListener('modelDownloadProgress', (event) => {
        const { loaded, total, percent } = event.detail;
        if (percent < 100) {
            showModelProgress();
            setModelProgress(
                `Downloading AI model... ${percent}%`,
                percent
            );
        } else {
            hideModelProgress();
        }
    });
}

/**
 * Update #apiStatus to show the currently selected mode name with matching color.
 * No auto-detection. What the user sees in the dropdown is what is active.
 */
function _updateModeStatus() {
    if (appState.aiMode === 'meilisearch-chat') {
        setApiStatus('mode-meilisearch-chat', 'Mode: Meilisearch Chat');
    } else {
        setApiStatus('mode-prompt-api', 'Mode: On-Device AI');
    }
}

// --- Search Handler ---

async function handleSearch(e) {
    e.preventDefault();
    console.log('[Search] Form submitted');

    const searchInput = document.getElementById('searchInput');
    const query = searchInput.value.trim();
    console.log('[Search] Query:', query);

    if (!query) {
        console.log('[Search] Empty query, aborting');
        return;
    }

    // Update state
    appState.currentQuery = query;
    appState.loading = true;
    appState.results = [];
    appState.answer = '';

    // In Meilisearch chat mode, the top search box starts a NEW conversation.
    // Reset the in-memory history so the first message is a clean user turn.
    if (appState.aiMode === 'meilisearch-chat') {
        appState.messages = [];
        console.log('[Search] Reset conversation history for new chat');
    }

    // Show loading UI
    showLoading();
    renderSkeletonLoaders();

    try {
        if (appState.aiMode === 'meilisearch-chat') {
            // --- Meilisearch Conversation Search mode ---
            console.log('[Search] Meilisearch chat mode for query:', query);

            // Step 1: ALWAYS run hybrid search first to get documents for context + RHS
            console.log('[Search] Running hybrid search for context...');
            const hits = await searchMultiIndex(query);
            console.log('[Search] Got hits:', hits.length, hits);
            appState.results = hits;

            // Render source documents on RHS immediately
            renderSearchResults(hits);

            // Step 2: Stream chat answer
            // ALWAYS pass retrieved documents as contexts. The LLM will
            // have them injected into its prompt, so it can answer from
            // actual content. Native tools may still be sent if enabled.
            await streamChatAnswer(query, hits);

            // Show follow-up input after first answer completes
            // This is called inside streamChatAnswer() after finalize completes,
            // not here, to avoid the follow-up container being destroyed during initAIAnswer().

        } else {
            // --- Prompt API (on-device AI) mode ---
            // Step 1: Search Meilisearch
            console.log('[Search] Calling searchMultiIndex...');
            const hits = await searchMultiIndex(query);
            console.log('[Search] Got hits:', hits.length, hits);
            appState.results = hits;

            // Render source documents immediately
            console.log('[Search] Rendering results...');
            renderSearchResults(hits);

            // Step 2: Fetch AI answer with retrieved context
            console.log('[Search] Starting AI answer stream...');
            await streamAIAnswer(query, hits);

            // Hide follow-up in Prompt API mode
            hideFollowUp();
        }

    } catch (error) {
        console.error('[Search] Error in handleSearch:', error);
        const msg = error.message || 'An error occurred during search.';
        if (msg.includes('Prompt API not available')) {
            // ... existing error handling
            const aiResponse = document.getElementById('aiResponse');
            aiResponse.innerHTML = `
                <div class="text-yellow-400">
                    <p class="font-semibold mb-2">On-Device AI is not available in this browser.</p>
                    <p class="text-sm text-gray-400 mb-3">The wiki search results are shown on the right. The AI summary requires a browser that exposes the Prompt API.</p>
                    <div class="bg-gray-700/50 rounded-lg p-3 mb-3 text-sm">
                        <p class="font-semibold text-gray-300 mb-1">For Chrome:</p>
                        <ul class="text-gray-400 list-disc pl-5 space-y-1">
                            <li>chrome://flags/#prompt-api-for-gemini-nano → <strong>Enable</strong></li>
                            <li>chrome://flags/#optimization-guide-on-device-model → <strong>Enable</strong></li>
                            <li>chrome://flags/#enable-experimental-web-platform-features → <strong>Enable</strong></li>
                            <li>Relaunch Chrome completely</li>
                        </ul>
                    </div>
                    <div class="bg-gray-700/50 rounded-lg p-3 mb-3 text-sm">
                        <p class="font-semibold text-gray-300 mb-1">For Microsoft Edge (recommended):</p>
                        <ul class="text-gray-400 list-disc pl-5 space-y-1">
                            <li>Install <a href="https://www.microsoft.com/edge/download/insider" target="_blank" class="text-blue-400 underline">Edge Canary or Dev</a> (v138+)</li>
                            <li>edge://flags/#prompt-api-for-on-device-language-model → <strong>Enable</strong></li>
                            <li>Relaunch Edge</li>
                        </ul>
                    </div>
                    <p class="text-sm text-gray-400">The first time you use the API, the model may take 10-30 seconds to load. See <a href="https://microsoftedge.github.io/Demos/built-in-ai/playgrounds/prompt-api/" target="_blank" class="text-blue-400 underline">Edge Prompt API Playground</a> for a working demo.</p>
                </div>
            `;
        } else {
            renderError(msg);
        }
    } finally {
        appState.loading = false;
        hideLoading();
        console.log('[Search] Search complete');
    }
}

// --- Meilisearch Chat Answer Streaming ---

async function streamChatAnswer(query, contexts = []) {
    initAIAnswer();

    try {
        // Push user message to conversation history
        appState.messages.push({ role: 'user', content: query });
        console.log('[Chat] Sending', appState.messages.length, 'messages to Meilisearch');

        // First attempt: let the configured workspace use its native retrieval.
        // With the unified workspace, Meilisearch should be able to search both
        // confluence and jira directly.
        let session = await chatWithMeilisearch(query, appState.messages, contexts);

        try {
            for await (const chunk of session.stream) {
                appendAIAnswerChunk(chunk);
            }
        } finally {
            if (session && session.destroy) {
                session.destroy();
            }
        }

        let fullText = getFullAnswerText();
        let fallbackReason = getWeakChatReason(fullText, session, contexts);

        if (fallbackReason) {
            console.warn('[Chat] Weak native-tool answer detected:', fallbackReason, 'Retrying tool-less with injected contexts.');
            renderSearchResults(contexts);
            initAIAnswer();

            session = await chatWithMeilisearch(query, appState.messages, contexts, {
                disableTools: true
            });

            try {
                for await (const chunk of session.stream) {
                    appendAIAnswerChunk(chunk);
                }
            } finally {
                if (session && session.destroy) {
                    session.destroy();
                }
            }

            fullText = getFullAnswerText();
            console.log('[Chat] Fallback completed for reason:', fallbackReason);
        }

        fallbackReason = getWeakChatReason(fullText, session, contexts);

        if (fallbackReason) {
            const promptAPIStatus = await checkPromptAPIAvailability();
            if (promptAPIStatus && promptAPIStatus !== 'unavailable') {
                console.warn('[Chat] Weak chat answer persisted after retry:', fallbackReason, 'Falling back to Prompt API.');
                renderSearchResults(contexts);
                await streamAIAnswer(query, contexts);
                fullText = getFullAnswerText();
                appState.answer = fullText;
                appState.results = contexts;
                appState.messages.push({ role: 'assistant', content: fullText });
                showFollowUp();
                return;
            }

            console.warn('[Chat] Prompt API unavailable for hard fallback:', promptAPIStatus, 'Using plain-text invalid response message.');
            renderSearchResults(contexts);
            initAIAnswer();
            appendAIAnswerChunk(INVALID_CHAT_RESPONSE_MESSAGE);
            fullText = getFullAnswerText();
        }

        appState.answer = fullText;

        // Finalize answer and render sources from chat
        finalizeAIAnswerWithSources(session.sources);

        // If chat returned sources, update results; otherwise keep the hybrid search results
        if (session.sources && session.sources.length > 0) {
            appState.results = session.sources;
        }

        // Append tool messages BEFORE assistant answer so next turn sees context first
        appendConversationMessages(appState.messages, session.appendMessages, 'Chat');

        // Append assistant answer to conversation history
        appState.messages.push({ role: 'assistant', content: fullText });

        console.log('[Chat] Conversation history now has', appState.messages.length, 'messages', 'toolCalls:', session.toolStats?.callCount || 0);

        // Show follow-up UI now that the answer is finalized and the container is safe
        showFollowUp();

    } catch (error) {
        console.error('[Chat] Meilisearch chat error:', error);
        appendErrorToAnswer(error.message || 'Failed to get chat answer from Meilisearch.');
    }
}

// --- AI Answer Streaming ---

async function streamAIAnswer(query, contexts) {
    initAIAnswer();

    let aiSession = null;

    try {
        aiSession = await fetchAIAnswer(query, contexts);
        
        // Model is ready now, hide the progress banner
        hideModelProgress();

        for await (const chunk of aiSession.stream) {
            appendAIAnswerChunk(chunk);
        }

        // Finalize: render markdown and wire citations
        finalizeAIAnswer();

    } catch (error) {
        console.error('AI answer error:', error);

        // If the AI panel is still showing skeleton or empty, show error there
        const aiResponse = document.getElementById('aiResponse');
        const textNode = aiResponse.querySelector('.ai-stream-text');
        if (textNode && !textNode.textContent.trim()) {
            renderError(error.message || 'Failed to get AI answer.');
        }
    } finally {
        // Cleanup AI session
        if (aiSession && aiSession.destroy) {
            aiSession.destroy();
        }
    }
}

// --- AI Answer Streaming (Adapter) ---

async function streamAdapterAnswer(query, contexts) {
    initAIAnswer();

    let aiSession = null;

    try {
        aiSession = await fetchAIAnswerViaAdapter(query, contexts);

        for await (const chunk of aiSession.stream) {
            appendAIAnswerChunk(chunk);
        }

        finalizeAIAnswer();
    } catch (error) {
        console.error('Adapter answer error:', error);
        const aiResponse = document.getElementById('aiResponse');
        const textNode = aiResponse.querySelector('.ai-stream-text');
        if (textNode && !textNode.textContent.trim()) {
            renderError(error.message || 'Failed to get AI answer from adapter.');
        }
    } finally {
        if (aiSession && aiSession.destroy) {
            aiSession.destroy();
        }
    }
}

// --- Follow-up Handler ---

async function handleFollowUp(e) {
    e.preventDefault();

    const input = document.getElementById('followUpInput');
    const query = input.value.trim();
    if (!query) return;

    console.log('[FollowUp] Query:', query);
    clearFollowUpInput();
    showLoading();

    try {
        // Create a new answer section without clearing the previous answer
        const aiResponse = document.getElementById('aiResponse');
        const sep = document.createElement('div');
        sep.className = 'my-4 border-t border-gray-600';
        aiResponse.appendChild(sep);

        // Show the follow-up question so the user knows what was asked
        const questionLabel = document.createElement('p');
        questionLabel.className = 'text-sm font-semibold text-blue-400 mb-2';
        questionLabel.textContent = 'Follow-up: ' + query;
        aiResponse.appendChild(questionLabel);

        // Create new container for streaming follow-up answer
        const mdContainer = document.createElement('div');
        mdContainer.className = 'ai-md-container mb-4';
        aiResponse.appendChild(mdContainer);

        // Set current text node for streaming into new container
        // We need to access ui.js internals — use a module trick
        const uiModule = await import('./ui.js');

        // For follow-up, we stream into the new container
        // We'll create a minimal streaming setup here
        await streamFollowUpAnswer(query, mdContainer);

        // Scroll to bottom
        aiResponse.scrollTop = aiResponse.scrollHeight;

    } catch (error) {
        console.error('[FollowUp] Error:', error);
        renderError(error.message || 'Failed to get follow-up answer.');
    } finally {
        hideLoading();
    }
}

async function streamFollowUpAnswer(query, container) {
    let session = null;

    try {
        // Run a fresh hybrid search for the follow-up query.
        // Reusing old documents from the first query yields irrelevant
        // answers when the follow-up topic drifts (e.g. first query is
        // "RMAN", follow-up is "NetBackup").
        console.log('[FollowUp] Running hybrid search for follow-up:', query);
        const hits = await searchMultiIndex(query);
        console.log('[FollowUp] Got hits:', hits.length, hits);
        appState.results = hits;

        // Update RHS with fresh results for this follow-up topic
        renderSearchResults(hits);

        // Push user message to conversation history
        appState.messages.push({ role: 'user', content: query });
        console.log('[FollowUp] Sending', appState.messages.length, 'messages to Meilisearch');

        // First attempt: let the configured workspace use its native retrieval.
        session = await chatWithMeilisearch(query, appState.messages, hits);

        let followUpText = '';
        for await (const chunk of session.stream) {
            if (typeof chunk === 'string' && chunk.length > 0) {
                followUpText += chunk;
                container.textContent = followUpText;
                const aiResponse = document.getElementById('aiResponse');
                aiResponse.scrollTop = aiResponse.scrollHeight;
            }
        }

        let fallbackReason = getWeakChatReason(followUpText, session, hits);
        if (fallbackReason) {
            console.warn('[FollowUp] Weak chat answer detected:', fallbackReason, 'Retrying tool-less with injected contexts.');
            followUpText = '';
            container.textContent = '';

            session = await chatWithMeilisearch(query, appState.messages, hits, {
                disableTools: true
            });

            for await (const chunk of session.stream) {
                if (typeof chunk === 'string' && chunk.length > 0) {
                    followUpText += chunk;
                    container.textContent = followUpText;
                    const aiResponse = document.getElementById('aiResponse');
                    aiResponse.scrollTop = aiResponse.scrollHeight;
                }
            }

            fallbackReason = getWeakChatReason(followUpText, session, hits);
        }

        // Fallback: if nothing was yielded or everything was suppressed
        if (!followUpText || followUpText.trim().length === 0) {
            followUpText = 'I apologize, but I could not generate an answer for your follow-up question. Please try rephrasing or starting a new conversation.';
            container.textContent = followUpText;
            console.warn('[FollowUp] Answer was empty after streaming — showing fallback message');
        } else if (fallbackReason) {
            followUpText = INVALID_CHAT_RESPONSE_MESSAGE;
            container.textContent = followUpText;
            console.warn('[FollowUp] Answer remained weak after retry — showing fallback message');
        }

        // Finalize: parse markdown and wire citations
        let html = marked.parse(followUpText);
        html = html.replace(
            /\[(\d+)\]/g,
            '<span class="citation-link" data-citation="$1">[$1]</span>'
        );
        container.innerHTML = html;

        appState.answer = followUpText;

        // Append tool messages BEFORE assistant answer so next turn sees context first
        appendConversationMessages(appState.messages, session.appendMessages, 'FollowUp');

        // Append assistant answer to conversation history
        appState.messages.push({ role: 'assistant', content: followUpText });

        // If chat returned sources, update RHS
        if (session.sources && session.sources.length > 0) {
            appState.results = session.sources;
            renderSearchResultsFromChat(session.sources);
        }

        console.log('[FollowUp] Conversation history now has', appState.messages.length, 'messages');

    } catch (error) {
        console.error('[FollowUp] Meilisearch chat error:', error);
        container.innerHTML = `<p class="text-red-400">Error: ${error.message || 'Failed to get follow-up answer.'}</p>`;
    } finally {
        if (session && session.destroy) {
            session.destroy();
        }
    }
}

// --- Start ---

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
