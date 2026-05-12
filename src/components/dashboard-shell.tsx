"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Film, Plus, LogOut, Video, Clapperboard } from "lucide-react";
import { getSupabaseBrowserClient } from "@/lib/supabase-browser";

export type DashJob = {
  id: string;
  title: string;
  status: string;
  duration_seconds: number;
  cost_usd: number | null;
  created_at: string;
};

// ─── New Job button ──────────────────────────────────────────────────────────

function NewJobButton({ size = "md" }: { size?: "sm" | "md" }) {
  const pad = size === "sm" ? "7px 16px" : "9px 18px";
  const fs  = size === "sm" ? 11.5 : 12.5;

  return (
    <Link
      href="/jobs/new"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 7,
        padding: pad,
        borderRadius: 999,
        fontSize: fs,
        fontWeight: 700,
        textDecoration: "none",
        letterSpacing: "0.04em",
        textTransform: "uppercase",
        color: "#001f10",
        backgroundImage:
          "linear-gradient(110deg, #1a9e6a 0%, #3ecf8e 30%, #9effd6 52%, #3ecf8e 70%, #1a9e6a 100%)",
        backgroundSize: "280% 100%",
        animation: "shimmer 4s ease-in-out infinite",
        boxShadow:
          "0 0 0 1px #3ecf8e55, 0 4px 16px #3ecf8e30, 0 1px 0 rgba(255,255,255,0.12) inset",
        transition: "transform 0.15s, box-shadow 0.2s",
        fontFamily: "var(--font-ysabeau-infant)",
      }}
      onMouseEnter={e => {
        e.currentTarget.style.transform = "translateY(-2px) scale(1.02)";
        e.currentTarget.style.boxShadow =
          "0 0 0 1px #3ecf8e88, 0 6px 24px #3ecf8e50, 0 1px 0 rgba(255,255,255,0.18) inset";
      }}
      onMouseLeave={e => {
        e.currentTarget.style.transform = "translateY(0) scale(1)";
        e.currentTarget.style.boxShadow =
          "0 0 0 1px #3ecf8e55, 0 4px 16px #3ecf8e30, 0 1px 0 rgba(255,255,255,0.12) inset";
      }}
    >
      {/* Icon bubble */}
      <span style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 16,
        height: 16,
        borderRadius: "50%",
        background: "rgba(0,0,0,0.18)",
        flexShrink: 0,
      }}>
        <Plus size={10} strokeWidth={3} />
      </span>
      New Job
    </Link>
  );
}

// ─── Status config ───────────────────────────────────────────────────────────

const STATUS: Record<string, { label: string; color: string; pulse?: true }> = {
  draft:                    { label: "Draft",           color: "#6b7280" },
  scripting:                { label: "Scripting",       color: "#3b82f6", pulse: true },
  awaiting_script_approval: { label: "Script Review",   color: "#f59e0b" },
  prompting:                { label: "Prompting",       color: "#3b82f6", pulse: true },
  awaiting_prompt_approval: { label: "Prompt Review",   color: "#f59e0b" },
  imaging:                  { label: "Imaging",         color: "#8b5cf6", pulse: true },
  awaiting_image_approval:  { label: "Image Review",    color: "#f59e0b" },
  videoing:                 { label: "Generating",      color: "#f97316", pulse: true },
  stitching:                { label: "Stitching",       color: "#06b6d4", pulse: true },
  complete:                 { label: "Complete",        color: "#3ecf8e" },
  failed:                   { label: "Failed",          color: "#ef4444" },
  cancelled:                { label: "Cancelled",       color: "#6b7280" },
  failed_recoverable:       { label: "Needs Attention", color: "#f97316" },
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmtDuration(s: number) {
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r ? `${m}m ${r}s` : `${m}m`;
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short", day: "numeric", year: "numeric",
  });
}

// ─── Status pill ─────────────────────────────────────────────────────────────

function StatusPill({ status }: { status: string }) {
  const cfg = STATUS[status] ?? { label: status, color: "#6b7280" };
  return (
    <span style={{
      display: "inline-flex",
      alignItems: "center",
      gap: 6,
      padding: "3px 10px 3px 8px",
      borderRadius: 999,
      fontSize: 11.5,
      fontWeight: 500,
      letterSpacing: "0.01em",
      background: `${cfg.color}14`,
      color: cfg.color,
      border: `1px solid ${cfg.color}28`,
      whiteSpace: "nowrap",
    }}>
      <span style={{
        width: 6,
        height: 6,
        borderRadius: "50%",
        background: cfg.color,
        flexShrink: 0,
        animation: cfg.pulse ? "pulseDot 1.6s ease-in-out infinite" : undefined,
      }} />
      {cfg.label}
    </span>
  );
}

// ─── Nav item ────────────────────────────────────────────────────────────────

function NavItem({
  href, icon, label, active,
}: { href: string; icon: React.ReactNode; label: string; active?: boolean }) {
  return (
    <Link href={href} style={{
      display: "flex", alignItems: "center", gap: 8,
      padding: "6px 10px", borderRadius: 6, marginBottom: 1,
      background: active ? "#1e1e1e" : "transparent",
      color: active ? "#ededed" : "#525252",
      textDecoration: "none", fontSize: 13,
      fontWeight: active ? 500 : 400,
      transition: "background 0.1s, color 0.1s",
    }}>
      <span style={{ color: active ? "#3ecf8e" : "#404040", display: "flex" }}>
        {icon}
      </span>
      {label}
    </Link>
  );
}

// ─── Empty state ─────────────────────────────────────────────────────────────

function EmptyState() {
  return (
    <div style={{
      display: "flex", flexDirection: "column", alignItems: "center",
      justifyContent: "center", minHeight: 360,
      border: "1px dashed #2c2c2c", borderRadius: 12,
      textAlign: "center",
      animation: "fadeInUp 0.3s ease both",
    }}>
      <div style={{
        width: 56, height: 56, borderRadius: 14,
        background: "#111111",
        border: "1px solid #2c2c2c",
        display: "flex", alignItems: "center", justifyContent: "center",
        marginBottom: 18,
        boxShadow: "0 0 0 6px #3ecf8e08",
      }}>
        <Clapperboard size={24} color="#3ecf8e" strokeWidth={1.5} />
      </div>
      <h3 style={{
        color: "#d4d4d4", fontSize: 17, fontWeight: 600,
        margin: "0 0 6px", letterSpacing: "-0.01em",
        fontFamily: "var(--font-ysabeau-infant)",
      }}>
        No jobs yet
      </h3>
      <p style={{
        color: "#737373", fontSize: 13, maxWidth: 260,
        margin: "0 0 22px", lineHeight: 1.65,
      }}>
        Paste a script and pick a target duration to generate your first video.
      </p>
      <NewJobButton size="md" />
    </div>
  );
}

// ─── Table row ───────────────────────────────────────────────────────────────

function JobRow({ job, last }: { job: DashJob; last: boolean }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1fr 120px 80px 170px 80px 56px",
        padding: "10px 16px",
        borderBottom: last ? "none" : "1px solid #222222",
        alignItems: "center",
        transition: "background 0.1s",
        cursor: "default",
      }}
      onMouseEnter={e => (e.currentTarget.style.background = "#111111")}
      onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
    >
      <Link href={`/jobs/${job.id}`} style={{
        color: "#d4d4d4",
        fontSize: 13,
        fontWeight: 500,
        letterSpacing: "-0.01em",
        textDecoration: "none",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        paddingRight: 16,
      }}>
        {job.title}
      </Link>

      <span style={{ color: "#7a7a7a", fontSize: 12 }}>
        {fmtDate(job.created_at)}
      </span>

      <span style={{
        color: "#8a8a8a", fontSize: 12,
        fontFamily: "var(--font-dm-mono)",
        letterSpacing: "-0.01em",
      }}>
        {fmtDuration(job.duration_seconds)}
      </span>

      <StatusPill status={job.status} />

      <span style={{
        color: job.cost_usd ? "#b0b0b0" : "#555555",
        fontSize: 12,
        fontFamily: "var(--font-dm-mono)",
        letterSpacing: "-0.01em",
      }}>
        {job.cost_usd != null ? `$${Number(job.cost_usd).toFixed(2)}` : "—"}
      </span>

      <Link href={`/jobs/${job.id}`} style={{
        color: "#3ecf8e", fontSize: 12,
        textDecoration: "none", fontWeight: 500,
        opacity: 0.6,
        transition: "opacity 0.1s",
      }}
        onMouseEnter={e => (e.currentTarget.style.opacity = "1")}
        onMouseLeave={e => (e.currentTarget.style.opacity = "0.6")}
      >
        View →
      </Link>
    </div>
  );
}

// ─── Jobs table ──────────────────────────────────────────────────────────────

function JobsTable({ jobs }: { jobs: DashJob[] }) {
  const COL_HEADS = ["Title", "Created", "Duration", "Status", "Cost", ""];
  return (
    <div style={{
      border: "1px solid #2c2c2c",
      borderRadius: 10,
      overflow: "hidden",
      background: "#0a0a0a",
      animation: "fadeInUp 0.25s ease both",
    }}>
      {/* Head */}
      <div style={{
        display: "grid",
        gridTemplateColumns: "1fr 120px 80px 170px 80px 56px",
        padding: "9px 16px",
        background: "#111111",
        borderBottom: "1px solid #2c2c2c",
      }}>
        {COL_HEADS.map(h => (
          <span key={h} style={{
            color: "#5a5a5a", fontSize: 10.5,
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: "0.09em",
          }}>
            {h}
          </span>
        ))}
      </div>

      {jobs.map((job, i) => (
        <JobRow key={job.id} job={job} last={i === jobs.length - 1} />
      ))}
    </div>
  );
}

// ─── Root shell ──────────────────────────────────────────────────────────────

export default function DashboardShell({
  jobs,
  userEmail,
}: {
  jobs: DashJob[];
  userEmail: string;
}) {
  const router = useRouter();

  async function signOut() {
    const sb = getSupabaseBrowserClient();
    await sb.auth.signOut();
    router.push("/login");
  }

  const running = jobs.filter(j =>
    ["scripting","prompting","imaging","videoing","stitching"].includes(j.status)
  ).length;
  const complete = jobs.filter(j => j.status === "complete").length;
  const attention = jobs.filter(j => j.status === "failed_recoverable").length;

  return (
    <div style={{ display: "flex", minHeight: "100vh", background: "#0f0f0f" }}>

      {/* ── Sidebar ── */}
      <aside style={{
        width: 232,
        flexShrink: 0,
        background: "#0c0c0c",
        borderRight: "1px solid #2a2a2a",
        display: "flex",
        flexDirection: "column",
        position: "fixed",
        inset: "0 auto 0 0",
        zIndex: 20,
      }}>
        {/* Logo */}
        <div style={{ padding: "16px 14px 14px", borderBottom: "1px solid #2a2a2a" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
            {/* Icon mark */}
            <div style={{ position: "relative", flexShrink: 0 }}>
              <div style={{
                width: 34, height: 34, borderRadius: 10,
                background: "linear-gradient(140deg, #4ade98 0%, #3ecf8e 45%, #16a06a 100%)",
                display: "flex", alignItems: "center", justifyContent: "center",
                boxShadow: "0 0 0 1px #3ecf8e30, 0 4px 20px #3ecf8e35, inset 0 1px 0 rgba(255,255,255,0.25)",
              }}>
                <Clapperboard size={17} color="#003d24" strokeWidth={2} />
              </div>
              {/* Live dot */}
              <span style={{
                position: "absolute", top: -2, right: -2,
                width: 8, height: 8, borderRadius: "50%",
                background: "#3ecf8e",
                border: "2px solid #0c0c0c",
                boxShadow: "0 0 6px #3ecf8eaa",
                animation: "pulseDot 2.5s ease-in-out infinite",
              }} />
            </div>
            {/* Wordmark */}
            <div>
              <div style={{
                color: "#f0f0f0", fontSize: 14, fontWeight: 800,
                letterSpacing: "0.08em", lineHeight: 1,
                fontFamily: "var(--font-ysabeau-infant)",
                textTransform: "uppercase",
              }}>
                Vishnu
              </div>
              <div style={{
                color: "#6b6b6b", fontSize: 9.5,
                letterSpacing: "0.14em",
                textTransform: "uppercase",
                marginTop: 4,
                fontWeight: 600,
              }}>
                Pipeline
              </div>
            </div>
          </div>
        </div>

        {/* Nav */}
        <nav style={{ flex: 1, padding: "14px 8px" }}>
          <div style={{
            color: "#484848", fontSize: 10, fontWeight: 600,
            letterSpacing: "0.1em", textTransform: "uppercase",
            padding: "0 10px", marginBottom: 6,
          }}>
            Content
          </div>
          <NavItem href="/" icon={<Film size={14} strokeWidth={1.75} />} label="Jobs" active />
        </nav>

        {/* User footer */}
        <div style={{ padding: "10px 8px 14px", borderTop: "1px solid #2a2a2a" }}>
          <div style={{
            padding: "9px 10px", borderRadius: 8,
            background: "#181818",
            border: "1px solid #2a2a2a",
          }}>
            <div style={{
              color: "#9a9a9a", fontSize: 12,
              overflow: "hidden", textOverflow: "ellipsis",
              whiteSpace: "nowrap", marginBottom: 9,
              fontWeight: 400,
            }}>
              {userEmail}
            </div>
            <button onClick={signOut} style={{
              display: "flex", alignItems: "center", gap: 6,
              background: "none", border: "none", cursor: "pointer",
              color: "#555555", fontSize: 12, padding: 0,
              transition: "color 0.15s",
            }}
              onMouseEnter={e => (e.currentTarget.style.color = "#a3a3a3")}
              onMouseLeave={e => (e.currentTarget.style.color = "#555555")}
            >
              <LogOut size={12} />
              Sign out
            </button>
          </div>
        </div>
      </aside>

      {/* ── Main ── */}
      <div style={{ marginLeft: 232, flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>

        {/* Top bar */}
        <div style={{
          borderBottom: "1px solid #2a2a2a",
          padding: "0 28px",
          height: 54,
          display: "flex", alignItems: "center", justifyContent: "space-between",
          background: "#0f0f0f",
          position: "sticky", top: 0, zIndex: 10,
          backdropFilter: "blur(12px)",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <h1 style={{
              color: "#e8e8e8", fontSize: 16, fontWeight: 600,
              margin: 0, letterSpacing: "-0.01em",
              fontFamily: "var(--font-ysabeau-infant)",
            }}>
              Jobs
            </h1>
            <div style={{ display: "flex", gap: 6 }}>
              {running > 0 && (
                <span style={{
                  background: "#3b82f610", color: "#60a5fa",
                  border: "1px solid #3b82f622",
                  padding: "2px 8px", borderRadius: 99,
                  fontSize: 11, fontWeight: 500,
                }}>
                  {running} running
                </span>
              )}
              {complete > 0 && (
                <span style={{
                  background: "#3ecf8e10", color: "#3ecf8e",
                  border: "1px solid #3ecf8e22",
                  padding: "2px 8px", borderRadius: 99,
                  fontSize: 11, fontWeight: 500,
                }}>
                  {complete} done
                </span>
              )}
              {attention > 0 && (
                <span style={{
                  background: "#f9731610", color: "#f97316",
                  border: "1px solid #f9731622",
                  padding: "2px 8px", borderRadius: 99,
                  fontSize: 11, fontWeight: 500,
                }}>
                  {attention} need attention
                </span>
              )}
            </div>
          </div>

          <NewJobButton size="sm" />
        </div>

        {/* Content */}
        <div style={{ padding: "22px 28px", flex: 1 }}>
          {jobs.length === 0 ? <EmptyState /> : <JobsTable jobs={jobs} />}
        </div>
      </div>
    </div>
  );
}
