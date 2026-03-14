import { create } from "zustand";
import type { Project, Task } from "../types";
import { api } from "../api/client";

export interface AgentTerminalMessage {
  role: "system" | "assistant" | "user" | "thinking" | "tool";
  content: string;
}

export interface PermissionRequest {
  id: string;
  taskId: string;
  agent: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  category: string;
  summary: string;
}

export interface AgentTerminalState {
  messages: AgentTerminalMessage[];
  streaming: boolean;
  status: "idle" | "pending" | "working" | "done" | "error";
}

export interface ContextUsage {
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheCreation: number;
  contextWindow: number;
  costUSD: number;
  numTurns: number;
  agent: string;
}

interface TaskTerminalSnapshot {
  agentTerminals: Record<string, AgentTerminalState>;
  pipelineAgentTab: string | null;
  pipelineWaitingInput: boolean;
  pipelineChoosingAgent: boolean;
  suggestedNextAgent: string | null;
  askingAgent: boolean;
}

interface AppState {
  projects: Project[];
  activeProjectId: string | null;
  activeAgentName: string | null;
  activeView: "welcome" | "agent-chat" | "settings" | "project-settings" | "pipeline";
  sidebarOpen: boolean;
  loading: boolean;

  // Task & pipeline state
  tasks: Task[];
  activeTaskId: string | null;
  agentTerminals: Record<string, AgentTerminalState>;
  pipelineAgentTab: string | null;
  pipelineWaitingInput: boolean;
  pipelineChoosingAgent: boolean;
  suggestedNextAgent: string | null;
  askingAgent: boolean;
  pendingPermissions: PermissionRequest[];
  autoApproveCategories: Set<string>;  // e.g. {"read", "write", "execute", "all"}
  contextUsage: Record<string, ContextUsage>;  // keyed by agent name
  _taskTerminalsCache: Record<string, TaskTerminalSnapshot>;

  setActiveProject: (id: string | null) => void;
  setActiveAgent: (name: string | null) => void;
  setActiveView: (view: AppState["activeView"]) => void;
  toggleSidebar: () => void;
  fetchProjects: () => Promise<void>;
  createProject: (data: { name: string; description?: string; tech_stack?: string[]; paths?: { label: string; path: string }[] }) => Promise<Project>;
  deleteProject: (id: string) => Promise<void>;

  // Tasks
  fetchTasks: (projectId: string) => Promise<void>;
  deleteTask: (projectId: string, taskId: string) => Promise<void>;
  setActiveTask: (taskId: string | null) => void;
  loadTaskTerminals: (projectId: string, taskId: string) => Promise<void>;
  setPipelineAgentTab: (agentName: string) => void;

  // Agent terminal actions (for pipeline view)
  initAgentTerminals: (agents: string[]) => void;
  appendAgentChunk: (agent: string, content: string) => void;
  setAgentStatus: (agent: string, status: AgentTerminalState["status"]) => void;
  addAgentSystemMessage: (agent: string, content: string) => void;
  addAgentUserMessage: (agent: string, content: string) => void;
  setAskingAgent: (asking: boolean) => void;
  appendAskAgentChunk: (agent: string, content: string) => void;
  setPipelineWaitingInput: (waiting: boolean) => void;
  setPipelineChoosingAgent: (choosing: boolean, suggested?: string | null) => void;
  addPermissionRequest: (req: PermissionRequest) => void;
  removePermissionRequest: (id: string) => void;
  setAutoApprove: (category: string) => void;
  clearAutoApprove: () => void;
  setContextUsage: (agent: string, usage: ContextUsage) => void;
  clearContextUsage: () => void;
  clearAgentTerminals: () => void;
  updateTaskTotalCost: (taskId: string, totalCostUSD: number) => void;
  // Update terminals for a specific task (routes to active or cache)
  _updateTaskTerminals: (taskId: string, updater: (snapshot: TaskTerminalSnapshot) => Partial<TaskTerminalSnapshot>) => void;
}

const EMPTY_TERMINAL: AgentTerminalState = {
  messages: [],
  streaming: false,
  status: "idle",
};

export const useStore = create<AppState>((set, get) => ({
  projects: [],
  activeProjectId: null,
  activeAgentName: null,
  activeView: "welcome",
  sidebarOpen: true,
  loading: false,
  tasks: [],
  activeTaskId: null,
  agentTerminals: {},
  pipelineAgentTab: null,
  pipelineWaitingInput: false,
  pipelineChoosingAgent: false,
  suggestedNextAgent: null,
  askingAgent: false,
  pendingPermissions: [],
  autoApproveCategories: new Set<string>(),
  contextUsage: {},
  _taskTerminalsCache: {},

  setActiveProject: (id) => set({
    activeProjectId: id,
    activeAgentName: null,
    activeView: "welcome",
    tasks: [],
    activeTaskId: null,
    agentTerminals: {},
  }),

  setActiveAgent: (name) => set({ activeAgentName: name, activeView: name ? "agent-chat" : "welcome" }),

  setActiveView: (view) => set({ activeView: view }),

  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),

  fetchProjects: async () => {
    set({ loading: true });
    try {
      let projects = await api.listProjects();

      // Auto-create a default project if none exist
      if (projects.length === 0) {
        const defaultProject = await api.createProject({
          name: "My Project",
          description: "Default project",
        });
        projects = [defaultProject];
      }

      // Auto-select first project if none is active
      const current = get().activeProjectId;
      const activeProjectId = current && projects.some((p: any) => p.id === current)
        ? current
        : projects[0]?.id || null;

      set({ projects, loading: false, activeProjectId });
    } catch {
      set({ loading: false });
    }
  },

  createProject: async (data) => {
    const project = await api.createProject(data);
    set((s) => ({ projects: [...s.projects, project], activeProjectId: project.id }));
    return project;
  },

  deleteProject: async (id) => {
    await api.deleteProject(id);
    set((s) => ({
      projects: s.projects.filter((p) => p.id !== id),
      activeProjectId: s.activeProjectId === id ? null : s.activeProjectId,
    }));
  },

  fetchTasks: async (projectId) => {
    try {
      const tasks = await api.listTasks(projectId);
      set({ tasks });
    } catch {
      // ignore
    }
  },

  deleteTask: async (projectId, taskId) => {
    await api.deleteTask(projectId, taskId);
    set((s) => {
      const cache = { ...s._taskTerminalsCache };
      delete cache[taskId];
      const isActive = s.activeTaskId === taskId;
      return {
        tasks: s.tasks.filter((t) => t.id !== taskId),
        _taskTerminalsCache: cache,
        ...(isActive ? {
          activeTaskId: null,
          activeView: "welcome" as const,
          agentTerminals: {},
          pipelineAgentTab: null,
          pipelineWaitingInput: false,
          pipelineChoosingAgent: false,
          suggestedNextAgent: null,
          askingAgent: false,
        } : {}),
      };
    });
  },

  setActiveTask: (taskId) => set((s) => {
    const cache = { ...s._taskTerminalsCache };

    // Save current task's terminal state
    if (s.activeTaskId && Object.keys(s.agentTerminals).length > 0) {
      cache[s.activeTaskId] = {
        agentTerminals: s.agentTerminals,
        pipelineAgentTab: s.pipelineAgentTab,
        pipelineWaitingInput: s.pipelineWaitingInput,
        pipelineChoosingAgent: s.pipelineChoosingAgent,
        suggestedNextAgent: s.suggestedNextAgent,
        askingAgent: s.askingAgent,
      };
    }

    // Restore target task's terminals (or reset)
    const restored = taskId ? cache[taskId] : null;

    // If no cached terminals, auto-init from task's current state
    const ALL_AGENTS = ["product", "architect", "dev", "test", "uxui"];
    let agentTerminals = restored?.agentTerminals ?? {};
    let pipelineAgentTab = restored?.pipelineAgentTab ?? null;

    if (!restored && taskId) {
      // Initialize empty terminals for all agents
      const terminals: Record<string, AgentTerminalState> = {};
      for (const a of ALL_AGENTS) {
        terminals[a] = { ...EMPTY_TERMINAL, messages: [] };
      }
      agentTerminals = terminals;

      const task = s.tasks.find((t) => t.id === taskId);
      pipelineAgentTab = task?.current_agent || ALL_AGENTS[0];

      // Load saved terminals from backend in background
      if (s.activeProjectId) {
        const pid = s.activeProjectId;
        setTimeout(() => {
          get().loadTaskTerminals(pid, taskId);
        }, 0);
      }
    }

    // Always refresh tasks from backend so statuses are current
    if (s.activeProjectId) {
      const pid = s.activeProjectId;
      setTimeout(() => {
        get().fetchTasks(pid);
      }, 0);
    }

    return {
      activeTaskId: taskId,
      activeView: taskId ? "pipeline" : "welcome",
      _taskTerminalsCache: cache,
      agentTerminals,
      pipelineAgentTab,
      // Always derive flags from task status — cached flags can go stale
      pipelineWaitingInput: taskId ? (s.tasks.find(t => t.id === taskId)?.status === "waiting_input") : false,
      pipelineChoosingAgent: taskId ? (s.tasks.find(t => t.id === taskId)?.status === "choosing_agent") : false,
      suggestedNextAgent: restored?.suggestedNextAgent ?? null,
      askingAgent: false,
    };
  }),

  loadTaskTerminals: async (projectId, taskId) => {
    try {
      const saved = await api.taskTerminals(projectId, taskId);
      if (!saved || Object.keys(saved).length === 0) return;

      // Only apply if this task is still active
      const s = get();
      if (s.activeTaskId !== taskId) return;

      const ALL_AGENTS = ["product", "architect", "dev", "test", "uxui"];
      const terminals: Record<string, AgentTerminalState> = {};
      for (const a of ALL_AGENTS) {
        const msgs = saved[a];
        if (msgs && msgs.length > 0) {
          terminals[a] = {
            messages: msgs.map((m: any) => ({ role: m.role, content: m.content })),
            streaming: false,
            status: "done",
          };
        } else {
          terminals[a] = { ...EMPTY_TERMINAL, messages: [] };
        }
      }

      // Find the last agent with content for the tab
      const task = s.tasks.find((t) => t.id === taskId);
      const agentTab = task?.current_agent || ALL_AGENTS.find(a => terminals[a].messages.length > 0) || ALL_AGENTS[0];

      // Scan for [NEXT:agent] in assistant messages to restore suggested agent
      let suggestedNext: string | null = null;
      for (const a of [...ALL_AGENTS].reverse()) {
        const msgs = terminals[a]?.messages || [];
        for (let i = msgs.length - 1; i >= 0; i--) {
          if (msgs[i].role === "assistant") {
            const match = msgs[i].content.match(/\[NEXT:(\w+)\]/i);
            if (match) {
              const valid = ["product", "architect", "dev", "test", "uxui"];
              if (valid.includes(match[1].toLowerCase())) {
                suggestedNext = match[1].toLowerCase();
              }
            }
            break;
          }
        }
        if (suggestedNext) break;
      }

      set({
        agentTerminals: terminals,
        pipelineAgentTab: agentTab,
        ...(suggestedNext ? { suggestedNextAgent: suggestedNext } : {}),
      });
    } catch {
      // ignore — terminals just won't be restored
    }
  },

  setPipelineAgentTab: (agentName) => set({ pipelineAgentTab: agentName }),

  initAgentTerminals: (agents) => set((s) => {
    const cache = { ...s._taskTerminalsCache };

    // Save current task's terminals before overwriting
    if (s.activeTaskId && Object.keys(s.agentTerminals).length > 0) {
      cache[s.activeTaskId] = {
        agentTerminals: s.agentTerminals,
        pipelineAgentTab: s.pipelineAgentTab,
        pipelineWaitingInput: s.pipelineWaitingInput,
        pipelineChoosingAgent: s.pipelineChoosingAgent,
        suggestedNextAgent: s.suggestedNextAgent,
        askingAgent: s.askingAgent,
      };
    }

    const terminals: Record<string, AgentTerminalState> = {};
    for (const a of agents) {
      terminals[a] = { ...EMPTY_TERMINAL, messages: [] };
    }
    return {
      agentTerminals: terminals,
      pipelineAgentTab: agents[0] || null,
      _taskTerminalsCache: cache,
    };
  }),

  appendAgentChunk: (agent, content) => set((s) => {
    const terminal = s.agentTerminals[agent] || { ...EMPTY_TERMINAL, messages: [] };

    const msgs = [...terminal.messages];
    if (msgs.length > 0 && msgs[msgs.length - 1].role === "assistant") {
      msgs[msgs.length - 1] = {
        ...msgs[msgs.length - 1],
        content: msgs[msgs.length - 1].content + content,
      };
    } else {
      msgs.push({ role: "assistant", content });
    }

    return {
      agentTerminals: {
        ...s.agentTerminals,
        [agent]: { ...terminal, messages: msgs, streaming: true },
      },
    };
  }),

  setAgentStatus: (agent, status) => set((s) => {
    const terminal = s.agentTerminals[agent] || { ...EMPTY_TERMINAL, messages: [] };
    return {
      agentTerminals: {
        ...s.agentTerminals,
        [agent]: { ...terminal, status, streaming: status === "working" },
      },
    };
  }),

  addAgentSystemMessage: (agent, content) => set((s) => {
    const terminal = s.agentTerminals[agent] || { ...EMPTY_TERMINAL, messages: [] };
    return {
      agentTerminals: {
        ...s.agentTerminals,
        [agent]: {
          ...terminal,
          messages: [...terminal.messages, { role: "system", content }],
        },
      },
    };
  }),

  addAgentUserMessage: (agent, content) => set((s) => {
    const terminal = s.agentTerminals[agent] || { ...EMPTY_TERMINAL, messages: [] };
    return {
      agentTerminals: {
        ...s.agentTerminals,
        [agent]: {
          ...terminal,
          messages: [...terminal.messages, { role: "user", content }],
        },
      },
    };
  }),

  setAskingAgent: (asking) => set({ askingAgent: asking }),

  appendAskAgentChunk: (agent, content) => set((s) => {
    const terminal = s.agentTerminals[agent] || { ...EMPTY_TERMINAL, messages: [] };
    const msgs = [...terminal.messages];
    // Append to last assistant message (the ask-agent response)
    if (msgs.length > 0 && msgs[msgs.length - 1].role === "assistant") {
      msgs[msgs.length - 1] = {
        ...msgs[msgs.length - 1],
        content: msgs[msgs.length - 1].content + content,
      };
    } else {
      msgs.push({ role: "assistant", content });
    }
    return {
      agentTerminals: {
        ...s.agentTerminals,
        [agent]: { ...terminal, messages: msgs, streaming: true },
      },
    };
  }),

  setPipelineWaitingInput: (waiting) => set({ pipelineWaitingInput: waiting }),

  setPipelineChoosingAgent: (choosing, suggested = null) => set({
    pipelineChoosingAgent: choosing,
    suggestedNextAgent: suggested ?? null,
  }),

  addPermissionRequest: (req) => set((s) => ({
    pendingPermissions: [...s.pendingPermissions, req],
  })),

  removePermissionRequest: (id) => set((s) => ({
    pendingPermissions: s.pendingPermissions.filter((p) => p.id !== id),
  })),

  setAutoApprove: (category) => set((s) => {
    const next = new Set(s.autoApproveCategories);
    next.add(category);
    return { autoApproveCategories: next };
  }),

  clearAutoApprove: () => set({ autoApproveCategories: new Set() }),

  setContextUsage: (agent, usage) => set((s) => ({
    contextUsage: { ...s.contextUsage, [agent]: usage },
  })),

  clearContextUsage: () => set({ contextUsage: {} }),

  updateTaskTotalCost: (taskId, totalCostUSD) =>
    set((s) => ({
      tasks: s.tasks.map((t) =>
        t.id === taskId ? { ...t, total_cost_usd: totalCostUSD } : t
      ),
    })),

  clearAgentTerminals: () => set({
    agentTerminals: {},
    pipelineAgentTab: null,
    pipelineWaitingInput: false,
    pipelineChoosingAgent: false,
    suggestedNextAgent: null,
    askingAgent: false,
  }),

  _updateTaskTerminals: (taskId, updater) => set((s) => {
    if (taskId === s.activeTaskId) {
      // Update active terminals directly
      const current: TaskTerminalSnapshot = {
        agentTerminals: s.agentTerminals,
        pipelineAgentTab: s.pipelineAgentTab,
        pipelineWaitingInput: s.pipelineWaitingInput,
        pipelineChoosingAgent: s.pipelineChoosingAgent,
        suggestedNextAgent: s.suggestedNextAgent,
        askingAgent: s.askingAgent,
      };
      return updater(current);
    } else {
      // Update cached terminals
      const cached = s._taskTerminalsCache[taskId] || {
        agentTerminals: {},
        pipelineAgentTab: null,
        pipelineWaitingInput: false,
        pipelineChoosingAgent: false,
        suggestedNextAgent: null,
        askingAgent: false,
      };
      const updates = updater(cached);
      return {
        _taskTerminalsCache: {
          ...s._taskTerminalsCache,
          [taskId]: { ...cached, ...updates },
        },
      };
    }
  }),
}));
