// ═══════════════════════════════════════════════════════════════
// PacketAssembler.jsx — Full UI for the immigration packet
// assembly workflow. Multi-step wizard with:
//   1. Folder selection
//   2. Cover letter detection + confirmation
//   3. Parsed exhibit review
//   4. Document match review (drag to reassign, confirm)
//   5. Packet config
//   6. Assembly progress
//   7. Completion + download
// ═══════════════════════════════════════════════════════════════

import React, { useState, useCallback, useMemo } from "react";
import { usePacketAssembler } from "./usePacketAssembler";

// ── Color palette ──
const C = {
  bg:       "#0B1120",
  surface:  "#131C31",
  surface2: "#182440",
  border:   "#1C2942",
  accent:   "#3B82F6",
  accentDim:"rgba(59,130,246,0.15)",
  green:    "#22C55E",
  greenDim: "rgba(34,197,94,0.12)",
  yellow:   "#FBBF24",
  yellowDim:"rgba(251,191,36,0.12)",
  red:      "#EF4444",
  redDim:   "rgba(239,68,68,0.12)",
  txt1:     "#E8EDF5",
  txt2:     "#6B7FA3",
  txt3:     "#3D5278",
};

// ── Shared styles ──
const card = {
  background: C.surface,
  border: `1px solid ${C.border}`,
  borderRadius: 10,
  padding: 20,
};
const btn = (color = C.accent, outline = false) => ({
  display: "inline-flex", alignItems: "center", gap: 6,
  padding: "8px 18px", borderRadius: 7, fontSize: 13, fontWeight: 600,
  cursor: "pointer", transition: "all 0.15s", border: "none",
  background: outline ? "transparent" : color,
  color: outline ? color : "#fff",
  ...(outline ? { border: `1px solid ${color}` } : {}),
});
const badge = (bg, color) => ({
  display: "inline-block", padding: "2px 10px", borderRadius: 10,
  fontSize: 11, fontWeight: 600, background: bg, color,
});

// ── Icons (inline SVG) ──
const Icon = ({ d, size = 16, color = "currentColor" }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
    stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d={d} />
  </svg>
);
const Icons = {
  folder:   "M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z",
  file:     "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6",
  check:    "M20 6L9 17l-5-5",
  x:        "M18 6L6 18 M6 6l12 12",
  arrow:    "M5 12h14 M12 5l7 7-7 7",
  back:     "M19 12H5 M12 19l-7-7 7-7",
  download: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4 M7 10l5 5 5-5 M12 15V3",
  search:   "M11 3a8 8 0 1 0 0 16 8 8 0 0 0 0-16z M21 21l-4.35-4.35",
  alert:    "M12 9v4 M12 17h.01 M10.29 3.86l-8.6 14.93A1 1 0 0 0 2.56 21h18.88a1 1 0 0 0 .87-1.5L13.71 3.86a1 1 0 0 0-1.74 0z",
  grip:     "M8 6h.01 M8 12h.01 M8 18h.01 M16 6h.01 M16 12h.01 M16 18h.01",
  settings: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  refresh:  "M23 4v6h-6 M1 20v-6h6 M3.51 9a9 9 0 0 1 14.85-3.36L23 10 M1 14l4.64 4.36A9 9 0 0 0 20.49 15",
  plus:     "M12 5v14 M5 12h14",
};


// ═══════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════════════════════

export default function PacketAssembler() {
  const hook = usePacketAssembler();
  const { state, stats } = hook;

  return (
    <div style={{
      fontFamily: "'Inter',-apple-system,sans-serif",
      background: C.bg, color: C.txt1,
      height: "100vh", display: "flex", flexDirection: "column", overflow: "hidden",
    }}>
      {/* ── Top Bar ── */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "14px 24px", borderBottom: `1px solid ${C.border}`, background: C.surface,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          {hook.canGoBack && (
            <button onClick={hook.goBack}
              style={{ ...btn(C.txt3, true), padding: "6px 10px" }}>
              <Icon d={Icons.back} size={14} />
            </button>
          )}
          <h1 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>
            Immigration Packet Assembler
          </h1>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <StepIndicator current={state.step} />
          {state.step !== "idle" && (
            <button onClick={hook.reset}
              style={{ ...btn(C.txt3, true), padding: "5px 12px", fontSize: 11 }}>
              Start Over
            </button>
          )}
        </div>
      </div>

      {/* ── Content ── */}
      <div style={{ flex: 1, overflow: "auto", padding: 24 }}>
        {state.step === "idle" && <StepIdle hook={hook} />}
        {state.step === "detecting-cover-letter" && <StepCoverLetter hook={hook} />}
        {state.step === "parsing-cover-letter" && <StepParsing hook={hook} />}
        {state.step === "matching-documents" && <StepMatching />}
        {state.step === "review-matches" && <StepReview hook={hook} />}
        {state.step === "configuring-packet" && <StepConfig hook={hook} />}
        {state.step === "assembling" && <StepAssembling hook={hook} />}
        {state.step === "complete" && <StepComplete hook={hook} />}
        {state.step === "error" && <StepError hook={hook} />}
      </div>
    </div>
  );
}


// ═══════════════════════════════════════════════════════════
// STEP INDICATOR
// ═══════════════════════════════════════════════════════════

const STEPS_DISPLAY = [
  { key: "selecting-folder", label: "Folder" },
  { key: "detecting-cover-letter", label: "Cover Letter" },
  { key: "parsing-cover-letter", label: "Parse" },
  { key: "review-matches", label: "Match" },
  { key: "configuring-packet", label: "Configure" },
  { key: "assembling", label: "Assemble" },
  { key: "complete", label: "Done" },
];

function StepIndicator({ current }) {
  const currentIdx = STEPS_DISPLAY.findIndex(s =>
    s.key === current || (current === "matching-documents" && s.key === "review-matches")
    || (current === "idle" && s.key === "selecting-folder")
    || (current === "error") // keep last position
  );

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
      {STEPS_DISPLAY.map((step, i) => {
        const isActive = i === currentIdx;
        const isPast = i < currentIdx;
        return (
          <div key={step.key} style={{ display: "flex", alignItems: "center", gap: 2 }}>
            <div style={{
              width: 7, height: 7, borderRadius: "50%",
              background: isActive ? C.accent : isPast ? C.green : C.txt3,
              transition: "all 0.3s",
            }} />
            {i < STEPS_DISPLAY.length - 1 && (
              <div style={{
                width: 16, height: 1,
                background: isPast ? C.green : C.txt3,
              }} />
            )}
          </div>
        );
      })}
    </div>
  );
}


// ═══════════════════════════════════════════════════════════
// STEP: IDLE (folder selection)
// ═══════════════════════════════════════════════════════════

function StepIdle({ hook }) {
  const [folderId, setFolderId] = useState("");
  const [folderName, setFolderName] = useState("");

  return (
    <div style={{ maxWidth: 520, margin: "60px auto", textAlign: "center" }}>
      <div style={{ fontSize: 48, marginBottom: 16 }}>📁</div>
      <h2 style={{ fontSize: 22, fontWeight: 700, marginBottom: 8 }}>
        Select a Case Folder
      </h2>
      <p style={{ color: C.txt2, fontSize: 14, marginBottom: 32, lineHeight: 1.6 }}>
        Choose the folder that contains your cover letter and all supporting
        documents. The assembler will scan it, find exhibits referenced in the
        cover letter, match them to files, and build the complete packet.
      </p>
      <div style={{ ...card, textAlign: "left" }}>
        <label style={{ fontSize: 12, fontWeight: 600, color: C.txt2, display: "block", marginBottom: 6 }}>
          Folder ID
        </label>
        <input value={folderId} onChange={e => setFolderId(e.target.value)}
          placeholder="Enter folder ID or browse..."
          style={{
            width: "100%", padding: "10px 14px", borderRadius: 7,
            border: `1px solid ${C.border}`, background: C.bg, color: C.txt1,
            fontSize: 13, outline: "none", boxSizing: "border-box",
          }} />
        <label style={{ fontSize: 12, fontWeight: 600, color: C.txt2, display: "block", marginBottom: 6, marginTop: 14 }}>
          Folder Name (for display)
        </label>
        <input value={folderName} onChange={e => setFolderName(e.target.value)}
          placeholder="e.g., Smith I-140 Petition"
          style={{
            width: "100%", padding: "10px 14px", borderRadius: 7,
            border: `1px solid ${C.border}`, background: C.bg, color: C.txt1,
            fontSize: 13, outline: "none", boxSizing: "border-box",
          }} />
        <button onClick={() => hook.selectFolder(folderId, folderName || folderId)}
          disabled={!folderId.trim()}
          style={{
            ...btn(), width: "100%", justifyContent: "center", marginTop: 18,
            opacity: folderId.trim() ? 1 : 0.4,
          }}>
          <Icon d={Icons.search} size={14} color="#fff" /> Scan Folder
        </button>
      </div>
    </div>
  );
}


// ═══════════════════════════════════════════════════════════
// STEP: COVER LETTER DETECTION
// ═══════════════════════════════════════════════════════════

function StepCoverLetter({ hook }) {
  const { coverLetterCandidates, state } = hook;

  return (
    <div style={{ maxWidth: 620, margin: "40px auto" }}>
      <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 4 }}>
        Identify Cover Letter
      </h2>
      <p style={{ color: C.txt2, fontSize: 13, marginBottom: 20 }}>
        {coverLetterCandidates.length > 0
          ? "We found these potential cover letters. Select the correct one."
          : "No cover letter candidates detected. Please select a file manually."}
      </p>

      {coverLetterCandidates.map(({ file, confidence, reason }) => {
        const isSelected = state.coverLetterFileId === file.id;
        return (
          <div key={file.id}
            onClick={() => hook.selectCoverLetter(file.id, file.name)}
            style={{
              ...card, marginBottom: 8, cursor: "pointer",
              borderColor: isSelected ? C.accent : C.border,
              background: isSelected ? C.accentDim : C.surface,
              display: "flex", alignItems: "center", gap: 14,
            }}>
            <div style={{
              width: 20, height: 20, borderRadius: "50%", flexShrink: 0,
              border: `2px solid ${isSelected ? C.accent : C.txt3}`,
              background: isSelected ? C.accent : "transparent",
              display: "flex", alignItems: "center", justifyContent: "center",
            }}>
              {isSelected && <Icon d={Icons.check} size={10} color="#fff" />}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 600, overflow: "hidden",
                textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {file.name}
              </div>
              <div style={{ fontSize: 11, color: C.txt2, marginTop: 2 }}>{reason}</div>
            </div>
            <ConfidenceBadge value={confidence} />
          </div>
        );
      })}

      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 20, gap: 10 }}>
        <button onClick={hook.goBack} style={btn(C.txt3, true)}>Back</button>
        <button onClick={hook.confirmCoverLetter}
          disabled={!state.coverLetterFileId}
          style={{ ...btn(), opacity: state.coverLetterFileId ? 1 : 0.4 }}>
          Parse Cover Letter <Icon d={Icons.arrow} size={14} color="#fff" />
        </button>
      </div>
    </div>
  );
}


// ═══════════════════════════════════════════════════════════
// STEP: PARSING (loading state + results preview)
// ═══════════════════════════════════════════════════════════

function StepParsing({ hook }) {
  const { parseResult } = hook.state;
  if (!parseResult) {
    return <LoadingState message="Parsing cover letter..." sub="Extracting text and detecting exhibit declarations" />;
  }

  return (
    <div style={{ maxWidth: 700, margin: "40px auto" }}>
      <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 4 }}>
        Parse Results
      </h2>
      <p style={{ color: C.txt2, fontSize: 13, marginBottom: 16 }}>
        Found {parseResult.exhibits.length} exhibit{parseResult.exhibits.length !== 1 ? "s" : ""} in {parseResult.totalPages} page{parseResult.totalPages !== 1 ? "s" : ""}.
        {parseResult.metadata.caseType && ` Case type: ${parseResult.metadata.caseType}.`}
      </p>

      {/* Warnings */}
      {parseResult.warnings.filter(w => w.severity !== "info").length > 0 && (
        <div style={{ ...card, marginBottom: 16, borderColor: C.yellow, background: C.yellowDim }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: C.yellow, marginBottom: 8 }}>
            ⚠ Warnings
          </div>
          {parseResult.warnings.filter(w => w.severity !== "info").map((w, i) => (
            <div key={i} style={{ fontSize: 12, color: C.txt2, marginBottom: 4 }}>
              • {w.message}
            </div>
          ))}
        </div>
      )}

      {/* Exhibit list */}
      {parseResult.exhibits.map((ex, i) => (
        <div key={i} style={{ ...card, marginBottom: 6, padding: 14 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{
              ...badge(C.accentDim, C.accent),
              fontSize: 12, fontWeight: 700, minWidth: 70, textAlign: "center",
            }}>
              {ex.label.raw}
            </span>
            <span style={{ fontSize: 13, color: C.txt1, flex: 1 }}>{ex.description || "(no description)"}</span>
          </div>
          {ex.subItems.length > 0 && (
            <div style={{ marginTop: 6, paddingLeft: 80 }}>
              {ex.subItems.map((sub, j) => (
                <div key={j} style={{ fontSize: 11, color: C.txt2, marginBottom: 2 }}>
                  — {sub}
                </div>
              ))}
            </div>
          )}
        </div>
      ))}

      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 20, gap: 10 }}>
        <button onClick={hook.reParse} style={btn(C.txt3, true)}>
          <Icon d={Icons.refresh} size={14} /> Re-parse
        </button>
        <button onClick={() => hook.reMatch()} style={btn()}>
          Match Documents <Icon d={Icons.arrow} size={14} color="#fff" />
        </button>
      </div>
    </div>
  );
}


// ═══════════════════════════════════════════════════════════
// STEP: MATCHING (loading)
// ═══════════════════════════════════════════════════════════

function StepMatching() {
  return <LoadingState message="Matching exhibits to documents..." sub="Scanning filenames, folder structure, and known immigration patterns" />;
}


// ═══════════════════════════════════════════════════════════
// STEP: REVIEW MATCHES (the big interactive one)
// ═══════════════════════════════════════════════════════════

function StepReview({ hook }) {
  const { state, stats } = hook;
  const [expandedExhibit, setExpanded] = useState(null);
  const [showUnmatched, setShowUnmatched] = useState(false);
  const unmatchedFiles = hook.getUnmatchedFiles();

  return (
    <div style={{ maxWidth: 900, margin: "0 auto" }}>
      {/* Summary bar */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        marginBottom: 20, flexWrap: "wrap", gap: 12,
      }}>
        <div>
          <h2 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>Review Matches</h2>
          <p style={{ color: C.txt2, fontSize: 13, margin: "4px 0 0" }}>
            Verify that each exhibit is matched to the correct documents. Drag files to reorder, or assign missing ones.
          </p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span style={badge(C.greenDim, C.green)}>{stats.matchedExhibits} matched</span>
          {stats.partialExhibits > 0 && <span style={badge(C.yellowDim, C.yellow)}>{stats.partialExhibits} partial</span>}
          {stats.unmatchedExhibits > 0 && <span style={badge(C.redDim, C.red)}>{stats.unmatchedExhibits} unmatched</span>}
        </div>
      </div>

      {/* Exhibit cards */}
      {state.matches.map((match) => {
        const isExpanded = expandedExhibit === match.exhibitLabel.normalized;
        const statusColor = match.status === "matched" || match.status === "confirmed"
          ? C.green : match.status === "partial" ? C.yellow : C.red;

        return (
          <div key={match.exhibitLabel.normalized} style={{ ...card, marginBottom: 10, padding: 0, overflow: "hidden" }}>
            {/* Header */}
            <div
              onClick={() => setExpanded(isExpanded ? null : match.exhibitLabel.normalized)}
              style={{
                display: "flex", alignItems: "center", gap: 12, padding: "12px 18px",
                cursor: "pointer", borderBottom: isExpanded ? `1px solid ${C.border}` : "none",
              }}>
              <span style={{
                ...badge(C.accentDim, C.accent), fontSize: 12, fontWeight: 700,
                minWidth: 75, textAlign: "center",
              }}>
                {match.exhibitLabel.raw}
              </span>

              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 500 }}>
                  {state.parseResult?.exhibits.find(
                    e => e.label.normalized === match.exhibitLabel.normalized
                  )?.description || "—"}
                </div>
              </div>

              <span style={{ fontSize: 12, color: C.txt2 }}>
                {match.matchedFiles.length} file{match.matchedFiles.length !== 1 ? "s" : ""}
              </span>
              <div style={{ width: 8, height: 8, borderRadius: "50%", background: statusColor }} />

              {match.status === "confirmed" && (
                <span style={{ fontSize: 11, color: C.green, fontWeight: 600 }}>✓ Confirmed</span>
              )}

              <span style={{ color: C.txt3, transform: isExpanded ? "rotate(90deg)" : "none", transition: "transform 0.15s" }}>▶</span>
            </div>

            {/* Expanded: file list */}
            {isExpanded && (
              <div style={{ padding: "12px 18px" }}>
                {match.matchedFiles.length === 0 && (
                  <div style={{ fontSize: 12, color: C.red, padding: "12px 0" }}>
                    No matching documents found. Use the "Assign" button to manually add files.
                  </div>
                )}

                {[...match.matchedFiles].sort((a, b) => a.sortOrder - b.sortOrder).map((mf) => (
                  <div key={mf.fileId} style={{
                    display: "flex", alignItems: "center", gap: 10, padding: "8px 12px",
                    borderRadius: 6, marginBottom: 4, background: C.surface2,
                  }}>
                    <span style={{ color: C.txt3, cursor: "grab" }}>⠿</span>
                    <Icon d={Icons.file} size={14} color={C.txt2} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12, fontWeight: 500, overflow: "hidden",
                        textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {mf.fileName}
                      </div>
                      <div style={{ fontSize: 10, color: C.txt3, marginTop: 1 }}>
                        {mf.matchReason.map(r => r.detail).join(" · ")}
                      </div>
                    </div>
                    <ConfidenceBadge value={mf.confidence} />
                    <button
                      onClick={(e) => { e.stopPropagation(); hook.removeFile(match.exhibitLabel.normalized, mf.fileId); }}
                      style={{ ...btn(C.red, true), padding: "3px 8px", fontSize: 10 }}>
                      Remove
                    </button>
                  </div>
                ))}

                {/* Unmatched sub-items */}
                {match.unmatchedDescriptions.length > 0 && (
                  <div style={{
                    marginTop: 8, padding: "8px 12px", borderRadius: 6,
                    background: C.yellowDim, fontSize: 12, color: C.yellow,
                  }}>
                    Missing: {match.unmatchedDescriptions.join("; ")}
                  </div>
                )}

                {/* Actions */}
                <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                  {match.status !== "confirmed" && (
                    <button onClick={() => hook.confirmExhibit(match.exhibitLabel.normalized)}
                      style={{ ...btn(C.green), padding: "5px 14px", fontSize: 11 }}>
                      <Icon d={Icons.check} size={12} color="#fff" /> Confirm
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        );
      })}

      {/* Unmatched files drawer */}
      {unmatchedFiles.length > 0 && (
        <div style={{ ...card, marginTop: 20 }}>
          <div onClick={() => setShowUnmatched(!showUnmatched)}
            style={{ display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer" }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>
              Unassigned Files ({unmatchedFiles.length})
            </span>
            <span style={{ color: C.txt3 }}>{showUnmatched ? "▼" : "▶"}</span>
          </div>
          {showUnmatched && (
            <div style={{ marginTop: 12 }}>
              <p style={{ fontSize: 11, color: C.txt2, marginBottom: 10 }}>
                These files in the folder aren't matched to any exhibit. You can drag them to an exhibit above.
              </p>
              {unmatchedFiles.map(f => (
                <div key={f.id} style={{
                  display: "flex", alignItems: "center", gap: 10, padding: "6px 10px",
                  borderRadius: 5, marginBottom: 3, background: C.surface2, fontSize: 12,
                }}>
                  <Icon d={Icons.file} size={13} color={C.txt3} />
                  <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {f.name}
                  </span>
                  <span style={{ color: C.txt3, fontSize: 11 }}>{f.sizeFormatted}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Bottom actions */}
      <div style={{
        display: "flex", justifyContent: "space-between", alignItems: "center",
        marginTop: 24, paddingTop: 16, borderTop: `1px solid ${C.border}`,
      }}>
        <button onClick={hook.reMatch} style={btn(C.txt3, true)}>
          <Icon d={Icons.refresh} size={14} /> Re-match
        </button>
        <div style={{ display: "flex", gap: 10 }}>
          <button onClick={hook.confirmAllExhibits} style={btn(C.green, true)}>
            Confirm All
          </button>
          <button onClick={() => hook.goToStep("configuring-packet")}
            style={{ ...btn(), opacity: stats.readyToAssemble || stats.confirmedExhibits > 0 ? 1 : 0.4 }}>
            Configure Packet <Icon d={Icons.arrow} size={14} color="#fff" />
          </button>
        </div>
      </div>
    </div>
  );
}


// ═══════════════════════════════════════════════════════════
// STEP: CONFIGURE PACKET
// ═══════════════════════════════════════════════════════════

function StepConfig({ hook }) {
  const { packetConfig } = hook.state;
  const upd = hook.updateConfig;

  const Toggle = ({ label, value, onChange }) => (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 0", borderBottom: `1px solid ${C.border}22` }}>
      <span style={{ fontSize: 13 }}>{label}</span>
      <div onClick={() => onChange(!value)} style={{
        width: 40, height: 22, borderRadius: 11, cursor: "pointer",
        background: value ? C.accent : C.txt3, padding: 2, transition: "background 0.2s",
      }}>
        <div style={{
          width: 18, height: 18, borderRadius: 9, background: "#fff",
          transform: value ? "translateX(18px)" : "translateX(0)", transition: "transform 0.2s",
        }} />
      </div>
    </div>
  );

  return (
    <div style={{ maxWidth: 560, margin: "40px auto" }}>
      <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 4 }}>Packet Settings</h2>
      <p style={{ color: C.txt2, fontSize: 13, marginBottom: 20 }}>
        Configure how the final PDF packet is assembled.
      </p>

      <div style={card}>
        <Toggle label="Include cover page" value={packetConfig.includeCoverPage}
          onChange={v => upd({ includeCoverPage: v })} />
        <Toggle label="Include table of contents" value={packetConfig.includeTableOfContents}
          onChange={v => upd({ includeTableOfContents: v })} />
        <Toggle label="Exhibit separator pages" value={packetConfig.includeExhibitSeparators}
          onChange={v => upd({ includeExhibitSeparators: v })} />
        <Toggle label="Stamp exhibit labels on documents" value={packetConfig.stampExhibitLabels}
          onChange={v => upd({ stampExhibitLabels: v })} />
        <Toggle label="Page numbering" value={packetConfig.pageNumbering.enabled}
          onChange={v => upd({ pageNumbering: { ...packetConfig.pageNumbering, enabled: v } })} />

        {/* Separator style */}
        {packetConfig.includeExhibitSeparators && (
          <div style={{ padding: "12px 0" }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: C.txt2, marginBottom: 8 }}>Separator Style</div>
            <div style={{ display: "flex", gap: 8 }}>
              {(["full-page", "half-page", "tab-style"]).map(style => (
                <button key={style}
                  onClick={() => upd({ separatorStyle: style })}
                  style={{
                    ...btn(packetConfig.separatorStyle === style ? C.accent : C.txt3, packetConfig.separatorStyle !== style),
                    padding: "5px 14px", fontSize: 11, textTransform: "capitalize",
                  }}>
                  {style.replace("-", " ")}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Output filename */}
        <div style={{ padding: "12px 0" }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: C.txt2, marginBottom: 6 }}>Output Filename</div>
          <input value={packetConfig.outputFileName}
            onChange={e => upd({ outputFileName: e.target.value })}
            style={{
              width: "100%", padding: "8px 12px", borderRadius: 6,
              border: `1px solid ${C.border}`, background: C.bg, color: C.txt1,
              fontSize: 13, outline: "none", boxSizing: "border-box",
            }} />
        </div>
      </div>

      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 20, gap: 10 }}>
        <button onClick={hook.goBack} style={btn(C.txt3, true)}>Back</button>
        <button onClick={hook.startAssembly} style={btn()}>
          Assemble Packet <Icon d={Icons.arrow} size={14} color="#fff" />
        </button>
      </div>
    </div>
  );
}


// ═══════════════════════════════════════════════════════════
// STEP: ASSEMBLING (progress)
// ═══════════════════════════════════════════════════════════

function StepAssembling({ hook }) {
  const { progress } = hook.state;

  const phaseLabels = {
    idle: "Preparing…",
    downloading: "Downloading files…",
    converting: "Converting to PDF…",
    merging: "Merging documents…",
    numbering: "Adding page numbers…",
    finalizing: "Finalizing packet…",
  };

  return (
    <div style={{ maxWidth: 480, margin: "80px auto", textAlign: "center" }}>
      <div style={{ marginBottom: 24 }}>
        <Spinner />
      </div>
      <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>Assembling Packet</h2>
      <p style={{ color: C.txt2, fontSize: 13, marginBottom: 24 }}>
        {phaseLabels[progress.phase] || "Working…"}
      </p>

      {/* Progress bar */}
      <div style={{
        width: "100%", height: 6, borderRadius: 3, background: C.surface2, overflow: "hidden",
      }}>
        <div style={{
          width: `${progress.percent}%`, height: "100%", borderRadius: 3,
          background: C.accent, transition: "width 0.3s ease-out",
        }} />
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8, fontSize: 12, color: C.txt2 }}>
        <span>{progress.percent}%</span>
        <span>
          {progress.filesProcessed}/{progress.filesTotal} files
          {progress.estimatedSecondsRemaining != null && ` · ~${progress.estimatedSecondsRemaining}s remaining`}
        </span>
      </div>

      {/* Current file */}
      {progress.currentFile && (
        <div style={{ marginTop: 16, fontSize: 12, color: C.txt3 }}>
          {progress.currentExhibit && <span style={{ color: C.accent }}>{progress.currentExhibit} → </span>}
          {progress.currentFile}
        </div>
      )}

      <button onClick={hook.cancelAssembly}
        style={{ ...btn(C.red, true), marginTop: 32 }}>
        Cancel
      </button>
    </div>
  );
}


// ═══════════════════════════════════════════════════════════
// STEP: COMPLETE
// ═══════════════════════════════════════════════════════════

function StepComplete({ hook }) {
  const packet = hook.state.assembledPacket;
  if (!packet) return null;

  const sizeStr = packet.outputFileSize > 1024 * 1024
    ? `${(packet.outputFileSize / 1024 / 1024).toFixed(1)} MB`
    : `${Math.round(packet.outputFileSize / 1024)} KB`;

  return (
    <div style={{ maxWidth: 560, margin: "60px auto", textAlign: "center" }}>
      <div style={{ fontSize: 52, marginBottom: 12 }}>{packet.success ? "✅" : "⚠️"}</div>
      <h2 style={{ fontSize: 22, fontWeight: 700, marginBottom: 6 }}>
        {packet.success ? "Packet Assembled" : "Assembled with Errors"}
      </h2>
      <p style={{ color: C.txt2, fontSize: 14, marginBottom: 28 }}>
        {packet.totalPages} pages · {sizeStr} · {(packet.assemblyDurationMs / 1000).toFixed(1)}s
      </p>

      {/* Error list */}
      {packet.errors.length > 0 && (
        <div style={{ ...card, textAlign: "left", marginBottom: 20, borderColor: C.red, background: C.redDim }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: C.red, marginBottom: 8 }}>
            {packet.errors.length} error{packet.errors.length > 1 ? "s" : ""} during assembly
          </div>
          {packet.errors.map((err, i) => (
            <div key={i} style={{ fontSize: 12, color: C.txt2, marginBottom: 4 }}>
              • [{err.code}] {err.message}
            </div>
          ))}
        </div>
      )}

      {/* Section breakdown */}
      <div style={{ ...card, textAlign: "left", marginBottom: 20 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: C.txt2, marginBottom: 10 }}>Packet Contents</div>
        {packet.sections.map((sec, i) => (
          <div key={i} style={{
            display: "flex", justifyContent: "space-between", padding: "5px 0",
            paddingLeft: sec.type === "exhibit-document" ? 20 : 0,
            fontSize: 12, color: sec.type === "exhibit-separator" ? C.accent : C.txt1,
            fontWeight: sec.type === "exhibit-separator" ? 600 : 400,
          }}>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, marginRight: 12 }}>
              {sec.label}
            </span>
            <span style={{ color: C.txt3, flexShrink: 0 }}>
              p. {sec.startPage}{sec.endPage !== sec.startPage ? `–${sec.endPage}` : ""}
            </span>
          </div>
        ))}
      </div>

      {/* Actions */}
      <div style={{ display: "flex", justifyContent: "center", gap: 12 }}>
        <button onClick={hook.downloadPacket} style={btn()}>
          <Icon d={Icons.download} size={14} color="#fff" /> Download Packet
        </button>
        <button onClick={hook.assembleAnother} style={btn(C.txt3, true)}>
          Assemble Another
        </button>
      </div>
    </div>
  );
}


// ═══════════════════════════════════════════════════════════
// STEP: ERROR
// ═══════════════════════════════════════════════════════════

function StepError({ hook }) {
  const { error } = hook.state;
  if (!error) return null;

  return (
    <div style={{ maxWidth: 480, margin: "80px auto", textAlign: "center" }}>
      <div style={{ fontSize: 48, marginBottom: 12 }}>❌</div>
      <h2 style={{ fontSize: 18, fontWeight: 700, color: C.red, marginBottom: 8 }}>
        {error.message}
      </h2>
      {error.details && (
        <p style={{ color: C.txt2, fontSize: 13, marginBottom: 24 }}>{error.details}</p>
      )}
      <div style={{ display: "flex", justifyContent: "center", gap: 12 }}>
        {error.retryable && (
          <button onClick={hook.goBack} style={btn()}>
            <Icon d={Icons.back} size={14} color="#fff" /> Go Back & Retry
          </button>
        )}
        <button onClick={hook.reset} style={btn(C.txt3, true)}>Start Over</button>
      </div>
    </div>
  );
}


// ═══════════════════════════════════════════════════════════
// SHARED SUB-COMPONENTS
// ═══════════════════════════════════════════════════════════

function ConfidenceBadge({ value }) {
  const pct = Math.round(value * 100);
  const color = pct >= 70 ? C.green : pct >= 40 ? C.yellow : C.red;
  const bg = pct >= 70 ? C.greenDim : pct >= 40 ? C.yellowDim : C.redDim;
  return <span style={badge(bg, color)}>{pct}%</span>;
}

function LoadingState({ message, sub }) {
  return (
    <div style={{ maxWidth: 400, margin: "100px auto", textAlign: "center" }}>
      <Spinner />
      <h3 style={{ fontSize: 16, fontWeight: 600, marginTop: 20, marginBottom: 6 }}>{message}</h3>
      {sub && <p style={{ color: C.txt2, fontSize: 13 }}>{sub}</p>}
    </div>
  );
}

function Spinner() {
  return (
    <div style={{ display: "inline-block" }}>
      <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke={C.accent} strokeWidth="2">
        <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83">
          <animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="1s" repeatCount="indefinite" />
        </path>
      </svg>
    </div>
  );
}
