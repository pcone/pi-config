#!/bin/bash
# Container entrypoint for the on-demand Bonsai pod. index.ts passes this file
# base64-encoded in BOOT_SH; the pod runs it once per creation.
#
# Downloads the pinned PrismML llama.cpp build and model, serves on :8080, and
# terminates its own pod after IDLE_MIN idle minutes, on a server exit, or on any
# boot failure. A terminated pod bills nothing; the next prompt creates a new one.
set -euo pipefail
exec > >(tee -a /root/boot.log) 2>&1

REL=prism-b12178-03ec600
HF=https://huggingface.co/prism-ml/Ternary-Bonsai-2.5-27B-GGUF/resolve/28a7093cc25bc151cc2b284c5570f12ce343fdcf
MODEL=Ternary-Bonsai-2.5-27B-PTQ1_0-mtp.gguf
MMPROJ=Ternary-Bonsai-2.5-27B-mmproj-Q8_0.gguf
IDLE_MIN=${IDLE_MIN:-30}

terminate() {
  echo "$(date -u +%FT%TZ) terminating pod: $1"
  curl -s -X POST -H "Authorization: Bearer $RUNPOD_API_KEY" -H 'Content-Type: application/json' \
    -d '{"action":"terminate"}' "https://api.runpod.io/v2/pods/$RUNPOD_POD_ID/action"
  sleep infinity
}
trap 'terminate "boot script exited (status $?)"' EXIT

# fetch URL OUT SIZE SHA256: download over 8 ranged connections, each writing
# its range in place. Per-connection speed from Hugging Face varies by host
# (10 MB/s on a slow one, 2.8x that with 8 connections). A failed range leaves
# zeros, not a short file, so the hash check is what proves the download.
fetch() {
  local url=$1 out=$2 size=$3 sha=$4 n=8 i pids=()
  local chunk=$(( (size + n - 1) / n ))
  : > "$out"
  for i in $(seq 0 $((n - 1))); do
    local a=$(( i * chunk )) b=$(( (i + 1) * chunk - 1 ))
    [ $b -ge $size ] && b=$(( size - 1 ))
    ( curl -fsSL -r $a-$b "$url" | dd of="$out" bs=4M oflag=seek_bytes seek=$a conv=notrunc status=none ) & pids+=($!)
  done
  for i in "${pids[@]}"; do wait $i; done
  echo "$sha  $out" | sha256sum -c --quiet
}

echo "$(date -u +%FT%TZ) downloading $REL and $MODEL"
mkdir -p /root/llama /root/models
curl -fsSL "https://github.com/PrismML-Eng/llama.cpp/releases/download/$REL/llama-$REL-bin-linux-cuda-12.8-x64.tar.gz" \
  | tar -xz -C /root/llama --strip-components=1 & p1=$!
fetch "$HF/$MODEL" /root/models/$MODEL 6232818944 e0fc5f3d47b9c926d52677d303b19df356a2376614b3e1cb9973865fc04ca431 & p2=$!
fetch "$HF/$MMPROJ" /root/models/$MMPROJ 629246976 6807ede61d570bb86ba34b756a0fa109edc33668604de867c6ea6d8f1d631903 & p3=$!
wait $p1; wait $p2; wait $p3
echo "$(date -u +%FT%TZ) downloads done"

# A slot is held per request, not per conversation; --cache-ram parks evicted
# prompt caches in system RAM so later turns skip re-prefill. Sizing and the
# settings A/B: ~/Developer/notes/bonsai-runpod/README.md.
export LLAMA_MTP_PREFILL_LEAN=1 GGML_CUDA_GDN_L8P=1 GGML_CUDA_FWHT_MMQ=1 GGML_CUDA_FWHT_MMQ_GLU=1
/root/llama/llama-server -m /root/models/$MODEL \
  --mmproj /root/models/$MMPROJ --no-mmproj-offload \
  --host 0.0.0.0 --port 8080 -ngl 99 -fa on -c 688128 --parallel 3 --no-kv-unified --cache-ram 40960 \
  --cache-type-k q4_0 --cache-type-v q4_0 -ctkd q4_0 -ctvd q4_0 \
  --spec-type draft-mtp --spec-draft-n-min 0 --spec-draft-n-max 3 --spec-draft-p-min 0 \
  --temp 1.0 --top-p 0.95 --top-k 20 --min-p 0 --jinja \
  --reasoning-format deepseek --reasoning-budget 16384 --alias bonsai25-27b-v1 \
  --api-key "$LLAMA_API_KEY" & server=$!

until curl -sf -o /dev/null localhost:8080/health; do
  kill -0 $server 2>/dev/null || { wait $server; exit; }
  sleep 1
done
echo "$(date -u +%FT%TZ) server ready"

# Idle watchdog: an unreachable server counts as idle.
(
  last=$(date +%s)
  while sleep 60; do
    busy=$(curl -sf -m 10 -H "Authorization: Bearer $LLAMA_API_KEY" localhost:8080/slots \
      | python3 -c 'import json,sys; print(int(any(s.get("is_processing") for s in json.load(sys.stdin))))' 2>/dev/null || true)
    now=$(date +%s)
    [ "$busy" = 1 ] && last=$now
    if [ $(( (now - last) / 60 )) -ge "$IDLE_MIN" ]; then
      kill -TERM $$
      exit 0
    fi
  done
) &

trap 'terminate "idle for ${IDLE_MIN}m"' TERM
wait $server || true
terminate "llama-server exited"
