# DevTeam Agent Platform - Product Spec

## Overview

A locally-hosted web platform for managing a virtual dev team composed of AI agents. Each agent has a specialized role (Product, Architect, Dev, Test, UX/UI) and they can trigger each other in workflows, passing results between steps. A real-time UI shows agent progress, allows ad-hoc interactions, and provides full visibility into the pipeline.

The platform supports multiple projects, each with its own isolated workspace, files, tasks, and agent configurations.

---

## Core Concepts

### Agents

| Agent | Role | Inputs | Outputs |
|-------|------|--------|---------|
| **Product Agent** | Translates user requests into specs, user stories, acceptance criteria | Raw feature request, feedback | PRD, user stories, priority rankings |
| **Architect Agent** | Designs system architecture, defines contracts, selects patterns | PRD / user stories | Architecture doc, API contracts, data models, tech decisions |
| **UX/UI Agent** | Creates wireframes, component specs, design tokens | PRD, architecture constraints | Component specs, layout descriptions, style guidelines |
| **Dev Agent** | Writes code, implements features, fixes bugs | Architecture doc, component specs, existing codebase | Code changes (files), PRs, implementation notes |
| **Test Agent** | Writes and runs tests, validates acceptance criteria | Code changes, acceptance criteria | Test results, coverage reports, bug reports |

### Pipelines

A **pipeline** is a predefined or custom sequence of agent steps triggered by a task. Example:

```
User Request
  -> Product Agent (writes spec)
    -> Architect Agent (designs solution)
      -> UX/UI Agent (component specs)  [parallel with below]
      -> Dev Agent (implements)
        -> Test Agent (validates)
          -> Dev Agent (fixes issues, if any)
```

Agents pass structured **artifacts** to the next agent. Each artifact is versioned and viewable in the UI.

### Tasks

A **task** is a unit of work that flows through the pipeline. It has:
- Title, description, priority
- Current status (which agent is working on it)
- Full history of agent interactions and artifacts
- Ability to pause, redirect, or inject human input at any step

### Projects

Each project is a first-class entity in the system. Users can create, switch between, and manage multiple projects. Each project has its own isolated workspace with its own files, tasks, agent configs, and pipelines.

---

## Multi-Project Data Structure

```
data/
├── config.json                    # Global config (API keys, defaults)
├── projects/
│   ├── project-001/
│   │   ├── project.json           # Project metadata (name, description, tech stack, repo path)
│   │   ├── context.json           # Project-specific context for agents
│   │   ├── agents/
│   │   │   ├── product.json       # Per-project agent config overrides
│   │   │   ├── architect.json
│   │   │   ├── dev.json
│   │   │   ├── test.json
│   │   │   └── uxui.json
│   │   ├── tasks/
│   │   │   ├── task-001.json
│   │   │   └── task-001/
│   │   │       ├── artifacts/
│   │   │       │   ├── prd-v1.md
│   │   │       │   └── architecture-v1.md
│   │   │       └── history.json
│   │   ├── pipelines/
│   │   │   ├── default.json
│   │   │   └── quick-fix.json
│   │   └── files/                 # Project's own working files
│   │       ├── src/
│   │       ├── docs/
│   │       └── ...
│   │
│   ├── project-002/
│   │   ├── project.json
│   │   ├── context.json
│   │   ├── agents/
│   │   ├── tasks/
│   │   ├── pipelines/
│   │   └── files/
│   │
│   └── ...
```

### Project Metadata (`project.json`)

```json
{
  "id": "project-001",
  "name": "E-Commerce Platform",
  "description": "Online marketplace with seller and buyer flows",
  "created_at": "2026-03-07T10:00:00Z",
  "tech_stack": ["React", "FastAPI", "PostgreSQL"],
  "repo_path": "/Users/keren/git/ecommerce",
  "status": "active"
}
```

### Project Context (`context.json`)

Agents read this to understand the project they're working on -- conventions, decisions, constraints. This grows over time as agents learn about the project.

```json
{
  "conventions": ["Use Zod for validation", "Functional components only"],
  "architecture_decisions": [],
  "known_patterns": [],
  "tech_constraints": ["Must run on Node 18+"]
}
```

---

## UI Design

### Layout

```
┌──────────────────────────────────────────────────────────────┐
│  Project Switcher: [E-Commerce Platform v]  [+ New Project]  │
├──────────────┬───────────────────────────────────────────────┤
│  Sidebar     │  Main Panel                                   │
│              │                                               │
│  ┌────────┐  │  ┌─────────────────────────────────────────┐  │
│  │ Tasks   │  │  │ Pipeline View / Agent Detail / Files   │  │
│  │ - Auth  │  │  │                                         │  │
│  │ - Cart  │  │  │  [Product] -> [Arch] -> [Dev]           │  │
│  ├────────┤  │  │              \ [UX/UI] /                 │  │
│  │ Agents  │  │  │      current: Dev Agent *               │  │
│  │  Prod   │  │  │                                         │  │
│  │  Dev    │  │  │                                         │  │
│  ├────────┤  │  ├─────────────────────────────────────────┤  │
│  │ Files   │  │  │ Agent Chat / Artifact Viewer            │  │
│  │  src/   │  │  │                                         │  │
│  │  docs/  │  │  │  Agent: Dev Agent                       │  │
│  ├────────┤  │  │  Status: Implementing auth               │  │
│  │+ Task   │  │  │  ████████░░ 80%                         │  │
│  │+ Ad-hoc │  │  │                                         │  │
│  └────────┘  │  │  [Type message...] [Send]                │  │
│              │  └─────────────────────────────────────────┘  │
└──────────────┴───────────────────────────────────────────────┘
```

### Key Views

1. **Dashboard** -- Overview of all active tasks, agent statuses, recent activity
2. **Pipeline View** -- Visual flow diagram for a specific task showing which agents ran, current step, outputs at each node
3. **Agent Detail** -- Live streaming output of what an agent is doing, plus chat interface for ad-hoc questions
4. **Artifacts Browser** -- View all generated docs, code, specs, test results with version history
5. **Files Browser** -- Browse and view the project's own working files
6. **Settings** -- Configure agent system prompts, API keys, pipeline templates, target project repo

---

## Agent Orchestration

### Trigger Mechanism

Each agent step produces a structured result:

```json
{
  "agent": "product",
  "task_id": "task-123",
  "status": "completed",
  "artifacts": [
    { "type": "prd", "content": "...", "version": 1 }
  ],
  "next_agents": ["architect"],
  "context_for_next": { "prd_id": "artifact-456" }
}
```

The **orchestrator** receives this, resolves the next agent(s), injects the relevant artifacts as context, and triggers execution. Parallel branches are supported (e.g., UX/UI and Dev can run simultaneously if configured).

### Human-in-the-Loop

At any point, a user can:
- **Pause** a pipeline before the next agent runs
- **Edit** an artifact before it's passed downstream
- **Redirect** -- skip an agent or re-run a previous one
- **Inject** -- add instructions or constraints to the next agent's context
- **Chat** -- ask any agent an ad-hoc question (outside a pipeline)

### Agent Memory

Each agent maintains:
- **Project context** -- persistent knowledge about the target project (tech stack, conventions, existing code)
- **Task context** -- everything related to the current task (upstream artifacts, conversation history)
- **Learned preferences** -- patterns from user feedback ("we always use Zod for validation", "prefer functional components")

### Agent Scoping

When an agent runs within a project, it automatically receives:
1. **Project metadata** -- tech stack, description
2. **Project context** -- conventions, past decisions
3. **Project files** -- can read/reference existing code in `files/`
4. **Task artifacts** -- upstream outputs from the current pipeline

Each project is a clean, isolated workspace. Agents working on Project A know nothing about Project B.

---

## Technical Architecture

```
┌──────────────┐     WebSocket / SSE      ┌──────────────┐
│   Frontend   │ <─────────────────────-> │   Backend    │
│  React + TS  │                          │   FastAPI    │
│  Vite        │                          │   Python     │
└──────────────┘                          ├──────────────┤
                                          │ Orchestrator │
                                          │   Engine     │
                                          ├──────┬───────┤
                                          │      │       │
                                    ┌─────┴┐ ┌───┴──┐ ┌──┴────┐
                                    │Agent │ │Agent │ │Agent  │
                                    │Runner│ │Runner│ │Runner │
                                    └──┬───┘ └──┬───┘ └──┬────┘
                                       │        │        │
                                    ┌──┴────────┴────────┴──┐
                                    │   LLM API (Claude)    │
                                    └───────────────────────┘

Storage: File-based JSON + flat files for artifacts
```

### Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 18 + TypeScript + Vite |
| Backend | FastAPI + Python |
| Real-time | WebSockets (agent streaming) + SSE (status updates) |
| LLM | Claude API (claude-opus-4-6 for complex agents, claude-sonnet-4-6 for simpler tasks) |
| Storage | File-based JSON (tasks, config, agent state) + flat files (artifacts, code) |
| Process | Async Python (asyncio) for concurrent agent execution |

### API Endpoints

```
# Projects
POST   /projects                          -- Create project
GET    /projects                          -- List all projects
GET    /projects/{id}                     -- Get project detail
PUT    /projects/{id}                     -- Update project settings
DELETE /projects/{id}                     -- Delete project

# Tasks (scoped to project)
POST   /projects/{id}/tasks               -- Create task
GET    /projects/{id}/tasks               -- List tasks
GET    /projects/{id}/tasks/{task_id}     -- Get task detail
POST   /projects/{id}/tasks/{task_id}/pause
POST   /projects/{id}/tasks/{task_id}/resume
POST   /projects/{id}/tasks/{task_id}/redirect

# Agents (scoped to project)
GET    /projects/{id}/agents              -- List agents + status for project
PUT    /projects/{id}/agents/{name}       -- Update agent config for project
POST   /projects/{id}/agents/{name}/chat  -- Ad-hoc chat (project-aware)
WS     /projects/{id}/agents/{name}/stream

# Files (project workspace)
GET    /projects/{id}/files               -- List file tree
GET    /projects/{id}/files/{path}        -- Read file
PUT    /projects/{id}/files/{path}        -- Write/update file

# Artifacts (scoped to project + task)
GET    /projects/{id}/tasks/{task_id}/artifacts
GET    /projects/{id}/tasks/{task_id}/artifacts/{artifact_id}
PUT    /projects/{id}/tasks/{task_id}/artifacts/{artifact_id}

# Pipelines (scoped to project)
GET    /projects/{id}/pipelines
POST   /projects/{id}/pipelines

# Global event stream
WS     /projects/{id}/events              -- Project-scoped events
```

---

## Pipeline Templates

### Full Feature (default)
`Product -> Architect -> [UX/UI + Dev (parallel)] -> Test -> (loop back to Dev if failures)`

### Quick Fix
`Dev -> Test`

### Spec Only
`Product -> Architect`

### Design Review
`Product -> UX/UI -> (human review)`

### Custom
User defines steps via drag-and-drop in UI or JSON config.

---

## Project Lifecycle

### Create
User provides name, description, tech stack. Optionally imports files from an existing repo path (copies or symlinks).

### Work
Tasks are created, pipelines run, agents produce artifacts, files accumulate.

### Archive
Mark a project as archived -- hidden from switcher but data preserved.

### Delete
Removes all project data (with confirmation).

---

## User Flows

### Flow 1: New Feature Request
1. User clicks "+ New Task", types "Add user authentication with OAuth"
2. System creates task, starts default pipeline
3. Product Agent generates PRD with user stories -- streams in UI
4. User reviews, optionally edits, clicks "Continue"
5. Architect Agent produces architecture doc -- streams in UI
6. UX/UI Agent and Dev Agent run in parallel
7. Test Agent validates -- reports pass/fail
8. If failures: Dev Agent receives bug report, iterates
9. Final artifacts viewable in task detail

### Flow 2: Ad-hoc Question
1. User clicks on Architect Agent in sidebar
2. Types: "What's the best way to handle file uploads in our stack?"
3. Agent responds with project-aware answer (knows the tech stack from project context)
4. No task created -- just a conversation

### Flow 3: Interrupt Pipeline
1. Task is running, Architect Agent just finished
2. User reads architecture doc, disagrees with database choice
3. User clicks "Pause", edits the artifact, adds note: "Use SQLite, not Postgres"
4. User clicks "Resume" -- Dev Agent receives the edited artifact

---

## MVP Scope (v1)

### In scope
1. **Multi-project management** -- create, switch, configure projects with isolated workspaces
2. **5 agents** with distinct system prompts and roles
3. **Pipeline execution** -- sequential agent triggering with artifact passing
4. **Live streaming UI** -- see agent output in real-time via WebSocket
5. **Ad-hoc chat** -- talk to any agent directly
6. **Task management** -- create, view, track tasks through pipeline
7. **Artifact viewer** -- browse all generated docs/code
8. **Files browser** -- browse project files
9. **Pause/resume** -- human-in-the-loop control
10. **File-based storage** -- no database needed
11. **Settings page** -- configure API key, agent prompts, target project path

### Out of scope for v1
- Git integration (auto-commit, PR creation)
- Agent-to-agent direct negotiation (e.g., architect pushes back on product)
- Code execution sandbox for test agent
- Authentication (local only)
- Drag-and-drop pipeline builder

---

## Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Local-only | Yes | Privacy, speed, no infra cost |
| File-based storage | JSON + flat files | Simple, no DB setup, git-friendly |
| WebSocket for streaming | Yes | Real-time agent output is core UX |
| Agent independence | Each agent has own system prompt + context window | Clean separation of concerns |
| Artifact-based handoff | Structured docs between agents | Inspectable, editable, versionable |
| Multi-project isolation | Each project gets its own folder | Clean separation, no cross-contamination |
