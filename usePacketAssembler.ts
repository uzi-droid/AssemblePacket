// ═══════════════════════════════════════════════════════════════
// usePacketAssembler.ts — React hook that orchestrates the full
// packet assembly workflow: folder selection → cover letter
// detection → parsing → matching → user review → assembly.
//
// Manages multi-step wizard state, progress, undo, error
// recovery, and all user interactions (confirm, override, reorder).
// ═══════════════════════════════════════════════════════════════

import { useState, useCallback, useRef, useEffect } from "react";
import type {
  WorkflowState, WorkflowStep, WorkflowError,
  AssemblyProgress, PacketConfig, DocumentMatch,
  CoverLetterParseResult, ParsedExhibit, StorageFile,
  MatchedFile, MatchStatus, DEFAULT_PACKET_CONFIG,
} from "./types";
import { DEFAULT_PACKET_CONFIG as DEFAULT_CONFIG } from "./types";
import * as storageApi from "./fileStorageApi";
import { parseCoverLetter } from "./coverLetterParser";
import {
  matchExhibitsToFiles,
  manuallyAssignFile,
  removeFileFromExhibit,
  confirmExhibitMatches,
  reorderExhibitFiles,
} from "./exhibitMatcher";
import { assemblePacket } from "./packetAssembler";


// ── Initial state ──
const INITIAL_PROGRESS: AssemblyProgress = {
  phase: "idle",
  currentExhibit: null,
  currentFile: null,
  filesProcessed: 0,
  filesTotal: 0,
  percent: 0,
  bytesProcessed: 0,
  estimatedSecondsRemaining: null,
};

function createInitialState(): WorkflowState {
  return {
    step: "idle",
    folderId: null,
    folderName: null,
    coverLetterFileId: null,
    coverLetterFileName: null,
    parseResult: null,
    matches: [],
    packetConfig: { ...DEFAULT_CONFIG },
    assembledPacket: null,
    progress: { ...INITIAL_PROGRESS },
    error: null,
    history: [],
  };
}


// ── Return type ──
export interface UsePacketAssemblerReturn {
  // State
  state: WorkflowState;

  // Navigation
  goToStep: (step: WorkflowStep) => void;
  goBack: () => void;
  reset: () => void;
  canGoBack: boolean;

  // Step 1: Folder selection
  selectFolder: (folderId: string, folderName: string) => Promise<void>;

  // Step 2: Cover letter detection + override
  coverLetterCandidates: Array<{ file: StorageFile; confidence: number; reason: string }>;
  selectCoverLetter: (fileId: string, fileName: string) => void;
  confirmCoverLetter: () => Promise<void>;

  // Step 3: Parsing (automatic, but can be retriggered)
  reParse: () => Promise<void>;

  // Step 4: Matching (automatic after parse)
  reMatch: () => Promise<void>;
  matchingOptions: {
    recursive: boolean;
    enableContentMatching: boolean;
    setRecursive: (v: boolean) => void;
    setEnableContentMatching: (v: boolean) => void;
  };

  // Step 5: Review matches — user can adjust
  assignFile: (exhibitNormalized: string, file: StorageFile, sortOrder: number) => void;
  removeFile: (exhibitNormalized: string, fileId: string) => void;
  confirmExhibit: (exhibitNormalized: string) => void;
  confirmAllExhibits: () => void;
  reorderFiles: (exhibitNormalized: string, orderedFileIds: string[]) => void;
  allFilesInFolder: StorageFile[];
  getUnmatchedFiles: () => StorageFile[];

  // Step 6: Configure packet
  updateConfig: (patch: Partial<PacketConfig>) => void;

  // Step 7: Assemble
  startAssembly: () => Promise<void>;
  cancelAssembly: () => void;

  // Step 8: Complete
  downloadPacket: () => Promise<void>;
  assembleAnother: () => void;

  // Summary stats
  stats: {
    totalExhibits: number;
    matchedExhibits: number;
    partialExhibits: number;
    unmatchedExhibits: number;
    confirmedExhibits: number;
    totalFiles: number;
    estimatedPages: number;
    readyToAssemble: boolean;
  };
}


export function usePacketAssembler(): UsePacketAssemblerReturn {
  const [state, setState] = useState<WorkflowState>(createInitialState);
  const [coverLetterCandidates, setCandidates] = useState
    Array<{ file: StorageFile; confidence: number; reason: string }>
  >([]);
  const [allFilesInFolder, setAllFiles] = useState<StorageFile[]>([]);
  const [matchRecursive, setMatchRecursive] = useState(true);
  const [matchContent, setMatchContent] = useState(false);
  const assemblyAbort = useRef<AbortController | null>(null);
  const progressTimer = useRef<ReturnType<typeof setInterval>>();

  // ── Helpers ──
  const update = useCallback((patch: Partial<WorkflowState>) => {
    setState(prev => ({ ...prev, ...patch }));
  }, []);

  const setStep = useCallback((step: WorkflowStep) => {
    setState(prev => ({
      ...prev,
      step,
      history: [...prev.history, prev.step],
      error: null,
    }));
  }, []);

  const setError = useCallback((step: WorkflowStep, message: string, details?: string, retryable = true) => {
    const error: WorkflowError = {
      step,
      message,
      details: details || null,
      retryable,
      timestamp: new Date().toISOString(),
    };
    setState(prev => ({ ...prev, step: "error", error, history: [...prev.history, prev.step] }));
  }, []);


  // ═══════════════════════════════════════════
  // NAVIGATION
  // ═══════════════════════════════════════════

  const goToStep = useCallback((step: WorkflowStep) => {
    setStep(step);
  }, [setStep]);

  const goBack = useCallback(() => {
    setState(prev => {
      if (prev.history.length === 0) return prev;
      const history = [...prev.history];
      const previousStep = history.pop()!;
      return { ...prev, step: previousStep, history, error: null };
    });
  }, []);

  const canGoBack = state.history.length > 0 && state.step !== "assembling";

  const reset = useCallback(() => {
    assemblyAbort.current?.abort();
    clearInterval(progressTimer.current);
    setState(createInitialState());
    setCandidates([]);
    setAllFiles([]);
  }, []);


  // ═══════════════════════════════════════════
  // STEP 1: FOLDER SELECTION
  // ═══════════════════════════════════════════

  const selectFolder = useCallback(async (folderId: string, folderName: string) => {
    update({ folderId, folderName });
    setStep("detecting-cover-letter");

    try {
      // Detect cover letter candidates
      const { candidates } = await storageApi.detectCoverLetter(folderId);
      setCandidates(candidates);

      // Also load all files for later matching/review
      const files = await storageApi.listFilesRecursive(folderId);
      setAllFiles(files);

      if (candidates.length === 0) {
        setError(
          "detecting-cover-letter",
          "No cover letter found",
          "Could not identify a cover letter in this folder. Please select one manually.",
          false
        );
        return;
      }

      // Auto-select the best candidate if high confidence
      if (candidates[0].confidence >= 0.8) {
        update({
          coverLetterFileId: candidates[0].file.id,
          coverLetterFileName: candidates[0].file.name,
        });
      }

      setStep("detecting-cover-letter");
    } catch (err: any) {
      setError("detecting-cover-letter", "Failed to scan folder", err.message);
    }
  }, [update, setStep, setError]);


  // ═══════════════════════════════════════════
  // STEP 2: COVER LETTER SELECTION + CONFIRM
  // ═══════════════════════════════════════════

  const selectCoverLetter = useCallback((fileId: string, fileName: string) => {
    update({ coverLetterFileId: fileId, coverLetterFileName: fileName });
  }, [update]);

  const confirmCoverLetter = useCallback(async () => {
    if (!state.coverLetterFileId || !state.coverLetterFileName) {
      setError("detecting-cover-letter", "Please select a cover letter first");
      return;
    }

    setStep("parsing-cover-letter");

    try {
      const result = await parseCoverLetter(
        state.coverLetterFileId,
        state.coverLetterFileName
      );

      update({ parseResult: result });

      if (!result.success) {
        const mainError = result.warnings.find(w => w.severity === "error");
        setError(
          "parsing-cover-letter",
          mainError?.message || "Failed to parse cover letter",
          `Found ${result.warnings.length} warning(s). The document may not contain exhibit references.`,
          true
        );
        return;
      }

      if (result.exhibits.length === 0) {
        setError(
          "parsing-cover-letter",
          "No exhibits found in cover letter",
          "The parser could not identify any exhibit declarations (Exhibit A, Tab 1, etc.).",
          true
        );
        return;
      }

      // Auto-proceed to matching
      setStep("matching-documents");
      await runMatching(result);
    } catch (err: any) {
      setError("parsing-cover-letter", "Parsing failed", err.message);
    }
  }, [state.coverLetterFileId, state.coverLetterFileName, update, setStep, setError]);

  // ── Matching (called after parse, or manually) ──
  const runMatching = useCallback(async (parseResult?: CoverLetterParseResult) => {
    const pr = parseResult || state.parseResult;
    if (!pr || !state.folderId || !state.coverLetterFileId) return;

    setStep("matching-documents");

    try {
      const matches = await matchExhibitsToFiles(
        pr.exhibits,
        state.folderId,
        {
          recursive: matchRecursive,
          enableContentMatching: matchContent,
          excludeFileIds: [state.coverLetterFileId],
        }
      );

      update({ matches });
      setStep("review-matches");
    } catch (err: any) {
      setError("matching-documents", "Matching failed", err.message);
    }
  }, [state.parseResult, state.folderId, state.coverLetterFileId, matchRecursive, matchContent, update, setStep, setError]);

  const reParse = useCallback(async () => {
    if (!state.coverLetterFileId || !state.coverLetterFileName) return;
    setStep("parsing-cover-letter");

    try {
      const result = await parseCoverLetter(
        state.coverLetterFileId,
        state.coverLetterFileName
      );
      update({ parseResult: result, matches: [] });

      if (result.success && result.exhibits.length > 0) {
        await runMatching(result);
      } else {
        setStep("parsing-cover-letter");
      }
    } catch (err: any) {
      setError("parsing-cover-letter", "Re-parse failed", err.message);
    }
  }, [state.coverLetterFileId, state.coverLetterFileName, update, setStep, setError, runMatching]);

  const reMatch = useCallback(async () => {
    await runMatching();
  }, [runMatching]);


  // ═══════════════════════════════════════════
  // STEP 5: REVIEW — User adjustments
  // ═══════════════════════════════════════════

  const assignFile = useCallback((exhibitNormalized: string, file: StorageFile, sortOrder: number) => {
    setState(prev => ({
      ...prev,
      matches: manuallyAssignFile(prev.matches, exhibitNormalized, file, sortOrder),
    }));
  }, []);

  const removeFile = useCallback((exhibitNormalized: string, fileId: string) => {
    setState(prev => ({
      ...prev,
      matches: removeFileFromExhibit(prev.matches, exhibitNormalized, fileId),
    }));
  }, []);

  const confirmExhibit = useCallback((exhibitNormalized: string) => {
    setState(prev => ({
      ...prev,
      matches: confirmExhibitMatches(prev.matches, exhibitNormalized),
    }));
  }, []);

  const confirmAllExhibits = useCallback(() => {
    setState(prev => {
      let matches = [...prev.matches];
      for (const match of matches) {
        matches = confirmExhibitMatches(matches, match.exhibitLabel.normalized);
      }
      return { ...prev, matches };
    });
  }, []);

  const reorderFiles = useCallback((exhibitNormalized: string, orderedFileIds: string[]) => {
    setState(prev => ({
      ...prev,
      matches: reorderExhibitFiles(prev.matches, exhibitNormalized, orderedFileIds),
    }));
  }, []);

  /**
   * Get all files in the folder that aren't matched to any exhibit.
   * Useful for the "unassigned files" panel in the UI.
   */
  const getUnmatchedFiles = useCallback((): StorageFile[] => {
    const matchedIds = new Set<string>();
    for (const match of state.matches) {
      for (const mf of match.matchedFiles) {
        matchedIds.add(mf.fileId);
      }
    }
    // Also exclude the cover letter
    if (state.coverLetterFileId) matchedIds.add(state.coverLetterFileId);

    return allFilesInFolder.filter(f => !matchedIds.has(f.id));
  }, [state.matches, state.coverLetterFileId, allFilesInFolder]);


  // ═══════════════════════════════════════════
  // STEP 6: CONFIGURE PACKET
  // ═══════════════════════════════════════════

  const updateConfig = useCallback((patch: Partial<PacketConfig>) => {
    setState(prev => ({
      ...prev,
      packetConfig: { ...prev.packetConfig, ...patch },
    }));
  }, []);


  // ═══════════════════════════════════════════
  // STEP 7: ASSEMBLY
  // ═══════════════════════════════════════════

  const startAssembly = useCallback(async () => {
    if (!state.coverLetterFileId || !state.folderId) {
      setError("assembling", "Missing cover letter or folder");
      return;
    }

    // Validate: at least one exhibit has matched files
    const validMatches = state.matches.filter(m => m.matchedFiles.length > 0);
    if (validMatches.length === 0) {
      setError("assembling", "No exhibits have matched documents. Please review and assign files.");
      return;
    }

    setStep("assembling");
    assemblyAbort.current = new AbortController();

    // Start elapsed time tracker
    const startTime = Date.now();
    progressTimer.current = setInterval(() => {
      setState(prev => {
        if (prev.step !== "assembling") return prev;
        const elapsed = (Date.now() - startTime) / 1000;
        const percent = prev.progress.percent || 1;
        const estimated = percent > 5
          ? Math.round((elapsed / percent) * (100 - percent))
          : null;
        return {
          ...prev,
          progress: { ...prev.progress, estimatedSecondsRemaining: estimated },
        };
      });
    }, 1000);

    try {
      const packet = await assemblePacket(
        state.coverLetterFileId,
        validMatches,
        state.packetConfig,
        state.folderId,
        (progress) => {
          // Abort check
          if (assemblyAbort.current?.signal.aborted) {
            throw new Error("Assembly cancelled by user");
          }
          update({ progress: { ...INITIAL_PROGRESS, ...progress } });
        }
      );

      clearInterval(progressTimer.current);
      update({
        assembledPacket: packet,
        progress: { ...INITIAL_PROGRESS, phase: "idle", percent: 100 },
      });
      setStep("complete");
    } catch (err: any) {
      clearInterval(progressTimer.current);
      if (err.message === "Assembly cancelled by user") {
        // User cancelled — go back to review
        update({ progress: { ...INITIAL_PROGRESS } });
        setStep("review-matches");
      } else {
        setError("assembling", "Assembly failed", err.message, true);
      }
    }
  }, [state.coverLetterFileId, state.folderId, state.matches, state.packetConfig, update, setStep, setError]);

  const cancelAssembly = useCallback(() => {
    assemblyAbort.current?.abort();
  }, []);


  // ═══════════════════════════════════════════
  // STEP 8: COMPLETE
  // ═══════════════════════════════════════════

  const downloadPacket = useCallback(async () => {
    if (!state.assembledPacket?.outputFileId) return;

    try {
      const { url } = await storageApi.getDownloadUrl([state.assembledPacket.outputFileId]);

      // Trigger browser download
      const link = document.createElement("a");
      link.href = url;
      link.download = state.assembledPacket.outputFileName;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } catch (err: any) {
      setError("complete", "Download failed", err.message, true);
    }
  }, [state.assembledPacket, setError]);

  const assembleAnother = useCallback(() => {
    // Keep folder selection but reset everything else
    const folderId = state.folderId;
    const folderName = state.folderName;
    setState({
      ...createInitialState(),
      folderId,
      folderName,
      step: "detecting-cover-letter",
    });
  }, [state.folderId, state.folderName]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      assemblyAbort.current?.abort();
      clearInterval(progressTimer.current);
    };
  }, []);


  // ═══════════════════════════════════════════
  // STATS — computed summary for UI
  // ═══════════════════════════════════════════

  const stats = (() => {
    const matches = state.matches;
    const totalExhibits = matches.length;
    const matchedExhibits = matches.filter(m => m.status === "matched" || m.status === "confirmed" || m.status === "manual-override").length;
    const partialExhibits = matches.filter(m => m.status === "partial").length;
    const unmatchedExhibits = matches.filter(m => m.status === "unmatched").length;
    const confirmedExhibits = matches.filter(m => m.status === "confirmed" || m.status === "manual-override").length;
    const totalFiles = matches.reduce((sum, m) => sum + m.matchedFiles.length, 0);

    // Rough page estimate: cover letter ~10 pages + ~3 pages per file average
    const estimatedPages = (state.parseResult?.totalPages || 10) +
      matches.length + // separator pages
      totalFiles * 3;  // rough average

    // Ready if every exhibit has at least one file OR user explicitly confirmed
    const readyToAssemble = totalExhibits > 0 && (
      unmatchedExhibits === 0 ||
      confirmedExhibits === totalExhibits
    );

    return {
      totalExhibits,
      matchedExhibits,
      partialExhibits,
      unmatchedExhibits,
      confirmedExhibits,
      totalFiles,
      estimatedPages,
      readyToAssemble,
    };
  })();


  return {
    state,
    goToStep, goBack, reset, canGoBack,
    selectFolder,
    coverLetterCandidates, selectCoverLetter, confirmCoverLetter,
    reParse,
    reMatch,
    matchingOptions: {
      recursive: matchRecursive,
      enableContentMatching: matchContent,
      setRecursive: setMatchRecursive,
      setEnableContentMatching: setMatchContent,
    },
    assignFile, removeFile, confirmExhibit, confirmAllExhibits, reorderFiles,
    allFilesInFolder, getUnmatchedFiles,
    updateConfig,
    startAssembly, cancelAssembly,
    downloadPacket, assembleAnother,
    stats,
  };
}
