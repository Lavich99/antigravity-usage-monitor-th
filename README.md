<div align="center">

<img src="assets/logo.svg" alt="Antigravity Usage & Speed Monitor Logo" width="84" />

# Antigravity Usage & Speed Monitor (Thai Hard Fork)

> Thai-localized, offline-safe hard fork of [`yuhuan-dev/antigravity-usage-monitor`](https://github.com/yuhuan-dev/antigravity-usage-monitor) for Google Antigravity 2.0, Antigravity IDE, and Antigravity CLI, with zero external npm dependencies.

[![Release](https://img.shields.io/github/v/release/Lavich99/antigravity-usage-monitor-th?style=flat-square&color=2A5E76&label=release)](https://github.com/Lavich99/antigravity-usage-monitor-th/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/Lavich99/antigravity-usage-monitor-th/total?style=flat-square&color=0ea5e9)](https://github.com/Lavich99/antigravity-usage-monitor-th/releases)
[![Stars](https://img.shields.io/github/stars/Lavich99/antigravity-usage-monitor-th?style=flat-square&color=f59e0b)](https://github.com/Lavich99/antigravity-usage-monitor-th/stargazers)
[![License](https://img.shields.io/github/license/Lavich99/antigravity-usage-monitor-th?style=flat-square&color=3b82f6)](LICENSE)
[![Zero Dependencies](https://img.shields.io/badge/dependencies-0%20npm%20packages-10b981?style=flat-square)](#local-development)
[![Platforms](https://img.shields.io/badge/platforms-Windows%20%7C%20macOS%20%7C%20Linux-6366f1?style=flat-square)](#client-support)

[Features](#features) · [Client Support](#client-support) · [Installation](#installation) · [Usage](#usage) · [Development](#local-development)

</div>

---

## Features

- **Live Metrics & Customizable Layout**: Tracks output speed (`tok/s`), time-to-first-token (`TTFT`), session average speed, step/session USD & THB (`฿`) cost, cache hit rate, tightest remaining quota, and session tokens. Choose and reorder overview metric cards and section blocks cleanly.
- **Thai-First UX & Smooth 60fps Animations**: Defaults to Thai (`th-TH`), THB (`฿`) conversion, compact font scaling, 1–2 customizable Capsule slots (`Gemini 5h` & `Context` with 2-decimal precision), Composer dock with Permission moved left, smooth `easeInOutCubic` 60fps transitions, and a GPU-composited spinning colored Context ring while the AI is actively running.
- **10-Category Context Breakdown**: Shows the token breakdown of the latest request across assistant replies, tool results, user messages, subagent notifications, checkpoints, system prompts, system tools, MCP tools, skills, and user rules, with a switcher between the main agent and spawned subagents.
- **Quota Pool Tracking**: Dynamically reads 5-hour and weekly quotas, reset timers, and cycle consumption across `Gemini`, `Gemini 4 Argon`, `Gemini 4 Carbon`, `Claude & GPT`, and future pools, preserving cached pool status with a stale badge when upstream quota data is temporarily unavailable.
- **Main Agent, Subagents & Multi-Session Views**: Merges main agent and subagent steps in chronological order (or filters by individual agent), renders optional turn rails, expands running subagent tasks inline, and provides a recent-conversation selector in the header.
- **Call Details & Custom Token Formats**: Includes **By Step** and **By Model** tabs (with multi-model throughput charts). Supports 2–14 configurable columns, optional speed color grading, preset `Ctx / Think / Reply` and `In / Out / Cache` columns, and custom token combination strings such as `context:new:cache` or `in:out:cache`.
- **Historical Usage & Breakdowns**: Summarizes tokens, uncached input vs. cache-read savings, thinking/output split, hourly/daily trend curves, model rankings, client attribution (`Desktop App` / `IDE` / `CLI`), and monthly bar charts across `Today`, `1d`, `7d`, `14d`, `30d`, `All`, or custom date/time ranges.
- **Multi-Client Capsules & Hover Popover**: Integrates as a titlebar or composer capsule (including Split View multi-pane support) and auxiliary sidebar in Antigravity 2.0, with multi-colored context ring segments, circular quota rings (`Left` / `Used`), and `Auto Fit` or fixed (`440–1080 px`) popover widths.
- **Offline Security & Custom Model Pricing**: Runs strictly offline (no external GitHub sync/auto-updater, no credential readers, and no outbound request interception). Supports `th-TH` / `en-US` / host language and custom offline per-model USD/1M pricing for future models.

---

## Client Support

| Client | Status Capsule / Bar | Panel UI | Offline SQLite &amp; Logs | Per-Model Context Limit | Modifies `app.asar` |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **Antigravity 2.0 (Desktop)** | Titlebar / Composer | Popover + Right Sidebar | Yes | Window Request Hook | No |
| **Antigravity IDE** | Titlebar / Composer | Capsule Popover | Yes | Window Request Hook | No |
| **Antigravity CLI (`agy`)** | Native ANSI `statusLine` | Standalone Web (`--port`) | Yes (`node:sqlite` + `.pbtxt`) | `AGY_CLI_AUTO_COMPACT_OVERRIDE` | No |
| **Remote / Headless Linux** | Native ANSI `statusLine` | SSH Tunnel / `--token` Web | Yes | `AGY_CLI_AUTO_COMPACT_OVERRIDE` | No |

> [!NOTE]
> On **Antigravity IDE**, enabling the plugin automatically adds `"remote-debugging-port": "0"` to `~/.antigravity-ide/argv.json` (preserving comments and existing keys) via a zero-tool MCP keep-alive entry (`0` context tokens). Restart Antigravity IDE once after the first activation so the titlebar capsule can attach.

---

## Installation

Keep the folder name as `usage-monitor`. **No `npm install` is needed.**

### Option 1: Git Clone

```powershell
# Windows (PowerShell)
git clone https://github.com/Lavich99/antigravity-usage-monitor-th.git "$env:USERPROFILE\.gemini\config\plugins\usage-monitor"
```

```bash
# macOS / Linux
git clone https://github.com/Lavich99/antigravity-usage-monitor-th.git ~/.gemini/config/plugins/usage-monitor
```

Or ask Antigravity directly:

```text
Clone https://github.com/Lavich99/antigravity-usage-monitor-th to ~/.gemini/config/plugins/usage-monitor and enable the plugin
```

### Option 2: Release ZIP

Download [`usage-monitor.zip`](https://github.com/Lavich99/antigravity-usage-monitor-th/releases/latest/download/usage-monitor.zip) and extract it into `~/.gemini/config/plugins/` so the directory path is `~/.gemini/config/plugins/usage-monitor`.

<details>
<summary>Windows PowerShell command for ZIP installation</summary>

```powershell
$pluginsDir = "$env:USERPROFILE\.gemini\config\plugins"
New-Item -ItemType Directory -Path $pluginsDir -Force | Out-Null
Invoke-WebRequest -Uri "https://github.com/Lavich99/antigravity-usage-monitor-th/releases/latest/download/usage-monitor.zip" -OutFile "$env:TEMP\usage-monitor.zip"
Expand-Archive -Path "$env:TEMP\usage-monitor.zip" -DestinationPath $pluginsDir -Force
```

</details>

---

## Usage

1. Open **Customizations → Installed** in the left sidebar and enable `usage-monitor`.
2. **Antigravity 2.0 (Desktop)**:
   - Mounts a capsule in the top-right titlebar (**hover** for summary, **click** for the 4-tab popover, **right-click** to refresh), alongside the right auxiliary sidebar pane.
3. **Antigravity IDE**:
   - **Restart Antigravity IDE once** after enabling for the first time. Keep **Mount Mode** on **Dual-mount** and click the top-bar capsule to open the panel.
4. **Antigravity CLI (`agy`)**:
   - When `~/.gemini/antigravity-cli` exists, `statusLine` in `settings.json` is configured automatically (existing third-party `statusLine.command` entries are left untouched) to render a single-line ANSI bar (`● 1 active   38.1 t/s | 0.85s | ◎ 17%`).
   - Toggle via `/statusline` in `agy` or **Preferences → Structure → Mount & Capsule Bar**.
5. **Standalone Web Server (Headless / Remote)**:

```bash
# 1. Start on the host (listens on 127.0.0.1:8787 by default)
node ~/.gemini/config/plugins/usage-monitor/sidecars/panel/standalone.mjs --port 8787

# 2. Forward the port locally and open http://localhost:8787
ssh -L 8787:127.0.0.1:8787 user@your-server
```

<details>
<summary>Standalone CLI flags, background auto-start, and non-loopback token auth</summary>

- **Auto-start with `agy`**: Set `USAGE_MONITOR_STANDALONE_PORT=8787` or `"standalonePort": 8787` in `~/.gemini/antigravity-cli/sidecar_data/usage-monitor/panel/data/settings.json` to start the web UI together with the MCP sidecar supervisor.
- **Non-loopback auth**: Binding to `0.0.0.0` or a LAN address requires `--token <secret>` (or `USAGE_MONITOR_STANDALONE_TOKEN`); starting on a non-loopback address without a token is rejected.
- **Overrides**: Supports `--data-dir`, `--app-data-dir`, `--gemini-dir`, `--ls-addr`, and `--csrf-token`.
- **Offline fallback**: When `agy` is not running, the backend reads `~/.gemini/antigravity-cli` (`conversation_summaries.db`, `conversations/*.db`, `annotations/*.pbtxt`, and `transcript.jsonl`) and switches to live RPC once `agy` starts.

</details>

---

## Configuration & Calculation Notes

<details>
<summary>UI options: mount mode, capsule slots, token formats, model IDs, and context limits</summary>

- **Mount Mode & Width**: Defaults to **Composer** mount with **Move Permission Left** enabled (`Auto Fit` popover or custom `440–1080 px`, default `550 px`). Switch anytime between **Dual-mount**, **Composer**, and **Sidebar only**.
- **Capsule Slots**: Choose **1–2** metric slots and reorder/swap or toggle them (default: **Gemini 5h** & **Context Usage**, 2-decimal precision, spinning colored Context ring while running).
- **Call Details Table & Token Format**: Defaults to agent badges, turn rail, and speed color grading enabled with columns `Step`, `Model`, `TPS`, `Ctx / Think / Reply`, `Cache`, and `Cost`, plus custom format strings like `context:new:cache` or `in:out:cache`.
- **Model Name Format**: Choose **Compact short alias** (`argon-4-high`), **Full raw ID**, or **Trimmed raw ID** (strips `gemini-` / `claude-` / `gpt-` prefixes while keeping `·compact` suffixes intact). Orchestrator series IDs have a separate setting.
- **Per-Model Context Limits**: Configure limits per model across thinking levels or follow host defaults under **Preferences → Other → Model Context Settings**. App/IDE applies saved rules at startup; CLI sets `AGY_CLI_AUTO_COMPACT_OVERRIDE`.

</details>

<details>
<summary>Model identification, compaction inference, and cost estimation rules</summary>

- **Model Resolution**: Read from each step's raw usage payload or matching generator metadata; explicit models are never overwritten. When an automatic compaction step omits the model field, it is inferred from adjacent steps in the same conversation (checking prior steps first, then following steps, preferring the same provider) for display and estimation, or shown as unknown compaction if none exist.
- **Cost Calculation**: If a model or price entry cannot be resolved, step cost is shown as pending while tokens still count toward totals; session totals sum all resolved steps. USD numbers are estimated from public per-million-token API pricing in [`pricing-catalog.json`](pricing-catalog.json) for reference only and do **not** reflect subscription quota consumption.
- **Cache & Speed Averages**: Upgrading re-checks cached entries against raw trajectory data while preserving token counts and valid timings. Compaction steps display request TPS in step tables but are excluded from session speed and TTFT averages.

</details>

<details>
<summary>Updating and data directory</summary>

- **Offline Updates**: External GitHub auto-update/network catalog sync is disabled in this edition for offline safety. Update anytime manually using `git pull` or ZIP extraction below.
- **Manual Git Update**:
  - Windows: `git -C "$env:USERPROFILE\.gemini\config\plugins\usage-monitor" pull --ff-only`
  - macOS / Linux: `git -C ~/.gemini/config/plugins/usage-monitor pull --ff-only`
  - Toggle the plugin off and back on in **Customizations → Installed**.
- **Data Persistence**: Settings and parsed caches live in `~/.gemini/antigravity/sidecar_data/usage-monitor/` (or `sidecars/panel/.data/` in standalone mode), so updates keep existing history intact.

</details>

---

## Local Development

All backend and frontend modules use Node.js ESM and native Web Components with **no external npm dependencies** (Node.js 22.5+ is recommended for built-in `node:sqlite`).

```bash
cd sidecars/panel

# Rebuild app.js and styles.css after modifying src/
npm run build

# Run unit and integration tests
npm test
```

## Contributing & License

Issues and pull requests are welcome. If you modify files under `sidecars/panel/src/`, please rebuild via `npm run build` and check the verification suites.

Forked from [`yuhuan-dev/antigravity-usage-monitor`](https://github.com/yuhuan-dev/antigravity-usage-monitor).
Licensed under the [GNU General Public License v3.0](LICENSE).

## Star History

<a href="https://www.star-history.com/#Lavich99/antigravity-usage-monitor-th&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=Lavich99/antigravity-usage-monitor-th&type=Date&theme=dark" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=Lavich99/antigravity-usage-monitor-th&type=Date" />
    <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=Lavich99/antigravity-usage-monitor-th&type=Date" />
  </picture>
</a>
