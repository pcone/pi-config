---
title: "Runpod Bonsai: a selectable self-hosted model on an on-demand pod"
type: decision
status: active
date: 2026-11-25
---

# 001 — Runpod Bonsai: a selectable self-hosted model on an on-demand pod

## Rulings (owner, 2026-11-25)

> "it shouldn't be one of our default seats, but we should make it available as a user selectable model, as well as an option for implementer sessions via a model override (default implementer seat shouldn't change)"

> "possible to bring the pod up on demand when a prompt is sent if it's down at the time?"

Asked how a down pod comes back, the owner chose "Fresh pod every time" (idle → terminate; wake = create a new pod and run full setup) over stop/start with a volume disk. Asked where the Runpod API key lives, the owner chose the macOS Keychain.

The implementer override is decision `subagents/054`.

## What

- `extensions/runpod-bonsai/` registers provider `runpod`, model `bonsai25-27b-v1` ("Bonsai 2.5 27B (Runpod)"). It is selectable through `/model` and is no seat's default.
- Each request resolves the running pod named `pi-bonsai`. With none running, the extension creates one and waits until `/health` answers through the Runpod proxy; the request then goes through pi's OpenAI-compatible client. A non-running pod by that name is deleted first: the name is reserved for this extension.
- Concurrent sessions share one pod (owner, 2026-11-25: "if two separate pi sessions try to use the runpod model at the same time while it's down, I don't want them creating separate pods").
  - A lock file (`~/.pi/runpod-bonsai.lock`, holding its holder's pid) serialises creation across pi processes. A lock whose holder has exited is removed.
  - The lock alone cannot guarantee one pod: removing a dead holder's lock can race a third process. After a create, the creator re-lists and keeps the winner, the oldest running `pi-bonsai` pod (ties by id); a creator whose pod lost deletes it. Every session applies the same rule, so racing sessions settle on one pod.
- Runpod refuses a create with 400 "does not have the resources" when the host it picked has no free 4090. The extension retries that refusal up to 5 times, 10 s apart; any other error fails the request.
- `boot.sh` is the pod's entrypoint. It downloads the pinned PrismML build (`prism-b12178-03ec600`) and the model at a pinned Hugging Face revision, serves the measured configuration, and terminates the pod after 30 idle minutes, when the server exits, or when boot fails.
- Model files download over 8 ranged connections and are checked against their SHA-256. A failed range leaves zeros rather than a short file, so the hash, not the size, proves the download.
- Keys come from the Keychain: `runpod-api-key` for the Runpod REST API and `bonsai-llama-api-key` for the pod's server. The Runpod key needs only Pods (lifecycle, actions and logs) read/write.

Measured 2026-11-25, prompt to first answer through `pi -p` with no pod running: 65 s and 70 s. One boot on a host with slow Hugging Face downloads took 6.4 min with single-connection downloads, which led to the ranged downloads. Three concurrent sessions started while no pod ran created one pod. Server configuration and its measurements: `~/Developer/notes/bonsai-runpod/README.md`.

## Alternatives rejected

- **Stop/start one pod with a volume disk.** Wakes in about a minute, but a stopped pod resumes only on its own host; if that host's GPU is rented out, the start fails. The owner chose fresh pods.
- **A `models.json` entry pointing at a fixed pod URL.** The URL changes with every pod, and a static entry cannot wake one.
- **Running Bonsai-demo's `setup.sh` on boot.** It installs uv, Python packages and Open WebUI dependencies the server does not use, and fetches the model at an unpinned revision.

## Tradeoffs accepted

- A cold request waits about 1–2 minutes, longer when the image is not cached on the host or Hugging Face is slow from it.
- Only Secure Cloud RTX 4090 pods are requested. With no 4090 stock after the retries, the request fails with Runpod's error.
- The lock covers one machine. Sessions on two machines can each create a pod; the winner rule still leaves one.
- The model reports zero token cost: billing is per pod-hour ($0.89/hr at creation), outside pi's token accounting.
