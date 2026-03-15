import { useEffect, useState } from "react";
import { useStore } from "./stores/useStore";
import { api } from "./api/client";
import { AuthScreen } from "./components/layout/AuthScreen";
import { TopBar } from "./components/layout/TopBar";
import { Sidebar } from "./components/layout/Sidebar";
import { MainPanel } from "./components/layout/MainPanel";
import "./App.css";

export default function App() {
  const fetchProjects = useStore((s) => s.fetchProjects);
  const [authChecked, setAuthChecked] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);

  useEffect(() => {
    api.getConfig().then((config) => {
      if (config.authenticated) {
        setAuthenticated(true);
        fetchProjects().then(() => {
          // Restore last project/task from localStorage
          const savedProject = localStorage.getItem("lastProjectId");
          const savedTask = localStorage.getItem("lastTaskId");
          if (savedProject) {
            const store = useStore.getState();
            if (store.projects.some((p: any) => p.id === savedProject)) {
              store.fetchTasks(savedProject).then(() => {
                if (savedTask) {
                  store.setActiveTask(savedTask);
                }
              });
            } else {
              // Saved project no longer exists
              localStorage.removeItem("lastProjectId");
              localStorage.removeItem("lastTaskId");
            }
          }
        });
      }
      setAuthChecked(true);
    }).catch(() => {
      setAuthChecked(true);
    });
  }, [fetchProjects]);

  if (!authChecked) {
    return (
      <div className="auth-screen">
        <div className="auth-validating">
          <div className="auth-spinner" />
          <span>Connecting...</span>
        </div>
      </div>
    );
  }

  if (!authenticated) {
    return (
      <AuthScreen
        onAuthenticated={() => {
          setAuthenticated(true);
          fetchProjects();
        }}
      />
    );
  }

  return (
    <div className="app">
      <TopBar />
      <div className="app-body">
        <Sidebar />
        <MainPanel />
      </div>
    </div>
  );
}
