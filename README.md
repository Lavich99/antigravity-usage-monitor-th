<div align="center">

<img src="assets/logo.svg" alt="Antigravity Usage & Speed Monitor Logo" width="84" />

# Antigravity Usage & Speed Monitor (Thai Hard Fork)

**[English](README.md) | [ภาษาไทย](README.th-TH.md)**

Real-time token usage, generation speed (`tok/s`), `TTFT`, Context Window, Quota Pool, and Subagent analytics monitor built exclusively for **Google Antigravity App (Desktop)** — 100% offline, Zero-LLM, and read-only.

[![Release](https://img.shields.io/github/v/release/Lavich99/antigravity-usage-monitor-th?style=flat-square&color=2A5E76&label=release)](https://github.com/Lavich99/antigravity-usage-monitor-th/releases/latest)
[![Stars](https://img.shields.io/github/stars/Lavich99/antigravity-usage-monitor-th?style=flat-square&color=f59e0b)](https://github.com/Lavich99/antigravity-usage-monitor-th/stargazers)
[![License](https://img.shields.io/github/license/Lavich99/antigravity-usage-monitor-th?style=flat-square&color=3b82f6)](LICENSE)
[![Zero Dependencies](https://img.shields.io/badge/dependencies-0%20npm%20packages-10b981?style=flat-square)](#local-development)
[![Supported App](https://img.shields.io/badge/support-Antigravity%20App%20(Desktop)%20Only-6366f1?style=flat-square)](#support-scope)

[Support Scope](#support-scope) · [Features](#features) · [Installation](#installation) · [Usage](#usage) · [Safety & Privacy](#safety--privacy)

</div>

---

## Support Scope

> [!IMPORTANT]
> **Tested & Supported Only on Google Antigravity App (Desktop)** (`Windows` / `macOS` / `Linux`).
> All **Antigravity CLI (`agy`)**, **Antigravity IDE (`.monaco-workbench` / `~/.antigravity-ide`)**, standalone HTTP server, external credential readers, and online auto-updater modules were intentionally removed because they are unverified and not guaranteed to work with this fork.

This repository is an independent hard fork of [`yuhuan-dev/antigravity-usage-monitor`](https://github.com/yuhuan-dev/antigravity-usage-monitor) customized for Thai users and high-precision real-time monitoring inside **Antigravity App**.

---

## Features

- **Thai-First Experience & THB (`฿`) Currency**: Localized UI (`th-TH` by default, switchable to `en-US` / System), compact panel typography (`sm`), and approximate local cost conversion in Thai Baht (`฿`).
- **1–2 Slot Capsule Bar (Locked Pixel Geometry)**:
  - Compact 2-decimal precision (`64.30%`, `52.87%`) with tabular numerals so numbers never jitter.
  - Customize **1 or 2 slots**, drag/swap Left ↔ Right, or toggle a single metric (`Gemini 5h` and `Context` by default).
  - Defaults to **Composer Mount** with **Move Permission beside Model** enabled (`Dual Titlebar` and `Sidebar Only` also supported).
- **Smooth 60fps UI & Running Context Spin**:
  - Smooth `420ms easeInOutCubic` `requestAnimationFrame` transitions on capsule percentages and SVG rings.
  - GPU-composited `60fps` `ease-in-out` rotation on the colored Context Window ring while the AI is actively running (`is-running`).
  - Adaptive Real-Time polling (`700ms` active / `2000ms` idle / `8000ms` hidden) with fast incremental step delta fetching and throttled disk cache writes.
- **Full Split View & Empty New-Chat Support**:
  - Each visible Split View pane gets an independent capsule bound to its own conversation and real model Context Limit (`256k` / `512k`, etc.), including empty new chats before the first prompt.
- **10-Category Context Breakdown & Multi-Pool Quotas**:
  - Tracks `Gemini`, `Gemini 4 Neon`, `Orchestrator (Neon)`, `Gemini 4 Hydrogen`, `Gemini 4 Carbon`, `Gemini 4 Argon`, and `Claude & GPT` with built-in offline pricing (`pricing-catalog.json`) + user-defined custom pricing overrides.
- **Zero-LLM & Offline Read-Only Safety**:
  - Zero external GitHub requests, zero `app.asar` binary patching, and zero network/fetch interception on user prompts.

---

## Installation

**No `npm install` or external packages required.**
Keep the destination folder named `usage-monitor` inside your local Antigravity plugins directory.

### Option 1: Git Clone (Recommended)

**Windows (PowerShell):**
```powershell
git clone https://github.com/Lavich99/antigravity-usage-monitor-th.git "$env:USERPROFILE\.gemini\config\plugins\usage-monitor"
```

**macOS / Linux:**
```bash
git clone https://github.com/Lavich99/antigravity-usage-monitor-th.git ~/.gemini/config/plugins/usage-monitor
```

### Option 2: Install by Asking Antigravity Directly

Copy and paste this prompt into Antigravity App:

```text
Clone https://github.com/Lavich99/antigravity-usage-monitor-th.git into ~/.gemini/config/plugins/usage-monitor and enable the usage-monitor plugin
```

### Option 3: Manual ZIP Download

1. Download the archive from [`Releases`](https://github.com/Lavich99/antigravity-usage-monitor-th/releases) (or **Code → Download ZIP**).
2. Extract it into your plugins folder and rename the extracted folder to `usage-monitor` so the final path is:
   - **Windows:** `%USERPROFILE%\.gemini\config\plugins\usage-monitor`
   - **macOS / Linux:** `~/.gemini/config/plugins/usage-monitor`

---

## Usage

1. Open **Antigravity App** → go to **Customizations → Plugins / Installed** and enable **`usage-monitor`**.
2. **First-Time Activation (Windows / Desktop):**
   - On Windows, the plugin automatically adds `--remote-debugging-port=0` (keeping existing arguments untouched) to Antigravity App shortcuts (`Desktop`, `Start Menu`, `Taskbar`) if needed so the Composer/Titlebar capsule can attach.
   - Restart **Antigravity App** once (via the updated shortcut) if the Composer capsule doesn't appear immediately on the first enable; afterwards it attaches automatically (`Ctrl+Shift+P` → **Reload Window** reloads UI updates anytime).
3. **Capsule Interactions:**
   - **Hover** for quick summary (`Context Window` + `Quota Pools` by default).
   - **Click** to open the full 4-tab Popover (`Live`, `Consumption`, `Details`, `Settings`).
   - **Right-click** to force-refresh telemetry immediately.

---

## Safety & Privacy

- **100% Local Processing**: All settings (`settings.json`) and usage caches stay strictly on your own machine under `~/.gemini/antigravity/sidecar_data/usage-monitor/panel/data/` (never inside the plugin repository).
- **Zero External Telemetry or Auto-Update Network Calls**: Does not phone home to GitHub or external servers. Update anytime manually with:
  ```powershell
  # Windows (PowerShell)
  git -C "$env:USERPROFILE\.gemini\config\plugins\usage-monitor" pull --ff-only
  ```
  ```bash
  # macOS / Linux
  git -C ~/.gemini/config/plugins/usage-monitor pull --ff-only
  ```

---

## Local Development

Uses native Node.js ESM (`v22+` recommended) and Web Components with **0 npm dependencies**:

```bash
cd sidecars/panel
node scripts/build-bundle.mjs
```

---

## Attribution & License

- Hard forked from [`yuhuan-dev/antigravity-usage-monitor`](https://github.com/yuhuan-dev/antigravity-usage-monitor).
- Licensed under the [GNU General Public License v3.0](LICENSE).
