export interface ProjectPath {
  label: string;
  path: string;
}

export interface Project {
  id: string;
  name: string;
  description: string;
  tech_stack: string[];
  paths: ProjectPath[];
  status: string;
  created_at: string;
}

export interface Task {
  id: string;
  name?: string;
  title: string;
  description: string;
  priority: string;
  status: string;
  current_agent: string | null;
  pipeline_id: string | null;
  created_at: string;
  worktree_path?: string | null;
  branch_name?: string | null;
  total_cost_usd?: number;
  agent_costs?: Record<string, number>;
  error_message?: string;
}

export interface Agent {
  name: string;
  display_name: string;
  status: "idle" | "working" | "error";
  current_task_id: string | null;
}

export interface Artifact {
  id: string;
  type: string;
  content: string;
  agent: string;
  created_at: string;
  updated_at?: string;
}

export interface PipelineStep {
  agent: string;
  status: "pending" | "running" | "completed" | "error" | "skipped";
  artifacts: string[];
}

export interface Pipeline {
  id: string;
  name: string;
  steps: PipelineStep[];
}

export interface AppConfig {
  anthropic_api_key: string;
  default_model: string;
  complex_model: string;
}

export interface FileNode {
  name: string;
  path: string;
  type: "file" | "directory";
  size?: number;
  children?: FileNode[];
}
