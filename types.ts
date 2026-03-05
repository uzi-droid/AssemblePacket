// ═══════════════════════════════════════════════════════════════
// types.ts — Domain types for Immigration Packet Assembly
// Covers: exhibit parsing, document matching, packet assembly,
// workflow state, and every edge case in between.
// ═══════════════════════════════════════════════════════════════

// ── Exhibit label formats commonly found in immigration cover letters ──
export type ExhibitLabelStyle =
  | "exhibit-alpha"     // Exhibit A, Exhibit B
  | "exhibit-numeric"   // Exhibit 1, Exhibit 2
  | "exhibit-roman"     // Exhibit I, Exhibit II
  | "tab-numeric"       // Tab 1, Tab 2
  | "tab-alpha"         // Tab A, Tab B
  | "attachment-alpha"  // Attachment A
  | "attachment-numeric"// Attachment 1
  | "appendix-alpha"    // Appendix A
  | "appendix-numeric"  // Appendix 1
  | "unknown";

export interface ExhibitLabel {
  style: ExhibitLabelStyle;
  raw: string;              // Original text as found: "Exhibit A", "Tab 3"
  normalized: string;       // Cleaned: "EXHIBIT_A", "TAB_3"
  sortKey: number;          // For ordering: A=1, B=2 / 1=1, 2=2 / I=1, II=2
}

/**
 * A single exhibit declaration found in the cover letter.
 * One exhibit may reference multiple sub-documents.
 */
export interface ParsedExhibit {
  label: ExhibitLabel;
  description: string;        // Text following the label: "Copy of Petitioner's Passport"
  rawSnippet: string;         // Full surrounding text for context
  pageNumber: number | null;  // Page in the cover letter where it was found
  lineNumber: number;         // Line number in extracted text
  charOffset: number;         // Character offset from start of text
  subItems: string[];         // If exhibit lists multiple docs: ["I-94", "Visa stamp"]
  confidence: number;         // 0-1, how confident we are this is a real exhibit ref
}

/**
 * Result of parsing the entire cover letter.
 */
export interface CoverLetterParseResult {
  success: boolean;
  fileName: string;
  totalPages: number;
  extractedText: string;
  labelStyle: ExhibitLabelStyle;   // Detected dominant style
  exhibits: ParsedExhibit[];
  warnings: ParseWarning[];
  metadata: {
    petitionerName: string | null;
    beneficiaryName: string | null;
    caseType: string | null;        // "I-140", "I-130", "I-485", etc.
    receiptNumber: string | null;
    attorney: string | null;
    dateOfLetter: string | null;
  };
}

export interface ParseWarning {
  code: ParseWarningCode;
  message: string;
  location: { line: number; char: number } | null;
  severity: "info" | "warning" | "error";
}

export type ParseWarningCode =
  | "MIXED_LABEL_STYLES"       // Found both "Exhibit A" and "Tab 1"
  | "GAP_IN_SEQUENCE"          // Exhibit A, Exhibit C (missing B)
  | "DUPLICATE_LABEL"          // Exhibit A declared twice
  | "AMBIGUOUS_DESCRIPTION"    // Couldn't parse what the exhibit contains
  | "NO_EXHIBITS_FOUND"        // Cover letter has no exhibit references
  | "LOW_TEXT_QUALITY"          // OCR/extraction produced garbled text
  | "POSSIBLE_MISSED_EXHIBIT"  // Text looks like an exhibit ref but doesn't match patterns
  | "UNUSUAL_ORDERING"         // Exhibits declared out of sequence
  | "EMPTY_DESCRIPTION"        // Exhibit label with no description following
  | "NESTED_REFERENCE"         // Exhibit references another exhibit
  | "PAGE_BREAK_SPLIT"         // Exhibit declaration split across pages
  | "TABLE_FORMAT_DETECTED"    // Exhibits listed in a table (different parse strategy)
  | "EXTRACTION_ERROR";        // PDF text extraction partially failed

// ── Document matching ──

export type MatchConfidence = "high" | "medium" | "low" | "manual";

export interface DocumentMatch {
  exhibitLabel: ExhibitLabel;
  matchedFiles: MatchedFile[];
  unmatchedDescriptions: string[];  // Parts of the exhibit we couldn't find files for
  status: MatchStatus;
}

export type MatchStatus =
  | "matched"           // All files found with good confidence
  | "partial"           // Some files found, some missing
  | "unmatched"         // No files found
  | "manual-override"   // User manually assigned files
  | "confirmed";        // User reviewed and confirmed

export interface MatchedFile {
  fileId: string;
  fileName: string;
  filePath: string;
  mimeType: string;
  fileSize: number;
  confidence: number;              // 0-1
  confidenceLevel: MatchConfidence;
  matchReason: MatchReason[];
  pageCount: number | null;
  userConfirmed: boolean;
  userOverride: boolean;           // User manually picked this file
  sortOrder: number;               // Order within the exhibit
}

export interface MatchReason {
  type: MatchReasonType;
  detail: string;
  weight: number;         // How much this contributed to the confidence score
}

export type MatchReasonType =
  | "filename-exact"       // Filename matches exhibit description exactly
  | "filename-partial"     // Filename partially matches
  | "filename-keyword"     // Key terms from description found in filename
  | "folder-name"          // File is in a folder whose name matches
  | "file-metadata"        // File metadata (title, tags) matches
  | "file-content"         // Text inside the file matches (expensive check)
  | "file-type-match"      // Expected file type matches (e.g., ".pdf" for forms)
  | "proximity"            // File is near other matched files in folder structure
  | "common-pattern"       // Matches known immigration document naming patterns
  | "date-match"           // File date aligns with exhibit context
  | "user-assigned";       // Manually assigned by user

// ── Known immigration document patterns ──
// Helps matching engine recognize common document types

export interface KnownDocumentPattern {
  category: string;                // "identity", "employment", "education", etc.
  keywords: string[];              // Terms to match in description
  fileNamePatterns: RegExp[];      // Patterns to match in file names
  commonExtensions: string[];      // Expected file types
  aliases: string[];               // Alternative names
}

// ── Packet assembly ──

export interface PacketConfig {
  includeCoverPage: boolean;           // Add a packet cover page before everything
  includeTableOfContents: boolean;
  includeExhibitSeparators: boolean;   // "EXHIBIT A" divider pages between sections
  separatorStyle: "full-page" | "half-page" | "tab-style";
  pageNumbering: PageNumberingConfig;
  stampExhibitLabels: boolean;         // Stamp "Exhibit A" on first page of each exhibit doc
  stampPosition: "top-right" | "top-left" | "bottom-right" | "bottom-left";
  outputFormat: "pdf";                 // Could expand later
  outputFileName: string;
  paperSize: "letter" | "a4";
  batesNumbering: BatesConfig | null;  // Optional Bates numbering
}

export interface PageNumberingConfig {
  enabled: boolean;
  startFrom: number;
  format: "arabic" | "roman-lower" | "roman-upper";
  position: "bottom-center" | "bottom-right" | "top-right";
  skipCoverPage: boolean;
  skipSeparators: boolean;
  prefix: string;                      // e.g., "Page " or ""
}

export interface BatesConfig {
  prefix: string;        // e.g., "PET" for petitioner
  startNumber: number;
  zeroPadding: number;   // 6 => "PET000001"
  position: "bottom-right" | "bottom-left";
}

export interface PacketSection {
  type: "cover-page" | "toc" | "cover-letter" | "exhibit-separator" | "exhibit-document";
  label: string;                    // Display name for TOC
  exhibitLabel: ExhibitLabel | null;
  sourceFileId: string | null;
  sourceFileName: string | null;
  pageCount: number;
  startPage: number;                // In final packet
  endPage: number;
}

export interface AssembledPacket {
  success: boolean;
  outputFileId: string;
  outputFileName: string;
  outputFilePath: string;
  outputFileSize: number;
  totalPages: number;
  sections: PacketSection[];
  tableOfContents: TOCEntry[];
  errors: AssemblyError[];
  warnings: string[];
  assembledAt: string;              // ISO timestamp
  assemblyDurationMs: number;
}

export interface TOCEntry {
  label: string;
  pageNumber: number;
  indent: number;       // 0 = top level (exhibit), 1 = sub-document
}

export interface AssemblyError {
  code: AssemblyErrorCode;
  message: string;
  exhibitLabel: string | null;
  fileId: string | null;
  recoverable: boolean;
}

export type AssemblyErrorCode =
  | "FILE_NOT_FOUND"            // File was deleted/moved since matching
  | "FILE_DOWNLOAD_FAILED"      // Couldn't download from storage
  | "FILE_CORRUPT"              // File is damaged
  | "UNSUPPORTED_FORMAT"        // Can't convert to PDF (e.g., .zip)
  | "CONVERSION_FAILED"         // Image/docx → PDF conversion failed
  | "PDF_MERGE_FAILED"          // PDFs couldn't be combined
  | "PAGE_COUNT_MISMATCH"       // Expected page count doesn't match actual
  | "ENCRYPTION_BLOCKED"        // PDF is password-protected
  | "FILE_TOO_LARGE"            // Single file exceeds size limit
  | "TOTAL_SIZE_EXCEEDED"       // Combined packet exceeds limit
  | "PERMISSION_DENIED"         // No read access to file
  | "TIMEOUT"                   // Operation took too long
  | "UNKNOWN";

// ── Workflow state (for the React hook / UI) ──

export type WorkflowStep =
  | "idle"
  | "selecting-folder"
  | "detecting-cover-letter"
  | "parsing-cover-letter"
  | "matching-documents"
  | "review-matches"       // User reviews + confirms matches
  | "configuring-packet"   // User sets assembly options
  | "assembling"
  | "complete"
  | "error";

export interface WorkflowState {
  step: WorkflowStep;
  folderId: string | null;
  folderName: string | null;
  coverLetterFileId: string | null;
  coverLetterFileName: string | null;
  parseResult: CoverLetterParseResult | null;
  matches: DocumentMatch[];
  packetConfig: PacketConfig;
  assembledPacket: AssembledPacket | null;
  progress: AssemblyProgress;
  error: WorkflowError | null;
  history: WorkflowStep[];          // For back-navigation
}

export interface AssemblyProgress {
  phase: "idle" | "downloading" | "converting" | "merging" | "numbering" | "finalizing";
  currentExhibit: string | null;
  currentFile: string | null;
  filesProcessed: number;
  filesTotal: number;
  percent: number;
  bytesProcessed: number;
  estimatedSecondsRemaining: number | null;
}

export interface WorkflowError {
  step: WorkflowStep;
  message: string;
  details: string | null;
  retryable: boolean;
  timestamp: string;
}

// ── Storage file reference (from your existing drive system) ──

export interface StorageFile {
  id: string;
  name: string;
  path: string;
  parentFolderId: string;
  mimeType: string;
  extension: string;
  size: number;
  sizeFormatted: string;
  createdAt: string;
  modifiedAt: string;
  pageCount: number | null;
  textContent: string | null;    // If pre-extracted / searchable
  tags: string[];
  metadata: Record<string, unknown>;
}

export interface StorageFolder {
  id: string;
  name: string;
  path: string;
  parentFolderId: string | null;
  childFileIds: string[];
  childFolderIds: string[];
}

// ── Default configs ──

export const DEFAULT_PACKET_CONFIG: PacketConfig = {
  includeCoverPage: false,
  includeTableOfContents: true,
  includeExhibitSeparators: true,
  separatorStyle: "full-page",
  pageNumbering: {
    enabled: true,
    startFrom: 1,
    format: "arabic",
    position: "bottom-center",
    skipCoverPage: true,
    skipSeparators: false,
    prefix: "",
  },
  stampExhibitLabels: true,
  stampPosition: "top-right",
  outputFormat: "pdf",
  outputFileName: "Immigration_Packet.pdf",
  paperSize: "letter",
  batesNumbering: null,
};
