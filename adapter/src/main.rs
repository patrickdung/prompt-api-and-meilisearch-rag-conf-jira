use std::{env, net::SocketAddr};

use axum::{
    Router,
    body::{Body, Bytes},
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use futures::StreamExt;
use reqwest::Client;
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::mpsc;

#[derive(Clone)]
struct AppState {
    client: Client,
    upstream_base_url: String,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    let listen_addr = env::var("LISTEN_ADDR").unwrap_or_else(|_| "127.0.0.1:8080".to_string());
    let upstream_base_url =
        env::var("UPSTREAM_BASE_URL").unwrap_or_else(|_| "http://127.0.0.1:4000".to_string());

    let state = AppState {
        client: Client::new(),
        upstream_base_url,
    };

    let app = Router::new()
        .route("/health", get(health))
        .route("/chat/completions", post(chat_completions))
        .with_state(state);

    let addr: SocketAddr = listen_addr.parse()?;
    let listener = tokio::net::TcpListener::bind(addr).await?;

    tracing::info!("meili chat adapter listening on http://{}", addr);
    axum::serve(listener, app).await?;

    Ok(())
}

async fn health() -> impl IntoResponse {
    axum::Json(serde_json::json!({"status": "ok", "adapter": "meili-chat-adapter"}))
}

async fn chat_completions(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, StatusCode> {
    let upstream_url = format!(
        "{}/chat/completions",
        state.upstream_base_url.trim_end_matches('/')
    );

    tracing::info!(%upstream_url, "forwarding chat completion request");
    let body_text = String::from_utf8_lossy(&body);
    tracing::debug!(body = %body_text, "received request body");

    let mut request = state.client.post(&upstream_url).body(body.to_vec());

    for (name, value) in headers.iter() {
        if matches!(name.as_str(), "host" | "content-length") {
            continue;
        }
        let header_value = value.to_str().unwrap_or("<non-utf8>");
        tracing::debug!(header_name = %name, header_value = %header_value, "forwarding header");
        request = request.header(name, value);
    }

    let response = request.send().await.map_err(|err| {
        tracing::error!(error = %err, "upstream request failed");
        StatusCode::BAD_GATEWAY
    })?;

    tracing::info!(
        status = %response.status(),
        content_type = ?response.headers().get("content-type"),
        "upstream responded"
    );

    let mut builder = Response::builder().status(response.status());
    for (name, value) in response.headers().iter() {
        if matches!(name.as_str(), "content-length") {
            continue;
        }
        builder = builder.header(name, value);
    }

    let content_type = response
        .headers()
        .get(axum::http::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_string();

    if content_type.contains("text/event-stream") {
        // Stream normalization: transform chunks on the fly
        let (tx, rx) = mpsc::channel::<Result<Bytes, std::io::Error>>(32);

        tokio::spawn(async move {
            let stream = response.bytes_stream();
            let mut reader = BufReader::new(tokio_util::io::StreamReader::new(stream.map(|r| {
                r.map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))
            })));
            let mut line = String::new();

            while let Ok(n) = reader.read_line(&mut line).await {
                if n == 0 {
                    break;
                }
                let trimmed = line.trim_end();
                let output = if let Some(data) = trimmed.strip_prefix("data: ") {
                    let inner = data.trim();
                    if inner.is_empty() || inner == "[DONE]" {
                        format!("{trimmed}\n")
                    } else {
                        match serde_json::from_str::<Value>(inner) {
                            Ok(value) => {
                                let event = normalize_sse_event(value);
                                format!("data: {}\n", serde_json::to_string(&event).unwrap())
                            }
                            Err(_) => format!("{trimmed}\n"),
                        }
                    }
                } else {
                    format!("{trimmed}\n")
                };
                if tx.send(Ok(Bytes::from(output))).await.is_err() {
                    break;
                }
                line.clear();
            }
        });

        return Ok(builder
            .header("x-meili-chat-adapter", "true")
            .body(Body::from_stream(tokio_stream::wrappers::ReceiverStream::new(rx)))
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?);
    }

    let status = response.status();
    let body_bytes = response.bytes().await.map_err(|err| {
        tracing::error!(error = %err, "failed reading non-streaming response");
        StatusCode::BAD_GATEWAY
    })?;
    let body_text = String::from_utf8_lossy(&body_bytes);
    tracing::debug!(status = %status, body = %body_text, "non-streaming upstream response");

    Ok(builder
        .header("x-meili-chat-adapter", "true")
        .body(Body::from(body_bytes))
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?)
}

fn normalize_sse_payload(payload: &str) -> String {
    let mut normalized = String::new();
    let mut normalized_count = 0usize;
    let mut preserved_count = 0usize;
    let mut skipped_count = 0usize;

    for line in payload.lines() {
        if let Some(data) = line.strip_prefix("data: ") {
            let trimmed = data.trim();
            if trimmed.is_empty() || trimmed == "[DONE]" {
                normalized.push_str(line);
                normalized.push('\n');
                continue;
            }

            match serde_json::from_str::<Value>(trimmed) {
                Ok(value) => {
                    if is_openai_stream_chunk(&value) {
                        preserved_count += 1;
                    } else {
                        normalized_count += 1;
                    }
                    let event = normalize_sse_event(value);
                    normalized.push_str(&format!(
                        "data: {}\n",
                        serde_json::to_string(&event).unwrap()
                    ));
                }
                Err(_) => {
                    skipped_count += 1;
                    normalized.push_str(line);
                    normalized.push('\n');
                }
            }
            continue;
        }

        normalized.push_str(line);
        normalized.push('\n');
    }

    tracing::debug!(
        normalized = normalized_count,
        preserved = preserved_count,
        skipped = skipped_count,
        "SSE normalization summary"
    );

    normalized
}

fn normalize_sse_event(value: Value) -> Value {
    if is_openai_stream_chunk(&value) {
        return value;
    }

    if let Some(message) = value
        .get("message")
        .cloned()
        .or_else(|| value.get("delta").cloned())
    {
        let mut delta = serde_json::Map::new();
        if let Some(role) = message.get("role") {
            delta.insert("role".to_string(), role.clone());
        }
        if let Some(content) = message.get("content") {
            delta.insert("content".to_string(), content.clone());
        }
        if let Some(tool_calls) = message.get("tool_calls") {
            delta.insert("tool_calls".to_string(), tool_calls.clone());
        }
        if let Some(function_call) = message.get("function_call") {
            delta.insert("function_call".to_string(), function_call.clone());
        }

        let mut choices = serde_json::Map::new();
        choices.insert("index".to_string(), Value::from(0u32));
        choices.insert("delta".to_string(), Value::Object(delta));
        choices.insert(
            "finish_reason".to_string(),
            value.get("finish_reason").cloned().unwrap_or(Value::Null),
        );

        let mut normalized = serde_json::Map::new();
        normalized.insert(
            "id".to_string(),
            value
                .get("id")
                .cloned()
                .unwrap_or(Value::from("chatcmpl-adapter")),
        );
        normalized.insert(
            "object".to_string(),
            value
                .get("object")
                .cloned()
                .unwrap_or(Value::from("chat.completion.chunk")),
        );
        normalized.insert(
            "created".to_string(),
            value.get("created").cloned().unwrap_or(Value::from(0u64)),
        );
        normalized.insert(
            "model".to_string(),
            value
                .get("model")
                .cloned()
                .unwrap_or(Value::from("adapter-model")),
        );
        normalized.insert(
            "choices".to_string(),
            Value::Array(vec![Value::Object(choices)]),
        );
        if let Some(usage) = value.get("usage") {
            normalized.insert("usage".to_string(), usage.clone());
        }

        return Value::Object(normalized);
    }

    if let Some(content) = value
        .get("content")
        .cloned()
        .or_else(|| value.get("response").cloned())
    {
        let mut normalized = serde_json::Map::new();
        normalized.insert(
            "id".to_string(),
            value
                .get("id")
                .cloned()
                .unwrap_or(Value::from("chatcmpl-adapter")),
        );
        normalized.insert(
            "object".to_string(),
            value
                .get("object")
                .cloned()
                .unwrap_or(Value::from("chat.completion.chunk")),
        );
        normalized.insert(
            "created".to_string(),
            value.get("created").cloned().unwrap_or(Value::from(0u64)),
        );
        normalized.insert(
            "model".to_string(),
            value
                .get("model")
                .cloned()
                .unwrap_or(Value::from("adapter-model")),
        );

        let mut choice = serde_json::Map::new();
        choice.insert("index".to_string(), Value::from(0u32));
        choice.insert("delta".to_string(), serde_json::json!({"content": content}));
        choice.insert(
            "finish_reason".to_string(),
            value.get("finish_reason").cloned().unwrap_or(Value::Null),
        );
        normalized.insert(
            "choices".to_string(),
            Value::Array(vec![Value::Object(choice)]),
        );

        return Value::Object(normalized);
    }

    value
}

fn is_openai_stream_chunk(value: &Value) -> bool {
    value
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .map(|choice| choice.get("delta").is_some())
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::normalize_sse_payload;

    #[test]
    fn normalizes_provider_specific_tool_call_chunk_to_openai_shape() {
        let input = "data: {\"model\":\"llama3\",\"message\":{\"role\":\"assistant\",\"tool_calls\":[{\"id\":\"call_1\",\"type\":\"function\",\"function\":{\"name\":\"lookup\",\"arguments\":\"{\\\"q\\\":\\\"x\\\"}\"}}]}}\n\n";

        let normalized = normalize_sse_payload(input);

        assert!(normalized.contains("\"delta\":{\"role\":\"assistant\""));
        assert!(normalized.contains("\"tool_calls\""));
        assert!(normalized.contains("\"call_1\""));
        assert!(normalized.contains("\"object\":\"chat.completion.chunk\""));
    }

    #[test]
    fn preserves_standard_openai_stream_chunks() {
        let input = "data: {\"id\":\"1\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"hi\"},\"finish_reason\":null}]}\n\n";

        let normalized = normalize_sse_payload(input);

        assert!(normalized.contains("\"object\":\"chat.completion.chunk\""));
        assert!(normalized.contains("\"content\":\"hi\""));
    }
}
