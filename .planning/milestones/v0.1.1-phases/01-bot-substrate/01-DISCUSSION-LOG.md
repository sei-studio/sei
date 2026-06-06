# Phase 1: Bot Substrate - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-24
**Phase:** 01-bot-substrate
**Areas discussed:** Runnable form, Owner identification, Auth flow (CONN-02)

---

## Runnable Form

| Option | Description | Selected |
|--------|-------------|----------|
| JSON config file + CLI | config.json loaded by node src/index.js, no Electron coupling | ✓ |
| Stub IPC protocol now | Wire utilityProcess message protocol from day one | |
| Pull from ../sui | Replicate ../sui entry point as-is | |

**User's choice:** JSON config file + CLI
**Notes:** User noted the phase is simple and already validated via ../sui prototype.

---

## Owner Identification

| Option | Description | Selected |
|--------|-------------|----------|
| Config field | owner_username in config.json | ✓ |
| First player to join | Bot assigns owner to first player seen | |
| Chat command | !own claim command | |

**User's choice:** Config field (owner_username)
**Notes:** Explicit and easy to test on local server.

---

## Auth Flow (CONN-02)

| Option | Description | Selected |
|--------|-------------|----------|
| Offline mode for Phase 1 | Test against local offline/LAN server | ✓ |
| Microsoft auth from the start | Target online-mode server, mineflayer handles stdout | |
| Config-driven (support both) | auth field: offline or microsoft | |

**User's choice:** Offline mode for Phase 1
**Notes:** User asked "what is device-code OAuth?" — confirmed mineflayer handles it natively via stdout when auth: "microsoft". Singleplayer/LAN works with auth: "offline", no Microsoft account needed. config.json will support both modes; offline is the dev default.

---

## Claude's Discretion

- Pathfinder timeout value
- Zod schema field naming conventions
- Internal src/ module structure
- Debounce mechanism implementation
