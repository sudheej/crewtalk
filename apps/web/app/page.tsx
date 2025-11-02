/* eslint-disable @typescript-eslint/no-floating-promises */
"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  FastForward,
  FileText,
  Loader2,
  Pause,
  Play,
  Radio,
  RefreshCcw,
  Rocket,
  Save,
  ShieldAlert,
  StopCircle,
  UserPlus,
} from "lucide-react";

import { cn } from "../lib/utils";

const API = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8080";

type HealthResponse = {
  ok: boolean;
  status?: number;
  error?: string;
  body?: unknown;
  ollama_url: string;
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

type AgentSummary = {
  id: string;
  name: string;
  role: string;
  trait?: string | null;
  model_hint?: string | null;
  is_active?: boolean;
};

type MessageTurn = {
  id: number;
  agent_id: string | null;
  phase: string;
  turn_index: number;
  text: string;
  sentiment: number | null;
  confidence: number | null;
  created_at: string;
};

type SessionDetail = {
  id: string;
  title: string;
  phase: string;
  status: string;
  deadline: string | null;
  strategy: string;
  time_limit_sec: number;
  agents: AgentSummary[];
  turns: MessageTurn[];
  notepad: string;
};

type StreamEvent = {
  event: string;
  payload: Record<string, unknown>;
  ts?: number;
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

function makeWsUrl(sessionId: string): string {
  try {
    const url = new URL(API);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = `/sessions/${sessionId}/stream`;
    url.search = "";
    return url.toString();
  } catch {
    return `${API.replace(/^http/, "ws")}/sessions/${sessionId}/stream`;
  }
}

function formatTimestamp(iso?: string | null): string {
  if (!iso) return "—";
  try {
    return new Intl.DateTimeFormat(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

export default function Home() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [isChecking, setIsChecking] = useState(false);

  const [sessionForm, setSessionForm] = useState<SessionPayload>(DEFAULT_SESSION);
  const [creatingSession, setCreatingSession] = useState(false);

  const [session, setSession] = useState<SessionDetail | null>(null);
  const [agentForm, setAgentForm] = useState<AgentPayload>(DEFAULT_AGENT);
  const [probing, setProbing] = useState(false);
  const [lastProbeSnippet, setLastProbeSnippet] = useState<string | null>(null);

  const [timeline, setTimeline] = useState<MessageTurn[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [notepad, setNotepad] = useState("");
  const [isSavingNotepad, setIsSavingNotepad] = useState(false);

  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [wsStatus, setWsStatus] = useState<"idle" | "connecting" | "open" | "closed">("idle");

  const wsRef = useRef<WebSocket | null>(null);

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

  const agentLookup = useMemo(() => {
    const map = new Map<string, AgentSummary>();
    if (session?.agents) {
      session.agents.forEach((agent) => {
        map.set(agent.id, agent);
      });
    }
    return map;
  }, [session?.agents]);

  const closeStream = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    setWsStatus("closed");
  }, []);

  const handleStreamEvent = useCallback(
    (event: StreamEvent) => {
      const payload = event.payload;
      switch (event.event) {
        case "token.delta": {
          const agentId = String(payload.agent_id ?? "unknown");
          const delta = String(payload.text_delta ?? "");
          setDrafts((prev) => {
            const next = { ...prev };
            next[agentId] = (next[agentId] ?? "") + delta;
            return next;
          });
          break;
        }
        case "message.created": {
          const agentId = payload.agent_id ? String(payload.agent_id) : null;
          const turn: MessageTurn = {
            id: Number(payload.id),
            agent_id: agentId,
            phase: String(payload.phase ?? session?.phase ?? "discover"),
            turn_index: Number(payload.turn_index ?? 0),
            text: String(payload.text ?? ""),
            sentiment: payload.sentiment === null ? null : Number(payload.sentiment ?? 0),
            confidence: payload.confidence === null ? null : Number(payload.confidence ?? 0),
            created_at: typeof payload.created_at === "string" ? payload.created_at : new Date().toISOString(),
          };
          setDrafts((prev) => {
            if (!agentId) return prev;
            const next = { ...prev };
            delete next[agentId];
            return next;
          });
          setTimeline((prev) => [...prev, turn].slice(-100));
          setSession((prev) =>
            prev
              ? {
                  ...prev,
                  turns: [...prev.turns, turn].slice(-50),
                }
              : prev,
          );
          break;
        }
        case "phase.changed": {
          const nextPhase = String(payload.to ?? payload.phase ?? session?.phase ?? "discover");
          appendLog("info", `Phase advanced to ${nextPhase.toUpperCase()}.`);
          setDrafts({});
          setSession((prev) =>
            prev
              ? {
                  ...prev,
                  phase: nextPhase,
                  deadline: typeof payload.deadline === "string" ? payload.deadline : prev.deadline,
                }
              : prev,
          );
          break;
        }
        case "session.status": {
          setSession((prev) =>
            prev
              ? {
                  ...prev,
                  status: String(payload.status ?? prev.status),
                  phase: String(payload.phase ?? prev.phase),
                  deadline: payload.deadline === null ? null : (payload.deadline as string | null) ?? prev.deadline,
                }
              : prev,
          );
          break;
        }
        case "notepad.updated": {
          const content = typeof payload.content === "string" ? payload.content : "";
          setNotepad(content);
          if (payload.updated_by) {
            appendLog("info", `Notepad updated by ${payload.updated_by}`);
          }
          break;
        }
        case "error": {
          const scope = String(payload.scope ?? "session");
          const message = String(payload.message ?? "unknown error");
          appendLog("error", `Engine error (${scope}): ${message}`);
          break;
        }
        default:
          break;
      }
    },
    [appendLog, session?.phase],
  );

  const openStream = useCallback(
    (sessionId: string) => {
      closeStream();
      const ws = new WebSocket(makeWsUrl(sessionId));
      wsRef.current = ws;
      setWsStatus("connecting");
      ws.onopen = () => {
        setWsStatus("open");
        appendLog("success", "Streaming channel established.");
      };
      ws.onmessage = (messageEvent) => {
        try {
          const data = JSON.parse(messageEvent.data as string) as StreamEvent;
          handleStreamEvent(data);
        } catch (error) {
          appendLog("error", `Failed to parse stream event: ${String(error)}`);
        }
      };
      ws.onerror = () => {
        appendLog("error", "WebSocket error encountered.");
      };
      ws.onclose = () => {
        setWsStatus("closed");
        appendLog("info", "Streaming channel closed.");
      };
    },
    [appendLog, closeStream, handleStreamEvent],
  );

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
      appendLog(
        data.ok ? "success" : "error",
        data.ok ? "Ollama is ready." : `Ollama reported an issue: ${data.error ?? "unknown error"}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      appendLog("error", `Health check failed: ${message}`);
    } finally {
      setIsChecking(false);
    }
  }, [appendLog]);

  const loadSession = useCallback(
    async (sessionId: string) => {
      const response = await fetch(`${API}/sessions/${sessionId}`, { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`Failed to load session (${response.status})`);
      }
      const data = (await response.json()) as SessionDetail;
      setSession(data);
      setTimeline(data.turns || []);
      setNotepad(data.notepad ?? "");
    },
    [],
  );

  const handleSessionSubmit = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setCreatingSession(true);
      appendLog("info", "Creating session…");
      try {
        const response = await fetch(`${API}/sessions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(sessionForm),
        });
        if (!response.ok) {
          const text = await response.text();
          throw new Error(text || `Server returned ${response.status}`);
        }
        const data = (await response.json()) as { id: string; phase: string; status: string };
        await loadSession(data.id);
        setLastProbeSnippet(null);
        appendLog("success", `Session ${data.id} created in phase “${data.phase}”.`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        appendLog("error", `Create session failed: ${message}`);
      } finally {
        setCreatingSession(false);
      }
    },
    [appendLog, loadSession, sessionForm],
  );

  const activeAgents = useMemo(
    () => (session ? session.agents.filter((agent) => agent.is_active !== false) : []),
    [session],
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
        const data = (await response.json()) as { ok: boolean; probe?: string | null };
        setLastProbeSnippet(data.probe ?? null);
        appendLog("success", `${agentForm.role} agent responded.`);
        await loadSession(session.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setLastProbeSnippet(null);
        appendLog("error", `Agent probe failed: ${message}`);
      } finally {
        setProbing(false);
      }
    },
    [agentForm, appendLog, loadSession, session],
  );

  const performSessionAction = useCallback(
    async (path: string, pendingLabel: string, successLabel: string, onSuccess?: () => void) => {
      if (!session) {
        appendLog("error", "No active session selected.");
        return;
      }
      appendLog("info", pendingLabel);
      try {
        const response = await fetch(`${API}/sessions/${session.id}/${path}`, { method: "POST" });
        if (!response.ok) {
          const text = await response.text();
          throw new Error(text || `Server returned ${response.status}`);
        }
        const data = (await response.json()) as { phase?: string; status?: string };
        await loadSession(session.id);
        appendLog("success", successLabel);
        if (onSuccess) onSuccess();
        if (data.status) {
          setSession((prev) =>
            prev
              ? {
                  ...prev,
                  status: data.status ?? prev.status,
                  phase: data.phase ?? prev.phase,
                }
              : prev,
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        appendLog("error", `${pendingLabel} failed: ${message}`);
      }
    },
    [appendLog, loadSession, session],
  );

  const handleStart = useCallback(async () => {
    if (!session) return;
    await performSessionAction(
      "start",
      "Starting session…",
      "Session started.",
      () => openStream(session.id),
    );
  }, [openStream, performSessionAction, session]);

  const handlePause = useCallback(async () => {
    await performSessionAction("pause", "Pausing session…", "Session paused.", () => setWsStatus("open"));
  }, [performSessionAction]);

  const handleResume = useCallback(async () => {
    await performSessionAction("resume", "Resuming session…", "Session resumed.");
  }, [performSessionAction]);

  const handleAdvance = useCallback(async () => {
    await performSessionAction("advance", "Advancing phase…", "Phase advance requested.");
  }, [performSessionAction]);

  const handleStop = useCallback(async () => {
    await performSessionAction(
      "stop",
      "Stopping session…",
      "Session stopped.",
      () => {
        closeStream();
        setWsStatus("closed");
      },
    );
  }, [closeStream, performSessionAction]);

  const handleSaveNotepad = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!session) {
        appendLog("error", "No session selected.");
        return;
      }
      setIsSavingNotepad(true);
      appendLog("info", "Saving notepad…");
      try {
        const response = await fetch(`${API}/sessions/${session.id}/notepad`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ content: notepad }),
        });
        if (!response.ok) {
          const text = await response.text();
          throw new Error(text || `Server returned ${response.status}`);
        }
        appendLog("success", "Notepad saved.");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        appendLog("error", `Notepad save failed: ${message}`);
      } finally {
        setIsSavingNotepad(false);
      }
    },
    [appendLog, notepad, session],
  );

  useEffect(() => {
    return () => {
      closeStream();
    };
  }, [closeStream]);

  const healthTagClass = cn("pixel-tag", health?.ok ? "pixel-tag--success" : health ? "pixel-tag--danger" : null);
  const healthValueClass = cn("pixel-stat__value", health?.ok ? "is-online" : health ? "is-offline" : null);
  const healthLabel = health ? (health.ok ? "ONLINE" : "ISSUE") : "UNKNOWN";
  const latestLog = logs[0] ?? null;
  const latestLogText = latestLog ? latestLog.message : "No events logged yet.";
  const latestLogTime = latestLog ? timeFormatter.format(latestLog.timestamp) : "—";

  const moderatorExists = activeAgents.some((agent) => agent.role === "moderator");
  const participantCount = activeAgents.filter((agent) => agent.role === "participant").length;

  const isRunning = session?.status === "running";
  const isPaused = session?.status === "paused";

  return (
    <main className="mx-auto flex min-h-screen max-w-6xl flex-col gap-8 px-4 py-8 md:px-8">
      <section className="pixel-panel pixel-panel--hero">
        <div className="flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
          <div className="space-y-4">
            <p className="retro-subtle text-rose-100/80">CrewTalk // Mission Control</p>
            <h1 className="retro-title">CrewTalk Control Center</h1>
            <p className="retro-subtitle">
              Spin up discovery sessions, confirm Ollama connectivity, and orchestrate Double Diamond runs with live
              token streaming.
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
              <span className="pixel-tag">
                Status:
                <span className="ml-2">{session ? session.status.toUpperCase() : "—"}</span>
              </span>
              <span className={healthTagClass}>
                Ollama:
                <span className="ml-2">{healthLabel}</span>
              </span>
              <span className="pixel-tag">
                Stream:
                <span className="ml-2">{wsStatus.toUpperCase()}</span>
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
              <span className="pixel-stat__label">Deadline</span>
              <span className="pixel-stat__value">
                {session?.deadline ? formatTimestamp(session.deadline) : "—"}
              </span>
              <p className="mt-3 text-[0.6rem] leading-relaxed tracking-[0.16em]">
                Time remaining driver for the active phase. Auto-advances when the clock expires.
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
          <p className="retro-subtle text-[0.55rem] uppercase tracking-[0.18em] text-slate-200/90">
            Tip: run this after every compose up so probes don&apos;t fail mid-demo.
          </p>
        </RetroPanel>

        <RetroPanel
          title="Session Blueprint"
          subtitle="Define title, problem, strategy, and timebox for the crew."
          actions={
            <span className={cn("pixel-tag", session ? "pixel-tag--success" : "pixel-tag--danger")}>
              {session ? "Ready" : "Needs session"}
            </span>
          }
        >
          <form onSubmit={handleSessionSubmit} className="grid gap-4">
            <div className="grid gap-4 md:grid-cols-2">
              <div className="grid gap-2">
                <label className="pixel-label" htmlFor="session-title">
                  Title
                </label>
                <input
                  id="session-title"
                  className="pixel-input"
                  value={sessionForm.title}
                  onChange={(event) => setSessionForm((prev) => ({ ...prev, title: event.target.value }))}
                  maxLength={120}
                  required
                />
              </div>
              <div className="grid gap-2">
                <label className="pixel-label" htmlFor="session-time">
                  Time Limit (sec)
                </label>
                <input
                  id="session-time"
                  className="pixel-input"
                  type="number"
                  min={300}
                  max={5400}
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
            </div>
            <div className="grid gap-2">
              <label className="pixel-label" htmlFor="session-problem">
                Problem Statement
              </label>
              <textarea
                id="session-problem"
                className="pixel-textarea"
                rows={3}
                value={sessionForm.problem_statement}
                onChange={(event) => setSessionForm((prev) => ({ ...prev, problem_statement: event.target.value }))}
                maxLength={600}
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
                  <code>
                    {session.title} · {session.phase} phase · {session.strategy}
                  </code>
                  <span>{sessionForm.problem_statement}</span>
                </>
              ) : (
                <span>No session selected. Create one before probing agents.</span>
              )}
            </div>

            <button
              type="submit"
              className={cn("pixel-button pixel-button--secondary pixel-button--block", (probing || !session) && "opacity-80")}
              disabled={probing || !session}
            >
              <UserPlus className={cn("h-4 w-4", probing && "animate-spin")} />
              {probing ? "Contacting…" : "Create & Probe Agent"}
            </button>
          </form>

          <div className="mt-6">
            <h3 className="pixel-label flex items-center gap-2">
              <Radio className="h-3.5 w-3.5" />
              Registered Agents
            </h3>
            {session ? (
              <ul className="pixel-list mt-2">
                {session.agents.length === 0 ? (
                  <li className="pixel-list__item">No agents yet. Add moderator, participants, and a note-taker.</li>
                ) : (
                  session.agents.map((agent) => (
                    <li key={agent.id} className="pixel-list__item flex items-center justify-between gap-4">
                      <span>
                        <strong>{agent.name}</strong> — {agent.role}
                        {agent.trait ? ` · ${agent.trait}` : ""}
                      </span>
                      {agent.model_hint ? <code className="text-xs">{agent.model_hint}</code> : null}
                    </li>
                  ))
                )}
              </ul>
            ) : (
              <p className="pixel-list__item">Create a session to list agents.</p>
            )}
          </div>

          <div className="pixel-probe mt-4">
            {lastProbeSnippet ?? "No agent call has been run yet."}
          </div>
        </RetroPanel>

        <RetroPanel
          title="Session Controls"
          subtitle="Start, pause, resume, advance, and stop the Double Diamond run."
          accent="muted"
          actions={
            <span className="pixel-tag pixel-tag--muted">
              Turn Index:
              <span className="ml-2">
                {session && session.turns.length > 0 ? session.turns[session.turns.length - 1].turn_index : "0"}
              </span>
            </span>
          }
        >
          <div className="grid gap-3 md:grid-cols-2">
            <button
              type="button"
              className={cn(
                "pixel-button pixel-button--secondary",
                (!session || !moderatorExists || participantCount === 0) && "opacity-50",
              )}
              onClick={handleStart}
              disabled={!session || !moderatorExists || participantCount === 0 || isRunning}
            >
              <Play className="h-4 w-4" />
              Start Session
            </button>
            <button
              type="button"
              className={cn("pixel-button", !session || !isRunning ? "opacity-50" : "pixel-button--warning")}
              onClick={handlePause}
              disabled={!session || !isRunning}
            >
              <Pause className="h-4 w-4" />
              Pause
            </button>
            <button
              type="button"
              className={cn("pixel-button pixel-button--secondary", !session || !isPaused ? "opacity-50" : undefined)}
              onClick={handleResume}
              disabled={!session || !isPaused}
            >
              <Play className="h-4 w-4" />
              Resume
            </button>
            <button
              type="button"
              className={cn("pixel-button pixel-button--ghost", !session ? "opacity-50" : undefined)}
              onClick={handleAdvance}
              disabled={!session}
            >
              <FastForward className="h-4 w-4" />
              Advance Phase
            </button>
            <button
              type="button"
              className={cn("pixel-button pixel-button--danger md:col-span-2", !session ? "opacity-50" : undefined)}
              onClick={handleStop}
              disabled={!session}
            >
              <StopCircle className="h-4 w-4" />
              Stop Session
            </button>
          </div>
          <div className="pixel-readout">
            <span>Prereqs</span>
            <code>
              {moderatorExists ? "✓" : "✕"} Moderator · {participantCount > 0 ? "✓" : "✕"} Participant(s) ·{" "}
              {session?.status.toUpperCase() ?? "IDLE"}
            </code>
            <span>Streaming: {wsStatus.toUpperCase()}</span>
          </div>
        </RetroPanel>
      </div>

      <div className="grid gap-6 lg:grid-cols-[2fr_3fr]">
        <RetroPanel
          title="Crew Notepad"
          subtitle="Shared scratchpad broadcast to all listeners."
          accent="muted"
          actions={
            <span className="pixel-tag">
              <FileText className="mr-2 h-3.5 w-3.5" />
              Auto-sync via WebSocket events
            </span>
          }
        >
          <form className="grid gap-4" onSubmit={handleSaveNotepad}>
            <textarea
              className="pixel-textarea"
              rows={6}
              value={notepad}
              onChange={(event) => setNotepad(event.target.value)}
              placeholder="Use this space to capture decisions, risks, TODOs…"
              disabled={!session}
            />
            <button
              type="submit"
              className={cn(
                "pixel-button pixel-button--secondary pixel-button--block",
                (!session || isSavingNotepad) && "opacity-80",
              )}
              disabled={!session || isSavingNotepad}
            >
              {isSavingNotepad ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              {isSavingNotepad ? "Saving…" : "Save Notepad"}
            </button>
          </form>
        </RetroPanel>

        <RetroPanel
          title="Live Transcript"
          subtitle="Token stream + committed turns (latest 50)."
          accent="muted"
          actions={
            <span className="pixel-tag pixel-tag--muted">
              <Radio className="mr-2 h-3 w-3" />
              Streaming {Object.keys(drafts).length ? `(${Object.keys(drafts).length})` : ""}
            </span>
          }
        >
          <div className="pixel-log">
            {Object.entries(drafts).map(([agentId, text]) => {
              const agent = agentLookup.get(agentId);
              return (
                <div key={`draft-${agentId}`} className="pixel-log__item pixel-log__item--draft">
                  <div className="pixel-log__meta">
                    <span className="pixel-log__badge info">
                      {agent ? agent.name : agentId} · drafting
                    </span>
                    <span>…</span>
                  </div>
                  <p className="pixel-log__message">{text}</p>
                </div>
              );
            })}
            {timeline.length === 0 ? (
              <div className="pixel-empty">
                <ShieldAlert className="h-4 w-4" />
                <span>No turns yet. Start the session to see live output.</span>
              </div>
            ) : (
              timeline.map((turn) => {
                const agent = turn.agent_id ? agentLookup.get(turn.agent_id) : null;
                const sentiment = turn.sentiment ?? 0;
                const confidence = turn.confidence ?? 0;
                return (
                  <div key={`turn-${turn.id}`} className="pixel-log__item">
                    <div className="pixel-log__meta">
                      <span className="pixel-log__badge success">
                        {(agent ? agent.name : "Unknown")} · {turn.phase} · #{turn.turn_index}
                      </span>
                      <span>{formatTimestamp(turn.created_at)}</span>
                    </div>
                    <p className="pixel-log__message whitespace-pre-wrap">{turn.text}</p>
                    <p className="mt-2 text-[0.6rem] uppercase tracking-[0.18em] text-slate-200/70">
                      Sentiment: {sentiment.toFixed(2)} · Confidence: {confidence.toFixed(2)}
                    </p>
                  </div>
                );
              })
            )}
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
            className={cn("pixel-button pixel-button--ghost pixel-button--sm", logs.length === 0 && "opacity-50")}
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
