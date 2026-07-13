"use client";

/**
 * NexusRep — full app, ported from the NexusRep.dc.html prototype into React.
 * Holds brand-console + HCP-experience state and renders the active screen.
 * Inline styles mirror the prototype; the DocNexus design tokens come from
 * /colors_and_type.css. Live behaviour (compliance/A-V) is wired where relevant.
 */

import { useEffect, useState } from "react";
import {
  COMMAND_KPIS,
  DEMO_USER,
  TONE_COLORS,
} from "./data";
import { BrandScreens } from "./BrandScreens";
import { StudioScreen } from "./StudioScreen";
import { HcpExperience } from "./HcpExperience";
import { useBrand } from "../_components/useBrand";

export type Screen =
  | "overview"
  | "studio"
  | "targeting"
  | "outreach"
  | "sessions"
  | "analytics"
  | "audit"
  | "crm"
  | "admin";

// The AI Rep badge is COMPUTED from live studio readiness (see useStudioMeta) — never static.
const NAV_PLAN: { id: Screen; label: string; badge?: string }[] = [
  { id: "studio", label: "AI Rep" },
  { id: "overview", label: "Overview" },
];

/** Live studio meta for the shell chrome: readiness % (nav badge) + rep state (header chip).
 *  Refetches on navigation so the chrome tracks what the user just changed in the Studio. */
function useStudioMeta(nav: Screen): { pct: number | null; repState: string | null } {
  const [meta, setMeta] = useState<{ pct: number | null; repState: string | null }>({ pct: null, repState: null });
  useEffect(() => {
    let alive = true;
    fetch("/api/studio")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { readiness?: { pct?: number }; rep?: { state?: string } } | null) => {
        if (alive && d) setMeta({ pct: d.readiness?.pct ?? null, repState: d.rep?.state ?? null });
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [nav]);
  return meta;
}
const NAV_GOVERN: { id: Screen; label: string }[] = [
  { id: "targeting", label: "Audience" },
  { id: "outreach", label: "Launch" },
  { id: "sessions", label: "Sessions" },
  { id: "analytics", label: "Analytics" },
  { id: "crm", label: "Follow-ups" },
];

export interface AppState {
  nav: Screen;
  setNav: (s: Screen) => void;
  mode: "brand" | "hcp";
  setMode: (m: "brand" | "hcp") => void;
  activation: string[];
  toggleActivation: (id: string) => void;
  drawerId: string | null;
  setDrawerId: (id: string | null) => void;
  /** Cohort HCP the in-app doctor-view preview should run AS (Audience → "Preview AI rep").
   *  Empty → the demo identity. The shared /hcp link uses ?hcp= instead. */
  sessionHcpId: string;
  setSessionHcpId: (id: string) => void;
  studioMode: string;
  setStudioMode: (m: string) => void;
  /** Session id whose evidence the Session-detail view should load. */
  selectedSessionId: string | null;
  setSelectedSessionId: (id: string | null) => void;
  /** Signed-in user's display name (null when auth is off — falls back to the demo operator). */
  userName: string | null;
}

/** Shared-password gate for the brand console — a dark, standalone sign-in in the DocNexus
 *  house style. Doctors never see this; they open the rep from their invite link. The password
 *  is entered by the user; on success the server sets an httpOnly session cookie and we reveal
 *  the console. */
function LoginScreen({ onSuccess }: { onSuccess: (name: string | null) => void }) {
  const [user, setUser] = useState("");
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [focus, setFocus] = useState<"user" | "pw" | "">("");
  const submit = async () => {
    if (!user || !pw || busy) return;
    setBusy(true);
    setErr("");
    try {
      const res = await fetch("/api/auth", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "login", username: user, password: pw }) });
      if (res.ok) { const d = (await res.json().catch(() => ({}))) as { name?: string }; onSuccess(typeof d.name === "string" ? d.name : null); return; }
      setErr("Incorrect username or password.");
    } catch {
      setErr("Couldn't reach the server — try again.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#000", fontFamily: "var(--dn-font-sans)", padding: 20, position: "relative", overflow: "hidden" }}>
      {/* ambient blue glow */}
      <div style={{ position: "absolute", top: "-22%", left: "50%", transform: "translateX(-50%)", width: 640, height: 640, background: "radial-gradient(circle, rgba(37,99,235,.18), transparent 62%)", pointerEvents: "none" }} />
      <div style={{ position: "relative", width: 388, maxWidth: "100%" }}>
        <div style={{ position: "relative", overflow: "hidden", borderRadius: 18, border: "1px solid rgba(255,255,255,.10)", background: "rgba(255,255,255,.028)", boxShadow: "0 30px 80px -20px rgba(0,0,0,.85)", padding: "34px 32px", backdropFilter: "blur(18px)" }}>
          {/* top accent line */}
          <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 1.5, background: "linear-gradient(90deg, transparent, rgba(96,165,250,.85), transparent)" }} />
          {/* logo lockup */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 9, marginBottom: 22 }}>
            <img src="/assets/docnexus-logo.png" alt="DocNexus" style={{ height: 22, filter: "brightness(0) invert(1)" }} />
            <span style={{ font: "700 12px/1 var(--dn-font-sans)", padding: "5px 8px", background: "rgba(96,165,250,.20)", color: "#dbeafe", borderRadius: 7, border: "1px solid rgba(96,165,250,.35)" }}>NexusRep</span>
          </div>
          {/* tagline */}
          <div style={{ textAlign: "center", marginBottom: 26 }}>
            <h1 style={{ font: "600 19px/1.25 var(--dn-font-sans)", letterSpacing: "-0.015em", color: "#fff", margin: 0 }}>Train and launch a compliant AI rep.</h1>
            <p style={{ font: "400 13.5px/1.5 var(--dn-font-sans)", color: "rgba(255,255,255,.65)", margin: "7px 0 0" }}>The AI Rep Studio for Life Sciences.</p>
            <p style={{ font: "600 11px/1 var(--dn-font-sans)", letterSpacing: ".14em", textTransform: "uppercase", color: "rgba(255,255,255,.36)", margin: "16px 0 0" }}>Sign in to continue</p>
          </div>
          {/* fields */}
          {(["user", "pw"] as const).map((f) => {
            const isPw = f === "pw";
            const active = focus === f;
            return (
              <div key={f} style={{ marginBottom: isPw ? 0 : 14 }}>
                <label htmlFor={`nx-${f}`} style={{ display: "block", font: "600 10.5px/1 var(--dn-font-sans)", letterSpacing: ".12em", textTransform: "uppercase", color: "rgba(255,255,255,.55)", marginBottom: 8 }}>{isPw ? "Password" : "Username"}</label>
                <input
                  id={`nx-${f}`}
                  type={isPw ? "password" : "text"}
                  value={isPw ? pw : user}
                  autoFocus={!isPw}
                  autoComplete={isPw ? "current-password" : "username"}
                  onFocus={() => setFocus(f)}
                  onBlur={() => setFocus("")}
                  onChange={(e) => { if (isPw) setPw(e.target.value); else setUser(e.target.value); setErr(""); }}
                  onKeyDown={(e) => { if (e.key === "Enter") void submit(); }}
                  placeholder={isPw ? "Enter password" : "Enter username"}
                  style={{
                    width: "100%", boxSizing: "border-box", padding: "11px 14px", borderRadius: 10,
                    border: `1px solid ${err ? "rgba(248,113,113,.7)" : active ? "rgba(96,165,250,.6)" : "rgba(255,255,255,.15)"}`,
                    background: active ? "rgba(255,255,255,.06)" : "rgba(255,255,255,.04)",
                    color: "#fff", font: "400 14px/1 var(--dn-font-sans)", outline: "none",
                    boxShadow: active ? "0 0 0 3px rgba(59,130,246,.22)" : "none", transition: "border-color .15s ease, box-shadow .15s ease, background .15s ease",
                  }}
                />
              </div>
            );
          })}
          {err && <p role="alert" style={{ font: "500 12.5px/1.4 var(--dn-font-sans)", color: "#f87171", textAlign: "center", margin: "12px 0 0" }}>{err}</p>}
          <button
            onClick={() => void submit()}
            disabled={busy || !user || !pw}
            style={{
              width: "100%", marginTop: 18, padding: "11px 0", borderRadius: 10, border: "none",
              background: "linear-gradient(90deg, #3b82f6, #4f46e5)", color: "#fff",
              font: "600 14px/1 var(--dn-font-sans)", letterSpacing: ".01em",
              cursor: busy || !user || !pw ? "default" : "pointer", opacity: busy || !user || !pw ? 0.45 : 1,
              boxShadow: "0 10px 26px -8px rgba(59,130,246,.5)", transition: "opacity .15s ease",
            }}
          >
            {busy ? "Signing in…" : "Sign In"}
          </button>
          <p style={{ font: "400 12px/1.5 var(--dn-font-sans)", color: "rgba(255,255,255,.42)", textAlign: "center", margin: "18px 0 0" }}>
            Doctors don&apos;t sign in — they open the rep from their invite link.
          </p>
        </div>
      </div>
    </div>
  );
}

export function NexusRepApp() {
  const [mode, setMode] = useState<"brand" | "hcp">("brand");
  const [nav, setNavState] = useState<Screen>("overview");
  const [studioMode, setStudioMode] = useState("setup");
  const [drawerId, setDrawerId] = useState<string | null>(null);
  const [activation, setActivation] = useState<string[]>([]);
  const [sessionHcpId, setSessionHcpId] = useState(""); // no fake default identity
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const studioMeta = useStudioMeta(nav);
  const [attnOpen, setAttnOpen] = useState(false);
  const [navCollapsed, setNavCollapsed] = useState(false);
  const brand = useBrand();
  const attention = useAttention(); // real pending items, not a hardcoded "3"
  // Simple console auth: ask /api/auth whether a password gate is on and whether this browser
  // already holds a valid session. null = still checking. Fails OPEN if the check errors so a
  // transient blip never locks a legitimately-open (ungated) deployment out of its own console.
  const [auth, setAuth] = useState<{ enabled: boolean; authed: boolean; name?: string | null } | null>(null);
  useEffect(() => {
    let alive = true;
    fetch("/api/auth")
      .then((r) => r.json())
      .then((d) => { if (alive) setAuth({ enabled: !!d.enabled, authed: !!d.authed, name: d.name ?? null }); })
      .catch(() => { if (alive) setAuth({ enabled: false, authed: true, name: null }); });
    return () => { alive = false; };
  }, []);
  const logout = async () => {
    try { await fetch("/api/auth", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "logout" }) }); } catch { /* clearing anyway */ }
    setAuth({ enabled: true, authed: false });
  };

  const setNav = (s: Screen) => {
    setNavState(s);
    setMode("brand");
    setDrawerId(null);
  };
  const toggleActivation = (id: string) =>
    setActivation((a) => (a.includes(id) ? a.filter((x) => x !== id) : [...a, id]));

  const account = auth?.name
    ? { initials: auth.name.trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase() || "U", name: auth.name, role: "Brand user" }
    : { initials: DEMO_USER.initials, name: DEMO_USER.shortName, role: DEMO_USER.role };

  const app: AppState = {
    nav, setNav, mode, setMode, activation, toggleActivation,
    drawerId, setDrawerId, sessionHcpId, setSessionHcpId, studioMode, setStudioMode,
    selectedSessionId, setSelectedSessionId,
    userName: auth?.name ?? null,
  };

  if (mode === "hcp") {
    return <HcpExperience app={app} />;
  }

  // Console auth gate (doctor view above is never gated). While the check is in flight, show a
  // brief splash so the console never flashes before a required login.
  if (auth === null) {
    return <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "var(--dn-bg)", color: "var(--dn-fg-subtle)", font: "500 13px/1 var(--dn-font-sans)" }}>Loading…</div>;
  }
  if (auth.enabled && !auth.authed) {
    return <LoginScreen onSuccess={(name) => setAuth({ enabled: true, authed: true, name })} />;
  }

  return (
    <div style={{ height: "100vh", overflow: "hidden", display: "flex", background: "var(--dn-bg)", color: "var(--dn-fg)", fontFamily: "var(--dn-font-sans)" }}>
      {/* LEFT NAV RAIL */}
      <aside style={{ width: navCollapsed ? 64 : 236, flexShrink: 0, background: "var(--dn-brand-dark)", color: "#fff", display: "flex", flexDirection: "column", borderRight: "1px solid rgba(255,255,255,.07)", transition: "width .18s ease" }}>
        <div style={{ padding: navCollapsed ? "14px 10px" : "16px 12px 14px 14px", borderBottom: "1px solid rgba(255,255,255,.08)", display: "flex", alignItems: "center", justifyContent: navCollapsed ? "center" : "space-between", gap: 8 }}>
          {navCollapsed ? (
            <button
              onClick={() => setNavCollapsed(false)}
              title="Expand menu"
              aria-label="Expand menu"
              style={{ width: 38, height: 34, borderRadius: 9, border: "1px solid rgba(255,255,255,.18)", background: "rgba(96,165,250,.16)", color: "#bfdbfe", font: "800 13px/1 var(--dn-font-sans)", cursor: "pointer" }}
            >
              NR
            </button>
          ) : (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                <img src="/assets/docnexus-logo.png" alt="DocNexus" style={{ height: 17, flexShrink: 0 }} />
                <span style={{ flexShrink: 0, whiteSpace: "nowrap", font: "700 11px/1 var(--dn-font-sans)", padding: "4px 7px", background: "rgba(96,165,250,.22)", color: "#dbeafe", borderRadius: 6, border: "1px solid rgba(96,165,250,.35)" }}>NexusRep</span>
              </div>
              <button
                onClick={() => setNavCollapsed(true)}
                title="Collapse menu"
                aria-label="Collapse menu"
                style={{ flexShrink: 0, width: 26, height: 26, borderRadius: 7, border: "1px solid rgba(255,255,255,.16)", background: "rgba(255,255,255,.06)", color: "rgba(255,255,255,.72)", font: "700 14px/1 var(--dn-font-sans)", cursor: "pointer" }}
              >
                ‹
              </button>
            </>
          )}
        </div>
        <nav style={{ flex: 1, overflowY: "auto", padding: navCollapsed ? "10px 8px" : 10, display: "flex", flexDirection: "column", gap: 1 }}>
          {NAV_PLAN.map((item) => <NavRow key={item.id} item={item.id === "studio" && studioMeta.pct != null ? { ...item, badge: `${studioMeta.pct}%` } : item} active={nav === item.id} collapsed={navCollapsed} onClick={() => setNav(item.id)} />)}
          <div style={{ height: 1, background: "rgba(255,255,255,.08)", margin: navCollapsed ? "12px 6px 4px" : "12px 8px 4px" }} />
          {!navCollapsed && <div style={{ font: "600 10px/1 var(--dn-font-sans)", letterSpacing: ".12em", color: "rgba(255,255,255,.38)", padding: "8px 12px 7px" }}>ACTIVITY</div>}
          {NAV_GOVERN.map((item) => <NavRow key={item.id} item={item} active={nav === item.id} collapsed={navCollapsed} onClick={() => setNav(item.id)} />)}
        </nav>
        <div style={{ padding: navCollapsed ? "8px 8px" : "8px 10px", borderTop: "1px solid rgba(255,255,255,.08)" }}>
          <div onClick={() => setNav("admin")} title={navCollapsed ? "Platform Admin" : undefined} style={{ display: "flex", alignItems: "center", justifyContent: navCollapsed ? "center" : "flex-start", gap: 10, padding: navCollapsed ? "10px 0" : "10px 13px", minHeight: 38, borderRadius: 9, cursor: "pointer", font: "500 13px/1.2 var(--dn-font-sans)", color: nav === "admin" ? "#fff" : "rgba(255,255,255,.6)", background: nav === "admin" ? "rgba(96,165,250,.18)" : "transparent" }}>
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#64748b" }} />{!navCollapsed && "Platform Admin"}
            {!navCollapsed && <span style={{ font: "500 9.5px/1 var(--dn-font-sans)", color: "rgba(255,255,255,.4)", marginLeft: "auto" }}>INTERNAL</span>}
          </div>
        </div>
        <div style={{ padding: navCollapsed ? "10px 8px" : "11px 14px", borderTop: "1px solid rgba(255,255,255,.08)", display: "flex", alignItems: "center", justifyContent: navCollapsed ? "center" : "flex-start", gap: 10 }}>
          <div style={{ width: 30, height: 30, borderRadius: "50%", background: "var(--dn-brand-light)", display: "flex", alignItems: "center", justifyContent: "center", font: "600 12px/1 var(--dn-font-sans)", color: "#fff" }}>{account.initials}</div>
          {!navCollapsed && <div style={{ lineHeight: 1.3 }}>
            <div style={{ font: "600 12px/1.2 var(--dn-font-sans)", color: "#fff" }}>{account.name}</div>
            <div style={{ font: "400 11px/1.2 var(--dn-font-sans)", color: "rgba(255,255,255,.5)" }}>{account.role}</div>
          </div>}
          {!navCollapsed && auth?.enabled && (
            <span onClick={() => void logout()} title="Sign out" style={{ marginLeft: "auto", font: "600 10.5px/1 var(--dn-font-sans)", color: "rgba(255,255,255,.55)", cursor: "pointer" }}>Sign out</span>
          )}
        </div>
      </aside>

      {/* MAIN COLUMN */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <header style={{ height: 60, flexShrink: 0, background: "#fff", borderBottom: "1px solid var(--dn-border)", display: "flex", alignItems: "center", padding: "0 22px", gap: 16 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--dn-success)", boxShadow: "0 0 0 3px rgba(22,163,74,.15)" }} />
              <span style={{ font: "700 14px/1 var(--dn-font-sans)", color: "var(--dn-fg)" }}>{brand?.campaign.title ?? "AI Rep Studio"}</span>
            </div>
            <span style={{ font: "500 11px/1 var(--dn-font-sans)", color: "var(--dn-fg-muted)", paddingLeft: 16 }}>{brand?.campaign.subtitle ?? ""}</span>
          </div>
          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10 }}>
            {/* Rep/campaign state is COMPUTED from the studio (live = launched); never a static chip. */}
            {studioMeta.repState != null && (
              <span style={{ display: "flex", alignItems: "center", gap: 6, font: "600 11px/1 var(--dn-font-sans)", color: studioMeta.repState === "live" ? "#166534" : "var(--dn-fg-muted)", background: studioMeta.repState === "live" ? "var(--dn-accent-green-bg)" : "var(--dn-surface-2)", padding: "6px 11px", borderRadius: 20 }}>
                <span style={{ width: 7, height: 7, borderRadius: "50%", background: studioMeta.repState === "live" ? "var(--dn-success)" : "var(--dn-fg-subtle)" }} />
                {studioMeta.repState === "live" ? "Campaign live" : studioMeta.repState === "ready" ? "Ready to launch" : studioMeta.repState === "in_review" ? "In review" : "Draft — not launched"}
              </span>
            )}
            {attention.length > 0 && (
              <span style={{ position: "relative" }}>
                <span onClick={() => setAttnOpen((v) => !v)} style={{ display: "flex", alignItems: "center", gap: 6, font: "600 11px/1 var(--dn-font-sans)", color: "#92400e", background: "var(--dn-accent-yellow-bg)", padding: "6px 11px", borderRadius: 20, cursor: "pointer" }}><span style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--dn-warning)" }} />Needs attention: {attention.length}</span>
                {attnOpen && (
                  <div style={{ position: "absolute", top: 34, right: 0, width: 270, background: "#fff", border: "1px solid var(--dn-border)", borderRadius: 11, boxShadow: "var(--dn-shadow-popover)", padding: 8, zIndex: 30 }}>
                    {attention.map((a, i) => (
                      <AttnItem key={a.label} n={String(i + 1)} label={a.label} onClick={() => { setAttnOpen(false); setNav(a.nav as Screen); }} />
                    ))}
                  </div>
                )}
              </span>
            )}
            <div style={{ width: 1, height: 26, background: "var(--dn-border)" }} />
            <div style={{ width: 30, height: 30, borderRadius: "50%", background: "var(--dn-brand-base)", display: "flex", alignItems: "center", justifyContent: "center", font: "600 11px/1 var(--dn-font-sans)", color: "#fff" }}>JR</div>
          </div>
        </header>

        <main style={{ flex: 1, overflowY: "auto", position: "relative" }}>
          {nav === "overview" && <OverviewScreen app={app} />}
          {nav === "studio" && <StudioScreen app={app} />}
          {nav !== "overview" && nav !== "studio" && <BrandScreens app={app} />}
        </main>
      </div>
    </div>
  );
}

function NavRow({ item, active, collapsed, onClick }: { item: { id: Screen; label: string; badge?: string }; active: boolean; collapsed: boolean; onClick: () => void }) {
  return (
    <div onClick={onClick} title={collapsed ? item.label : undefined} style={{ display: "flex", alignItems: "center", justifyContent: collapsed ? "center" : "flex-start", gap: 10, padding: collapsed ? "10px 0" : "10px 13px", minHeight: 38, borderRadius: 9, font: `${active ? 600 : 500} 13px/1.2 var(--dn-font-sans)`, cursor: "pointer", position: "relative", color: active ? "#fff" : "rgba(255,255,255,.72)", background: active ? "rgba(96,165,250,.18)" : "transparent" }}>
      <span style={{ position: "absolute", left: 0, top: 8, bottom: 8, width: 3, borderRadius: 2, background: active ? "#60a5fa" : "transparent" }} />
      {collapsed ? <span style={{ font: "700 10px/1 var(--dn-font-sans)", letterSpacing: ".05em" }}>{item.label.slice(0, 2).toUpperCase()}</span> : item.label}
      {!collapsed && item.badge && <span style={{ marginLeft: "auto", font: "700 9px/1 var(--dn-font-sans)", letterSpacing: ".04em", padding: "3px 6px", borderRadius: 5, background: "rgba(96,165,250,.22)", color: "#bfdbfe" }}>{item.badge}</span>}
    </div>
  );
}

function AttnItem({ n, label, onClick }: { n: string; label: string; onClick: () => void }) {
  return (
    <div onClick={onClick} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 11px", borderRadius: 8, cursor: "pointer" }}>
      <span style={{ font: "700 12px/1 var(--dn-font-sans)", color: "#92400e", background: "var(--dn-accent-yellow-bg)", width: 22, height: 22, borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "center" }}>{n}</span>
      <span style={{ font: "500 12px/1.3 var(--dn-font-sans)", color: "var(--dn-fg)" }}>{label}</span>
    </div>
  );
}

type Metric = { key?: string; label: string; value: string; sub: string; tone: string };
type CommandKpi = { tone: string; label: string; value: string; sub: string };

// Real "needs attention" items, computed from live state (readiness gaps, pending coaching
// rules, CRM rows needing identity mapping) — never a hardcoded count.
export interface AttentionItem { label: string; nav: string }
function useAttention(): AttentionItem[] {
  const [items, setItems] = useState<AttentionItem[]>([]);
  useEffect(() => {
    let alive = true;
    (async () => {
      const found: AttentionItem[] = [];
      try {
        const res = await fetch("/api/studio");
        if (res.ok) {
          const d = (await res.json()) as { readiness?: { items?: { label: string; done: boolean }[] }; rules?: { status: string }[] } | null;
          const open = (d?.readiness?.items ?? []).filter((i) => !i.done);
          if (open.length) found.push({ label: `${open.length} readiness item${open.length > 1 ? "s" : ""} open`, nav: "studio" });
          const pending = (d?.rules ?? []).filter((r) => r.status === "Draft" || r.status === "Needs review" || r.status === "Needs source").length;
          if (pending) found.push({ label: `${pending} coaching rule${pending > 1 ? "s" : ""} awaiting review`, nav: "studio" });
        }
      } catch { /* leave what we have */ }
      try {
        const res = await fetch("/api/followups");
        if (res.ok) {
          const d = (await res.json()) as { rows?: { status: string }[] };
          const mapping = (d.rows ?? []).filter((r) => r.status === "Needs mapping").length;
          if (mapping) found.push({ label: `${mapping} follow-up${mapping > 1 ? "s" : ""} need CRM identity mapping`, nav: "followups" });
        }
      } catch { /* leave what we have */ }
      if (alive) setItems(found);
    })();
    return () => { alive = false; };
  }, []);
  return items;
}

type TopicMix = { total: number; slices: { label: string; count: number; pct: number }[] };

function useCommandKpis(): { kpis: CommandKpi[]; live: boolean; topicMix: TopicMix | null } {
  const [kpis, setKpis] = useState<CommandKpi[]>(COMMAND_KPIS);
  const [live, setLive] = useState(false);
  const [topicMix, setTopicMix] = useState<TopicMix | null>(null);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch("/api/analytics");
        if (!res.ok) return;
        const json = (await res.json()) as { data?: Record<string, Metric[]>; topicMix?: TopicMix };
        if (!alive || !json.data) return;
        if (json.topicMix) setTopicMix(json.topicMix);
        const d = json.data;
        const find = (cat: string, key: string) => (d[cat] ?? []).find((m) => m.key === key);
        const matches = [
          find("engagement", "completed"),
          find("targeting", "high_opp"),
          find("crm_ops", "followups"),
          find("compliance", "isi"),
          find("content", "gaps"),
          find("crm_ops", "crm_success"),
        ];
        const derived: CommandKpi[] = COMMAND_KPIS.map((fallback, i) => {
          const m = matches[i];
          const label = [
            "Sessions completed", "Target HCPs", "Follow-ups created",
            "ISI delivery", "Content gaps", "CRM export success",
          ][i]!;
          return m
            ? { tone: m.tone ?? fallback.tone, label, value: m.value, sub: m.sub }
            : fallback;
        });
        setKpis(derived);
        // The "sample data" pill must show if ANY tile fell back to the fixture — a
        // partially-live analytics response otherwise renders fixture numbers as real.
        setLive(matches.every(Boolean));
      } catch {
        /* keep static fallback — the caller labels it as sample data */
      }
    })();
    return () => { alive = false; };
  }, []);
  return { kpis, live, topicMix };
}

function OverviewScreen({ app }: { app: AppState }) {
  const { kpis: commandKpis, live: kpisLive, topicMix } = useCommandKpis();
  // Show the REAL question mix once there's enough classified volume to be meaningful;
  // below that, keep the labeled illustrative sample so a sparse demo doesn't look broken.
  const TOPIC_MIN = 8;
  const topicLive = !!topicMix && topicMix.total >= TOPIC_MIN && topicMix.slices.length > 0;
  const topicRows: [string, number, string][] = topicLive
    ? topicMix!.slices.slice(0, 6).map((s) => [s.label, Math.round((s.pct / (topicMix!.slices[0]!.pct || 1)) * 100), `${s.pct}%`])
    : [["What the product is / mechanism", 100, "34%"], ["The program", 72, "23%"], ["Investigational & FDA status", 58, "19%"], ["Dosing / efficacy (→ Medical Info)", 44, "14%"], ["Comparative questions (→ Medical Info)", 32, "10%"]];
  const brand = useBrand();
  // Real "needs coaching" list: sessions whose compliance status isn't clean, from the live API.
  const [coachRows, setCoachRows] = useState<{ id: string; hcp: string; comp: string }[] | null>(null);
  useEffect(() => {
    let alive = true;
    fetch("/api/sessions")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { rows?: { id: string; hcp: string; comp: string }[] } | null) => {
        if (!alive || !d?.rows) return;
        setCoachRows(d.rows.filter((s) => !/approved|clean/i.test(s.comp)).slice(0, 3));
      })
      .catch(() => {});
    return () => { alive = false; };
  }, []);
  const samplePill = (
    <span style={{ font: "600 9px/1 var(--dn-font-sans)", letterSpacing: ".05em", textTransform: "uppercase", color: "#92400e", background: "var(--dn-accent-yellow-bg)", padding: "3px 7px", borderRadius: 5 }}>sample data</span>
  );
  return (
    <div style={{ padding: "24px 30px 40px", maxWidth: 1340 }}>
      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", marginBottom: 18 }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
            <span style={{ font: "600 11px/1.2 var(--dn-font-sans)", letterSpacing: ".08em", textTransform: "uppercase", color: "var(--dn-brand-light)" }}>Command Center</span>
            {!kpisLive && samplePill}
          </div>
          <h1 style={{ font: "600 26px/1.2 var(--dn-font-sans)", letterSpacing: "-0.02em", margin: 0 }}>{`Good ${new Date().getHours() < 12 ? "morning" : new Date().getHours() < 17 ? "afternoon" : "evening"}, ${(app.userName?.trim().split(/\s+/)[0]) || DEMO_USER.firstName}`}</h1>
          <div style={{ font: "400 13px/1.4 var(--dn-font-sans)", color: "var(--dn-fg-muted)", marginTop: 5 }}>{brand?.campaign.title ?? "AI Rep Studio"}</div>
        </div>
        <div style={{ display: "flex", gap: 9 }}>
          <button onClick={() => app.setNav("studio")} style={btnPrimary}>Open AI Rep Studio →</button>
          <button onClick={() => app.setNav("targeting")} style={btnGhost}>Review priority HCPs</button>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 13, marginBottom: 16 }}>
        {commandKpis.map((k) => (
          <div key={k.label} style={{ background: "#fff", border: "1px solid var(--dn-border)", borderRadius: 13, padding: "15px 16px", boxShadow: "var(--dn-shadow-card)", cursor: "pointer" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
              <span style={{ font: "600 10.5px/1.3 var(--dn-font-sans)", letterSpacing: ".04em", textTransform: "uppercase", color: "var(--dn-fg-muted)" }}>{k.label}</span>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: TONE_COLORS[k.tone] }} />
            </div>
            <div style={{ font: "600 28px/1 var(--dn-font-sans)", letterSpacing: "-0.02em", color: TONE_COLORS[k.tone] }}>{k.value}</div>
            <div style={{ font: "400 11.5px/1.3 var(--dn-font-sans)", color: "var(--dn-fg-subtle)", marginTop: 6 }}>{k.sub}</div>
          </div>
        ))}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1.62fr 1fr", gap: 16 }}>
        <div style={{ background: "#fff", border: "1px solid var(--dn-border)", borderRadius: 13, padding: "18px 20px", boxShadow: "var(--dn-shadow-card)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
            <span style={{ font: "600 13px/1 var(--dn-font-sans)" }}>What HCPs are asking</span>
            {!topicLive && samplePill}
          </div>
          <div style={{ font: "400 11.5px/1.3 var(--dn-font-sans)", color: "var(--dn-fg-subtle)", marginBottom: 16 }}>{topicLive ? `Measured across ${topicMix!.total} classified questions this campaign` : "Illustrative topic mix — the real distribution appears once sessions accrue"}</div>
          {topicRows.map(([label, pct, val]) => (
            <div key={label as string} style={{ display: "flex", alignItems: "center", gap: 11, marginBottom: 10 }}>
              <span style={{ width: 150, flexShrink: 0, font: "500 11.5px/1.3 var(--dn-font-sans)", color: "var(--dn-fg)" }}>{label}</span>
              <span style={{ flex: 1, height: 13, borderRadius: 4, background: "var(--dn-surface-2)", overflow: "hidden" }}><span style={{ display: "block", height: "100%", borderRadius: 4, background: "var(--dn-brand-light)", width: `${pct}%` }} /></span>
              <span style={{ width: 40, textAlign: "right", font: "600 11.5px/1 var(--dn-font-sans)", color: "var(--dn-fg-muted)" }}>{val}</span>
            </div>
          ))}
        </div>
        <div style={{ background: "#fff", border: "1px solid var(--dn-border)", borderRadius: 13, padding: "18px 20px", boxShadow: "var(--dn-shadow-card)" }}>
          <div style={{ font: "600 13px/1 var(--dn-font-sans)", marginBottom: 12 }}>Sessions needing coaching</div>
          {/* REAL sessions with a non-clean compliance status — never fixture doctors. */}
          {(coachRows ?? []).map((s) => (
            <div key={s.id} onClick={() => { app.setSelectedSessionId(String(s.id)); app.setNav("audit"); }} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 0", borderBottom: "1px solid var(--dn-surface-2)", cursor: "pointer" }}>
              <span style={{ width: 28, height: 28, borderRadius: "50%", background: "var(--dn-surface-2)", display: "flex", alignItems: "center", justifyContent: "center", font: "600 11px/1 var(--dn-font-sans)", color: "var(--dn-brand-base)" }}>{s.hcp.split(" ").slice(-1)[0]?.[0]}</span>
              <div style={{ flex: 1 }}>
                <div style={{ font: "600 12px/1.2 var(--dn-font-sans)" }}>{s.hcp}</div>
                <div style={{ font: "400 10.5px/1.2 var(--dn-font-sans)", color: "var(--dn-fg-subtle)", marginTop: 2 }}>{s.comp}</div>
              </div>
              <span style={{ font: "600 11px/1 var(--dn-font-sans)", color: "var(--dn-brand-light)" }}>Review →</span>
            </div>
          ))}
          {coachRows !== null && coachRows.length === 0 && (
            <div style={{ font: "400 11.5px/1.5 var(--dn-font-sans)", color: "var(--dn-fg-subtle)", padding: "10px 0" }}>Nothing flagged — every reviewed session is clean.</div>
          )}
          {coachRows === null && (
            <div style={{ font: "400 11.5px/1.5 var(--dn-font-sans)", color: "var(--dn-fg-subtle)", padding: "10px 0" }}>Loading sessions…</div>
          )}
        </div>
      </div>
    </div>
  );
}

export const btnPrimary: React.CSSProperties = { padding: "11px 18px", background: "var(--dn-brand-base)", color: "#fff", border: "none", borderRadius: 9, font: "600 13px/1 var(--dn-font-sans)", cursor: "pointer" };
export const btnGhost: React.CSSProperties = { padding: "11px 18px", background: "#fff", color: "var(--dn-fg)", border: "1px solid var(--dn-border)", borderRadius: 9, font: "600 13px/1 var(--dn-font-sans)", cursor: "pointer" };
