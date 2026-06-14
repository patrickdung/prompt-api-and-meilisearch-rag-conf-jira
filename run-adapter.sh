export RUST_LOG=debug
export LISTEN_ADDR=0.0.0.0:8080
#export UPSTREAM_BASE_URL=http://127.0.0.1:9062/v1
#export UPSTREAM_BASE_URL=http://127.0.0.1:9067/v1
#export UPSTREAM_BASE_URL=http://127.0.0.1:9069/v1
export UPSTREAM_BASE_URL=http://127.0.0.1:11434/v1
# 9066 vllm
#9066/ or 9066/v1 ?
#export UPSTREAM_BASE_URL=http://127.0.0.1:9066/
./adapter/target/release/meili-chat-adapter
