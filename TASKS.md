# DevTeam Agent Platform - Architecture & Task Breakdown

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                      Frontend (React + TS + Vite)       │
│  ┌──────────┐ ┌──────────┐ ┌────────┐ ┌─────────────┐  │
│  │ Project  │ │ Pipeline │ │ Agent  │ │  Files      │  │
│  │ Manager  │ │ Viewer   │ │ Chat   │ │  Browser    │  │
│  └────┬─────┘ └────┬─────┘ └───┬────┘ └──────┬──────┘  │
│       └─────────────┴───────────┴─────────────┘         │
│                     REST + WebSocket                     │
└──────────────────────────┬──────────────────────────────┘
                           │
┌──────────────────────────┴──────────────────────────────┐
│                      Backend (FastAPI + Python)          │
│                                                         │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────┐  │
│  │  REST API   │  │  WebSocket   │  │  Orchestrator  │  │
│  │  Routes     │  │  Manager     │  │  Engine        │  │
│  └──────┬──────┘  └──────┬───────┘  └───────┬────────┘  │
│         │                │                  │            │
│  ┌──────┴────────────────┴──────────────────┴────────┐  │
│  │              Agent Runner Framework               │  │
│  │  ┌─────────┐ ┌─────────┐ ┌─────┐ ┌──────┐ ┌────┐ │  │
│  │  │ Product │ │Architect│ │ Dev │ │ Test │ │UX  │ │  │
│  │  └─────────┘ └─────────┘ └─────┘ └──────┘ └────┘ │  │
│  └───────────────────────┬───────────────────────────┘  │
│                          │                              │
│  ┌───────────────────────┴───────────────────────────┐  │
│  │              Storage Layer (File-based JSON)      │  │
│  └───────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

## Key Architectural Decisions

1. **Monorepo** -- `frontend/` and `backend/` in one repo
2. **Backend-first** -- Build API + agents before UI
3. **Agent Runner as abstraction** -- All 5 agents share a base runner class; each agent is a config (system prompt + tools) not a separate codebase
4. **Orchestrator is event-driven** -- Agent completion emits events; orchestrator subscribes and triggers next step
5. **WebSocket per project** -- One WS connection per active project for streaming all agent output + status updates
6. **Storage layer abstraction** -- Simple file-based read/write behind an interface, easy to swap later if needed

---

## Phases & Tasks

### Phase 1: Project Skeleton & Infrastructure

> Goal: Runnable backend + frontend with basic project CRUD

| # | Task | Description | Dependencies |
|---|------|-------------|-------------|
| 1.1 | **Repo setup** | Init monorepo structure: `frontend/`, `backend/`, root `README.md`, `.gitignore`. Set up Python venv + `requirements.txt`. Set up Vite + React + TS in frontend. | None |
| 1.2 | **Storage layer** | Build `storage.py` -- read/write JSON files, create/delete directories, list files. All file I/O goes through this layer. Create `data/` directory structure on first run. | 1.1 |
| 1.3 | **Project CRUD API** | `POST/GET/PUT/DELETE /projects`. Create project directory structure on creation. Return project list, detail. | 1.2 |
| 1.4 | **Config management** | Global `config.json` for API keys + defaults. Endpoint to read/update config. Validate API key on save. | 1.2 |
| 1.5 | **Frontend shell** | App layout with sidebar, top bar (project switcher), main panel. React Router for navigation. No real data yet -- just the frame. | 1.1 |
| 1.6 | **Project UI** | Project switcher dropdown, new project dialog, project settings page. Wire to backend API. | 1.3, 1.5 |

---

### Phase 2: Agent Runner Framework

> Goal: A single agent can receive a prompt, call Claude, stream the response, and produce an artifact

| # | Task | Description | Dependencies |
|---|------|-------------|-------------|
| 2.1 | **Base agent runner** | `AgentRunner` class: takes system prompt + user prompt + context, calls Claude API with streaming, yields chunks, returns structured result with artifacts. | 1.4 |
| 2.2 | **Agent config loader** | Load agent definitions (system prompt, model, temperature) from per-project `agents/*.json`. Provide defaults if no project override exists. | 1.2, 2.1 |
| 2.3 | **5 agent definitions** | Write default system prompts + config for Product, Architect, Dev, Test, UX/UI agents. Store in `backend/defaults/agents/`. | 2.1 |
| 2.4 | **Artifact model** | Define artifact schema: `id`, `type`, `content`, `version`, `created_at`, `agent`. Save/load artifacts to `tasks/{id}/artifacts/`. | 1.2 |
| 2.5 | **Agent chat endpoint** | `POST /projects/{id}/agents/{name}/chat` -- ad-hoc chat with an agent. Stateless (context comes from project context + user message). Returns streamed response. | 2.1, 2.2, 1.3 |
| 2.6 | **WebSocket streaming** | `WS /projects/{id}/agents/{name}/stream` -- stream agent output in real-time. Backend pushes chunks as agent generates. | 2.1 |

---

### Phase 3: Task & Pipeline Engine

> Goal: Create a task, run it through a pipeline of agents, each triggering the next

| # | Task | Description | Dependencies |
|---|------|-------------|-------------|
| 3.1 | **Task CRUD API** | `POST/GET /projects/{id}/tasks`. Task model: id, title, description, priority, status, current_agent, created_at. Store in `tasks/task-{id}.json`. | 1.2, 1.3 |
| 3.2 | **Pipeline definitions** | Pipeline model: ordered list of steps, each step is an agent name + config. Load from `pipelines/*.json`. Provide default templates (full feature, quick fix, spec only). | 1.2 |
| 3.3 | **Orchestrator engine** | Core engine: given a task + pipeline, execute step 1, collect result, inject artifacts into step 2 context, execute step 2, etc. Handle sequential flow. Emit events on step start/complete/error. | 2.1, 2.4, 3.1, 3.2 |
| 3.4 | **Parallel step support** | Extend orchestrator to run steps in parallel when pipeline config says so (e.g., UX/UI + Dev). Use `asyncio.gather`. | 3.3 |
| 3.5 | **Task history logging** | Log every agent interaction to `tasks/{id}/history.json`: timestamp, agent, input summary, output, artifacts produced. | 3.3 |
| 3.6 | **Pause / resume** | Add `POST /projects/{id}/tasks/{task_id}/pause` and `/resume`. Orchestrator checks pause flag before triggering next step. Paused tasks wait for resume signal. | 3.3 |
| 3.7 | **Redirect / inject** | `POST /projects/{id}/tasks/{task_id}/redirect` -- change next agent or skip. Allow injecting extra context/instructions before next step runs. | 3.3, 3.6 |
| 3.8 | **Event stream** | `WS /projects/{id}/events` -- global event stream for a project. Broadcasts: task status changes, agent start/complete, errors. Frontend subscribes for live updates. | 3.3, 2.6 |

---

### Phase 4: Frontend - Core Views

> Goal: Full working UI for tasks, agents, and pipeline visualization

| # | Task | Description | Dependencies |
|---|------|-------------|-------------|
| 4.1 | **Task list view** | Sidebar task list with status indicators (pending, running, paused, done). Click to view detail. "+ New Task" button with modal. | 3.1, 1.6 |
| 4.2 | **Pipeline view** | Visual flow diagram showing pipeline steps as connected nodes. Highlight current step. Show status per node (pending/running/done/error). | 3.3, 4.1 |
| 4.3 | **Agent streaming panel** | Bottom/right panel showing live agent output as it streams. Connect to WebSocket. Auto-scroll. Markdown rendering. | 2.6, 3.8 |
| 4.4 | **Agent chat UI** | Chat interface for ad-hoc conversations with any agent. Agent selector in sidebar. Message input, streaming response, conversation history (session only). | 2.5 |
| 4.5 | **Artifact viewer** | Browse artifacts for a task. Click to view content (markdown rendered). Show version history. Allow editing artifact content before passing downstream. | 2.4, 4.1 |
| 4.6 | **Pipeline controls** | Pause/Resume/Redirect buttons in pipeline view. Inject instructions modal before next step. | 3.6, 3.7, 4.2 |
| 4.7 | **Agent status sidebar** | Show all 5 agents in sidebar with status indicator (idle/working/error). Click to open agent detail or chat. | 3.8 |

---

### Phase 5: Files & Project Context

> Goal: Browse project files, manage project context that agents use

| # | Task | Description | Dependencies |
|---|------|-------------|-------------|
| 5.1 | **Files API** | `GET /projects/{id}/files` -- return file tree. `GET /projects/{id}/files/{path}` -- read file content. `PUT /projects/{id}/files/{path}` -- write file. | 1.2, 1.3 |
| 5.2 | **Files browser UI** | Tree view in sidebar showing project files. Click file to view content with syntax highlighting. | 5.1, 1.6 |
| 5.3 | **Project context API** | `GET/PUT /projects/{id}/context` -- read and update project context (conventions, decisions, constraints). | 1.3 |
| 5.4 | **Context injection** | When any agent runs, auto-inject project context (tech stack, conventions, file summaries) into its system prompt. | 5.3, 2.1 |
| 5.5 | **Agent file access** | Dev and Test agents can read/write to project `files/` directory. Architect and Product agents can read files for reference. | 5.1, 2.1 |

---

### Phase 6: Settings & Polish

> Goal: Configurable, polished, ready for daily use

| # | Task | Description | Dependencies |
|---|------|-------------|-------------|
| 6.1 | **Settings page** | UI to configure: API key, default model, per-agent system prompts, pipeline templates. | 1.4, 2.2, 3.2 |
| 6.2 | **Agent prompt editor** | In settings, edit each agent's system prompt per project. Preview with test message. | 6.1, 2.2 |
| 6.3 | **Pipeline template editor** | Create/edit pipeline templates. Choose agents, set order, mark parallel steps. | 6.1, 3.2 |
| 6.4 | **Dashboard view** | Landing page: active tasks across projects, recent activity feed, agent utilization. | 4.1, 3.8 |
| 6.5 | **Error handling & retry** | Handle Claude API errors gracefully. Show errors in UI. Allow retry of failed agent steps. | 3.3, 4.3 |
| 6.6 | **Loading states & UX** | Skeleton loaders, progress indicators, empty states, toast notifications for events. | 4.* |

---

## Implementation Order (Critical Path)

```
1.1 ─> 1.2 ─> 1.3 ─> 1.4 ─────────────────────────────────────┐
        │       │                                                │
        │      1.5 ─> 1.6                                       │
        │                                                        │
        └─> 2.1 ─> 2.2 ─> 2.3                                  │
             │      │                                            │
             │     2.4                                           │
             │      │                                            │
             └─> 2.5, 2.6                                        │
                  │    │                                         │
            3.1 ──┘    │                                         │
             │         │                                         │
            3.2 ─> 3.3 ─> 3.4                                   │
                    │                                            │
                   3.5, 3.6 ─> 3.7                               │
                    │                                            │
                   3.8 ────────────────────────────────> 4.* ──> 6.*
                                                         │
                                                    5.1 ─> 5.*
```

**Shortest path to first demo:** 1.1 -> 1.2 -> 1.3 -> 1.4 -> 2.1 -> 2.2 -> 2.3 -> 2.5 -> 2.6 -> 1.5 -> 4.4

This gets you: a running app where you can create a project and chat with an agent that streams responses. ~11 tasks to first visible output.

---

## File Structure (After Phase 1)

```
agents-dev-team/
├── backend/
│   ├── main.py                  # FastAPI app entry point
│   ├── requirements.txt
│   ├── config.py                # Config loading
│   ├── storage.py               # File-based storage layer
│   ├── routes/
│   │   ├── projects.py
│   │   ├── tasks.py
│   │   ├── agents.py
│   │   ├── files.py
│   │   └── websocket.py
│   ├── agents/
│   │   ├── base.py              # AgentRunner base class
│   │   ├── registry.py          # Agent registry + loader
│   │   └── defaults/
│   │       ├── product.json
│   │       ├── architect.json
│   │       ├── dev.json
│   │       ├── test.json
│   │       └── uxui.json
│   ├── orchestrator/
│   │   ├── engine.py            # Pipeline execution engine
│   │   ├── models.py            # Task, Pipeline, Artifact models
│   │   └── events.py            # Event bus
│   └── data/                    # Created at runtime
│       └── ...
├── frontend/
│   ├── package.json
│   ├── vite.config.ts
│   ├── index.html
│   ├── src/
│   │   ├── main.tsx
│   │   ├── App.tsx
│   │   ├── api/                 # API client + WebSocket hooks
│   │   ├── components/
│   │   │   ├── layout/          # Shell, Sidebar, TopBar
│   │   │   ├── projects/        # ProjectSwitcher, ProjectSettings
│   │   │   ├── tasks/           # TaskList, TaskDetail, NewTaskModal
│   │   │   ├── agents/          # AgentChat, AgentStatus, StreamPanel
│   │   │   ├── pipeline/        # PipelineView, PipelineControls
│   │   │   ├── artifacts/       # ArtifactViewer, ArtifactEditor
│   │   │   └── files/           # FileBrowser, FileViewer
│   │   ├── pages/               # Dashboard, Settings
│   │   ├── hooks/               # useWebSocket, useProject, useAgent
│   │   ├── types/               # TypeScript interfaces
│   │   └── stores/              # State management (Zustand or context)
│   └── public/
├── .gitignore
├── README.md
├── SPEC.md
└── TASKS.md
```
