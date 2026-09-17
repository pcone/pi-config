# Work Order WO-2026-050 — DS LCD-shader screenshots at Retroid Duo panel sizes

### Metadata

- **work_order_id**: WO-2026-050
- **parent_plan_id**: N/A (ad-hoc user task; plan doc lives at ~/Developer/ds-shader-test/PLAN.md)
- **sequence_position**: 1 of 1
- **routed_to**: implement
- **invariant_exhaustiveness**: explicit
- **priority**: normal
- **estimated_complexity**: moderate
- **review_policy**: skip — artifact-producing task (PNGs + manifest), no repo/code invariants; correctness is enforced mechanically by the harness's per-image geometry manifest gate and by direct orchestrator visual review of every output. A review subagent would re-read the same PNGs.

## Task Summary

**One-sentence description**: Capture RetroArch+melonDS screenshots of Mario Kart DS with lcd3x and lcd-grid-v2 shaders rendered at the Retroid Pocket Duo's exact panel geometries (top 1920×1080 non-integer 5.625×, bottom 1280×960 integer 5×), plus baseline and contrast rows, with verified geometry and magnified crops.

**Goal**: A 9-cell matrix of PNGs in `~/Developer/ds-shader-test/shots/`, each pixel-exact to its target panel size, with a machine-checked manifest (dimensions + content bounding box) proving the geometry, 3× nearest-neighbor crops for subpixel inspection, and an observations report. The user will judge shader artifacts from these images.

## Scope

**Working directory**: `/Users/scott/Developer/ds-shader-test` (created; `tools/`, `shots/`, `crops/`, `PLAN.md`, git-init'd). You run directly here — no worktree isolation.

**Files to create**:
- `tools/harness.sh` — capture harness (see spec below)
- `tools/manifest.py` — PNG dimension/bbox/uniformity checker emitting the manifest (may be embedded in harness.sh instead; your call)
- `shots/<cell>/<name>.png` + `shots/<cell>/<name>.crop3x.png` — the matrix (cells below)
- `shots/raw/` — all intermediate timed captures (kept for provenance)
- `REPORT.md` — observations (see Verification section for required content)
- commit everything to the local git repo as you go

**Files to read (reference only, do not modify)**:
- `/Users/scott/Developer/moto-racer/tools/harness.sh` — the harness you are forking. Its header documents the environment lessons you inherit. Strip the PSX-specific logic (CUE validation, BIOS scan/table, Beetle/PCSX branches, mednafen backend); keep the environment machinery (caffeinate self-wrap, stale-process kill, session-lock probe, accessibility probe if you use scripted input, UDP-55355 wait loop, `open -a` activation, PNG sanity checker pattern, teardown trap, screenshot staging + rename, exit-code discipline).
- `/Users/scott/Developer/moto-racer/inputs/ra-binds.cfg` — keyboard binds pattern if you use scripted input
- `/Users/scott/Developer/moto-racer/NOTES.md` + `notes/` — background only; skim if curious, not required
- `/Users/scott/Developer/ds-shader-test/PLAN.md` — the plan (geometry table + matrix)

**Files NOT to modify**:
- Anything under `/Users/scott/Developer/moto-racer/` — closed experiment repo, reference only
- Anything under `/Users/scott/Developer/pi-config/` — this includes `work-orders/` (this file is frozen at dispatch)
- `~/Downloads/` — read the ROM, never write
- Do not install system-wide packages except `ffmpeg` is already present; if you need anything else, prefer pure-python/pip --user or report the gap

**Out of scope**: reaching an actual race in-game (title/attract/menu content is sufficient — do not burn time blind-navigating menus beyond a single best-effort attempt); 3DS content; GLSL (.glslp) shader variants; any Retroid device (this is all simulated on this Mac); modifying pi-config.

## Implementation Specification

### Environment facts (verified by orchestrator — trust these)

- RetroArch 1.22.2 (git 69a4f0ea), `/Applications/RetroArch.app/Contents/MacOS/RetroArch`, universal (arm64 ✓)
- RA config lives at `~/Library/Application Support/RetroArch/retroarch.cfg` and the moto-racer harness regenerates it per run — same pattern for you (see Config pinning). Core dir `~/Library/Application Support/RetroArch/cores/`, system dir `.../system/`
- **Critical mechanism**: RA on macOS renders and screenshots at the window's *physical backing* resolution. Built-in display is a 2× Retina (2408×1506 logical). A window whose *content* is 960×540 logical produces a **1920×1080** screenshot. moto-racer evidence: default `video_scale=3` (logical 960×720) → 1920×1440 PNGs. The two external 2560×1440 displays are 1× — **the window must stay fully within the built-in display** or the 2× math breaks.
- Built-in display is the main display at global origin (0,0). Suggested window position: {80, 80} logical.
- No melonDS core installed. Download: `https://buildbot.libretro.com/nightly/apple/osx/arm64/latest/melonds_libretro.dylib.zip` (verified 200) → unzip into the cores dir; also fetch `melonds_libretro.info` from the same `latest/` directory. After download, read the `.info` to get the exact core-option key names for screen layout ("top only"/"bottom only"), BIOS usage, and firmware/language options — option names vary by core version; do not guess them, read the file.
- Shaders already on disk (nothing to download): `~/Library/Application Support/RetroArch/shaders/shaders_slang/handheld/` contains `lcd3x.slangp`, `lcd-grid-v2.slangp`, `lcd1x_nds.slangp`, and the `shaders/` pass dir. RA runs slang fine on its default macOS video driver.
- `video_gpu_screenshot = "true"` MUST be pinned explicitly — if false, RA dumps core-res (256×192) instead of the shader-composited output.
- Accessibility permission for this terminal is already granted (moto-racer used cliclick successfully); cliclick at `/opt/homebrew/bin/cliclick`; `nc`, `python3`, `cc`, `ffmpeg` all present.
- melonDS core has built-in FreeBIOS and boots most retail ROMs without BIOS dumps. If MKDS fails to boot without BIOS, that is a distinct failure (exit code 6) — report, do NOT hunt for BIOS dumps.

### Capture matrix (9 cells)

| cell dir | window content (logical) | physical out | integer scale | shader rows |
|---|---|---|---|---|
| `shots/top-1080p/` | 960×540 | 1920×1080 | OFF | `baseline-nn`, `lcd3x`, `lcd-grid-v2`, `lcd1x-nds` |
| `shots/top-1080p-int5x/` | 960×540 | 1920×1080 | ON | `lcd3x`, `lcd-grid-v2` |
| `shots/bottom-5x/` | 640×480 | 1280×960 | ON | `baseline-nn`, `lcd3x`, `lcd-grid-v2`, `lcd1x-nds` |

Row naming: `<shader>.png`. `baseline-nn` = no shader, `video_shader_enable=false`, `video_smooth=false` (raw nearest — shows the scaling alone). Shader rows load their `.slangp` via appendconfig (`video_shader_enable=true` + `video_shader_preset=<abs path>`), one RA launch per row.

Core layout: melonDS screen layout = **top screen only** for `top-*` cells, **bottom screen only** for `bottom-5x` cells (the Duo shows one DS screen per physical panel; we reproduce each panel independently). Aspect: force 4:3 (`video_aspect_ratio = "1.3333334"` with the forced-ratio aspect index — set the index that means "config-defined ratio", not "core provided", so behavior is deterministic across RA versions) — in a 16:9 window this yields 1440×1080 active pillarboxed, i.e. height-fill 5.625×; in a 4:3 window, full-frame.

### Window geometry — self-calibrating loop (primary mechanism)

`osascript` System Events can set the *frame* of RA's window, but the frame includes the title bar (~28pt) while the GL content view does not. Do not hardcode the titlebar height; calibrate:

1. Launch RA windowed (default scale) with the cell's appendconfig; wait for UDP 55355 (moto pattern).
2. `open -a RetroArch` (activation, moto pattern), then osascript: set position {80,80}, set size {W, H + tb} where tb starts at 28.
3. Send SCREENSHOT, `sips -g pixelWidth -g pixelHeight` the result.
   - Target hit (1920×1080 or 1280×960): done, lock tb for the session.
   - Height short by 2·k: tb += k; retry. ≤4 iterations, else die with the observed dims.
4. Also read back the window frame via CGWindowList (moto's winid helper pattern) after 1s and assert it didn't get re-asserted by RA to a different size, and that the frame is fully inside the built-in display bounds (x,y ≥ 0 and x+w ≤ 2408, y+h ≤ 1506 logical).

**Fallback ladder** (only if step 3 cannot converge — say why in the report):
- Rung 2: Docker/Xvfb — `colima start`, ubuntu container, `apt install retroarch libretro-melonds xvfb x11-utils`, run RA on `Xvfb :1 -screen 0 <WxH>x24` fullscreen (exact 1× pixels, no HiDPI), UDP SCREENSHOT from inside, `docker cp` PNGs out. Shaders: the slang pack must be mounted in (bind-ro from the Mac shader dir works). GL on llvmpipe supports slang via glcore.
- Rung 3: report blocker (exit 7) with evidence — do not silently deliver wrong-size images.

### Content capture per row

Schedule (seconds after launch): 45, 70, 95, 125, 160, 200. Keep every capture in `shots/raw/<row>-t###s.png`. Canonical image = the **latest non-uniform capture** (PNG checker: non-black; use mean/max spread like moto's checker), copied to the matrix path. FreeBIOS boot takes ~10–30s; title screen then either idles into attract or sits on menu. Optional single best-effort input script (cliclick A presses at t≈40,50,60) to get past a "press start" screen — abandon if it doesn't help within the schedule; do not extend the schedule for it.

Rom: `/Users/scott/Downloads/0201 - Mario Kart DS (Europe) (En,Fr,De,Es,It).nds` (quote the path — it has spaces and parentheses).

### Config pinning (per launch, moto pattern — regenerate, never hand-edit)

Write the full `retroarch.cfg` (both `~/Library/Application Support/RetroArch/retroarch.cfg` and the `config/` copy) with: the moto environment pins (config_save_on_exit=false, dirs, network_cmd, pause_nonactive=false, video_frame_skip=false, video_font_enable=false, run_ahead off, caffeinate handled at script level) plus: `video_gpu_screenshot="true"`, `video_smooth="false"`, `video_shader_enable` true/false per row, `video_scale_integer` true/false per cell, forced 4:3 aspect, `input_overlay_enable="false"`, OSD/notification off, and the melonDS core options (from the `.info`). Shader + integer + layout vary per launch via `--appendconfig` overlay files, keeping the base cfg identical across runs.

### Manifest gate (the test boundary)

`python3 tools/manifest.py` (or embedded) emits + checks `shots/manifest.tsv`: for every canonical PNG, `path  width  height  bbox_x bbox_y bbox_w bbox_h  mean`. bbox = smallest box of pixels with any channel ≥ 16 (content detection; shader grids darken but not below 16). Expected, hard-asserted:

| cell | PNG dims | content bbox |
|---|---|---|
| top-1080p/* | 1920×1080 | 1440×1080, x=240±2, y=0±2 |
| top-1080p-int5x/* | 1920×1080 | 1280×960, x=320±2, y=60±2 |
| bottom-5x/* | 1280×960 | full frame ±2 |

Any row failing = the geometry is wrong = the screenshot misrepresents the device: **fail the run**, do not ship it. Exit non-zero. (If a shader renders its grid across pillarbox areas making bbox larger, note it in the report and widen that row's expectation with evidence — this is a real finding about the shader, not a bug.)

### Crops

For each canonical PNG: 480×480 crop from the **center of the active content area** (top cells: x=240+480, y=300; int5x: x=320+480, y=60+240; bottom: x=400, y=240), upscaled 3× nearest → `<name>.crop3x.png` (1440×1440) via `ffmpeg -i in -vf crop=...,scale=3:3:flags=neighbor`. These are for subpixel-grid inspection — the whole point of the exercise.

### Shader-applied verification

Per shader row, grep the RA verbose log for shader/preset load errors, and confirm the canonical image is not pixel-identical to a baseline capture of the same row (different schedule times make exact comparison impossible; instead verify visually via your own review of the crop — a working lcd shader shows an unmistakable grid texture). A silently-unloaded preset looks like baseline: that's a failed row; retry or report.

## Invariants

- **Pixel-exactness**: canonical PNGs must measure exactly 1920×1080 / 1280×960 — enforced by manifest gate, not by eyeball.
- **Scale fidelity**: top cells non-integer (content 1440×1080), bottom cells integer 5× full-frame — enforced by bbox expectations. Never "fix" a non-integer row by enabling integer scaling to make it look cleaner.
- **Window display placement**: window fully on built-in Retina display at all times (assert frame bounds); never on the 1× externals.
- **One mechanism per concern**: fork moto's harness once; don't grow a second parallel capture path in the same script. The Docker fallback is a separate rung, clearly gated.
- **Machine etiquette**: kill RA on exit (teardown trap), remove `.stage` dirs, leave `retroarch.cfg` in the harness-generated state (it is a generated file; moto regenerates it too — note this in REPORT.md for the user).
- **No unproven fallbacks**: if the primary window mechanism fails and Docker also fails, deliver nothing rather than wrong-geometry images, and report exit 7 with the evidence.
- Console/stdout discipline from moto: stdout = machine-readable paths/manifest only; everything else to stderr; documented exit codes.

## Verification Criteria (implementer must satisfy all before reporting complete)

1. `shots/manifest.tsv` exists, all 10 canonical rows (9 cells; top-1080p and bottom-5x have 4 rows each incl. lcd1x-nds, top-1080p-int5x has 2) pass dims+bbox against the table above.
2. All 10 `*.crop3x.png` exist at 1440×1440.
3. `REPORT.md` exists containing, per row: which content state won (title/attract/menu), the observed shader behavior in the crop (uniform grid vs visible beat/moiré pattern — describe what you see, e.g. "grid lines vary in darkness with a period of ~16px horizontally"), any config/environment deviations, which rung of the fallback ladder was used, and the exact titlebar height calibrated. Observations only — the orchestrator writes the verdicts.
4. `git log` in the work dir shows your commits; nothing under moto-racer/pi-config modified (`git -C ~/Developer/moto-racer status --porcelain` clean; `git -C ~/Developer/pi-config status --porcelain` clean apart from this WO's own file which was committed pre-dispatch).
5. Exit codes respected if you hit the specified failure modes (5 no captures, 6 ROM won't boot BIOS-less, 7 geometry unachievable).

## Structural Risks

- [x] Route/path correctness — matrix paths, cell names, crop geometry exactly as specified
- [x] Input validation scope — none (fixed input set); reject nothing silently
- [x] Test surface — manifest gate exercises every canonical output, not internals
- [x] Recovery logic — teardown always kills RA + stage dirs even on failure
- [x] No unrequested changes — moto-racer, pi-config, ~/Downloads untouched
- [x] Build config untouched — no system packages installed
- [x] No unsolicited features — no race-navigation heroics, no GLSL variants, no mockups

## Context

**Prior work**: none in this plan. The moto-racer harness (WO-2026-001/002/003 there) is the direct ancestor; its header comments carry the environment lessons (pause_nonactive, caffeinate, locked-session starvation, UDP quirks like "no STATUS command"). Inheriting those fixes is mandatory, not optional.

**Relevant decisions**: This task deliberately runs outside pi-config (scratch experiment repo at ~/Developer/ds-shader-test); forking moto's harness rather than extracting a shared cross-repo library is an accepted one-off deviation from share-don't-parallel — moto-racer is a closed experiment repo, not a package, and this fork strips most of it.

## Completion Report Format

status / invariant_exhaustiveness / files_modified / tests (manifest gate results) / structural_checks / deviations_from_spec / notes_for_orchestrator. With review_policy skip, no reviewer fields needed — instead include **calibration numbers** (titlebar height, screenshot dims observed per cell) so the orchestrator can audit the geometry without re-running.
