/* eslint-disable @typescript-eslint/no-floating-promises */
"use client";

import { useCallback, useMemo, useState, type ReactNode } from "react";
import { RefreshCcw, Rocket, UserPlus, ShieldAlert } from "lucide-react";

import { cn } from "../lib/utils";

const API = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8080";

type HealthResponse = {
  ok: boolean;
  status?: number;
  error?: string;
  body?: unknown;
  ollama_url: string;
};

type SessionSummary = {
  id: string;
  phase: string;
  info: SessionPayload;
};

type SessionPayload = {
  title: string;
  problem_statement: string;
  time_limit_sec: number;
  strategy: string;
};

type AgentPayload = {
  name: string;
  role: "moderator" | "participant" | "notetaker";
  trait: string;
  model_hint: string;
};

type LogEntry = {
  id: string;
  level: "info" | "success" | "error";
  message: string;
  timestamp: number;
};

const STRATEGY_OPTIONS = [
  { label: "Double Diamond (default)", value: "double_diamond" },
  { label: "Design Sprint", value: "design_sprint" },
  { label: "Custom", value: "custom" },
];

const TRAIT_OPTIONS = [
  { label: "Balanced (no trait)", value: "" },
  { label: "Contrarian", value: "contrarian" },
  { label: "Domain Expert", value: "domain_expert" },
  { label: "Risk Analyst", value: "risk_analyst" },
];

const ROLE_OPTIONS: Array<{ label: string; value: AgentPayload["role"] }> = [
  { label: "Moderator", value: "moderator" },
  { label: "Participant", value: "participant" },
  { label: "Notetaker", value: "notetaker" },
];

const DEFAULT_SESSION: SessionPayload = {
  title: "Demo Session",
  problem_statement: "Increase conversion without compromising customer trust.",
  time_limit_sec: 900,
  strategy: "double_diamond",
};

const DEFAULT_AGENT: AgentPayload = {
  name: "Ava",
  role: "moderator",
  trait: "",
  model_hint: "",
};

type RetroPanelProps = {
  title: string;
  subtitle?: string;
  accent?: "default" | "muted" | "warning";
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
};

function RetroPanel({ title, subtitle, accent = "default", actions, children, className }: RetroPanelProps) {
  const accentClass =
    accent === "muted" ? "pixel-panel--muted" : accent === "warning" ? "pixel-panel--warning" : undefined;

  return (
    <section className={cn("pixel-panel", accentClass, className)}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="pixel-panel__title">{title}</h2>
          {subtitle ? <p className="pixel-panel__subtitle">{subtitle}</p> : null}
        </div>
        {actions}
      </div>
      <div className="pixel-panel__body">{children}</div>
    </section>
  );
}

export default function Home() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [isChecking, setIsChecking] = useState(false);

  const [sessionForm, setSessionForm] = useState<SessionPayload>(DEFAULT_SESSION);
  const [session, setSession] = useState<SessionSummary | null>(null);
  const [creatingSession, setCreatingSession] = useState(false);

  const [agentForm, setAgentForm] = useState<AgentPayload>(DEFAULT_AGENT);
  const [agentProbe, setAgentProbe] = useState<string | null>(null);
  const [probing, setProbing] = useState(false);

  const [logs, setLogs] = useState<LogEntry[]>([]);

  const timeFormatter = useMemo(
    () => new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
    [],
  );

  const appendLog = useCallback((level: LogEntry["level"], message: string) => {
    const entry: LogEntry = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      level,
      message,
      timestamp: Date.now(),
    };
    setLogs((prev) => [entry, ...prev].slice(0, 25));
  }, []);

  const checkOllama = useCallback(async () => {
    setIsChecking(true);
    appendLog("info", "Checking Ollama health…");
    try {
      const response = await fetch(`${API}/health/ollama`, { cache: "no-store" });
      if (!response.ok) {
        const text = await response.text();
        appendLog("error", `Health check failed (${response.status}): ${text || "no response body"}`);
        return;
      }
      const data: HealthResponse = await response.json();
      setHealth(data);
      appendLog(data.ok ? "success" : "error", data.ok ? "Ollama is ready." : `Ollama reported an issue: ${data.error ?? "unknown error"}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      appendLog("error", `Health check failed: ${message}`);
    } finally {
      setIsChecking(false);
    }
  }, [appendLog]);

  const handleSessionSubmit = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setCreatingSession(true);
      appendLog("info", "Creating session…");
      try {
        const body = JSON.stringify(sessionForm);
        const response = await fetch(`${API}/sessions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        });
        if (!response.ok) {
          const text = await response.text();
          throw new Error(text || `Server returned ${response.status}`);
        }
        const data = (await response.json()) as { id: string; phase: string };
        const summary: SessionSummary = { id: data.id, phase: data.phase, info: sessionForm };
        setSession(summary);
        setAgentProbe(null);
        appendLog("success", `Session ${data.id} created in phase "${data.phase}".`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        appendLog("error", `Create session failed: ${message}`);
      } finally {
        setCreatingSession(false);
      }
    },
    [appendLog, sessionForm],
  );

  const handleAgentSubmit = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!session) {
        appendLog("error", "Create a session before adding agents.");
        return;
      }
      setProbing(true);
      appendLog("info", `Probing ${agentForm.role} agent…`);
      try {
        const payload = {
          ...agentForm,
          model_hint: agentForm.model_hint.trim() || null,
          trait: agentForm.role === "participant" ? agentForm.trait : "",
        };
        const response = await fetch(`${API}/sessions/${session.id}/agents`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!response.ok) {
          const text = await response.text();
          throw new Error(text || `Server returned ${response.status}`);
        }
        const data = (await response.json()) as { ok: boolean; probe: string };
        setAgentProbe(data.probe);
        appendLog("success", `${agentForm.role} agent responded.`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setAgentProbe(null);
        appendLog("error", `Agent probe failed: ${message}`);
      } finally {
        setProbing(false);
      }
    },
    [agentForm, appendLog, session],
  );

  const healthTagClass = cn("pixel-tag", health?.ok ? "pixel-tag--success" : health ? "pixel-tag--danger" : null);
  const healthValueClass = cn(
    "pixel-stat__value",
    health?.ok ? "is-online" : health ? "is-offline" : null,
  );
  const healthLabel = health ? (health.ok ? "ONLINE" : "ISSUE") : "UNKNOWN";
  const latestLog = logs[0] ?? null;
  const latestLogText = latestLog ? latestLog.message : "No events logged yet.";
  const latestLogTime = latestLog ? timeFormatter.format(latestLog.timestamp) : "—";

  return (
    <main className="mx-auto flex min-h-screen max-w-6xl flex-col gap-8 px-4 py-8 md:px-8">
      <section className="pixel-panel pixel-panel--hero">
        <div className="flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
          <div className="space-y-4">
            <p className="retro-subtle text-rose-100/80">CrewTalk // Mission Control</p>
            <h1 className="retro-title">CrewTalk Control Center</h1>
            <p className="retro-subtitle">
              Spin up discovery sessions, confirm Ollama connectivity, and dry-run agents before inviting the crew.
            </p>
            <div className="flex flex-wrap gap-3">
              <span className="pixel-tag">
                Session:
                <span className="ml-2">{session ? session.id : "None"}</span>
              </span>
              <span className="pixel-tag">
                Phase:
                <span className="ml-2">{session ? session.phase : "—"}</span>
              </span>
              <span className={healthTagClass}>
                Ollama:
                <span className="ml-2">{healthLabel}</span>
              </span>
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="pixel-stat">
              <span className="pixel-stat__label">Latest Log</span>
              <span className="pixel-stat__value">{latestLog ? latestLog.level.toUpperCase() : "NONE"}</span>
              <p className="mt-3 text-[0.6rem] leading-relaxed tracking-[0.16em]">{latestLogText}</p>
              <p className="mt-2 text-[0.55rem] tracking-[0.14em] opacity-80">Time: {latestLogTime}</p>
            </div>
            <div className="pixel-stat">
              <span className="pixel-stat__label">Ollama Status</span>
              <span className={healthValueClass}>{healthLabel}</span>
              <p className="mt-3 text-[0.6rem] leading-relaxed tracking-[0.16em]">
                {health?.ollama_url ?? "http://ollama:11434"}
              </p>
              <p className="mt-2 text-[0.55rem] tracking-[0.14em] opacity-80">
                {health?.status !== undefined ? `HTTP ${health.status}` : "No check yet"}
              </p>
            </div>
          </div>
        </div>
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <RetroPanel
          title="Ollama Health"
          subtitle="Verify the bundled model router is awake before agent hand-offs."
          actions={
            <button
              type="button"
              className={cn("pixel-button pixel-button--secondary min-w-[200px]", isChecking && "opacity-80")}
              onClick={checkOllama}
              disabled={isChecking}
            >
              <RefreshCcw className={cn("h-4 w-4", isChecking && "animate-spin")} />
              {isChecking ? "Checking…" : "Health Check"}
            </button>
          }
        >
          <div className="pixel-readout">
            <span>Target URL</span>
            <code>{health?.ollama_url ?? "http://ollama:11434"}</code>
            {health?.status !== undefined ? <span>Last HTTP Status: {health.status}</span> : <span>No health check recorded.</span>}
            {health?.error ? <span>Error: {health.error}</span> : null}
          </div>
          <p className="retro-subtle text-[0.55rem] uppercase tracking-[0.18em] text-slate-600">
            Tip: run this after every compose up so probes don't fail mid-demo.
          </p>
        </RetroPanel>

        <RetroPanel
          title="Session Blueprint"
          subtitle="Define the challenge and timebox before inviting the crew."
          accent="muted"
          actions={
            <span className={cn("pixel-tag", session ? "pixel-tag--success" : "pixel-tag--danger")}>
              {session ? `Active: ${session.id}` : "No session"}
            </span>
          }
        >
          <form onSubmit={handleSessionSubmit} className="grid gap-5">
            <div className="grid gap-2">
              <label className="pixel-label" htmlFor="session-title">
                Title
              </label>
              <input
                id="session-title"
                className="pixel-input"
                value={sessionForm.title}
                onChange={(event) => setSessionForm((prev) => ({ ...prev, title: event.target.value }))}
                required
                maxLength={120}
              />
            </div>
            <div className="grid gap-2">
              <label className="pixel-label" htmlFor="session-problem">
                Problem Statement
              </label>
              <textarea
                id="session-problem"
                className="pixel-textarea"
                value={sessionForm.problem_statement}
                onChange={(event) =>
                  setSessionForm((prev) => ({ ...prev, problem_statement: event.target.value }))
                }
                required
                maxLength={500}
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-2">
                <label className="pixel-label" htmlFor="session-duration">
                  Time Limit (seconds)
                </label>
                <input
                  id="session-duration"
                  className="pixel-input"
                  type="number"
                  min={300}
                  max={7200}
                  step={60}
                  value={sessionForm.time_limit_sec}
                  onChange={(event) =>
                    setSessionForm((prev) => ({
                      ...prev,
                      time_limit_sec: Number.parseInt(event.target.value, 10) || DEFAULT_SESSION.time_limit_sec,
                    }))
                  }
                  required
                />
              </div>
              <div className="grid gap-2">
                <label className="pixel-label" htmlFor="session-strategy">
                  Strategy
                </label>
                <select
                  id="session-strategy"
                  className="pixel-select"
                  value={sessionForm.strategy}
                  onChange={(event) => setSessionForm((prev) => ({ ...prev, strategy: event.target.value }))}
                >
                  {STRATEGY_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <button
              type="submit"
              className={cn("pixel-button pixel-button--block", creatingSession && "opacity-80")}
              disabled={creatingSession}
            >
              <Rocket className={cn("h-4 w-4", creatingSession && "animate-bounce")} />
              {creatingSession ? "Creating…" : "Create Session"}
            </button>
          </form>
        </RetroPanel>
      </div>

      <div className="grid gap-6 xl:grid-cols-[2fr_3fr]">
        <RetroPanel
          title="Agent Sanity Probe"
          subtitle="Call into CrewAI to ensure each role can hear the facilitator."
          actions={
            <span className={cn("pixel-tag", session ? "pixel-tag--success" : "pixel-tag--danger")}>
              {session ? "Ready" : "Needs session"}
            </span>
          }
        >
          <form onSubmit={handleAgentSubmit} className="grid gap-5">
            <div className="grid gap-4 md:grid-cols-2">
              <div className="grid gap-2">
                <label className="pixel-label" htmlFor="agent-role">
                  Role
                </label>
                <select
                  id="agent-role"
                  className="pixel-select"
                  value={agentForm.role}
                  onChange={(event) =>
                    setAgentForm((prev) => ({
                      ...prev,
                      role: event.target.value as AgentPayload["role"],
                      trait: event.target.value === "participant" ? prev.trait : "",
                      name: event.target.value === "moderator" && !prev.name ? "Moderator" : prev.name,
                    }))
                  }
                >
                  {ROLE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="grid gap-2">
                <label className="pixel-label" htmlFor="agent-name">
                  Display Name
                </label>
                <input
                  id="agent-name"
                  className="pixel-input"
                  value={agentForm.name}
                  onChange={(event) => setAgentForm((prev) => ({ ...prev, name: event.target.value }))}
                  placeholder={agentForm.role === "moderator" ? "Moderator" : "e.g. Riley"}
                  required
                  maxLength={60}
                />
              </div>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div className="grid gap-2">
                <label className="pixel-label" htmlFor="agent-trait">
                  Trait
                </label>
                <select
                  id="agent-trait"
                  className="pixel-select"
                  value={agentForm.trait}
                  onChange={(event) => setAgentForm((prev) => ({ ...prev, trait: event.target.value }))}
                  disabled={agentForm.role !== "participant"}
                >
                  {TRAIT_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="grid gap-2">
                <label className="pixel-label" htmlFor="agent-model">
                  Model Hint (optional)
                </label>
                <input
                  id="agent-model"
                  className="pixel-input"
                  value={agentForm.model_hint}
                  onChange={(event) => setAgentForm((prev) => ({ ...prev, model_hint: event.target.value }))}
                  placeholder="gemma3:4b-it-qat"
                />
              </div>
            </div>

            <div className="pixel-readout">
              {session ? (
                <>
                  <span>Session context</span>
                  <code>{session.info.title} · {session.phase} phase · {session.info.strategy}</code>
                  <span>{session.info.problem_statement}</span>
                </>
              ) : (
                <span>No session selected. Create one before probing agents.</span>
              )}
            </div>

            <button
              type="submit"
              className={cn(
                "pixel-button pixel-button--secondary pixel-button--block",
                (probing || !session) && "opacity-80",
              )}
              disabled={probing || !session}
            >
              <UserPlus className={cn("h-4 w-4", probing && "animate-spin")} />
              {probing ? "Contacting…" : "Create & Probe Agent"}
            </button>
          </form>
        </RetroPanel>

        <RetroPanel
          title="Agent Probe Output"
          subtitle="First 200 characters returned by CrewAI for quick validation."
          accent="muted"
          actions={
            <span className={cn("pixel-log__badge", agentProbe ? "success" : "info")}>
              {agentProbe ? "Responded" : "Awaiting"}
            </span>
          }
          className="flex flex-col"
        >
          <div className="pixel-probe">
            {agentProbe ?? "No agent call has been run yet."}
          </div>
        </RetroPanel>
      </div>

      <RetroPanel
        title="Run Log"
        subtitle="Latest actions and responses (capped at 25 entries)."
        accent="muted"
        actions={
          <button
            type="button"
            className={cn(
              "pixel-button pixel-button--ghost pixel-button--sm",
              logs.length === 0 && "opacity-50",
            )}
            onClick={() => setLogs([])}
            disabled={logs.length === 0}
          >
            Clear
          </button>
        }
      >
        {logs.length === 0 ? (
          <div className="pixel-empty">
            <ShieldAlert className="h-4 w-4" />
            <span>No actions logged yet. Run a health check or create a session.</span>
          </div>
        ) : (
          <div className="pixel-log">
            {logs.map((log) => (
              <div key={log.id} className="pixel-log__item">
                <div className="pixel-log__meta">
                  <span
                    className={cn(
                      "pixel-log__badge",
                      log.level === "success" && "success",
                      log.level === "error" && "error",
                      log.level === "info" && "info",
                    )}
                  >
                    {log.level.toUpperCase()}
                  </span>
                  <span>{timeFormatter.format(log.timestamp)}</span>
                </div>
                <p className="pixel-log__message">{log.message}</p>
              </div>
            ))}
          </div>
        )}
      </RetroPanel>
    </main>
  );
}
