"use client";

/**
 * Studio · Agent mode — choose WHO the rep is on video. Browse the agent gallery
 * (your own trained agents + the stock library), pick one — the choice persists
 * and every video call uses it — or start training a personal agent from footage.
 * Voice is bundled with the agent (picking a different agent changes the voice);
 * the built-in avatar's speaking tone is set here too.
 *
 * Vendor-neutral: talks only to /api/realtime/agents (canonical AgentSummary
 * shapes) — no vendor names, ids, or vocabulary anywhere in this file.
 */

import { memo, useEffect, useMemo, useRef, useState } from "react";
import { useAgents, setAgentsCache, type AgentInfo, type AgentsPayload } from "../_components/useAgents";
import { OpenAiVoiceProvider } from "@lib/browser-speech";
import { previewScript, voiceForName, PREVIEW_VOICES, DEFAULT_VOICE } from "@lib/agent-preview";

const card: React.CSSProperties = { background: "#fff", border: "1px solid var(--dn-border)", borderRadius: 13, boxShadow: "var(--dn-shadow-card)" };
const cardHead: React.CSSProperties = { padding: "12px 14px 10px", borderBottom: "1px solid var(--dn-border)", font: "600 12px/1 var(--dn-font-sans)", color: "var(--dn-fg)" };
const hint: React.CSSProperties = { font: "400 10.5px/1.5 var(--dn-font-sans)", color: "var(--dn-fg-subtle)" };
const input: React.CSSProperties = { width: "100%", boxSizing: "border-box", padding: "8px 10px", border: "1px solid var(--dn-border)", borderRadius: 8, font: "400 12px/1.3 var(--dn-font-sans)", color: "var(--dn-fg)", background: "#fff" };

/** Gallery names often carry a setting suffix ("Mary - Office", "Steph - Selfie (…)").
 *  Derive it so the gallery can be filtered by setting; version suffixes collapse
 *  ("Office V1" → "office") so one chip covers the family. */
function settingOf(a: AgentInfo): string | null {
  const after = a.name.replace(/\(.*?\)/g, "").split(/\s[-–—]\s/)[1]?.trim();
  if (!after) return null;
  const cleaned = after.replace(/\s*v?\d+$/i, "").trim().toLowerCase();
  return cleaned || null;
}

const isDeprecated = (a: AgentInfo): boolean => /deprecated/i.test(a.name);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// One reused provider for the "Hear it" button in the Video-off voice card — samples the chosen
// voice reading the intro script. No tone anywhere: tone is a coaching concern, not a voice knob.
let voiceSampleProvider: OpenAiVoiceProvider | null = null;
function hearVoice(name: string, voice?: string): void {
  if (!voiceSampleProvider) { voiceSampleProvider = new OpenAiVoiceProvider(); void voiceSampleProvider.warmup(); }
  voiceSampleProvider.cancel();
  void voiceSampleProvider.speak(previewScript(name), { voice: voice || voiceForName(name) });
}

// Client cache of RESOLVED Tavus preview clip URLs, keyed by agent id. Rendering is OFF by default
// (env.agentPreviewRender) — the route returns "unavailable" and hover plays the STOCK clip. When
// enabled, a rendered clip (agent speaking our script) is fetched once and replayed from cache.
const previewClipCache = new Map<string, string>();
async function fetchPreviewClip(agentId: string, name: string): Promise<string | null> {
  if (previewClipCache.has(agentId)) return previewClipCache.get(agentId)!;
  try {
    const res = await fetch("/api/realtime/agents/preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ agentId, name }) });
    const d = (await res.json()) as { status?: string; url?: string };
    if (d.status === "ready" && d.url) { previewClipCache.set(agentId, d.url); return d.url; }
  } catch { /* stock clip carries the hover */ }
  return null;
}

/** Thumbnail that SHOWS the agent's first frame once the card scrolls into view, and on hover PLAYS
 *  the agent's STOCK clip with its real voice (same video, same voice — no tones). If Tavus render
 *  is enabled (off by default) and a clip has been rendered, that cached clip (the agent speaking
 *  our script) plays instead. The <video> is mounted lazily via IntersectionObserver so a 90-cell
 *  gallery doesn't open 90 connections at once. Memoized so filtering/typing doesn't re-reconcile. */
const AgentThumb = memo(function AgentThumb({ agent }: { agent: AgentInfo }) {
  const [inView, setInView] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const hoveringRef = useRef(false);
  const initials = agent.name.split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase();

  useEffect(() => {
    const el = wrapRef.current;
    if (!el || !agent.thumbnailUrl) return;
    const io = new IntersectionObserver(
      (entries) => { if (entries.some((e) => e.isIntersecting)) { setInView(true); io.disconnect(); } },
      { root: null, rootMargin: "200px" }, // load a little before it's visible for a seamless scroll
    );
    io.observe(el);
    return () => io.disconnect();
  }, [agent.thumbnailUrl]);

  const playClip = (src: string, muted: boolean) => {
    const v = videoRef.current;
    if (!v) return;
    if (v.getAttribute("src") !== src) { v.setAttribute("src", src); v.load(); }
    v.muted = muted; v.currentTime = 0; void v.play().catch(() => {});
  };

  const onEnter = () => {
    hoveringRef.current = true;
    const stock = agent.thumbnailUrl;
    const ready = previewClipCache.get(agent.id);
    if (ready) { playClip(ready, false); return; } // a rendered clip already exists → real voice + our script
    if (stock) playClip(stock, false); // default: the agent's stock clip (its real voice)
    void fetchPreviewClip(agent.id, agent.name).then((url) => {
      if (url && hoveringRef.current) playClip(url, false); // swap in the rendered clip if enabled+ready
    });
  };
  const onLeave = () => {
    hoveringRef.current = false;
    const v = videoRef.current;
    if (v) { v.pause(); v.muted = true; v.currentTime = 0; if (agent.thumbnailUrl && v.getAttribute("src") !== agent.thumbnailUrl) { v.setAttribute("src", agent.thumbnailUrl); v.load(); } }
  };

  return (
    <div
      ref={wrapRef}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      style={{ position: "relative", width: "100%", aspectRatio: "4 / 3", borderRadius: 9, overflow: "hidden", background: "#0a1a33" }}
    >
      {/* gradient+initials placeholder — sits under the video, shows until (and if) it loads */}
      <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "linear-gradient(135deg, var(--dn-surface-2), var(--dn-border))" }}>
        <span style={{ font: "700 22px/1 var(--dn-font-sans)", color: "var(--dn-fg-subtle)" }}>{initials || "?"}</span>
      </div>
      {inView && agent.thumbnailUrl && (
        <video
          ref={videoRef}
          src={agent.thumbnailUrl}
          muted
          playsInline
          preload="metadata"
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", display: "block" }}
        />
      )}
    </div>
  );
});

export function StudioAgentMode() {
  // Cached at module scope (useAgents) — switching Studio tabs and returning is instant
  // instead of re-fetching the 90+ agent list every mount.
  const { data, loading, refresh } = useAgents();
  const [busy, setBusy] = useState<string | null>(null); // agent id (or "create") with an action in flight
  const [msg, setMsg] = useState("");
  const [createName, setCreateName] = useState("");
  const [createUrl, setCreateUrl] = useState("");
  const [createAck, setCreateAck] = useState(false);
  // Gallery browsing state — the list is large (90+ stock agents), so it filters
  // instead of making the page scroll.
  const [query, setQuery] = useState("");
  const [kindFilter, setKindFilter] = useState<"all" | "personal" | "stock">("all");
  const [setting, setSetting] = useState<string | null>(null);
  const [showDeprecated, setShowDeprecated] = useState(false);
  // "Video off voice" options (collapsible). The rep's voice when video is off (and, with the
  // whole-conversation toggle, throughout). "" = app default; else a chosen OpenAI voice. Persisted.
  const [voiceOptionsOpen, setVoiceOptionsOpen] = useState(false);
  const [openaiVoice, setOpenaiVoice] = useState(DEFAULT_VOICE);
  const [wholeConvo, setWholeConvo] = useState(false);
  const [trainOpen, setTrainOpen] = useState(false);

  // A configured-deployment load problem (e.g. the vendor list timed out) shows above the grid;
  // action feedback (msg, set by post) takes precedence. Unconfigured notes render in the empty state.
  const banner = msg || data?.error || (data?.configured ? data?.note : "") || "";

  const post = async (body: Record<string, unknown>, busyKey: string, okMsg: string) => {
    setBusy(busyKey);
    setMsg("");
    try {
      const res = await fetch("/api/realtime/agents", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const d = (await res.json()) as AgentsPayload;
      setAgentsCache(d); // update the shared cache; every mounted consumer re-reads it
      setMsg(d.error ?? d.note ?? okMsg);
      return !d.error;
    } catch (e) {
      setMsg(`That didn't save: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    } finally {
      setBusy(null);
    }
  };

  const select = (a: AgentInfo) => post({ action: "select", agentId: a.id, name: a.name }, a.id, `${a.name} is now your agent — every video call uses them.`);
  const clearSelection = () => post({ action: "select", agentId: null }, "clear", "Back to the default agent.");
  const create = async () => {
    const ok = await post({ action: "create", name: createName, trainVideoUrl: createUrl }, "create", "Training started.");
    if (ok) { setCreateName(""); setCreateUrl(""); setCreateAck(false); }
  };

  const agents = useMemo(() => data?.agents ?? [], [data]);
  const activeId = data?.selected ?? data?.defaultReplicaId ?? null;
  const active = agents.find((a) => a.id === activeId) ?? null;

  // Reflect the PERSISTED video-off voice + scope, syncing the controls to what's saved server-side.
  useEffect(() => { setOpenaiVoice(data?.voiceId ?? DEFAULT_VOICE); }, [data?.voiceId]);
  useEffect(() => { setWholeConvo(Boolean(data?.voiceWholeConvo)); }, [data?.voiceWholeConvo]);
  const changeVoice = (v: string) => {
    setOpenaiVoice(v);
    void post({ action: "voice", voiceId: v || null }, "voice", v ? `Video-off voice set to ${cap(v)}.` : "Using the default video-off voice.");
  };
  const changeWholeConvo = (checked: boolean) => {
    setWholeConvo(checked);
    void post({ action: "voice", voiceWholeConvo: checked }, "voice", checked ? "This voice will be used for the whole conversation." : "This voice is used only when video is off.");
  };

  // Setting chips are data-derived (only settings that actually exist), most common first.
  const settingChips = useMemo(() => {
    const counts = new Map<string, number>();
    for (const a of agents) {
      if (!showDeprecated && isDeprecated(a)) continue;
      const s = settingOf(a);
      if (s) counts.set(s, (counts.get(s) ?? 0) + 1);
    }
    return [...counts.entries()].filter(([, n]) => n >= 2).sort((x, y) => y[1] - x[1]).slice(0, 8);
  }, [agents, showDeprecated]);

  const deprecatedCount = useMemo(() => agents.filter(isDeprecated).length, [agents]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return agents.filter((a) =>
      (showDeprecated || !isDeprecated(a)) &&
      (kindFilter === "all" || a.kind === kindFilter) &&
      (!setting || settingOf(a) === setting) &&
      (!q || a.name.toLowerCase().includes(q) || (settingOf(a) ?? "").includes(q)),
    );
  }, [agents, query, kindFilter, setting, showDeprecated]);
  const visiblePersonal = visible.filter((a) => a.kind === "personal");
  const visibleStock = visible.filter((a) => a.kind === "stock");

  const chip = (label: string, on: boolean, onClick: () => void): React.ReactElement => (
    <button key={label} onClick={onClick} style={{ padding: "6px 11px", borderRadius: 15, border: on ? "1.5px solid var(--dn-brand-base)" : "1px solid var(--dn-border)", background: on ? "var(--dn-brand-base)" : "#fff", color: on ? "#fff" : "var(--dn-fg-muted)", font: "600 10.5px/1 var(--dn-font-sans)", cursor: "pointer", whiteSpace: "nowrap" }}>{label}</button>
  );

  const gallerySection = (title: string, list: AgentInfo[]) => (
    <div>
      <div style={{ font: "600 11px/1 var(--dn-font-sans)", color: "var(--dn-fg-muted)", margin: "2px 0 8px" }}>{title} <span style={{ color: "var(--dn-fg-subtle)", fontWeight: 500 }}>· {list.length}</span></div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 10 }}>
        {list.map((a) => {
          const isActive = a.id === activeId;
          return (
            <div key={a.id} data-testid="agent-card" style={{ border: isActive ? "2px solid var(--dn-brand-base)" : "1px solid var(--dn-border)", borderRadius: 11, padding: 7, background: "#fff", display: "flex", flexDirection: "column", gap: 7 }}>
              <AgentThumb agent={a} />
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6, minWidth: 0 }}>
                <span title={a.name} style={{ font: "600 11px/1.25 var(--dn-font-sans)", color: "var(--dn-fg)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.name}</span>
                {a.status !== "ready" && (
                  <span style={{ font: "600 9px/1 var(--dn-font-sans)", color: a.status === "training" ? "#92400e" : "#991b1b", background: a.status === "training" ? "#fef3c7" : "#fee2e2", padding: "3px 6px", borderRadius: 8, flex: "none" }}>{a.status === "training" ? "Training" : "Error"}</span>
                )}
              </div>
              {isActive ? (
                <span style={{ font: "600 10.5px/1 var(--dn-font-sans)", color: "var(--dn-brand-base)", padding: "6px 0", textAlign: "center" }}>✓ In use</span>
              ) : (
                <button
                  onClick={() => void select(a)}
                  disabled={a.status !== "ready" || busy !== null}
                  style={{ padding: "6px 0", border: "1px solid var(--dn-border)", borderRadius: 8, background: "var(--dn-surface-2)", font: "600 10.5px/1 var(--dn-font-sans)", color: a.status === "ready" ? "var(--dn-fg)" : "var(--dn-fg-subtle)", cursor: a.status === "ready" ? "pointer" : "default", opacity: busy === a.id ? 0.6 : 1 }}
                >
                  {busy === a.id ? "Selecting…" : "Select"}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );

  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(290px, 350px) 1fr", gap: 14, alignItems: "start" }}>
      {/* ── Left: who the agent is now + voice + train-your-own ─────────────── */}
      <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
        <div style={card}>
          <div style={cardHead}>Your agent today</div>
          <div style={{ padding: "12px 14px", display: "flex", flexDirection: "column", gap: 9 }}>
            {data?.configured ? (
              <>
                {active ? <AgentThumb agent={active} /> : null}
                <div style={{ font: "600 12.5px/1.3 var(--dn-font-sans)", color: "var(--dn-fg)" }}>
                  {active?.name ?? data.selectedName ?? (activeId ? activeId : "Default agent")}
                  <span style={{ font: "500 10px/1 var(--dn-font-sans)", color: "var(--dn-fg-subtle)", marginLeft: 7 }}>{data.selected ? "your pick" : "deployment default"}</span>
                </div>
                <div style={hint}>This is the face doctors see on video calls.</div>
                {data.selected && (
                  <span onClick={() => { if (!busy) void clearSelection(); }} style={{ font: "600 10.5px/1 var(--dn-font-sans)", color: "var(--dn-brand-light)", cursor: "pointer" }}>
                    {busy === "clear" ? "Resetting…" : "↺ Use the default agent instead"}
                  </span>
                )}
              </>
            ) : (
              <>
                <div style={{ font: "600 12.5px/1.3 var(--dn-font-sans)", color: "var(--dn-fg)" }}>Built-in 3D avatar</div>
                <div style={hint}>{data?.note ?? "Live video agents aren't connected on this deployment — the built-in 3D avatar represents the rep meanwhile."}</div>
              </>
            )}
          </div>
        </div>

        <div style={card}>
          <div
            onClick={() => setVoiceOptionsOpen((v) => !v)}
            style={{ ...cardHead, display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer", borderBottom: voiceOptionsOpen ? "1px solid var(--dn-border)" : "none" }}
          >
            <span>Video off voice {openaiVoice && <span style={{ font: "600 9px/1 var(--dn-font-sans)", color: "var(--dn-brand-base)", background: "rgba(6,73,172,.08)", padding: "3px 6px", borderRadius: 5, marginLeft: 4 }}>{cap(openaiVoice)}{wholeConvo ? " · whole call" : ""}</span>}</span>
            <span style={{ color: "var(--dn-fg-subtle)", fontSize: 13 }}>{voiceOptionsOpen ? "▾" : "▸"}</span>
          </div>
          {voiceOptionsOpen && (
            <div style={{ padding: "12px 14px", display: "flex", flexDirection: "column", gap: 10 }}>
              <div style={hint}>The rep&apos;s voice <strong>when video is off</strong> — same video, same script, only the voice changes. Pick the one that sounds most natural.</div>
              <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                <span style={{ font: "600 10px/1 var(--dn-font-sans)", letterSpacing: ".04em", textTransform: "uppercase", color: "var(--dn-fg-muted)" }}>Voice</span>
                <div style={{ display: "flex", gap: 7 }}>
                  <select value={openaiVoice || DEFAULT_VOICE} onChange={(e) => changeVoice(e.target.value)} disabled={busy === "voice"} style={{ ...input, cursor: "pointer", flex: 1 }}>
                    {PREVIEW_VOICES.map((v) => <option key={v} value={v}>{cap(v)}</option>)}
                  </select>
                  <button onClick={() => hearVoice(active?.name ?? data?.selectedName ?? "your rep", openaiVoice)} title="Hear this voice" style={{ padding: "0 12px", borderRadius: 8, border: "1px solid var(--dn-border)", background: "var(--dn-surface-2)", font: "600 11px/1 var(--dn-font-sans)", color: "var(--dn-fg)", cursor: "pointer", whiteSpace: "nowrap" }}>▶ Hear</button>
                </div>
              </label>
              <label style={{ display: "flex", gap: 7, alignItems: "flex-start", cursor: "pointer", font: "500 11.5px/1.35 var(--dn-font-sans)", color: "var(--dn-fg)" }}>
                <input type="checkbox" checked={wholeConvo} onChange={(e) => changeWholeConvo(e.target.checked)} disabled={busy === "voice"} style={{ marginTop: 1 }} />
                <span>Use this voice for the <strong>whole conversation</strong> (video on too), not just when video is off.</span>
              </label>
            </div>
          )}
        </div>

        <div style={card}>
          <div
            onClick={() => setTrainOpen((v) => !v)}
            style={{ ...cardHead, display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer", borderBottom: trainOpen ? "1px solid var(--dn-border)" : "none" }}
          >
            <span>Train your own agent</span>
            <span style={{ color: "var(--dn-fg-subtle)", fontSize: 13 }}>{trainOpen ? "▾" : "▸"}</span>
          </div>
          {trainOpen && (
            <div style={{ padding: "12px 14px", display: "flex", flexDirection: "column", gap: 9 }}>
              <div style={hint}>Turn footage of a real presenter into a personal agent — their face and voice. The video must include the presenter&apos;s <strong>spoken consent</strong>, and training takes a few hours.</div>
              <input value={createName} onChange={(e) => setCreateName(e.target.value)} placeholder="Agent name (e.g. Dr. Patel — cardiology rep)" style={input} />
              <input value={createUrl} onChange={(e) => setCreateUrl(e.target.value)} placeholder="Training footage URL (https://…, 2+ min of talking)" style={input} />
              <label style={{ ...hint, display: "flex", gap: 7, alignItems: "flex-start", cursor: "pointer" }}>
                <input type="checkbox" checked={createAck} onChange={(e) => setCreateAck(e.target.checked)} style={{ marginTop: 1 }} />
                <span>I understand this uses one of my plan&apos;s <strong>custom-agent slots</strong> and the footage includes consent.</span>
              </label>
              <button
                onClick={() => void create()}
                disabled={!data?.configured || !createAck || createName.trim().length < 2 || !/^https:\/\//.test(createUrl.trim()) || busy !== null}
                style={{ padding: "9px 0", border: "none", borderRadius: 9, background: "var(--dn-brand-base)", color: "#fff", font: "600 12px/1 var(--dn-font-sans)", cursor: "pointer", opacity: !data?.configured || !createAck || createName.trim().length < 2 || !/^https:\/\//.test(createUrl.trim()) || busy !== null ? 0.5 : 1 }}
              >
                {busy === "create" ? "Starting training…" : "Start training"}
              </button>
            </div>
          )}
        </div>
      </div>

      {/* ── Right: the gallery — search + filters + a scrollable grid ───────── */}
      <div style={{ ...card, minWidth: 0 }}>
        <div style={{ ...cardHead, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span>Agent gallery {agents.length > 0 && <span style={{ font: "500 10px/1 var(--dn-font-sans)", color: "var(--dn-fg-subtle)" }}>· {visible.length} of {agents.length}</span>}</span>
          <span onClick={() => { if (!loading) void refresh(); }} style={{ font: "600 10.5px/1 var(--dn-font-sans)", color: "var(--dn-fg-subtle)", cursor: "pointer" }}>{loading ? "Loading…" : "↻ Refresh"}</span>
        </div>
        <div style={{ padding: "12px 14px", display: "flex", flexDirection: "column", gap: 11 }}>
          {banner && <div data-testid="agent-msg" style={{ font: "500 11px/1.45 var(--dn-font-sans)", color: "var(--dn-fg-muted)", background: "var(--dn-surface-2)", border: "1px solid var(--dn-border)", borderRadius: 9, padding: "8px 11px" }}>{banner}</div>}
          {loading && !data ? (
            <div style={hint}>Loading the gallery…</div>
          ) : !data?.configured ? (
            <div style={hint}>Once live video agents are connected, every stock agent — and any you train — shows up here to browse and pick from. Doctors always meet whoever you choose as the <strong>DocNexus Agent</strong>.</div>
          ) : (
            <>
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search agents — try a name or a setting like “office”" style={input} />
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                {chip("All", kindFilter === "all", () => setKindFilter("all"))}
                {chip("Yours", kindFilter === "personal", () => setKindFilter(kindFilter === "personal" ? "all" : "personal"))}
                {chip("Stock", kindFilter === "stock", () => setKindFilter(kindFilter === "stock" ? "all" : "stock"))}
                {settingChips.length > 0 && <span style={{ width: 1, alignSelf: "stretch", background: "var(--dn-border)", margin: "0 3px" }} />}
                {settingChips.map(([s, n]) => chip(`${cap(s)} · ${n}`, setting === s, () => setSetting(setting === s ? null : s)))}
                {deprecatedCount > 0 && chip(showDeprecated ? "Hide older versions" : `Older versions · ${deprecatedCount}`, showDeprecated, () => setShowDeprecated((v) => !v))}
              </div>
              {/* The grid scrolls inside the card — browsing 90+ agents never means scrolling the whole page. */}
              <div style={{ maxHeight: "56vh", overflowY: "auto", paddingRight: 4, display: "flex", flexDirection: "column", gap: 14 }}>
                {visible.length === 0 ? (
                  <div style={{ ...hint, padding: "12px 0" }}>No agents match{query ? ` “${query}”` : " these filters"} — clear a filter or hit ↻ Refresh.</div>
                ) : (
                  <>
                    {kindFilter !== "stock" && (
                      visiblePersonal.length > 0
                        ? gallerySection("Your agents", visiblePersonal)
                        : kindFilter === "personal" && <div style={hint}>None yet — train one from footage on the left.</div>
                    )}
                    {kindFilter !== "personal" && visibleStock.length > 0 && gallerySection("Stock agents", visibleStock)}
                  </>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
