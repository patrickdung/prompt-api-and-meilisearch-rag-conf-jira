/**
 * Configuration for the Confluence RAG Frontend.
 * All secrets and API endpoints are centralized here.
 */

const RAG_INSTRUCTIONS = `You are a helpful assistant that answers questions based ONLY on the provided documents below.

IMPORTANT:
- The documents you need are ALREADY listed below under "Provided documents".
- You do NOT need to search for more documents.
- You do NOT have access to any search tools, database, or external API.
- Read the provided documents carefully and answer directly.
- If a document has a title, key, project, status, or type field, USE those fields as facts. Do not ignore a document just because its body is short or empty.

CITATION RULES — THIS IS VERY IMPORTANT:
- Every fact in your answer must have a citation in the format [1], [2], [3], etc.
- The number in [N] refers to the document number shown in the "Provided documents" list below.
- Place the citation immediately after the fact it supports, like: "Oracle Data Pump uses a dump file [1]."
- Do NOT use "1.", "2.", "3." to list items — those look like citations but are NOT citations.
- Example of a good answer: "Database migration can use Data Pump [1] or transportable tablespaces [2]."

Answer rules:
1. Use ONLY the information in the provided documents to answer.
2. Cite your sources using [1], [2], [3], etc. after every fact.
3. Answer in 3-4 sentences. Keep your answer concise and less than 4800 characters.
4. Do NOT make up information. Do NOT hallucinate facts.
5. Output ONLY plain natural language text. NEVER output JSON, tool calls, function calls, code blocks, structured data, or anything that looks like {"name": ...} or {"parameters": ...}.
NEVER output raw tool JSON fragments like {"tool_calls", {"function", "call_id", "id": "call_", or any partial JSON that starts with { and contains tool-related words.
6. You MUST answer from the provided documents. NEVER output the exact phrase "The provided documents do not contain any information about" unless NONE of the documents mention the topic.
7. If the documents truly do not contain the answer, say so clearly WITHOUT using the forbidden phrase above, then ask the user to contact help@example.com for further assistance. Do NOT add any citation to "not found" statements or to the email contact of the suggestion.`;

const PROMPT_API_NO_JSON_SUFFIX = `

CRITICAL: Your answer must be plain text only. Do NOT output JSON, tool calls, function calls, or any structured format. Just write a natural language answer.`;

export const CONFIG = {
    RAG_INSTRUCTIONS,
    // Meilisearch settings
    // IMPORTANT: If this page is served over HTTPS, the Meilisearch host
    // must also be HTTPS, or the browser will block requests (Mixed Content).
    // Options:
    //   1. Put Meilisearch behind the same HTTPS reverse proxy (recommended)
    //   2. Use a relative URL like '/search-api' if proxied
    //   3. Set up a separate HTTPS endpoint for Meilisearch
    MEILISEARCH_HOST: 'https://kb.local.nonet/api/meilisearch/',
    MEILISEARCH_KEY: '',
    MEILISEARCH_INDEX: 'confluence',
    MEILISEARCH_INDEXES: ['confluence', 'jira'],

    // Hybrid search parameters
    HYBRID_SEMANTIC_RATIO: 0.5,
    HYBRID_EMBEDDER: 'embedder_granite',
    SEARCH_LIMIT: 6,

    // Prompt API settings
    PROMPT_API_OPTIONS: {
        temperature: 0.2,
        topK: 4
    },

    // System prompt for RAG answer generation (Prompt API mode)
    // Uses RAG_INSTRUCTIONS plus extra anti-JSON guard for on-device models.
    PROMPT_API_SYSTEM_PROMPT: `${RAG_INSTRUCTIONS}

When you are not confident in your answer:
- Say "Based on the available documents, ..." to signal partial information
- List what you found and what is missing
- Suggest the user refine their search query or contact support${PROMPT_API_NO_JSON_SUFFIX}`,

    // Prefix template for injecting retrieved documents
    getRagContextPrefix(contexts) {
        if (!contexts || contexts.length === 0) return '';

        let prefix = '\n\n---\nProvided documents:\n';
        contexts.forEach((doc, index) => {
            const num = index + 1;
            const isJira = doc._sourceIndex === 'jira';
            const title = isJira && doc.key
                ? `${doc.key}: ${doc.title || 'Untitled'}`
                : (doc.title || 'Untitled');
            prefix += `\n[${num}] Title: ${title}\n`;
            if (isJira) {
                prefix += `Project: ${doc.project || 'Unknown'}\n`;
                prefix += `Status: ${doc.status || 'Unknown'}\n`;
                prefix += `Type: ${doc.issue_type || 'Unknown'}\n`;
            } else {
                prefix += `Space: ${doc.space || 'Unknown'}\n`;
            }
            // For JIRA, synthesize descriptive content when body is empty or very short,
            // so even small models see that the document is relevant.
            let content = '';
            if (isJira) {
                if (doc.body && doc.body.trim().length > 10) {
                    content = doc.body.substring(0, 1600);
                } else {
                    const key = doc.key || 'unknown';
                    const project = doc.project || 'Unknown';
                    const status = doc.status || 'Unknown';
                    const type = doc.issue_type || 'Unknown';
                    const titleText = doc.title || 'Untitled';
                    content = `JIRA issue ${key} in project ${project}. Status: ${status}. Type: ${type}. Title: ${titleText}.`;
                }
            } else {
                content = doc.body ? doc.body.substring(0, 1600) : 'No content';
            }
            prefix += `Content: ${content}\n`;
        });
        prefix += '\n---\n\n';
        return prefix;
    },

    // Meilisearch Chat (Conversation Search) settings
    // MEILISEARCH_CHAT_WORKSPACE: 'confluence',
    MEILISEARCH_CHAT_WORKSPACE: 'unified',
    // MEILISEARCH_CHAT_MODEL: 'ministral3-offline:latest',
    // MEILISEARCH_CHAT_MODEL: 'llama3.2:3b',
    MEILISEARCH_CHAT_MODEL: 'granite4.1:3b',
    // MEILISEARCH_CHAT_MODEL: 'ministral-3:3b',
    // NOTE: /chats/{workspace}/chat/completions requires a key with broader
    // permissions than a search-only key. If unset, falls back to MEILISEARCH_KEY.
    MEILISEARCH_CHAT_KEY: '',

    // AI mode selection
    AI_MODE: 'prompt-api',  // 'prompt-api' or 'meilisearch-chat'

    // Meilisearch Chat native tool mode
    // When true, Meilisearch chat uses native _meiliSearchSources/_meiliSearchProgress
    // tool calls instead of pre-injecting hybrid search results as context.
    // NOTE: The LLM often calls built-in tools with invalid filter syntax (400 errors).
    // For reliability, always pre-inject hybrid search results as context.
    MEILISEARCH_CHAT_NATIVE_TOOLS: true,
};
