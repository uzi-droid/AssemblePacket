// ═══════════════════════════════════════════════════════════════
// exhibitMatcher.ts — Takes parsed exhibits from the cover letter
// and searches the file storage to find the actual documents each
// exhibit refers to. Uses multi-signal matching: filename keywords,
// folder structure, known immigration patterns, file metadata,
// content extraction, and proximity scoring.
//
// Outputs a ranked list of matched files per exhibit with
// confidence scores, match reasons, and flags for manual review.
// ═══════════════════════════════════════════════════════════════

import type {
  ParsedExhibit, DocumentMatch, MatchedFile, MatchReason,
  MatchReasonType, MatchConfidence, MatchStatus,
  ExhibitLabel, StorageFile, KnownDocumentPattern,
} from "./types";
import * as storageApi from "./fileStorageApi";

// ═══════════════════════════════════════════════════════════
// KNOWN IMMIGRATION DOCUMENT PATTERNS
// These help the matcher recognize common docs even when
// filenames are cryptic (e.g., "scan_001.pdf").
// ═══════════════════════════════════════════════════════════

const KNOWN_PATTERNS: KnownDocumentPattern[] = [
  {
    category: "passport",
    keywords: ["passport", "travel document", "bio page", "biopage", "bio-data"],
    fileNamePatterns: [/passport/i, /bio.?page/i, /travel.?doc/i, /pp[_\s-]/i],
    commonExtensions: ["pdf", "jpg", "jpeg", "png"],
    aliases: ["passport copy", "valid passport", "unexpired passport"],
  },
  {
    category: "visa",
    keywords: ["visa", "visa stamp", "visa foil", "nonimmigrant visa", "immigrant visa"],
    fileNamePatterns: [/visa/i, /visa.?stamp/i, /visa.?foil/i],
    commonExtensions: ["pdf", "jpg", "jpeg", "png"],
    aliases: ["U.S. visa", "entry visa"],
  },
  {
    category: "i94",
    keywords: ["i-94", "i94", "arrival record", "arrival/departure", "admission record"],
    fileNamePatterns: [/i-?94/i, /arrival/i, /departure/i, /admission/i],
    commonExtensions: ["pdf", "jpg", "jpeg", "png"],
    aliases: ["I-94 record", "electronic I-94", "CBP I-94"],
  },
  {
    category: "ead",
    keywords: ["ead", "employment authorization", "work permit", "work card", "c09"],
    fileNamePatterns: [/ead/i, /employment.?auth/i, /work.?permit/i, /work.?card/i],
    commonExtensions: ["pdf", "jpg", "jpeg", "png"],
    aliases: ["EAD card", "employment authorization document"],
  },
  {
    category: "i140",
    keywords: ["i-140", "i140", "immigrant petition", "approval notice", "petition approval"],
    fileNamePatterns: [/i-?140/i, /immigrant.?petition/i],
    commonExtensions: ["pdf"],
    aliases: ["I-140 approval", "I-140 receipt"],
  },
  {
    category: "i130",
    keywords: ["i-130", "i130", "petition for alien relative", "relative petition"],
    fileNamePatterns: [/i-?130/i, /relative.?petition/i],
    commonExtensions: ["pdf"],
    aliases: ["I-130 approval", "I-130 receipt"],
  },
  {
    category: "i485",
    keywords: ["i-485", "i485", "adjustment of status", "AOS", "green card application"],
    fileNamePatterns: [/i-?485/i, /adjustment/i, /AOS/i],
    commonExtensions: ["pdf"],
    aliases: ["I-485 receipt", "AOS application"],
  },
  {
    category: "i20",
    keywords: ["i-20", "i20", "certificate of eligibility", "SEVIS"],
    fileNamePatterns: [/i-?20/i, /sevis/i, /eligibility/i],
    commonExtensions: ["pdf"],
    aliases: ["I-20 form", "SEVIS I-20"],
  },
  {
    category: "receipt_notice",
    keywords: ["receipt notice", "receipt", "i-797", "i797", "797c", "notice of action"],
    fileNamePatterns: [/receipt/i, /i-?797/i, /797[cC]/i, /notice.?of.?action/i, /NOA/i],
    commonExtensions: ["pdf"],
    aliases: ["I-797 receipt", "I-797C", "USCIS receipt"],
  },
  {
    category: "approval_notice",
    keywords: ["approval notice", "approval", "i-797", "797a", "notice of approval"],
    fileNamePatterns: [/approval/i, /797[aA]/i, /approved/i],
    commonExtensions: ["pdf"],
    aliases: ["I-797A", "approval letter"],
  },
  {
    category: "birth_certificate",
    keywords: ["birth certificate", "birth record", "certificate of birth"],
    fileNamePatterns: [/birth/i, /nacimiento/i, /naissance/i],
    commonExtensions: ["pdf", "jpg", "jpeg", "png"],
    aliases: ["birth cert", "BC"],
  },
  {
    category: "marriage_certificate",
    keywords: ["marriage certificate", "marriage record", "certificate of marriage", "marriage license"],
    fileNamePatterns: [/marriage/i, /matrimonio/i, /wedding/i],
    commonExtensions: ["pdf", "jpg", "jpeg", "png"],
    aliases: ["marriage cert", "MC"],
  },
  {
    category: "diploma",
    keywords: ["diploma", "degree", "bachelor", "master", "phd", "doctorate", "certificate of completion"],
    fileNamePatterns: [/diploma/i, /degree/i, /bachelor/i, /master/i, /phd/i, /B\.?S\.?/i, /M\.?S\.?/i],
    commonExtensions: ["pdf", "jpg", "jpeg", "png"],
    aliases: ["university degree", "academic degree"],
  },
  {
    category: "transcript",
    keywords: ["transcript", "academic record", "grade report", "marksheet", "mark sheet"],
    fileNamePatterns: [/transcript/i, /grades/i, /marksheet/i, /academic.?record/i],
    commonExtensions: ["pdf"],
    aliases: ["official transcript", "academic transcript"],
  },
  {
    category: "resume_cv",
    keywords: ["resume", "cv", "curriculum vitae", "professional background"],
    fileNamePatterns: [/resume/i, /\bcv\b/i, /curriculum/i],
    commonExtensions: ["pdf", "docx", "doc"],
    aliases: ["CV", "professional resume"],
  },
  {
    category: "tax_return",
    keywords: ["tax return", "1040", "w-2", "w2", "tax transcript", "irs"],
    fileNamePatterns: [/tax/i, /1040/i, /w-?2/i, /irs/i],
    commonExtensions: ["pdf"],
    aliases: ["IRS tax return", "federal tax return", "W-2"],
  },
  {
    category: "pay_stub",
    keywords: ["pay stub", "paystub", "pay slip", "payslip", "earnings statement"],
    fileNamePatterns: [/pay.?stub/i, /pay.?slip/i, /earnings/i],
    commonExtensions: ["pdf"],
    aliases: ["paycheck stub", "salary statement"],
  },
  {
    category: "employment_letter",
    keywords: ["employment letter", "employment verification", "offer letter", "experience letter"],
    fileNamePatterns: [/employ/i, /offer.?letter/i, /experience.?letter/i, /verification/i],
    commonExtensions: ["pdf", "docx"],
    aliases: ["job offer", "employment verification letter"],
  },
  {
    category: "labor_certification",
    keywords: ["labor certification", "perm", "eta 9089", "9089", "eta-9089", "labor condition"],
    fileNamePatterns: [/perm/i, /labor/i, /9089/i, /eta/i, /lca/i],
    commonExtensions: ["pdf"],
    aliases: ["PERM", "ETA Form 9089", "LCA"],
  },
  {
    category: "photo",
    keywords: ["photo", "photograph", "passport photo", "passport-style photo"],
    fileNamePatterns: [/photo/i, /headshot/i, /portrait/i, /pic/i],
    commonExtensions: ["jpg", "jpeg", "png"],
    aliases: ["passport photo", "2x2 photo"],
  },
  {
    category: "translation",
    keywords: ["translation", "certified translation", "english translation"],
    fileNamePatterns: [/translat/i, /english.?vers/i],
    commonExtensions: ["pdf", "docx"],
    aliases: ["certified translation", "translated document"],
  },
  {
    category: "support_letter",
    keywords: ["support letter", "recommendation", "reference letter", "advisory opinion", "expert letter"],
    fileNamePatterns: [/support/i, /recommend/i, /reference.?letter/i, /expert/i, /advisory/i],
    commonExtensions: ["pdf", "docx"],
    aliases: ["letter of support", "expert opinion letter"],
  },
  {
    category: "financial",
    keywords: ["bank statement", "financial", "assets", "account statement", "investment"],
    fileNamePatterns: [/bank/i, /financial/i, /statement/i, /account/i, /asset/i],
    commonExtensions: ["pdf"],
    aliases: ["bank letter", "account statement"],
  },
  {
    category: "publication",
    keywords: ["publication", "article", "journal", "paper", "citation", "google scholar"],
    fileNamePatterns: [/publication/i, /article/i, /journal/i, /paper/i, /citation/i],
    commonExtensions: ["pdf"],
    aliases: ["published article", "research paper"],
  },
  {
    category: "affidavit",
    keywords: ["affidavit", "sworn statement", "declaration", "statutory declaration"],
    fileNamePatterns: [/affidavit/i, /sworn/i, /declaration/i],
    commonExtensions: ["pdf", "docx"],
    aliases: ["sworn affidavit", "notarized statement"],
  },
];


// ═══════════════════════════════════════════════════════════
// MAIN MATCHING ENGINE
// ═══════════════════════════════════════════════════════════

export interface MatchingOptions {
  /** Search subfolders recursively (default: true) */
  recursive: boolean;
  /** Minimum confidence to auto-include a file (default: 0.3) */
  minConfidence: number;
  /** Maximum files to match per exhibit (default: 10) */
  maxMatchesPerExhibit: number;
  /** Try to extract text from files for content matching (expensive, default: false) */
  enableContentMatching: boolean;
  /** IDs to exclude from matching (e.g., the cover letter itself) */
  excludeFileIds: string[];
  /** Known folder names that map to exhibit categories */
  folderHints: Record<string, string>;
}

const DEFAULT_OPTIONS: MatchingOptions = {
  recursive: true,
  minConfidence: 0.3,
  maxMatchesPerExhibit: 10,
  enableContentMatching: false,
  excludeFileIds: [],
  folderHints: {},
};

/**
 * Match all exhibits to files in storage.
 * This is the main entry point.
 */
export async function matchExhibitsToFiles(
  exhibits: ParsedExhibit[],
  folderId: string,
  options: Partial<MatchingOptions> = {}
): Promise<DocumentMatch[]> {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  // ── Step 1: Gather all available files ──
  const allFiles = opts.recursive
    ? await storageApi.listFilesRecursive(folderId)
    : await storageApi.listFiles(folderId);

  // Exclude cover letter and any other specified files
  const excludeSet = new Set(opts.excludeFileIds);
  const candidateFiles = allFiles.filter(f => !excludeSet.has(f.id));

  // ── Step 2: Pre-process files for efficient matching ──
  const fileIndex = buildFileIndex(candidateFiles);

  // ── Step 3: Match each exhibit ──
  const matches: DocumentMatch[] = [];
  const usedFileIds = new Set<string>(); // track assigned files to prefer unique assignments

  for (const exhibit of exhibits) {
    const match = await matchSingleExhibit(
      exhibit, candidateFiles, fileIndex, usedFileIds, opts
    );
    matches.push(match);

    // Mark high-confidence matches as used
    for (const mf of match.matchedFiles) {
      if (mf.confidence >= 0.6) usedFileIds.add(mf.fileId);
    }
  }

  // ── Step 4: Resolve conflicts (two exhibits claiming same file) ──
  resolveConflicts(matches);

  return matches;
}


// ═══════════════════════════════════════════════════════════
// FILE INDEX — Pre-processed file data for fast matching
// ═══════════════════════════════════════════════════════════

interface FileIndex {
  /** filename tokens (lowercased, split on separators) */
  nameTokens: Map<string, Set<string>>;
  /** file ID → folder name it's in */
  folderNames: Map<string, string>;
  /** file ID → all name tokens */
  fileTokens: Map<string, string[]>;
  /** keyword → file IDs that contain it */
  invertedIndex: Map<string, string[]>;
  /** file extension → file IDs */
  byExtension: Map<string, string[]>;
}

function buildFileIndex(files: StorageFile[]): FileIndex {
  const nameTokens = new Map<string, Set<string>>();
  const folderNames = new Map<string, string>();
  const fileTokens = new Map<string, string[]>();
  const invertedIndex = new Map<string, string[]>();
  const byExtension = new Map<string, string[]>();

  for (const file of files) {
    // Tokenize filename (strip extension, split on common separators)
    const baseName = file.name.replace(/\.[^.]+$/, ""); // remove extension
    const tokens = tokenize(baseName);
    fileTokens.set(file.id, tokens);

    // Build inverted index
    for (const token of tokens) {
      if (!invertedIndex.has(token)) invertedIndex.set(token, []);
      invertedIndex.get(token)!.push(file.id);
    }

    // Folder name from path
    const pathParts = file.path.split("/");
    const folderName = pathParts.length >= 2
      ? pathParts[pathParts.length - 2].toLowerCase()
      : "";
    folderNames.set(file.id, folderName);

    // By extension
    const ext = file.extension.toLowerCase();
    if (!byExtension.has(ext)) byExtension.set(ext, []);
    byExtension.get(ext)!.push(file.id);
  }

  return { nameTokens, folderNames, fileTokens, invertedIndex, byExtension };
}

/**
 * Tokenize a string into searchable terms.
 * "I-94_Arrival_Record" → ["i", "94", "arrival", "record", "i-94"]
 */
function tokenize(str: string): string[] {
  const lower = str.toLowerCase();

  // Split on non-alphanumeric, but preserve compound tokens like "i-94"
  const raw = lower.split(/[\s_.,()[\]{}'"+]+/).filter(t => t.length > 0);

  // Also split hyphenated words but keep the original
  const expanded: string[] = [];
  for (const token of raw) {
    expanded.push(token);
    if (token.includes("-")) {
      expanded.push(...token.split("-").filter(t => t.length > 0));
    }
  }

  return [...new Set(expanded)];
}


// ═══════════════════════════════════════════════════════════
// SINGLE EXHIBIT MATCHING
// ═══════════════════════════════════════════════════════════

async function matchSingleExhibit(
  exhibit: ParsedExhibit,
  allFiles: StorageFile[],
  index: FileIndex,
  usedFileIds: Set<string>,
  opts: MatchingOptions
): Promise<DocumentMatch> {
  const scores = new Map<string, { score: number; reasons: MatchReason[] }>();

  // Initialize all files with zero score
  for (const file of allFiles) {
    scores.set(file.id, { score: 0, reasons: [] });
  }

  // ── Signal 1: Keyword matching (description → filename) ──
  applyKeywordMatching(exhibit, allFiles, index, scores);

  // ── Signal 2: Known immigration patterns ──
  applyPatternMatching(exhibit, allFiles, index, scores);

  // ── Signal 3: Folder name matching ──
  applyFolderMatching(exhibit, index, scores, opts.folderHints);

  // ── Signal 4: Exhibit label in filename (e.g., "Exhibit_A_passport.pdf") ──
  applyLabelMatching(exhibit, allFiles, scores);

  // ── Signal 5: File type relevance ──
  applyFileTypeMatching(exhibit, allFiles, scores);

  // ── Signal 6: Content matching (expensive, optional) ──
  if (opts.enableContentMatching) {
    await applyContentMatching(exhibit, allFiles, scores);
  }

  // ── Signal 7: Proximity to other matched files ──
  // (files in the same folder as other high-confidence matches get a small boost)
  applyProximityBoost(scores, index, usedFileIds);

  // ── Signal 8: De-boost already-used files ──
  // If a file is confidently matched to another exhibit, reduce its score here
  for (const usedId of usedFileIds) {
    const entry = scores.get(usedId);
    if (entry) {
      entry.score *= 0.3; // heavy penalty
      entry.reasons.push({
        type: "proximity",
        detail: "Already matched to another exhibit (penalty applied)",
        weight: -0.5,
      });
    }
  }

  // ── Rank and filter ──
  const ranked = [...scores.entries()]
    .filter(([_, data]) => data.score >= opts.minConfidence)
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, opts.maxMatchesPerExhibit);

  const matchedFiles: MatchedFile[] = ranked.map(([fileId, data], idx) => {
    const file = allFiles.find(f => f.id === fileId)!;
    return {
      fileId,
      fileName: file.name,
      filePath: file.path,
      mimeType: file.mimeType,
      fileSize: file.size,
      confidence: clamp(data.score, 0, 1),
      confidenceLevel: scoreToLevel(data.score),
      matchReason: data.reasons,
      pageCount: file.pageCount,
      userConfirmed: false,
      userOverride: false,
      sortOrder: idx,
    };
  });

  // Determine status
  const unmatchedDescriptions: string[] = [];
  if (exhibit.subItems.length > 0) {
    // Check which sub-items are covered
    for (const sub of exhibit.subItems) {
      const subTokens = tokenize(sub);
      const covered = matchedFiles.some(mf => {
        const fileTokens = index.fileTokens.get(mf.fileId) || [];
        return subTokens.some(st => fileTokens.includes(st));
      });
      if (!covered) unmatchedDescriptions.push(sub);
    }
  } else if (matchedFiles.length === 0) {
    unmatchedDescriptions.push(exhibit.description);
  }

  let status: MatchStatus = "unmatched";
  if (matchedFiles.length > 0 && unmatchedDescriptions.length === 0) {
    status = "matched";
  } else if (matchedFiles.length > 0) {
    status = "partial";
  }

  return {
    exhibitLabel: exhibit.label,
    matchedFiles,
    unmatchedDescriptions,
    status,
  };
}


// ═══════════════════════════════════════════════════════════
// SCORING SIGNALS
// ═══════════════════════════════════════════════════════════

/**
 * Signal 1: Match keywords from exhibit description to filenames.
 */
function applyKeywordMatching(
  exhibit: ParsedExhibit,
  files: StorageFile[],
  index: FileIndex,
  scores: Map<string, { score: number; reasons: MatchReason[] }>
) {
  const descTokens = tokenize(exhibit.description);
  // Also tokenize sub-items
  const subTokens = exhibit.subItems.flatMap(s => tokenize(s));
  const allTokens = [...new Set([...descTokens, ...subTokens])];

  // Filter out very common / stop words
  const stopWords = new Set([
    "a", "an", "the", "of", "for", "and", "or", "to", "in", "on",
    "at", "by", "is", "it", "from", "with", "as", "be", "this",
    "that", "was", "are", "been", "copy", "copies", "document",
    "documents", "form", "letter", "page", "pages", "see", "attached",
  ]);
  const meaningfulTokens = allTokens.filter(t => !stopWords.has(t) && t.length > 1);

  if (meaningfulTokens.length === 0) return;

  for (const file of files) {
    const fileTokens = index.fileTokens.get(file.id) || [];
    if (fileTokens.length === 0) continue;

    // Count how many description tokens appear in the filename
    const matchedTokens = meaningfulTokens.filter(dt => fileTokens.includes(dt));
    const matchRatio = matchedTokens.length / meaningfulTokens.length;

    if (matchedTokens.length === 0) continue;

    const entry = scores.get(file.id)!;

    // Exact full name match (very high confidence)
    const fileBase = file.name.replace(/\.[^.]+$/, "").toLowerCase();
    const descLower = exhibit.description.toLowerCase().trim();
    if (fileBase === descLower || fileBase.includes(descLower) || descLower.includes(fileBase)) {
      entry.score += 0.85;
      entry.reasons.push({
        type: "filename-exact",
        detail: `Filename closely matches exhibit description`,
        weight: 0.85,
      });
      continue;
    }

    // Partial keyword match
    if (matchRatio >= 0.6) {
      const weight = 0.4 + (matchRatio * 0.35);
      entry.score += weight;
      entry.reasons.push({
        type: "filename-keyword",
        detail: `${matchedTokens.length}/${meaningfulTokens.length} keywords match: ${matchedTokens.join(", ")}`,
        weight,
      });
    } else if (matchedTokens.length >= 1) {
      const weight = 0.15 + (matchRatio * 0.2);
      entry.score += weight;
      entry.reasons.push({
        type: "filename-partial",
        detail: `Partial match: ${matchedTokens.join(", ")}`,
        weight,
      });
    }
  }
}

/**
 * Signal 2: Match against known immigration document patterns.
 */
function applyPatternMatching(
  exhibit: ParsedExhibit,
  files: StorageFile[],
  index: FileIndex,
  scores: Map<string, { score: number; reasons: MatchReason[] }>
) {
  // Find which known patterns the exhibit description matches
  const descLower = exhibit.description.toLowerCase();
  const subLower = exhibit.subItems.map(s => s.toLowerCase());
  const allText = [descLower, ...subLower].join(" ");

  const matchedPatterns: KnownDocumentPattern[] = [];

  for (const pattern of KNOWN_PATTERNS) {
    const keywordMatch = pattern.keywords.some(kw => allText.includes(kw.toLowerCase()));
    const aliasMatch = pattern.aliases.some(a => allText.includes(a.toLowerCase()));
    if (keywordMatch || aliasMatch) {
      matchedPatterns.push(pattern);
    }
  }

  if (matchedPatterns.length === 0) return;

  // Now boost files that match these patterns by filename
  for (const file of files) {
    for (const pattern of matchedPatterns) {
      for (const fnPattern of pattern.fileNamePatterns) {
        if (fnPattern.test(file.name)) {
          const entry = scores.get(file.id)!;
          const weight = 0.35;
          entry.score += weight;
          entry.reasons.push({
            type: "common-pattern",
            detail: `Filename matches known ${pattern.category} pattern`,
            weight,
          });
          break; // one match per pattern per file is enough
        }
      }

      // Also check if file extension matches expected types
      if (pattern.commonExtensions.includes(file.extension.toLowerCase())) {
        // Minor boost for having the right file type
        const entry = scores.get(file.id)!;
        const alreadyBoosted = entry.reasons.some(
          r => r.type === "common-pattern" && r.detail.includes(pattern.category)
        );
        if (alreadyBoosted) {
          entry.score += 0.05;
        }
      }
    }
  }
}

/**
 * Signal 3: File is in a folder whose name matches the exhibit.
 */
function applyFolderMatching(
  exhibit: ParsedExhibit,
  index: FileIndex,
  scores: Map<string, { score: number; reasons: MatchReason[] }>,
  folderHints: Record<string, string>
) {
  const descTokens = tokenize(exhibit.description);
  const labelNorm = exhibit.label.normalized.toLowerCase();

  for (const [fileId, folderName] of index.folderNames) {
    if (!folderName) continue;
    const entry = scores.get(fileId);
    if (!entry) continue;

    // Check if folder name matches exhibit label (e.g., folder named "Exhibit A")
    const folderTokens = tokenize(folderName);
    if (folderName.includes(labelNorm.replace("_", " "))
      || folderName.includes(labelNorm.replace("_", ""))
      || folderName.includes(exhibit.label.raw.toLowerCase())) {
      entry.score += 0.5;
      entry.reasons.push({
        type: "folder-name",
        detail: `File is in folder "${folderName}" which matches exhibit label`,
        weight: 0.5,
      });
      continue;
    }

    // Check if folder name matches description keywords
    const folderKeywordMatch = descTokens.some(dt => folderTokens.includes(dt));
    if (folderKeywordMatch) {
      entry.score += 0.15;
      entry.reasons.push({
        type: "folder-name",
        detail: `File is in folder "${folderName}" which relates to the exhibit description`,
        weight: 0.15,
      });
    }

    // Check user-provided folder hints
    const hint = folderHints[folderName];
    if (hint && tokenize(hint).some(ht => descTokens.includes(ht))) {
      entry.score += 0.3;
      entry.reasons.push({
        type: "folder-name",
        detail: `Folder hint: "${folderName}" → "${hint}"`,
        weight: 0.3,
      });
    }
  }
}

/**
 * Signal 4: Exhibit label embedded in filename.
 * e.g., "ExA_Passport.pdf", "Tab1_I94.pdf", "Exhibit_B_diploma.pdf"
 */
function applyLabelMatching(
  exhibit: ParsedExhibit,
  files: StorageFile[],
  scores: Map<string, { score: number; reasons: MatchReason[] }>
) {
  const label = exhibit.label;

  // Build regex variants for this exhibit's label
  // "Exhibit A" → /Exhibit[_\s-]*A/i, /Ex[_\s-]*A/i, /ExA/i
  const labelVariants: RegExp[] = buildLabelVariants(label);

  for (const file of files) {
    for (const variant of labelVariants) {
      if (variant.test(file.name)) {
        const entry = scores.get(file.id)!;
        entry.score += 0.7;
        entry.reasons.push({
          type: "filename-exact",
          detail: `Filename contains exhibit label "${label.raw}"`,
          weight: 0.7,
        });
        break; // one match is enough
      }
    }
  }
}

function buildLabelVariants(label: ExhibitLabel): RegExp[] {
  const variants: RegExp[] = [];
  const raw = label.raw;

  // Direct: "Exhibit A", "Tab 1"
  const escaped = raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  variants.push(new RegExp(escaped.replace(/\s+/g, "[_\\s\\-]*"), "i"));

  // Abbreviated: "Ex A", "ExA", "Ex_A"
  const parts = raw.split(/\s+/);
  if (parts.length === 2) {
    const prefix = parts[0];
    const suffix = parts[1];

    // "Ex" abbreviation
    if (prefix.toLowerCase().startsWith("exhibit")) {
      variants.push(new RegExp(`Ex[_\\s\\-]*${suffix}`, "i"));
      variants.push(new RegExp(`Exh[_\\s\\-]*${suffix}`, "i"));
    }

    // No separator: "ExA", "Tab1"
    variants.push(new RegExp(`${prefix.slice(0, 3)}${suffix}`, "i"));
  }

  return variants;
}

/**
 * Signal 5: Boost files with expected file types based on description context.
 */
function applyFileTypeMatching(
  exhibit: ParsedExhibit,
  files: StorageFile[],
  scores: Map<string, { score: number; reasons: MatchReason[] }>
) {
  const desc = exhibit.description.toLowerCase();

  // Infer expected file types from description
  const expectedTypes: string[] = [];

  if (/photo|photograph|picture|image|headshot/.test(desc)) {
    expectedTypes.push("jpg", "jpeg", "png");
  }
  if (/letter|form|petition|application|notice/.test(desc)) {
    expectedTypes.push("pdf", "docx");
  }
  if (/spreadsheet|excel|financial|statement/.test(desc)) {
    expectedTypes.push("xlsx", "pdf");
  }
  if (/scan|copy|stamp/.test(desc)) {
    expectedTypes.push("pdf", "jpg", "jpeg", "png");
  }

  if (expectedTypes.length === 0) return;

  const typeSet = new Set(expectedTypes);
  for (const file of files) {
    const ext = file.extension.toLowerCase();
    if (typeSet.has(ext)) {
      const entry = scores.get(file.id)!;
      // Only a small boost — file type alone isn't very specific
      entry.score += 0.05;
      entry.reasons.push({
        type: "file-type-match",
        detail: `File type .${ext} matches expected types for this exhibit`,
        weight: 0.05,
      });
    }
  }
}

/**
 * Signal 6: Extract text from files and compare with description (expensive).
 */
async function applyContentMatching(
  exhibit: ParsedExhibit,
  files: StorageFile[],
  scores: Map<string, { score: number; reasons: MatchReason[] }>
) {
  const descTokens = tokenize(exhibit.description);
  const meaningfulTokens = descTokens.filter(t => t.length > 3);
  if (meaningfulTokens.length === 0) return;

  // Only check files that already have some score (to limit API calls)
  const candidates = files.filter(f => {
    const entry = scores.get(f.id);
    return entry && entry.score > 0.1;
  });

  // Batch limit: max 10 content extractions per exhibit
  const toCheck = candidates.slice(0, 10);

  const extractions = await Promise.allSettled(
    toCheck.map(async (file) => {
      const result = await storageApi.extractText(file.id);
      return { fileId: file.id, text: result?.text || null };
    })
  );

  for (const result of extractions) {
    if (result.status !== "fulfilled" || !result.value.text) continue;
    const { fileId, text } = result.value;
    const contentTokens = tokenize(text.slice(0, 5000)); // first 5k chars
    const overlap = meaningfulTokens.filter(t => contentTokens.includes(t));

    if (overlap.length >= 2) {
      const ratio = overlap.length / meaningfulTokens.length;
      const weight = 0.1 + (ratio * 0.2);
      const entry = scores.get(fileId)!;
      entry.score += weight;
      entry.reasons.push({
        type: "file-content",
        detail: `File content matches ${overlap.length} keywords: ${overlap.slice(0, 5).join(", ")}`,
        weight,
      });
    }
  }
}

/**
 * Signal 7: Files near other matched files get a small boost.
 */
function applyProximityBoost(
  scores: Map<string, { score: number; reasons: MatchReason[] }>,
  index: FileIndex,
  usedFileIds: Set<string>
) {
  // Find folders that contain already-matched files
  const matchedFolders = new Set<string>();
  for (const fileId of usedFileIds) {
    const folder = index.folderNames.get(fileId);
    if (folder) matchedFolders.add(folder);
  }

  if (matchedFolders.size === 0) return;

  for (const [fileId, entry] of scores) {
    if (usedFileIds.has(fileId)) continue; // already matched
    const folder = index.folderNames.get(fileId);
    if (folder && matchedFolders.has(folder)) {
      entry.score += 0.08;
      entry.reasons.push({
        type: "proximity",
        detail: `Located near other matched exhibit documents`,
        weight: 0.08,
      });
    }
  }
}


// ═══════════════════════════════════════════════════════════
// CONFLICT RESOLUTION
// ═══════════════════════════════════════════════════════════

/**
 * If the same file is the top match for multiple exhibits,
 * assign it to the exhibit where it scores highest and
 * demote it for the others.
 */
function resolveConflicts(matches: DocumentMatch[]) {
  // Build a map of fileId → all exhibits that claim it
  const claims = new Map<string, Array<{ matchIdx: number; fileIdx: number; confidence: number }>>();

  for (let mi = 0; mi < matches.length; mi++) {
    for (let fi = 0; fi < matches[mi].matchedFiles.length; fi++) {
      const mf = matches[mi].matchedFiles[fi];
      if (!claims.has(mf.fileId)) claims.set(mf.fileId, []);
      claims.get(mf.fileId)!.push({ matchIdx: mi, fileIdx: fi, confidence: mf.confidence });
    }
  }

  // For each file claimed by multiple exhibits, keep the highest scorer
  for (const [fileId, claimList] of claims) {
    if (claimList.length <= 1) continue;

    // Sort by confidence, keep highest
    claimList.sort((a, b) => b.confidence - a.confidence);
    const winner = claimList[0];

    // Remove from all losers
    for (let i = 1; i < claimList.length; i++) {
      const loser = claimList[i];
      const match = matches[loser.matchIdx];
      match.matchedFiles = match.matchedFiles.filter(mf => mf.fileId !== fileId);

      // Recheck status
      if (match.matchedFiles.length === 0) {
        match.status = "unmatched";
      } else if (match.unmatchedDescriptions.length > 0) {
        match.status = "partial";
      }
    }
  }
}


// ═══════════════════════════════════════════════════════════
// USER OVERRIDES — for when the algorithm gets it wrong
// ═══════════════════════════════════════════════════════════

/**
 * Manually assign a file to an exhibit, overriding algorithm results.
 */
export function manuallyAssignFile(
  matches: DocumentMatch[],
  exhibitNormalized: string,
  file: StorageFile,
  sortOrder: number
): DocumentMatch[] {
  return matches.map(match => {
    if (match.exhibitLabel.normalized !== exhibitNormalized) return match;

    // Check if file is already in this exhibit's matches
    const existing = match.matchedFiles.find(mf => mf.fileId === file.id);
    if (existing) {
      // Just mark as user-confirmed
      return {
        ...match,
        matchedFiles: match.matchedFiles.map(mf =>
          mf.fileId === file.id
            ? { ...mf, userConfirmed: true, userOverride: true, sortOrder }
            : mf
        ),
        status: "manual-override" as MatchStatus,
      };
    }

    // Add new file
    const newFile: MatchedFile = {
      fileId: file.id,
      fileName: file.name,
      filePath: file.path,
      mimeType: file.mimeType,
      fileSize: file.size,
      confidence: 1.0,
      confidenceLevel: "manual",
      matchReason: [{
        type: "user-assigned",
        detail: "Manually assigned by user",
        weight: 1.0,
      }],
      pageCount: file.pageCount,
      userConfirmed: true,
      userOverride: true,
      sortOrder,
    };

    return {
      ...match,
      matchedFiles: [...match.matchedFiles, newFile],
      status: "manual-override" as MatchStatus,
    };
  });
}

/**
 * Remove a file from an exhibit's matches.
 */
export function removeFileFromExhibit(
  matches: DocumentMatch[],
  exhibitNormalized: string,
  fileId: string
): DocumentMatch[] {
  return matches.map(match => {
    if (match.exhibitLabel.normalized !== exhibitNormalized) return match;

    const updated = match.matchedFiles.filter(mf => mf.fileId !== fileId);
    return {
      ...match,
      matchedFiles: updated,
      status: updated.length === 0 ? "unmatched" as MatchStatus : match.status,
    };
  });
}

/**
 * Confirm all current matches for an exhibit (user reviewed and approved).
 */
export function confirmExhibitMatches(
  matches: DocumentMatch[],
  exhibitNormalized: string
): DocumentMatch[] {
  return matches.map(match => {
    if (match.exhibitLabel.normalized !== exhibitNormalized) return match;
    return {
      ...match,
      matchedFiles: match.matchedFiles.map(mf => ({ ...mf, userConfirmed: true })),
      status: "confirmed" as MatchStatus,
    };
  });
}

/**
 * Reorder files within an exhibit.
 */
export function reorderExhibitFiles(
  matches: DocumentMatch[],
  exhibitNormalized: string,
  orderedFileIds: string[]
): DocumentMatch[] {
  return matches.map(match => {
    if (match.exhibitLabel.normalized !== exhibitNormalized) return match;
    const reordered = orderedFileIds
      .map((fid, idx) => {
        const mf = match.matchedFiles.find(m => m.fileId === fid);
        return mf ? { ...mf, sortOrder: idx } : null;
      })
      .filter(Boolean) as MatchedFile[];

    // Append any files not in the ordered list (shouldn't happen, but safety)
    const orderedSet = new Set(orderedFileIds);
    const remaining = match.matchedFiles
      .filter(mf => !orderedSet.has(mf.fileId))
      .map((mf, i) => ({ ...mf, sortOrder: reordered.length + i }));

    return { ...match, matchedFiles: [...reordered, ...remaining] };
  });
}


// ═══════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function scoreToLevel(score: number): MatchConfidence {
  if (score >= 0.7) return "high";
  if (score >= 0.4) return "medium";
  return "low";
}
