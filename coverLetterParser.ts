// ═══════════════════════════════════════════════════════════════
// coverLetterParser.ts — Scans cover letter text, detects exhibit
// declarations, extracts labels + descriptions + sub-items,
// infers metadata, and returns a structured parse result.
//
// Handles: letter/number/roman labels, table-format listings,
// multi-line descriptions, sub-item lists, mixed styles,
// sequence gaps, duplicates, split declarations, and OCR noise.
// ═══════════════════════════════════════════════════════════════

import type {
  CoverLetterParseResult, ParsedExhibit, ExhibitLabel,
  ExhibitLabelStyle, ParseWarning, ParseWarningCode,
} from "./types";
import * as storageApi from "./fileStorageApi";

// ── Roman numeral helpers ──
const ROMAN_MAP: Record<string, number> = {
  I:1, II:2, III:3, IV:4, V:5, VI:6, VII:7, VIII:8, IX:9, X:10,
  XI:11, XII:12, XIII:13, XIV:14, XV:15, XVI:16, XVII:17, XVIII:18,
  XIX:19, XX:20, XXI:21, XXII:22, XXIII:23, XXIV:24, XXV:25,
};

function romanToInt(roman: string): number {
  return ROMAN_MAP[roman.toUpperCase()] || 0;
}

function alphaToInt(letter: string): number {
  return letter.toUpperCase().charCodeAt(0) - 64; // A=1, B=2, ...
}

// ── Label detection patterns ──
// Order matters: more specific patterns first to avoid false positives

interface LabelPattern {
  regex: RegExp;
  style: ExhibitLabelStyle;
  extractSortKey: (match: RegExpMatchArray) => number;
  extractRaw: (match: RegExpMatchArray) => string;
}

const LABEL_PATTERNS: LabelPattern[] = [
  // "Exhibit A" / "EXHIBIT A" / "Exhibit A:" / "Exhibit A -" / "Exhibit A –"
  {
    regex: /\b(Exhibit|EXHIBIT|Exh\.?|EXH\.?)\s+([A-Z])\b\s*[:\-–—.]?\s*/gi,
    style: "exhibit-alpha",
    extractSortKey: (m) => alphaToInt(m[2]),
    extractRaw: (m) => m[0].trim(),
  },
  // "Exhibit 1" / "Exhibit 12" / "EXHIBIT 1:"
  {
    regex: /\b(Exhibit|EXHIBIT|Exh\.?|EXH\.?)\s+(\d{1,3})\b\s*[:\-–—.]?\s*/gi,
    style: "exhibit-numeric",
    extractSortKey: (m) => parseInt(m[2], 10),
    extractRaw: (m) => m[0].trim(),
  },
  // "Exhibit I" / "Exhibit IV" (roman)
  {
    regex: /\b(Exhibit|EXHIBIT|Exh\.?)\s+(I{1,3}|IV|VI{0,3}|IX|XI{0,3}|XIV|XV|XVI{0,3}|XIX|XX[I]{0,3})\b\s*[:\-–—.]?\s*/gi,
    style: "exhibit-roman",
    extractSortKey: (m) => romanToInt(m[2]),
    extractRaw: (m) => m[0].trim(),
  },
  // "Tab 1" / "TAB 1:"
  {
    regex: /\b(Tab|TAB)\s+(\d{1,3})\b\s*[:\-–—.]?\s*/gi,
    style: "tab-numeric",
    extractSortKey: (m) => parseInt(m[2], 10),
    extractRaw: (m) => m[0].trim(),
  },
  // "Tab A"
  {
    regex: /\b(Tab|TAB)\s+([A-Z])\b\s*[:\-–—.]?\s*/gi,
    style: "tab-alpha",
    extractSortKey: (m) => alphaToInt(m[2]),
    extractRaw: (m) => m[0].trim(),
  },
  // "Attachment A" / "Attachment 1"
  {
    regex: /\b(Attachment|ATTACHMENT)\s+([A-Z])\b\s*[:\-–—.]?\s*/gi,
    style: "attachment-alpha",
    extractSortKey: (m) => alphaToInt(m[2]),
    extractRaw: (m) => m[0].trim(),
  },
  {
    regex: /\b(Attachment|ATTACHMENT)\s+(\d{1,3})\b\s*[:\-–—.]?\s*/gi,
    style: "attachment-numeric",
    extractSortKey: (m) => parseInt(m[2], 10),
    extractRaw: (m) => m[0].trim(),
  },
  // "Appendix A" / "Appendix 1"
  {
    regex: /\b(Appendix|APPENDIX)\s+([A-Z])\b\s*[:\-–—.]?\s*/gi,
    style: "appendix-alpha",
    extractSortKey: (m) => alphaToInt(m[2]),
    extractRaw: (m) => m[0].trim(),
  },
  {
    regex: /\b(Appendix|APPENDIX)\s+(\d{1,3})\b\s*[:\-–—.]?\s*/gi,
    style: "appendix-numeric",
    extractSortKey: (m) => parseInt(m[2], 10),
    extractRaw: (m) => m[0].trim(),
  },
];


// ═══════════════════════════════════════════════════════════
// MAIN PARSER
// ═══════════════════════════════════════════════════════════

/**
 * Parse a cover letter file: extract text, find exhibit declarations,
 * pull descriptions, infer document metadata.
 */
export async function parseCoverLetter(
  fileId: string,
  fileName: string
): Promise<CoverLetterParseResult> {
  const warnings: ParseWarning[] = [];

  // ── Step 1: Extract text ──
  const extraction = await storageApi.extractText(fileId);

  if (!extraction) {
    return {
      success: false,
      fileName,
      totalPages: 0,
      extractedText: "",
      labelStyle: "unknown",
      exhibits: [],
      warnings: [warn("EXTRACTION_ERROR", "Could not extract text from this file type.", null, "error")],
      metadata: emptyMetadata(),
    };
  }

  const { text, pages, confidence: ocrConfidence } = extraction;

  if (ocrConfidence < 0.5) {
    warnings.push(warn("LOW_TEXT_QUALITY",
      `Text extraction confidence is low (${Math.round(ocrConfidence * 100)}%). Results may be inaccurate.`,
      null, "warning"));
  }

  if (text.trim().length < 100) {
    warnings.push(warn("LOW_TEXT_QUALITY",
      "Extracted text is very short. The file may be image-based or mostly blank.",
      null, "warning"));
  }

  // ── Step 2: Detect if exhibits are in a table format ──
  const isTableFormat = detectTableFormat(text);
  if (isTableFormat) {
    warnings.push(warn("TABLE_FORMAT_DETECTED",
      "Exhibits appear to be listed in a table. Using table-aware parsing.",
      null, "info"));
  }

  // ── Step 3: Find all exhibit label matches ──
  const rawMatches = findAllExhibitMatches(text);

  if (rawMatches.length === 0) {
    return {
      success: false,
      fileName,
      totalPages: pages.length,
      extractedText: text,
      labelStyle: "unknown",
      exhibits: [],
      warnings: [
        ...warnings,
        warn("NO_EXHIBITS_FOUND",
          "No exhibit references (Exhibit A, Tab 1, etc.) were found in this document.",
          null, "error"),
      ],
      metadata: extractMetadata(text),
    };
  }

  // ── Step 4: Determine dominant label style ──
  const labelStyle = detectDominantStyle(rawMatches);

  // Check for mixed styles
  const styles = new Set(rawMatches.map(m => m.style));
  if (styles.size > 1) {
    warnings.push(warn("MIXED_LABEL_STYLES",
      `Found multiple labeling styles: ${[...styles].join(", ")}. Using "${labelStyle}" as primary.`,
      null, "warning"));
  }

  // ── Step 5: Deduplicate + merge ──
  const deduped = deduplicateMatches(rawMatches, warnings);

  // ── Step 6: Extract descriptions for each exhibit ──
  const lines = text.split("\n");
  const exhibits: ParsedExhibit[] = deduped.map((match, idx) => {
    const nextMatch = deduped[idx + 1];
    const description = extractDescription(text, match, nextMatch, isTableFormat);
    const subItems = extractSubItems(description);
    const lineNum = getLineNumber(text, match.charOffset);
    const pageNum = getPageNumber(pages, match.charOffset);
    const snippet = extractSnippet(text, match.charOffset, 200);

    // Confidence: based on description quality + position
    let conf = 0.9;
    if (!description || description.trim().length < 3) {
      conf = 0.5;
      warnings.push(warn("EMPTY_DESCRIPTION",
        `${match.raw} has no clear description following it.`,
        { line: lineNum, char: match.charOffset }, "warning"));
    }
    if (description.toLowerCase().includes("exhibit") || description.toLowerCase().includes("tab")) {
      // Description itself references another exhibit — possibly nested
      warnings.push(warn("NESTED_REFERENCE",
        `${match.raw} description references another exhibit: "${description.slice(0, 80)}..."`,
        { line: lineNum, char: match.charOffset }, "info"));
    }

    return {
      label: {
        style: match.style,
        raw: match.raw,
        normalized: normalizeLabel(match.style, match.sortKey),
        sortKey: match.sortKey,
      },
      description: description.trim(),
      rawSnippet: snippet,
      pageNumber: pageNum,
      lineNumber: lineNum,
      charOffset: match.charOffset,
      subItems,
      confidence: conf,
    };
  });

  // ── Step 7: Validate sequence ──
  validateSequence(exhibits, warnings);

  // ── Step 8: Check for possible missed exhibits ──
  findPossibleMissedExhibits(text, exhibits, warnings);

  // ── Step 9: Extract cover letter metadata ──
  const metadata = extractMetadata(text);

  return {
    success: true,
    fileName,
    totalPages: pages.length,
    extractedText: text,
    labelStyle,
    exhibits,
    warnings,
    metadata,
  };
}


// ═══════════════════════════════════════════════════════════
// INTERNAL HELPERS
// ═══════════════════════════════════════════════════════════

interface RawMatch {
  style: ExhibitLabelStyle;
  raw: string;
  sortKey: number;
  charOffset: number;
}

/**
 * Run all label patterns against the full text.
 */
function findAllExhibitMatches(text: string): RawMatch[] {
  const matches: RawMatch[] = [];
  const seen = new Set<string>(); // track by offset to avoid overlapping matches

  for (const pattern of LABEL_PATTERNS) {
    // Reset lastIndex for global regex
    const regex = new RegExp(pattern.regex.source, pattern.regex.flags);
    let m: RegExpExecArray | null;

    while ((m = regex.exec(text)) !== null) {
      const offset = m.index;
      const key = `${offset}`;

      // Skip if we already have a match at this exact position
      // (earlier patterns take priority)
      if (seen.has(key)) continue;
      seen.add(key);

      // Skip if this is inside a quote or parenthetical reference
      // e.g., "as shown in Exhibit A" is a reference, not a declaration
      // We want declarations — heuristic: skip if preceded by "see ", "in ", "per "
      // BUT keep if it's at the start of a line or after a bullet/number
      const before = text.slice(Math.max(0, offset - 30), offset).toLowerCase();
      const isReference = /\b(see|in|per|from|under|above|below|noted in|shown in|attached as|included as|referenced in)\s*$/.test(before);

      // We still record references but mark them differently —
      // they confirm an exhibit exists even if this isn't the declaration
      if (isReference) {
        // Check if we already have a declaration for this exhibit
        const norm = normalizeLabel(pattern.style, pattern.extractSortKey(m));
        const alreadyDeclared = matches.some(
          existing => normalizeLabel(existing.style, existing.sortKey) === norm && !isReferenceMatch(text, existing.charOffset)
        );
        if (alreadyDeclared) continue;
        // If not declared elsewhere, keep this — it might be the only mention
      }

      matches.push({
        style: pattern.style,
        raw: pattern.extractRaw(m),
        sortKey: pattern.extractSortKey(m),
        charOffset: offset,
      });
    }
  }

  // Sort by position in document
  matches.sort((a, b) => a.charOffset - b.charOffset);
  return matches;
}

function isReferenceMatch(text: string, offset: number): boolean {
  const before = text.slice(Math.max(0, offset - 30), offset).toLowerCase();
  return /\b(see|in|per|from|under|noted in|shown in)\s*$/.test(before);
}

/**
 * Detect which label style is most common (the "official" one).
 */
function detectDominantStyle(matches: RawMatch[]): ExhibitLabelStyle {
  const counts: Record<string, number> = {};
  for (const m of matches) {
    counts[m.style] = (counts[m.style] || 0) + 1;
  }

  let best: ExhibitLabelStyle = "unknown";
  let bestCount = 0;
  for (const [style, count] of Object.entries(counts)) {
    if (count > bestCount) { best = style as ExhibitLabelStyle; bestCount = count; }
  }
  return best;
}

/**
 * Remove duplicate exhibits (same label appearing multiple times).
 * Keep the first occurrence (likely the declaration), record duplicates as warnings.
 */
function deduplicateMatches(matches: RawMatch[], warnings: ParseWarning[]): RawMatch[] {
  const seen = new Map<string, RawMatch>();
  const deduped: RawMatch[] = [];

  for (const match of matches) {
    const key = normalizeLabel(match.style, match.sortKey);
    if (seen.has(key)) {
      // This is a duplicate — likely a back-reference in the text
      // Only warn if it's not clearly a reference
      continue;
    }
    seen.set(key, match);
    deduped.push(match);
  }

  // Check if any labels were seen 3+ times — that's unusual
  const countMap = new Map<string, number>();
  for (const m of matches) {
    const k = normalizeLabel(m.style, m.sortKey);
    countMap.set(k, (countMap.get(k) || 0) + 1);
  }
  for (const [label, count] of countMap) {
    if (count >= 3) {
      warnings.push(warn("DUPLICATE_LABEL",
        `"${label}" appears ${count} times. Using first occurrence as the declaration.`,
        null, "info"));
    }
  }

  return deduped;
}

/**
 * Extract the description text that follows an exhibit label.
 * Handles: single-line, multi-line, table cells, semi-colon separated lists.
 */
function extractDescription(
  text: string,
  match: RawMatch,
  nextMatch: RawMatch | undefined,
  isTable: boolean
): string {
  const startPos = match.charOffset + match.raw.length;
  const endPos = nextMatch ? nextMatch.charOffset : text.length;

  // Get the text between this exhibit and the next
  let between = text.slice(startPos, endPos);

  // For table format: description is usually on the same line or next cell
  if (isTable) {
    // Take first meaningful line
    const lines = between.split("\n").map(l => l.trim()).filter(l => l.length > 0);
    if (lines.length > 0) {
      // Take lines until we hit a blank line or another pattern
      const descLines: string[] = [];
      for (const line of lines) {
        if (line.length === 0) break;
        if (/^\d+\.\s/.test(line) && descLines.length > 0) break; // numbered list = new item
        descLines.push(line);
        // Stop after 3 lines for table format
        if (descLines.length >= 3) break;
      }
      return descLines.join(" ");
    }
  }

  // Non-table: take text until end of paragraph or next exhibit
  // Trim to first double-newline or reasonable length
  const paragraphEnd = between.search(/\n\s*\n/);
  if (paragraphEnd > 0 && paragraphEnd < 500) {
    between = between.slice(0, paragraphEnd);
  }

  // Clean up
  between = between
    .replace(/\s+/g, " ")          // collapse whitespace
    .replace(/^\s*[:\-–—.]\s*/, "") // remove leading punctuation
    .trim();

  // Cap at reasonable length
  if (between.length > 500) {
    // Try to cut at a sentence boundary
    const sentenceEnd = between.slice(0, 500).lastIndexOf(".");
    if (sentenceEnd > 100) between = between.slice(0, sentenceEnd + 1);
    else between = between.slice(0, 500) + "…";
  }

  return between;
}

/**
 * Extract sub-items from a description.
 * e.g., "Copy of passport, I-94 arrival record, and visa stamp"
 *     → ["Copy of passport", "I-94 arrival record", "visa stamp"]
 */
function extractSubItems(description: string): string[] {
  if (!description || description.length < 10) return [];

  // Split on common delimiters
  const items: string[] = [];

  // Pattern 1: Semicolon-separated
  if (description.includes(";")) {
    return description.split(";").map(s => s.trim()).filter(s => s.length > 2);
  }

  // Pattern 2: Numbered sub-items (a), (b) or 1), 2) or (i), (ii)
  const numberedPattern = /(?:^|\n)\s*(?:\(?[a-z]\)|\(?[ivx]+\)|\d+[\).])[\s]+/i;
  if (numberedPattern.test(description)) {
    const parts = description.split(/(?:\(?[a-z]\)|\(?[ivx]+\)|\d+[\).])[\s]+/i);
    return parts.map(s => s.trim()).filter(s => s.length > 2);
  }

  // Pattern 3: Comma-separated with "and"/"or" before last item
  // Only if there are 2+ commas (to avoid splitting normal sentences)
  const commaCount = (description.match(/,/g) || []).length;
  if (commaCount >= 2) {
    const cleaned = description.replace(/,?\s*\b(and|or)\b\s*/gi, ",");
    const parts = cleaned.split(",").map(s => s.trim()).filter(s => s.length > 2);
    if (parts.length >= 2) return parts;
  }

  // Pattern 4: Bullet points or dashes
  if (/[\n•\-]\s/.test(description)) {
    const parts = description.split(/\n\s*[•\-]\s*/);
    const filtered = parts.map(s => s.trim()).filter(s => s.length > 2);
    if (filtered.length >= 2) return filtered;
  }

  // No sub-items detected — the whole description is one item
  return [];
}

/**
 * Detect if the cover letter uses a table format for exhibit listings.
 * Tables often have consistent column-like spacing or tab characters.
 */
function detectTableFormat(text: string): boolean {
  const lines = text.split("\n");
  let tabLineCount = 0;
  let exhibitInTableLine = 0;

  for (const line of lines) {
    // Check for tab-separated or heavy-whitespace-separated columns
    if (line.includes("\t") || /\s{4,}/.test(line)) {
      tabLineCount++;
      if (/exhibit|tab\s+[a-z0-9]/i.test(line)) {
        exhibitInTableLine++;
      }
    }
  }

  // If multiple exhibit references appear in table-like lines, it's a table
  return exhibitInTableLine >= 3;
}

/**
 * Validate the exhibit sequence for gaps and ordering issues.
 */
function validateSequence(exhibits: ParsedExhibit[], warnings: ParseWarning[]) {
  if (exhibits.length < 2) return;

  for (let i = 1; i < exhibits.length; i++) {
    const prev = exhibits[i - 1];
    const curr = exhibits[i];

    // Only compare same-style labels
    if (prev.label.style !== curr.label.style) continue;

    const gap = curr.label.sortKey - prev.label.sortKey;

    if (gap > 1) {
      // Missing exhibits in sequence
      const missing: string[] = [];
      for (let k = prev.label.sortKey + 1; k < curr.label.sortKey; k++) {
        missing.push(normalizeLabel(curr.label.style, k));
      }
      warnings.push(warn("GAP_IN_SEQUENCE",
        `Gap in sequence between ${prev.label.raw} and ${curr.label.raw}. Missing: ${missing.join(", ")}`,
        { line: curr.lineNumber, char: curr.charOffset },
        "warning"));
    }

    if (gap < 0) {
      warnings.push(warn("UNUSUAL_ORDERING",
        `${curr.label.raw} appears after ${prev.label.raw} but has a lower sequence number.`,
        { line: curr.lineNumber, char: curr.charOffset },
        "info"));
    }

    if (gap === 0) {
      warnings.push(warn("DUPLICATE_LABEL",
        `${curr.label.raw} appears to be a duplicate of ${prev.label.raw}.`,
        { line: curr.lineNumber, char: curr.charOffset },
        "warning"));
    }
  }
}

/**
 * Look for text that might be exhibit references we missed.
 */
function findPossibleMissedExhibits(text: string, found: ParsedExhibit[], warnings: ParseWarning[]) {
  // Look for patterns like "See attached [Document Name]" without exhibit labels
  const attachedPattern = /\b(see\s+attached|attached\s+hereto|enclosed)\s+["']?([A-Z][A-Za-z\s]{3,40})["']?/gi;
  let m: RegExpExecArray | null;

  while ((m = attachedPattern.exec(text)) !== null) {
    const docName = m[2].trim();
    // Check if this is already covered by a found exhibit
    const covered = found.some(ex =>
      ex.description.toLowerCase().includes(docName.toLowerCase())
    );
    if (!covered) {
      warnings.push(warn("POSSIBLE_MISSED_EXHIBIT",
        `Found reference to "${docName}" that isn't linked to any exhibit label.`,
        { line: getLineNumber(text, m.index), char: m.index },
        "info"));
    }
  }
}

/**
 * Extract metadata from the cover letter text.
 */
function extractMetadata(text: string): CoverLetterParseResult["metadata"] {
  // Case/petition type
  const caseTypeMatch = text.match(
    /\b(I-\d{3}[A-Z]?|Form\s+I-\d{3}|N-\d{3}|ETA-?\d{3,4})\b/i
  );

  // Receipt number
  const receiptMatch = text.match(
    /\b((?:WAC|EAC|LIN|SRC|MSC|NBC|IOE|IOE)\d{10,13})\b/i
  );

  // Names — look for "Petitioner: Name" or "Beneficiary: Name" patterns
  const petitionerMatch = text.match(
    /(?:Petitioner|Sponsor|Employer)[:\s]+([A-Z][A-Za-z\s,.''-]{2,50}?)(?:\n|,|\(|;)/
  );
  const beneficiaryMatch = text.match(
    /(?:Beneficiary|Applicant|Intending Immigrant)[:\s]+([A-Z][A-Za-z\s,.''-]{2,50}?)(?:\n|,|\(|;)/
  );

  // Attorney
  const attorneyMatch = text.match(
    /(?:Attorney|Counsel|Prepared by|Law (?:Office|Firm|Group))[:\s]+([A-Z][A-Za-z\s,.''-]{2,60}?)(?:\n|,|\(|;|$)/
  );

  // Date
  const dateMatch = text.match(
    /(?:Date|Dated)[:\s]+(\w+\s+\d{1,2},?\s+\d{4}|\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/i
  );

  return {
    petitionerName: petitionerMatch?.[1]?.trim() || null,
    beneficiaryName: beneficiaryMatch?.[1]?.trim() || null,
    caseType: caseTypeMatch?.[1]?.toUpperCase() || null,
    receiptNumber: receiptMatch?.[1]?.toUpperCase() || null,
    attorney: attorneyMatch?.[1]?.trim() || null,
    dateOfLetter: dateMatch?.[1]?.trim() || null,
  };
}


// ═══════════════════════════════════════════════════════════
// UTILITY FUNCTIONS
// ═══════════════════════════════════════════════════════════

function normalizeLabel(style: ExhibitLabelStyle, sortKey: number): string {
  const prefix = style.split("-")[0].toUpperCase(); // "EXHIBIT", "TAB", etc.
  const suffix = style.endsWith("alpha")
    ? String.fromCharCode(64 + sortKey) // 1→A, 2→B
    : style.endsWith("roman")
    ? Object.entries(ROMAN_MAP).find(([_, v]) => v === sortKey)?.[0] || String(sortKey)
    : String(sortKey);
  return `${prefix}_${suffix}`;
}

function getLineNumber(text: string, charOffset: number): number {
  const before = text.slice(0, charOffset);
  return (before.match(/\n/g) || []).length + 1;
}

function getPageNumber(
  pages: { pageNumber: number; text: string }[],
  charOffset: number
): number | null {
  if (!pages.length) return null;

  let cumulative = 0;
  for (const page of pages) {
    cumulative += page.text.length + 1; // +1 for implicit newline between pages
    if (cumulative >= charOffset) return page.pageNumber;
  }
  return pages[pages.length - 1].pageNumber;
}

function extractSnippet(text: string, offset: number, radius: number): string {
  const start = Math.max(0, offset - radius);
  const end = Math.min(text.length, offset + radius);
  let snippet = text.slice(start, end);
  if (start > 0) snippet = "…" + snippet;
  if (end < text.length) snippet = snippet + "…";
  return snippet;
}

function warn(
  code: ParseWarningCode,
  message: string,
  location: { line: number; char: number } | null,
  severity: ParseWarning["severity"]
): ParseWarning {
  return { code, message, location, severity };
}

function emptyMetadata(): CoverLetterParseResult["metadata"] {
  return {
    petitionerName: null,
    beneficiaryName: null,
    caseType: null,
    receiptNumber: null,
    attorney: null,
    dateOfLetter: null,
  };
}
