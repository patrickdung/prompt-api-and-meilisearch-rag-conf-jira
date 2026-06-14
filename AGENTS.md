# Specification: Vanilla JS Frontend Interface to query Meilisearch with RAG

> **Architecture note:** A Rust adapter (`adapter/`) is included in this repo to normalize Ollama/LiteLLM SSE streaming responses into strict OpenAI-compatible chunks for Meilisearch's conversational-search API. The frontend itself uses the browser's on-device Prompt API for answer generation; the adapter is only needed if you want Meilisearch's `/chats` endpoint to talk to Ollama. See `adapter/src/main.rs` and `adapter/Cargo.toml`.

## Adapter quickstart
```bash
cd adapter
cargo build --release
LISTEN_ADDR=0.0.0.0:8080 UPSTREAM_BASE_URL=http://ollama:11434/v1 ./target/release/meili-chat-adapter
```

## Adapter environment variables
| Variable | Default | Description |
|----------|---------|-------------|
| `LISTEN_ADDR` | `127.0.0.1:8080` | Address the adapter listens on |
| `UPSTREAM_BASE_URL` | `http://127.0.0.1:4000` | Base URL of the LLM provider (Ollama/LiteLLM) |

## Meilisearch chat settings via adapter

The workspace is configured with a **unified** setup that can search across multiple indexes (`confluence` and `jira`). The LLM must be explicitly instructed to choose the correct index.

```bash
curl -X PATCH "${MEILISEARCH_URL}/chats/${WORKSPACE}/settings" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  --data-binary '{
    "source": "openAi",
    "baseUrl": "http://adapter-host:8080",
    "prompts": {
      "system": "You are a helpful assistant for the knowledge base. You have access to two indexes: confluence (wiki documents) and jira (tickets, bugs, tasks). When searching, choose the correct index based on the query. For wiki articles, documentation, guides, or general knowledge, use confluence. For tickets, bugs, issues, or project tasks, use jira. NEVER invent an index name. If unsure, search confluence first.",
      "searchDescription": "Query: database backup documentation\nAvailable indexes: confluence, jira\nAnswer: {\"q\": \"database backup\", \"index_uid\": \"confluence\"}\n\nQuery: high priority bugs in PROJECT-X from 2022\nAvailable indexes: confluence, jira\nAnswer: {\"q\": \"bugs\", \"filter\": \"project = PROJECT-X AND priority = High\", \"index_uid\": \"jira\"}\n\nQuery: software installation guide\nAvailable indexes: confluence, jira\nAnswer: {\"q\": \"software installation\", \"index_uid\": \"confluence\"}\n\nQuery: closed tickets assigned to username\nAvailable indexes: confluence, jira\nAnswer: {\"q\": \"\", \"filter\": \"assignee = username AND status = Closed\", \"index_uid\": \"jira\"}\n\nQuery: migration tasks\nAvailable indexes: confluence, jira\nAnswer: {\"q\": \"migration\", \"filter\": \"type = Task\", \"index_uid\": \"jira\"}\n\nQuery: configuration password issue\nAvailable indexes: confluence, jira\nAnswer: {\"q\": \"configuration password\", \"index_uid\": \"jira\"}\n\nQuery: environment setup documentation\nAvailable indexes: confluence, jira\nAnswer: {\"q\": \"environment setup\", \"index_uid\": \"confluence\"}\n\nCRITICAL: index_uid must be EXACTLY \"confluence\" or \"jira\". Extract keywords from the query and put them in q, NOT in index_uid. Never create index names from query terms.",
      "searchQParam": "The search query string. Use keywords that best represent what the user is looking for. More specific queries yield more precise results.",
      "searchFilterParam": "The search filter string. Supports parentheses, =, !=, >=, >, <=, <, IN, NOT IN, TO, EXISTS, NOT EXISTS, IS NULL, IS NOT NULL, IS EMPTY, IS NOT EMPTY, _geoRadius, _geoBoundingBox. Example: \"project = DEVJOBS AND status = Closed\". CRITICAL: Only use fields listed below. Do not invent field names.\n\nFor index confluence, available fields: space, title, body, uri\nFor index jira, available fields: project, status, issue_type, assignee, labels, created, updated, key, title, body",
      "searchIndexUidParam": "CRITICAL: Choose the correct index. Use confluence for wiki articles, documentation, and general knowledge. Use jira for tickets, bugs, issues, and tasks. These are the ONLY valid index names. Never invent an index name from the query."
    }
  }'
```

## 1. Objective / File Structure
Build a modular, lightweight frontend for a Meilisearch RAG system using modern Vanilla JavaScript (ES6+), HTML5, and Tailwind CSS.

The frontend supports **two AI modes**, selectable by the user:
1. **On-Device AI (Prompt API)** — Uses the browser's built-in on-device language model.
2. **Meilisearch Conversation Search** — Uses Meilisearch's `/chats` endpoint with SSE streaming.
3. Refer to https://github.com/meilisearch/documentation/tree/main/capabilities/conversational_search on how conversational search/chat works in Meilisearch

## 2. Original Documents and RAG via Meilisearch
- The original documents come from two sources:
  1. **Atlassian Confluence (non-cloud)** — Wiki pages stored in the `confluence` index.
  2. **Atlassian JIRA** — Tickets, bugs, and tasks stored in the `jira` index.
- An external system pulls both sources and indexes them into Meilisearch with AI embeddings.
- The frontend uses the **Chrome browser Prompt API**:
  - https://learn.microsoft.com/en-us/microsoft-edge/web-platform/prompt-api
  - https://developer.chrome.com/docs/ai/get-started
- User asks a question via the frontend:
  1. The website searches RAG via **multi-index hybrid search** across both `confluence` and `jira`.
     - Hybrid search: https://www.meilisearch.com/docs/capabilities/hybrid_search/overview
  2. Retrieved results from both indexes are merged and sorted by Meilisearch ranking score.
  3. Retrieved documents are returned to the browser:
     - **Max 6 results** displayed (combined from all indexes).
     - Each result shows a **summary of max 300 characters**.
     - Each result provides a **clickable hyperlink** to `url`.
     - JIRA results show additional metadata: `key`, `project`, `status`, `issue_type`.
  4. The retrieved documents are sent to the selected AI provider as context.
  5. The AI answer is **streamed** into the left panel.
  6. The AI is instructed to **auto-generate citations** using `[1]`, `[2]`, etc.
  7. Clicking a citation highlights the corresponding source document card.

## 3. File Structure
Strictly adhere to this structure:
```
├── index.html          # Clean structure, semantic layout, structural layout only
├── styles.css          # Custom overrides (Tailwind loaded via CDN)
├── AGENTS.md           # This specification file
├── run-adapter.sh      # Helper script to start the Rust adapter
├── adapter/            # Rust adapter (see Architecture note)
│   ├── Cargo.toml
│   └── src/main.rs
└── js/
    ├── config.js       # Environment variables and API endpoints
    ├── api.js          # Meilisearch client, Prompt API, adapter, and chat fetch requests
    ├── ui.js           # DOM manipulation and component templates
    └── app.js          # Orchestrator / Event listeners (App initialization)
```

## 4. Dependencies & CDNs
In `index.html`, use the following official CDNs. Do not install NPM packages unless requested.
* **Tailwind CSS:** `<script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4.3.0"></script>`
* **Meilisearch Client:** `<script type="module"> import meilisearch from 'https://cdn.jsdelivr.net/npm/meilisearch@0.58.0/+esm' </script>`
* **Markdown parser:** `<script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>`

## 5. AI Mode Selection
The user **must** be able to explicitly choose the AI mode. Do **not** use auto-detection.

### UI: Mode Switch
In `index.html`, a static `<select id="aiModeSelect">` with two options is rendered inside `#aiModeContainer`:
* Option 1: `prompt-api` — label: "On-Device AI (Prompt API)"
* Option 2: `meilisearch-chat` — label: "Meilisearch Conversation Search"
* A live badge `<span id="aiModeBadge">` shows the currently active mode in color:
  - Green badge: "On-Device AI"
  - Blue badge: "Meilisearch Chat"
* Status text `#apiStatus` shows: "Mode: On-Device AI" or "Mode: Meilisearch Chat".
* **Meilisearch Chat Only:** A hint text appears near the mode selector stating "Follow-up questions available after the first answer in Meilisearch Conversation Search mode." This helps users understand when the follow-up input becomes available.

### Persistence
* The selected mode is stored in `sessionStorage` under key `aiMode`.
* On page load, `app.js` restores the saved mode and applies it to the `<select>`.
* Changing the `<select>` dispatches a `CustomEvent('aiModeChange')` with `detail: { mode }`.

### Behavior per Mode
| Aspect | Prompt API Mode | Meilisearch Chat Mode |
|--------|-----------------|----------------------|
| Hybrid search | Yes (Meilisearch) | Yes (Meilisearch) |
| AI provider | Browser Prompt API (`LanguageModel` or `window.ai.languageModel`) | Meilisearch `/chats/{workspace}/chat/completions` |
| Streaming | `promptStreaming()` | SSE (Server-Sent Events) over fetch |
| Context | Retrieved documents injected into system prompt | Prepended to the **last user message** (upstream model templates reject `role: system`) |
| Sources | Rendered from Meilisearch hits | Rendered from Meilisearch hits on RHS; chat tool-call sources used as fallback |
| Session | New session per query; old session destroyed | Conversation history kept in `appState.messages` |
| Prompt API probing | Probed on init (30s timeout) | **Skipped** — no background probing |
| Follow-up | N/A (one-shot per query) | **Follow-up input** appears after first answer; "New conversation" resets history |

## 6. Module Responsibilities

### A. js/config.js
Export a `CONFIG` object containing:
* `MEILISEARCH_HOST`, `MEILISEARCH_KEY`, `MEILISEARCH_INDEX` (legacy single index)
* `MEILISEARCH_INDEXES` — Array of index names to search: `['confluence', 'jira']`
* `HYBRID_SEMANTIC_RATIO` (0.5), `HYBRID_EMBEDDER` (`embedder_granite`), `SEARCH_LIMIT` (6)
* `PROMPT_API_OPTIONS` — Model options (temperature, topK)
* `PROMPT_API_SYSTEM_PROMPT` — Base system prompt for the RAG answer
* `getRagContextPrefix(contexts)` — Template function injecting retrieved documents into prompt. Handles both Confluence (`space`, `title`, `body`) and JIRA (`key`, `project`, `status`, `issue_type`, `title`, `body`) document types. For JIRA with empty body, synthesizes descriptive content from metadata.
* **Meilisearch Chat settings:**
  - `MEILISEARCH_CHAT_WORKSPACE` — `'unified'` (multi-index workspace)
  - `MEILISEARCH_CHAT_MODEL` — e.g. `'llama3.2:3b'`
  - `MEILISEARCH_CHAT_KEY` — API key for `/chats` endpoint (may need broader permissions)
  - `MEILISEARCH_CHAT_NATIVE_TOOLS` — Boolean; when true, sends `_meiliSearchSources`/`_meiliAppendConversationMessage` tools. May be disabled on fallback.
* `AI_MODE` — default mode string (`'prompt-api'` or `'meilisearch-chat'`)

### B. js/api.js
Handle all asynchronous network calls. No DOM manipulation. Implement and export:

#### Multi-Index Hybrid Search
* `searchMultiIndex(query)`: Uses the Meilisearch client CDN module to query **both** `confluence` and `jira` indexes in parallel with hybrid search (`semanticRatio: 0.5`, `embedder: "embedder_granite"`, `limit: 6` per index). Results are merged and sorted by `_rankingScore` descending. Each hit gets `_sourceIndex` field. Backward-compat alias: `searchMeilisearch`.

#### Prompt API
* `checkPromptAPIAvailability()`: Probes multiple API paths with 30s timeout. Returns availability status string.
* `fetchAIAnswer(query, contexts)`: Creates a Prompt API session with RAG system prompt, streams answer via `promptStreaming()`.
  - **Detection order:**
    1. `typeof LanguageModel !== 'undefined'` → use `LanguageModel`
    2. Else `window.ai && window.ai.languageModel` → use `window.ai.languageModel`
  - **Streaming chunk handling:** The Prompt API may return the full accumulated string in each chunk. Detect this and append only the delta (new characters) to avoid duplication.
  - **Session strategy:** Recreate the Prompt API session per query with fresh RAG context, destroying the previous session to free resources.

#### Meilisearch Conversation Search (`/chats`)
* `chatWithMeilisearch(query, messages, contexts)`: Calls `POST /chats/{workspace}/chat/completions` with SSE streaming.
  - **Deep-copy messages:** Incoming `messages` array is deep-copied via `messages.map(m => ({...m}))` so that prepending the RAG context to the last user message does **not** corrupt the conversation history stored in `appState.messages`.
  - **RAG context injection:** When `contexts` (hybrid search hits) are provided, the retrieved documents are **prepended to the last user message's content**, NOT added as a `role: system` message. Many upstream model templates (e.g. Ollama/LiteLLM via the adapter) only support `user`, `assistant`, and `tool` roles and will return a 500 if `system` is used.
  - **Native tools enabled:** `tools` are sent in the request body (including `_meiliSearchSources`, `_meiliSearchProgress`, and `_meiliAppendConversationMessage`) to allow the model to search independently. However, when `contexts` are pre-injected (first search or follow-up with already-retrieved hits), the model is expected to ground its answer in those provided documents.
  - Request body includes `stream: true`, `messages` array, `temperature`.
  - Returns `{ stream: AsyncGenerator<string>, sources: Array, appendMessages: Array, destroy: Function }`.
  - **Tool Call Accumulator (`ToolCallAccumulator`):**
    - Incrementally accumulates `delta.tool_calls` across SSE chunks keyed by `index`.
    - When `finish_reason === 'tool_calls'`, calls `.finalize()` to build complete tool-call objects.
    - Parses `_meiliSearchSources` → extracts `sources` array.
    - Parses `_meiliAppendConversationMessage` → extracts conversation append messages (subject to validation).
  - **Weak-answer detection (first-turn fallback):** If the native-tool response is empty, does not include sources from the search, or contains meta-tool refusal language (e.g., "filter", "not support", "cannot"), a fallback retry is triggered immediately.
  - **Fallback path:** On weak-answer detection, `chatWithMeilisearch()` is called a second time with `contexts` pre-injected (hybrid search results) and `MEILISEARCH_CHAT_NATIVE_TOOLS` temporarily disabled for that retry only. This ensures a grounded answer even if native tools fail. The fallback is logged as `[Chat] Fallback triggered: weak answer detected`.
  - **SSE parsing:** Reads `response.body.getReader()`, decodes chunks, splits on newlines, strips `data: ` prefix, skips `[DONE]`, parses JSON.
  - **Reader lifecycle:** A `streamClosed` flag tracks whether the generator's `finally` has already called `reader.releaseLock()`. `destroy()` only calls `reader.cancel()` if the stream hasn't already finished, preventing `TypeError: Canceling is not possible after calling releaseLock`.

#### Adapter (OpenAI-compatible LLM proxy)
* `fetchAIAnswerViaAdapter(query, contexts)`: Optional fallback. Calls adapter's `/chat/completions` with OpenAI-compatible request/response.

### C. js/ui.js
Contains all DOM-rendering functions using JS template literals. No fetch calls. Implement:

#### Core Rendering
* `renderSkeletonLoaders()` — Loading placeholders in both panels.
* `renderSearchResults(hits)` — Vertical stack of document cards (max 6, combined from all indexes). Each card:
  - Title as clickable hyperlink to `url`.
  - **Source type badge** — `JIRA` (green) or `Confluence` (blue).
  - For JIRA: `key` badge, `project`, `status`, `issue_type` metadata.
  - For Confluence: `space` label.
  - Body summary (max 300 characters).
  - `data-source-id` attribute for citation linking.
* `renderSearchResultsFromChat(sources)` — Same card format, but renders sources returned by Meilisearch chat's `_meiliSearchSources` tool call.
* `renderAIAnswer(text, isStreaming)` — AI response in left panel with markdown rendering (`**bold**`, code blocks). Use streaming text-node pattern.
* `renderError(message)` — User-friendly error display + toast. **Replaces the entire AI panel** — used for initial-query errors.
* `appendErrorToAnswer(message)` — Appends a styled error box **inside** the current `.ai-md-container` without wiping the panel or follow-up form. Used for follow-up errors so previous answers remain visible.
* `highlightSourceCard(sourceId)` — Visual highlight on the corresponding document card.

#### Mode Switch UI
* `bindModeSwitch(savedMode)` — Binds to `#aiModeSelect` and `#aiModeBadge`. On change, dispatches `aiModeChange` event and updates badge color.
* `_updateModeBadge(selectEl, badgeEl)` — Helper to set badge text and color class based on selected value.

#### AI Answer Streaming Helpers
* `initAIAnswer()` — Clears panel, creates `.ai-md-container`. **Preserves** `#followUpContainer` if present (so follow-up input survives re-initialization).
* `appendAIAnswerChunk(chunk)` — Handles delta vs full-string detection. Appends raw text during streaming.
* `finalizeAIAnswer()` — Parses markdown with `marked.parse()`, converts `[N]` citations into clickable `<span class="citation-link" data-citation="N">`.
* `finalizeAIAnswerWithSources(sources)` — Calls `finalizeAIAnswer()` then `renderSearchResultsFromChat(sources)`.
* `getFullAnswerText()` — Returns accumulated raw answer text.

#### Follow-up UI (Chat Mode Only)
* `showFollowUp()` — Removes `hidden` class from `#followUpContainer`, displays a helper label above the input ("Chat continued—ask a follow-up question"), and focuses the input field to make it visually discoverable after the first answer.
* `hideFollowUp()` — Adds `hidden` class to `#followUpContainer`.
* `clearFollowUpInput()` — Clears `#followUpInput` value.
* `appendErrorToAnswer(message)` — Appends a styled inline error block to the current answer container without destroying the panel.

#### Loading & Status
* `showLoading()` / `hideLoading()` — Toggle `#loadingBar` visibility.
* `setApiStatus(status, text)` — Sets `#apiStatus` text and color class. Supports:
  - `ready` → green
  - `unavailable` → red
  - `checking` → yellow
  - `mode-prompt-api` → green
  - `mode-meilisearch-chat` → blue
* `showModelProgress()` / `hideModelProgress()` / `setModelProgress(text, percent)` — Model download banner (Prompt API mode only).

#### Utility
* `escapeHtml(str)` — Basic HTML entity escaping.

### D. js/app.js
The entry point. Implement:

#### State
* `appState = { currentQuery: '', loading: false, results: [], answer: '', aiMode: 'prompt-api', messages: [] }`
  - `aiMode`: `'prompt-api'` or `'meilisearch-chat'`
  - `messages`: In-memory conversation history for Meilisearch Chat mode (cleared on new tab)

#### Initialization (`init()`)
1. Restore `aiMode` from `sessionStorage` (default: `'prompt-api'`).
2. Call `bindModeSwitch(savedMode)` to wire the `<select>` element.
3. Call `_updateModeStatus()` to set `#apiStatus` text/color immediately.
4. Listen for `aiModeChange` events → update `appState.aiMode`, save to `sessionStorage`, call `_updateModeStatus()`.
5. Wire search form submit and Enter key listeners.
6. Wire citation click delegation on `#aiResponse` (`.citation-link` → `highlightSourceCard()`).
7. Wire **follow-up form** submit (`#followUpForm` → `handleFollowUp`) and **new conversation button** (`#newChatBtn` → clear history, hide follow-up, reset panels).
8. **Prompt API probing:** Only if `appState.aiMode === 'prompt-api'`, call `waitForPromptAPI(30000)`. If unavailable, log helpful Chrome flags to console.
9. Listen for `modelDownloadProgress` events (Prompt API mode only).

#### Mode Status (`_updateModeStatus()`)
* Sets `#apiStatus` class and text based on `appState.aiMode`:
  - `'meilisearch-chat'` → blue text, "Mode: Meilisearch Chat"
  - `'prompt-api'` → green text, "Mode: On-Device AI"
* No generic "Checking..." state — status always reflects the explicitly selected mode.

#### Search Handler (`handleSearch(e)`)
1. Prevent default, get query from `#searchInput`.
2. Update `appState`, show loading, render skeletons.
3. **If `appState.aiMode === 'meilisearch-chat'`, reset `appState.messages = []`** so the top search box always starts a new conversation.
4. Branch on `appState.aiMode`:
   - **Meilisearch Chat mode:**
     a. Call `searchMeilisearch(query)` → get hits.
     b. Render source cards via `renderSearchResults(hits)` on RHS.
     c. Call `streamChatAnswer(query, hits)` — passes hits as `contexts` for RAG grounding. `streamChatAnswer()` internally calls `showFollowUp()` at the end to reveal the follow-up input.
   - **Prompt API mode:**
     a. Call `searchMeilisearch(query)` → get hits.
     b. Render source cards via `renderSearchResults(hits)`.
     c. Call `streamAIAnswer(query, hits)`.
     d. Call `hideFollowUp()`.
4. Error handling:
   - If Prompt API not available, show detailed setup instructions for Chrome and Edge in the AI panel.
   - Other errors rendered via `renderError()`.
5. Finally: `hideLoading()`, reset `appState.loading`.

#### Meilisearch Chat Streaming (`streamChatAnswer(query, contexts)`)
1. Call `initAIAnswer()`.
2. Push user message to `appState.messages`.
3. Call `chatWithMeilisearch(query, appState.messages, contexts)` — `contexts` (hybrid search hits) are prepended to the last user message for RAG grounding. If the first-turn answer is weak, `chatWithMeilisearch()` internally triggers a fallback retry with tools disabled.
4. Stream chunks via `for await...of session.stream` → `appendAIAnswerChunk(chunk)`.
5. After stream ends:
   - Call `finalizeAIAnswerWithSources(session.sources)`.
   - If `session.sources` has items, update `appState.results`; otherwise keep the hybrid search results.
   - Push assistant answer to `appState.messages`.
   - Append `session.appendMessages` (tool messages) **only if they are well-formed and relevant** — filter out empty, malformed, or internal tool chatter. Log each appended message as `[Chat] Appended tool message: <role>: <content snippet>`.
6. On error: call `appendErrorToAnswer()` so the previous answer and follow-up form are preserved. Do NOT use `renderError()` which wipes the entire panel.
7. Cleanup: `session.destroy()`.  
8. Call `showFollowUp()` so users know they can ask a follow-up question next.

#### Follow-up Handler (`handleFollowUp(e)`)
1. Prevent default, get query from `#followUpInput`.
2. Clear input, show loading.
3. Append a visual separator and new `.ai-md-container` to `#aiResponse`.
4. Call `streamFollowUpAnswer(query, container)` — reuses conversation history. On weak answer, retries with injected context and tools disabled (same fallback as first-turn). Only well-formed tool messages are appended back to history.
5. Auto-scroll to the new answer.
6. On error: call `appendErrorToAnswer()` so previous answers are preserved. Finally: `hideLoading()`.

#### Prompt API Streaming (`streamAIAnswer(query, contexts)`)
1. Call `initAIAnswer()`.
2. Call `fetchAIAnswer(query, contexts)`.
3. Stream chunks → `appendAIAnswerChunk(chunk)`.
4. Call `finalizeAIAnswer()`.
5. Cleanup: `aiSession.destroy()`.

#### Citation Click Delegation
* Event listener on `#aiResponse` clicks.
* If target is `.citation-link`, read `data-citation` attribute and call `highlightSourceCard(sourceId)`.

## 7. UI Layout Requirements
Use a split-pane layout with the Tailwind grid system:
* **Top:** Sticky search bar with:
  - Title "Wiki & JIRA RAG"
  - Search input + button
  - **AI Mode switch** (`#aiModeContainer` with `<select>` + badge)
  - Status text (`#apiStatus`)
  - Loading bar (`#loadingBar`)
* **Left Column (40% width):** AI Response output. Supports markdown rendering.
  - After a chat-mode answer completes, a **follow-up form** (`#followUpContainer`) appears with an input + Send button + "Start new conversation" link.
* **Right Column (60% width):** Vertical stack of Meilisearch document cards showing source context.

## 8. Security & State Rules
* Never hardcode API keys directly into logic files; keep them strictly grouped inside `config.js`.
* State management: Keep the central `appState` object in `app.js`.
* Conversation history is **in-memory only** (`appState.messages`). Do **not** persist to `localStorage` or `sessionStorage`.
* Mode selection **is** persisted to `sessionStorage` so the user's choice survives reloads.

## 9. Design Decisions
1. **Source URLs are rendered as plain hyperlinks** (`href` pointing to `url`). The user clicks them directly.
2. **AI citations are auto-generated by the LLM.** The system prompt instructs the model to cite sources using `[1]`, `[2]`, etc. The UI parses these markers and wires them to `data-source-id` highlights.
3. **Sequential RAG flow:** Search executes first, then the retrieved documents are sent to the AI. This ensures the AI answer is always grounded in the retrieved context.
4. **Explicit mode selection:** The user must choose the AI mode via the UI. No automatic detection or switching.
5. **No background Prompt API probing in Chat mode:** When Meilisearch Chat is selected, the app does not wait 30 seconds probing for the Prompt API.
6. **Delta-deduplication for Prompt API:** The Prompt API may echo the full accumulated string in each chunk. `appendAIAnswerChunk()` detects this and appends only the delta.
7. **No `role: system` in Meilisearch Chat mode:** The upstream model template (via Ollama/LiteLLM adapter) only supports `user`, `assistant`, and `tool` roles. RAG context is prepended to the last `user` message instead.
8. **Native tools with fallback in Meilisearch chat:** Tools are always sent in the request body to allow the model to invoke `_meiliSearchSources` when needed. However, if the first-turn response is weak or unrelated (empty answer, meta-tool refusals), the `chatWithMeilisearch()` function immediately retries with RAG context pre-injected and tools disabled. This provides a deterministic safety net without sacrificing native-tool behavior when the model cooperates.
9. **Tool-message hygiene in conversation history:** Only well-formed and contextually relevant tool messages (e.g., `_meiliAppendConversationMessage` with valid content) are appended to `appState.messages`. Internal or error-like tool chatter is filtered out before appending so later follow-ups inherit only useful context.
10. **Deep-copy messages before mutation:** `chatWithMeilisearch()` clones each message object with `messages.map(m => ({...m}))` before prepending the RAG context to the last user message. A shallow copy (`[...messages]`) would mutate the original objects in `appState.messages`, permanently corrupting the stored conversation history with duplicated system prompts on every turn.

## 10. Samples

### 10.1 Sample curl command for Multi-Index Hybrid search in Meilisearch

The frontend searches **both** `confluence` and `jira` indexes in parallel and merges results:

```bash
# Search confluence index
curl \
  -X POST "${MEILISEARCH_URL}/indexes/confluence/search" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H 'Content-Type: application/json' \
  -d '{
    "q": "Tell me something about databases",
    "hybrid": {
      "semanticRatio": 0.5,
      "embedder": "embedder_granite"
    },
    "limit": 6,
    "attributesToRetrieve": ["id", "title", "body", "space", "uri", "url"]
  }'

# Search jira index (parallel)
curl \
  -X POST "${MEILISEARCH_URL}/indexes/jira/search" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H 'Content-Type: application/json' \
  -d '{
    "q": "Tell me something about databases",
    "hybrid": {
      "semanticRatio": 0.5,
      "embedder": "embedder_granite"
    },
    "limit": 6,
    "attributesToRetrieve": ["id", "key", "title", "body", "project", "url", "status", "assignee", "labels", "created", "updated", "issue_type"]
  }'
```

Merged results are sorted by `_rankingScore` (descending). Each hit has `_sourceIndex` field (`"confluence"` or `"jira"`).

Sample merged output:
```json
[
  {
    "id": "11730952",
    "title": "Backup and Recovery",
    "body": "Oracle Backup and Recovery Articles...",
    "space": "Database",
    "url": "https://kb.local.nonet/confluence/display/Database/Backup+and+Recovery",
    "_rankingScore": 0.95,
    "_sourceIndex": "confluence"
  },
  {
    "id": "DEVJOBS-2",
    "key": "DEVJOBS-2",
    "title": "Update App code to use (cursor)...",
    "body": "No description provided.",
    "project": "DEVJOBS",
    "status": "Closed",
    "issue_type": "Improvement",
    "url": "https://kb.local.nonet/jira/browse/DEVJOBS-2",
    "_rankingScore": 0.82,
    "_sourceIndex": "jira"
  }
]
```

### 10.2 Sample Meilisearch Chat API request

The unified workspace uses the adapter to route to Ollama/LiteLLM:

```bash
curl -N -X POST "${MEILISEARCH_URL}/chats/unified/chat/completions" \
  -H "Authorization: Bearer ${CHAT_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "llama3.2:3b",
    "stream": true,
    "messages": [{"role":"user","content":"Tell me about databases"}],
    "temperature": 0.8,
    "tools": [
      {"type":"function","function":{"name":"_meiliSearchProgress"}},
      {"type":"function","function":{"name":"_meiliSearchSources"}},
      {"type":"function","function":{"name":"_meiliAppendConversationMessage"}}
    ]
  }'
```

SSE response chunks:
```
data: {"choices":[{"delta":{"content":"Here"}}]}
data: {"choices":[{"delta":{"content":" is"}}]}
data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"_meiliSearchSources","arguments":"{\"sources\":[{\"title\":\"...\"}]"}}]}},{"finish_reason":"tool_calls"}]}
```
