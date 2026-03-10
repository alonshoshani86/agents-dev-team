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
        fetchProjects();
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
