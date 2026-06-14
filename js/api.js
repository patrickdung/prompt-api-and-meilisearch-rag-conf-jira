/**
 * api.js — All asynchronous network calls.
 * Pure logic, zero DOM manipulation.
 */

import { CONFIG } from './config.js';

// --- Tool-JSON Fragment Detection ---

const TOOL_JSON_TRIGGERS = /"call_id"|"function_name"|"function_arguments"|"tool_calls"|"tool_call_id"|"_meili"|"arguments"\s*:/i;
const GENERIC_TOOL_JSON_PATTERN = /(?=[\s\S]*"name"\s*:)(?=[\s\S]*"parameters"\s*:)/i;
const JSON_FRAGMENT_PATTERN = /\{[^}]*$/; // string ending with an unclosed brace

/**
 * Detect whether a string (or its combination with surrounding text)
 * contains raw tool JSON that the LLM is leaking as plain text.
 * Handles both complete JSON objects and partial fragments across chunks.
 */
function isRawToolJsonFragment(text) {
    if (!text || typeof text !== 'string') return false;
    const trimmed = text.trim();
    const hasToolShape = TOOL_JSON_TRIGGERS.test(trimmed) || GENERIC_TOOL_JSON_PATTERN.test(trimmed);
    // If it starts with { and contains any tool trigger, suppress it
    if (trimmed.startsWith('{') && hasToolShape) {
        return true;
    }
    // If it contains a partial unclosed brace with tool trigger
    if (JSON_FRAGMENT_PATTERN.test(trimmed) && hasToolShape) {
        return true;
    }
    return false;
}

// --- Meilisearch Client ---

let meilisearchClient = null;

async function getMeilisearchClient() {
    if (meilisearchClient) return meilisearchClient;

    console.log('[Meilisearch] Loading client module from CDN...');
    try {
        const meilisearchModule = await import(
            'https://cdn.jsdelivr.net/npm/meilisearch@0.58.0/+esm'
        );
        console.log('[Meilisearch] Module loaded, exports:', Object.keys(meilisearchModule));

        // Handle various export patterns from the CDN
        const Meilisearch = meilisearchModule.default || meilisearchModule.Meilisearch || meilisearchModule;
        console.log('[Meilisearch] Constructor found:', typeof Meilisearch);

        meilisearchClient = new Meilisearch({
            host: CONFIG.MEILISEARCH_HOST,
            apiKey: CONFIG.MEILISEARCH_KEY || undefined
        });
        console.log('[Meilisearch] Client initialized for host:', CONFIG.MEILISEARCH_HOST);

        return meilisearchClient;
    } catch (err) {
        console.error('[Meilisearch] Failed to load client:', err);
        throw err;
    }
}

/**
 * Search multiple Meilisearch indexes and merge results.
 * @param {string} query — User search query
 * @returns {Promise<Array>} — Array of hit objects
 */
export async function searchMultiIndex(query) {
    console.log('[Meilisearch] Starting multi-index search for:', query);
    const client = await getMeilisearchClient();

    const indexConfigs = [
        {
            name: 'confluence',
            attrs: ['id', 'title', 'body', 'space', 'uri', 'url']
        },
        {
            name: 'jira',
            attrs: ['id', 'key', 'title', 'body', 'project', 'url', 'status', 'assignee', 'labels', 'created', 'updated', 'issue_type']
        }
    ];

    const searchOptionsBase = {
        hybrid: {
            semanticRatio: CONFIG.HYBRID_SEMANTIC_RATIO,
            embedder: CONFIG.HYBRID_EMBEDDER
        },
        limit: CONFIG.SEARCH_LIMIT,
        showRankingScore: true
    };

    const searches = indexConfigs.map(async (cfg) => {
        try {
            const index = client.index(cfg.name);
            const opts = { ...searchOptionsBase, attributesToRetrieve: cfg.attrs };
            console.log(`[Meilisearch] Searching index "${cfg.name}" with options:`, opts);
            const response = await index.search(query, opts);
            const hits = (response.hits || []).map(h => ({ ...h, _sourceIndex: cfg.name }));
            console.log(`[Meilisearch] Index "${cfg.name}" returned ${hits.length} hits`);
            return hits;
        } catch (err) {
            console.warn(`[Meilisearch] Index "${cfg.name}" search failed:`, err.message);
            return [];
        }
    });

    const results = await Promise.allSettled(searches);
    let allHits = [];
    results.forEach((res, idx) => {
        if (res.status === 'fulfilled') {
            allHits.push(...res.value);
        } else {
            console.warn(`[Meilisearch] Index "${indexConfigs[idx].name}" rejected:`, res.reason?.message);
        }
    });

    // Sort merged results by Meilisearch ranking score (descending)
    allHits.sort((a, b) => (b._rankingScore ?? 0) - (a._rankingScore ?? 0));

    console.log(`[Meilisearch] Merged ${allHits.length} hits from all indexes`);
    if (allHits.length > 0) {
        console.log('[Meilisearch] First hit fields:', Object.keys(allHits[0]));
        console.log('[Meilisearch] First hit source:', allHits[0]._sourceIndex);
    }
    return allHits;
}

// Backward-compat alias
export const searchMeilisearch = searchMultiIndex;

// --- Meilisearch Conversation Search (/chats) ---

/**
 * Accumulator for streaming OpenAI-style tool calls across multiple SSE chunks.
 * Each tool call is keyed by its `index` in the chunk.
 */
class ToolCallAccumulator {
    constructor() {
        this.calls = new Map(); // index -> { id, type, name, argumentsParts: [] }
    }

    /**
     * @param {object} delta — chunk.choices[0].delta
     */
    feed(delta) {
        const toolCalls = delta?.tool_calls;
        if (!Array.isArray(toolCalls)) return;

        for (const tc of toolCalls) {
            const idx = tc.index ?? 0;
            if (!this.calls.has(idx)) {
                this.calls.set(idx, { id: tc.id || '', type: tc.type || 'function', name: '', argumentsParts: [] });
            }
            const call = this.calls.get(idx);
            if (tc.id) call.id = tc.id;
            if (tc.type) call.type = tc.type;
            if (tc.function?.name) call.name = tc.function.name;
            if (typeof tc.function?.arguments === 'string') {
                call.argumentsParts.push(tc.function.arguments);
            }
        }
    }

    /**
     * After finish_reason === 'tool_calls', build complete tool-call objects.
     * @returns {Array<{id, type, name, arguments}>}
     */
    finalize() {
        const result = [];
        const indices = Array.from(this.calls.keys()).sort((a, b) => a - b);
        for (const idx of indices) {
            const call = this.calls.get(idx);
            const args = call.argumentsParts.join('');
            result.push({ id: call.id, type: call.type, name: call.name, arguments: args });
        }
        return result;
    }

    clear() {
        this.calls.clear();
    }
}

/**
 * Call Meilisearch /chats/{workspace}/chat/completions with multi-turn context.
 * Handles SSE streaming, tool-call accumulation, and source extraction.
 * @param {string} query — User query (last user turn)
 * @param {Array<{role:string,content:string}>} messages — Full conversation history
 * @param {Array} contexts — Retrieved documents for optional prompt injection
 * @param {{forceContextInjection?: boolean, disableTools?: boolean}} options — Per-request chat overrides
 * @returns {Promise<{stream: AsyncGenerator<string>, sources: Array, appendMessages: Array, toolStats: object, destroy: Function}>}
 */
export async function chatWithMeilisearch(query, messages = [], contexts = [], options = {}) {
    const workspace = CONFIG.MEILISEARCH_CHAT_WORKSPACE || 'confluence';
    const model = CONFIG.MEILISEARCH_CHAT_MODEL || 'ministral3-offline:latest';
    const host = CONFIG.MEILISEARCH_HOST.replace(/\/$/, '');
    const url = `${host}/chats/${workspace}/chat/completions`;
    const hasContexts = Array.isArray(contexts) && contexts.length > 0;
    const shouldSendTools = !options.disableTools && CONFIG.MEILISEARCH_CHAT_NATIVE_TOOLS;

    // Build messages array with context injection
    // Deep-copy each message so mutating content here does not corrupt appState.messages.
    let chatMessages = messages.length > 0 ? messages.map(m => ({...m})) : [{ role: 'user', content: query }];

    // When tools are disabled, strip previous tool and tool_call messages from history
    // to prevent the LLM from reflexively calling or hallucinating tools.
    if (options.disableTools) {
        const originalCount = chatMessages.length;
        chatMessages = chatMessages.filter(m => m.role !== 'tool');
        // Also strip tool_calls from assistant messages so the LLM isn't primed
        chatMessages = chatMessages.map(m => {
            if (m.role === 'assistant' && m.tool_calls) {
                const clone = { ...m };
                delete clone.tool_calls;
                console.log('[Chat] Stripped tool_calls from assistant message');
                return clone;
            }
            return m;
        });
        if (chatMessages.length < originalCount) {
            console.log('[Chat] Stripped', originalCount - chatMessages.length, 'tool messages from history for tool-less request');
        }
    }

    // ALWAYS inject contexts when available, regardless of native tool mode.
    // The LLM needs the document text to ground its answer. If native tools
    // are also enabled, the LLM may choose to call them for additional sources.
    if (hasContexts) {
        const contextPrefix = CONFIG.getRagContextPrefix(contexts);
        const ragPrefix = `${CONFIG.RAG_INSTRUCTIONS}${contextPrefix}\n\nQuestion: `;

        // Prepend context to the LAST user message only
        const lastUserIdx = chatMessages.map(m => m.role).lastIndexOf('user');
        if (lastUserIdx >= 0) {
            const userMsg = chatMessages[lastUserIdx];
            userMsg.content = ragPrefix + userMsg.content;
        } else {
            // No user message yet — shouldn't happen, but just in case
            chatMessages.push({ role: 'user', content: ragPrefix + query });
        }
        console.log('[Chat] Injected', contexts.length, 'documents into last user message');
    }

    const requestBody = {
        model,
        stream: true,
        messages: chatMessages,
        temperature: CONFIG.PROMPT_API_OPTIONS.temperature ?? 0.8
    };

    // Always send tools in native mode; otherwise only when no pre-injected contexts.
    // Use minimal tool definitions (no schemas/strict) for ministral3/ollama compatibility.
    if (shouldSendTools) {
        requestBody.tools = [
            {
                type: 'function',
                function: {
                    name: '_meiliSearchProgress',
                    description: 'Reports real-time search progress to the user'
                }
            },
            {
                type: 'function',
                function: {
                    name: '_meiliSearchSources',
                    description: 'Provides sources and references for the information'
                }
            },
            {
                type: 'function',
                function: {
                    name: '_meiliAppendConversationMessage',
                    description: 'Appends internal context to maintain conversation history'
                }
            }
        ];
    }

    console.log('[Chat] POST', url, 'messages:', requestBody.messages.length, 'hasContexts:', hasContexts, 'sendTools:', shouldSendTools);

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${CONFIG.MEILISEARCH_CHAT_KEY || CONFIG.MEILISEARCH_KEY}`
        },
        body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
        const text = await response.text().catch(() => 'Unknown error');
        throw new Error(`Meilisearch chat error ${response.status}: ${text}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const accumulator = new ToolCallAccumulator();
    const sources = [];
    const appendMessages = [];
    const toolStats = {
        callCount: 0,
        names: [],
        sourceDocumentCount: 0,
        appendMessageCount: 0,
        usedNativeTools: shouldSendTools,
        usedContextInjection: hasContexts,
        sentTools: shouldSendTools
    };

    let streamClosed = false;
    let chunkCount = 0;

    async function* streamChunks() {
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) {
                    console.log('[Chat] SSE stream DONE. Total chunks:', chunkCount);
                    break;
                }

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop(); // keep incomplete line in buffer

                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed || !trimmed.startsWith('data: ')) continue;

                    const data = trimmed.slice(6).trim();
                    if (data === '[DONE]') {
                        console.log('[Chat] [DONE] marker');
                        continue;
                    }

                    try {
                        const chunk = JSON.parse(data);
                        chunkCount++;
                        if (chunkCount <= 5 || chunk.choices?.[0]?.finish_reason) {
                            console.log('[Chat] Chunk #' + chunkCount, JSON.stringify(chunk).substring(0, 400));
                        }

                        const choice = chunk.choices?.[0];
                        if (!choice) {
                            console.warn('[Chat] No choice in chunk');
                            continue;
                        }

                        const delta = choice.delta;
                        const finishReason = choice.finish_reason;

                        if (delta?.tool_calls) {
                            console.log('[Chat] Tool call delta:', JSON.stringify(delta.tool_calls).substring(0, 200));
                            accumulator.feed(delta);
                        }

                        if (finishReason === 'tool_calls') {
                            console.log('[Chat] finish_reason=tool_calls');
                            const calls = accumulator.finalize();
                            toolStats.callCount += calls.length;
                            toolStats.names.push(...calls.map(call => call.name).filter(Boolean));
                            console.log('[Chat] Tool calls finalized:', calls.map(c => ({name: c.name, argsLen: c.arguments.length})));
                            for (const call of calls) {
                                if (call.name === '_meiliSearchSources') {
                                    try {
                                        const payload = JSON.parse(call.arguments);
                                        console.log('[Chat] SearchSources keys:', Object.keys(payload));
                                        if (Array.isArray(payload.documents)) {
                                            sources.push(...payload.documents);
                                            toolStats.sourceDocumentCount += payload.documents.length;
                                            console.log('[Chat] Got documents:', payload.documents.length);
                                        } else {
                                            console.warn('[Chat] documents not array:', payload);
                                        }
                                    } catch (e) {
                                        console.warn('[Chat] Parse error:', e, call.arguments.substring(0, 200));
                                    }
                                } else if (call.name === '_meiliAppendConversationMessage') {
                                    try {
                                        const payload = JSON.parse(call.arguments);
                                        if (payload.message) {
                                            appendMessages.push(payload.message);
                                            toolStats.appendMessageCount += 1;
                                            console.log('[Chat] Append msg');
                                        }
                                    } catch (e) {
                                        console.warn('[Chat] Append parse error:', e);
                                    }
                                }
                            }
                            accumulator.clear();
                            continue;
                        }

                        const content = delta?.content;
                        if (typeof content === 'string' && content.length > 0) {
                            if (isRawToolJsonFragment(content)) {
                                console.warn('[Chat] Suppressed raw tool JSON fragment:', content.substring(0, 120));
                            } else {
                                console.log('[Chat] Yielding:', content.substring(0, 80));
                                yield content;
                            }
                        } else if (finishReason) {
                            console.log('[Chat] finish_reason:', finishReason, 'content:', JSON.stringify(content));
                        }
                    } catch (e) {
                        console.warn('[Chat] Parse error on line:', e.message, line.substring(0, 200));
                    }
                }
            }
        } finally {
            streamClosed = true;
            console.log('[Chat] Stream closed. Sources:', sources.length, 'AppendMessages:', appendMessages.length);
            try { reader.releaseLock(); } catch (_) {}
        }
    }

    return {
        stream: streamChunks(),
        sources,
        appendMessages,
        toolStats,
        destroy: () => {
            if (!streamClosed) {
                try { reader.cancel(); } catch (_) {}
            }
        }
    };
}

// --- Adapter (OpenAI-compatible LLM proxy) ---

/**
 * Fetch an AI answer via the adapter using OpenAI-compatible streaming.
 * @param {string} query — User query
 * @param {Array} contexts — Retrieved Meilisearch documents
 * @returns {Promise<{stream: AsyncGenerator<string>, destroy: Function}>}
 */
export async function fetchAIAnswerViaAdapter(query, contexts) {
    if (!CONFIG.USE_ADAPTER) {
        throw new Error('Adapter is disabled in config');
    }

    const contextPrefix = CONFIG.getRagContextPrefix(contexts);
    const fullPrompt = `${contextPrefix}\n\nQuestion: ${query}`;

    const messages = [
        {
            role: 'system',
            content: CONFIG.PROMPT_API_SYSTEM_PROMPT
        },
        {
            role: 'user',
            content: fullPrompt
        }
    ];

    const requestBody = {
        model: CONFIG.ADAPTER_MODEL || 'llama3',
        stream: true,
        messages,
        temperature: CONFIG.PROMPT_API_OPTIONS.temperature ?? 0.8
    };

    const headers = {
        'Content-Type': 'application/json'
    };
    if (CONFIG.ADAPTER_API_KEY) {
        headers['Authorization'] = `Bearer ${CONFIG.ADAPTER_API_KEY}`;
    }

    const response = await fetch(`${CONFIG.ADAPTER_URL.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
        const text = await response.text().catch(() => 'Unknown error');
        throw new Error(`Adapter error ${response.status}: ${text}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    async function* streamChunks() {
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop(); // keep incomplete line in buffer

                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed || !trimmed.startsWith('data: ')) continue;

                    const data = trimmed.slice(6).trim();
                    if (data === '[DONE]') return;

                    try {
                        const chunk = JSON.parse(data);
                        const content = chunk.choices?.[0]?.delta?.content;
                        if (typeof content === 'string' && content.length > 0) {
                            yield content;
                        }
                    } catch (e) {
                        // Skip unparseable lines
                    }
                }
            }
        } finally {
            reader.releaseLock();
        }
    }

    return {
        stream: streamChunks(),
        destroy: () => {
            try {
                reader.cancel();
            } catch (_) {}
        }
    };
}

// --- Prompt API (On-Device LLM) ---

let _cachedApi = null;

/**
 * Comprehensive diagnostic: log everything about the AI API namespace.
 */
function diagnoseAI() {
    console.group('=== AI API Diagnostics ===');

    // Check LanguageModel global
    console.log('typeof LanguageModel:', typeof LanguageModel);
    if (typeof LanguageModel !== 'undefined') {
        console.log('LanguageModel keys:', Object.keys(LanguageModel));
        console.log('LanguageModel.create:', typeof LanguageModel.create);
    }

    // Check globalThis.ai
    console.log('typeof globalThis.ai:', typeof globalThis.ai);
    console.log('globalThis === window:', globalThis === window);

    // Check 'ai' in window (property existence vs value)
    console.log("'ai' in window:", 'ai' in window);
    console.log("'ai' in globalThis:", 'ai' in globalThis);
    console.log("Object.getOwnPropertyNames(window) includes 'ai':", Object.getOwnPropertyNames(window).includes('ai'));
    console.log("Object.getOwnPropertyDescriptor(window, 'ai'):", Object.getOwnPropertyDescriptor(window, 'ai'));

    // Check window.ai
    console.log('typeof window.ai:', typeof window.ai);
    if (window.ai) {
        console.log('window.ai keys:', Object.keys(window.ai));
        console.log('window.ai.languageModel:', window.ai.languageModel);
        console.log('typeof window.ai.create:', typeof window.ai.create);
        console.log('typeof window.ai.availability:', typeof window.ai.availability);
        console.log('typeof window.ai.canCreate:', typeof window.ai.canCreate);
        console.log('typeof window.ai.createTextSession:', typeof window.ai.createTextSession);
        console.log('typeof window.ai.assistant:', typeof window.ai.assistant);
        console.log('typeof window.ai.prompt:', typeof window.ai.prompt);
        console.log('typeof window.ai.model:', typeof window.ai.model);

        if (window.ai.languageModel) {
            console.log('window.ai.languageModel keys:', Object.keys(window.ai.languageModel));
            console.log('typeof window.ai.languageModel.create:', typeof window.ai.languageModel.create);
            console.log('typeof window.ai.languageModel.availability:', typeof window.ai.languageModel.availability);
            console.log('typeof window.ai.languageModel.capabilities:', typeof window.ai.languageModel.capabilities);
        }
    }

    // Check chrome namespace
    console.log('typeof chrome:', typeof chrome);
    if (typeof chrome !== 'undefined') {
        console.log('typeof chrome.ai:', typeof chrome.ai);
        if (chrome.ai) {
            console.log('chrome.ai keys:', Object.keys(chrome.ai));
        }
    }

    // Check navigator
    console.log('typeof navigator.ai:', typeof (navigator && navigator.ai));
    console.log("'ai' in navigator:", navigator && 'ai' in navigator);
    if (navigator && navigator.ai) {
        console.log('navigator.ai keys:', Object.keys(navigator.ai));
    }

    console.groupEnd();
}

/**
 * Detect the Prompt API availability.
 * Tries multiple known API paths to support different Chrome versions.
 * @returns {object|null} — The API constructor/object or null
 */
function getPromptAPI() {
    if (_cachedApi) return _cachedApi;

    diagnoseAI();

    try {
        // Path 1: Global LanguageModel constructor (older/experimental builds)
        if (typeof LanguageModel !== 'undefined' && typeof LanguageModel.create === 'function') {
            console.log('Prompt API found via: LanguageModel global');
            _cachedApi = LanguageModel;
            return _cachedApi;
        }

        // Path 2: window.ai.languageModel.create (newer stable Chrome)
        if (window.ai && window.ai.languageModel && typeof window.ai.languageModel.create === 'function') {
            console.log('Prompt API found via: window.ai.languageModel');
            _cachedApi = window.ai.languageModel;
            return _cachedApi;
        }

        // Path 3: window.ai itself might be the API object with .create()
        if (window.ai && typeof window.ai.create === 'function') {
            console.log('Prompt API found via: window.ai (direct create)');
            _cachedApi = window.ai;
            return _cachedApi;
        }

        // Path 4: window.ai.createTextSession (very old Chrome builds)
        if (window.ai && typeof window.ai.createTextSession === 'function') {
            console.log('Prompt API found via: window.ai.createTextSession');
            _cachedApi = window.ai;
            return _cachedApi;
        }

        // Path 5: navigator.ai (alternative namespace)
        if (typeof navigator !== 'undefined' && navigator.ai && navigator.ai.languageModel) {
            console.log('Prompt API found via: navigator.ai.languageModel');
            _cachedApi = navigator.ai.languageModel;
            return _cachedApi;
        }

        // Path 6: chrome.ai (extension-like namespace)
        if (typeof chrome !== 'undefined' && chrome.ai && chrome.ai.languageModel) {
            console.log('Prompt API found via: chrome.ai.languageModel');
            _cachedApi = chrome.ai.languageModel;
            return _cachedApi;
        }
    } catch (e) {
        console.warn('Prompt API detection error:', e);
    }

    console.warn('Prompt API not found after exhaustive search.');
    return null;
}

/**
 * Check if the Prompt API is available.
 * Tries availability() first, falls back to create() for a quick probe.
 * @returns {Promise<string>} — Availability status string
 */
export async function checkPromptAPIAvailability() {
    const api = getPromptAPI();
    if (!api) {
        console.warn('checkPromptAPIAvailability: getPromptAPI() returned null');
        return 'unavailable';
    }

    console.log('checkPromptAPIAvailability: api found, type of availability:', typeof api.availability, 'type of create:', typeof api.create);

    // First try the availability() method
    if (typeof api.availability === 'function') {
        try {
            const status = await api.availability({ outputLanguage: 'en' });
            console.log('Prompt API availability:', status);
            return status;
        } catch (e) {
            console.warn('availability() failed, will try probe:', e);
        }
    }

    // Fallback: try creating a session and immediately destroy it
    if (typeof api.create === 'function') {
        let probeSession = null;
        try {
            probeSession = await api.create({
                systemPrompt: 'You are a helpful assistant.',
                temperature: 0.1,
                topK: 1
            });
            console.log('Prompt API probe: create() succeeded');
            try { probeSession.destroy(); } catch (_) {}
            return 'available';
        } catch (e) {
            console.warn('Prompt API probe create() failed:', e);
            if (probeSession) {
                try { probeSession.destroy(); } catch (_) {}
            }
        }
    }

    return 'unavailable';
}

/**
 * Fetch an AI answer using the Prompt API with RAG context.
 * @param {string} query — User query
 * @param {Array} contexts — Retrieved Meilisearch documents
 * @returns {Promise<AsyncGenerator>} — Stream of answer chunks
 */
export async function fetchAIAnswer(query, contexts) {
    const api = getPromptAPI();
    if (!api) {
        throw new Error('Prompt API not available. Please enable Chrome flags and download the model.');
    }

    // Build the full prompt: instructions + documents + reminder + question.
    // On-device models often ignore systemPrompt, so we put directives
    // directly into the user prompt — right before the question.
    const contextPrefix = CONFIG.getRagContextPrefix(contexts);
    const citationReminder = 'Remember: cite the documents using [1], [2], [3], etc. after every fact.\n';
    const fullPrompt = `${CONFIG.PROMPT_API_SYSTEM_PROMPT}\n\n${contextPrefix}\n${citationReminder}\nQuestion: ${query}`;

    // Build options
    const options = {
        temperature: CONFIG.PROMPT_API_OPTIONS.temperature,
        topK: CONFIG.PROMPT_API_OPTIONS.topK,
        systemPrompt: 'You are a helpful assistant.',
        expectedOutputs: [{ type: 'text', language: 'en' }],
        // Monitor model download progress (first-time use)
        monitor: (m) => {
            m.addEventListener('downloadprogress', (event) => {
                const percent = event.total > 0
                    ? Math.round((event.loaded / event.total) * 100)
                    : 0;
                console.log(`Model download: ${percent}% (${event.loaded}/${event.total})`);
                // Dispatch a custom event for the UI to pick up
                window.dispatchEvent(new CustomEvent('modelDownloadProgress', {
                    detail: { loaded: event.loaded, total: event.total, percent }
                }));
            });
        }
    };

    // Create session
    const session = await api.create(options);

    // Return both the stream and a cleanup function
    const rawStream = session.promptStreaming(fullPrompt);

    // Sanitize stream: strip JSON/tool-call artifacts that on-device models
    // sometimes emit (e.g. {"name":"Upgrade","parameters":{...}}).
    async function* sanitizeStream() {
        const jsonPattern = /\{[\s\S]*?"(?:name|parameters|index_uid|q|filter)"[\s\S]*?\}/g;
        for await (const chunk of rawStream) {
            if (typeof chunk === 'string') {
                const cleaned = chunk.replace(jsonPattern, '');
                if (cleaned.length > 0) yield cleaned;
            } else {
                yield chunk;
            }
        }
    }

    const stream = sanitizeStream();

    // Wrap the stream to handle cleanup after it's done
    return {
        stream,
        destroy: () => {
            try {
                session.destroy();
            } catch (e) {
                // Ignore errors during cleanup
            }
        }
    };
}
