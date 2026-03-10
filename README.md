# DevTeam Agent Platform

A locally-hosted web platform for managing a virtual dev team composed of AI agents (Product, Architect, Dev, Test, UX/UI). Agents trigger each other in pipelines, passing artifacts between steps.

## Quick Start

### Backend

```bash
cd backend
source .venv/bin/activate
uvicorn main:app --reload --port 8000
```

### Frontend

```bash
cd frontend
npm run dev
```

Open http://localhost:5173

## Tech Stack

- **Frontend**: React 18 + TypeScript + Vite
- **Backend**: FastAPI + Python
- **LLM**: Claude API (Anthropic)
- **Storage**: File-based JSON
