// ═══════════════════════════════════════════════════════════════
// packetAssembler.ts — Orchestrates final packet assembly:
// cover letter on top → exhibit separators → exhibit documents,
// all merged into a single PDF with optional TOC, page numbers,
// exhibit stamps, and Bates numbering.
//
// Uses pdf-lib for PDF manipulation (no server dependency).
// Falls back to server-side conversion for non-PDF files.
// ═══════════════════════════════════════════════════════════════

import type {
  DocumentMatch, PacketConfig, PacketSection, AssembledPacket,
  TOCEntry, AssemblyError, AssemblyErrorCode, AssemblyProgress,
  ExhibitLabel, MatchedFile, BatesConfig, PageNumberingConfig,
} from "./types";
import * as storageApi from "./fileStorageApi";

// ── We assume pdf-lib is installed: npm install pdf-lib ──
// In a real project you'd import like this:
// import { PDFDocument, rgb, StandardFonts, PageSizes } from "pdf-lib";

// For this code, we'll type the imports and assume pdf-lib is available.
import { PDFDocument, rgb, StandardFonts, PageSizes, PDFFont, PDFPage } from "pdf-lib";

// ── Constants ──
const LETTER_WIDTH  = 612;   // 8.5" × 72
const LETTER_HEIGHT = 792;   // 11" × 72
const A4_WIDTH      = 595.28;
const A4_HEIGHT     = 841.89;

const MAX_FILE_SIZE  = 100 * 1024 * 1024; // 100 MB per file
const MAX_TOTAL_SIZE = 500 * 1024 * 1024; // 500 MB total

type ProgressCallback = (progress: Partial<AssemblyProgress>) => void;


// ═══════════════════════════════════════════════════════════
// MAIN ASSEMBLY
// ═══════════════════════════════════════════════════════════

/**
 * Assemble the full immigration packet.
 *
 * Order:
 * 1. (Optional) Cover page
 * 2. (Optional) Table of contents (placeholder, filled after assembly)
 * 3. Cover letter
 * 4. For each exhibit in order:
 *    a. (Optional) Exhibit separator page
 *    b. All matched documents in order
 */
export async function assemblePacket(
  coverLetterFileId: string,
  matches: DocumentMatch[],
  config: PacketConfig,
  folderId: string,
  onProgress?: ProgressCallback
): Promise<AssembledPacket> {
  const startTime = Date.now();
  const errors: AssemblyError[] = [];
  const warnings: string[] = [];
  const sections: PacketSection[] = [];

  const pageSize = config.paperSize === "a4"
    ? { width: A4_WIDTH, height: A4_HEIGHT }
    : { width: LETTER_WIDTH, height: LETTER_HEIGHT };

  // Sort matches by exhibit sort key
  const sortedMatches = [...matches]
    .filter(m => m.matchedFiles.length > 0)
    .sort((a, b) => a.exhibitLabel.sortKey - b.exhibitLabel.sortKey);

  // Count total files for progress tracking
  const totalFiles = 1 + sortedMatches.reduce((sum, m) => sum + m.matchedFiles.length, 0);
  let filesProcessed = 0;

  const emitProgress = (partial: Partial<AssemblyProgress>) => {
    onProgress?.({
      phase: "downloading",
      currentExhibit: null,
      currentFile: null,
      filesProcessed,
      filesTotal: totalFiles,
      percent: Math.round((filesProcessed / totalFiles) * 90), // reserve 10% for finalization
      bytesProcessed: 0,
      estimatedSecondsRemaining: null,
      ...partial,
    });
  };

  // ── Create the master PDF ──
  const masterPdf = await PDFDocument.create();
  const font = await masterPdf.embedFont(StandardFonts.Helvetica);
  const fontBold = await masterPdf.embedFont(StandardFonts.HelveticaBold);
  let currentPage = 1;

  // ── Phase 1: Cover page (optional) ──
  if (config.includeCoverPage) {
    emitProgress({ phase: "merging", currentFile: "Cover page" });
    const coverPageCount = addCoverPage(masterPdf, fontBold, font, pageSize, config, sortedMatches);
    sections.push({
      type: "cover-page",
      label: "Cover Page",
      exhibitLabel: null,
      sourceFileId: null,
      sourceFileName: null,
      pageCount: coverPageCount,
      startPage: currentPage,
      endPage: currentPage + coverPageCount - 1,
    });
    currentPage += coverPageCount;
  }

  // ── Phase 2: TOC placeholder (we'll come back and fill it) ──
  let tocStartPage = currentPage;
  let tocPageCount = 0;
  if (config.includeTableOfContents) {
    // Reserve pages — we'll fill after we know all page numbers.
    // Estimate: 1 page per ~25 entries
    const entryCount = 1 + sortedMatches.length + sortedMatches.reduce(
      (s, m) => s + m.matchedFiles.length, 0
    );
    tocPageCount = Math.max(1, Math.ceil(entryCount / 25));

    for (let i = 0; i < tocPageCount; i++) {
      masterPdf.addPage([pageSize.width, pageSize.height]);
    }

    sections.push({
      type: "toc",
      label: "Table of Contents",
      exhibitLabel: null,
      sourceFileId: null,
      sourceFileName: null,
      pageCount: tocPageCount,
      startPage: tocStartPage,
      endPage: tocStartPage + tocPageCount - 1,
    });
    currentPage += tocPageCount;
  }

  // ── Phase 3: Cover letter ──
  emitProgress({ phase: "downloading", currentFile: "Cover letter" });
  const coverLetterResult = await safeLoadPdf(coverLetterFileId, "Cover Letter", errors);
  if (coverLetterResult) {
    emitProgress({ phase: "merging", currentFile: "Cover letter" });
    const pages = await masterPdf.copyPages(coverLetterResult, coverLetterResult.getPageIndices());
    const clPageCount = pages.length;

    for (const page of pages) {
      masterPdf.addPage(page);
    }

    sections.push({
      type: "cover-letter",
      label: "Cover Letter",
      exhibitLabel: null,
      sourceFileId: coverLetterFileId,
      sourceFileName: null,
      pageCount: clPageCount,
      startPage: currentPage,
      endPage: currentPage + clPageCount - 1,
    });
    currentPage += clPageCount;
  }
  filesProcessed++;
  emitProgress({});

  // ── Phase 4: Exhibits ──
  for (const match of sortedMatches) {
    const exhibitLabel = match.exhibitLabel;

    emitProgress({
      phase: "merging",
      currentExhibit: exhibitLabel.raw,
    });

    // ── Separator page ──
    if (config.includeExhibitSeparators) {
      const sepPageCount = addSeparatorPage(
        masterPdf, fontBold, font, pageSize, exhibitLabel, config
      );
      sections.push({
        type: "exhibit-separator",
        label: `${exhibitLabel.raw} — Separator`,
        exhibitLabel,
        sourceFileId: null,
        sourceFileName: null,
        pageCount: sepPageCount,
        startPage: currentPage,
        endPage: currentPage + sepPageCount - 1,
      });
      currentPage += sepPageCount;
    }

    // ── Exhibit documents ──
    const sortedFiles = [...match.matchedFiles].sort((a, b) => a.sortOrder - b.sortOrder);

    for (const matchedFile of sortedFiles) {
      emitProgress({
        phase: "downloading",
        currentExhibit: exhibitLabel.raw,
        currentFile: matchedFile.fileName,
      });

      // Download + convert to PDF if necessary
      const docPdf = await safeLoadFileAsPdf(matchedFile, errors);

      if (!docPdf) {
        filesProcessed++;
        emitProgress({});
        continue;
      }

      emitProgress({
        phase: "merging",
        currentExhibit: exhibitLabel.raw,
        currentFile: matchedFile.fileName,
      });

      try {
        const pages = await masterPdf.copyPages(docPdf, docPdf.getPageIndices());
        const docPageCount = pages.length;

        // Stamp exhibit label on first page if configured
        if (config.stampExhibitLabels && pages.length > 0) {
          stampExhibitLabel(pages[0], fontBold, exhibitLabel, config.stampPosition, pageSize);
        }

        for (const page of pages) {
          masterPdf.addPage(page);
        }

        sections.push({
          type: "exhibit-document",
          label: `${exhibitLabel.raw} — ${matchedFile.fileName}`,
          exhibitLabel,
          sourceFileId: matchedFile.fileId,
          sourceFileName: matchedFile.fileName,
          pageCount: docPageCount,
          startPage: currentPage,
          endPage: currentPage + docPageCount - 1,
        });
        currentPage += docPageCount;
      } catch (err: any) {
        errors.push(assemblyError(
          "PDF_MERGE_FAILED",
          `Failed to merge ${matchedFile.fileName}: ${err.message}`,
          exhibitLabel.raw,
          matchedFile.fileId,
          true
        ));
      }

      filesProcessed++;
      emitProgress({});
    }
  }

  // ── Phase 5: Page numbering ──
  if (config.pageNumbering.enabled) {
    emitProgress({ phase: "numbering", percent: 92 });
    applyPageNumbers(masterPdf, font, config.pageNumbering, sections, pageSize);
  }

  // ── Phase 5b: Bates numbering ──
  if (config.batesNumbering) {
    emitProgress({ phase: "numbering", percent: 94 });
    applyBatesNumbers(masterPdf, font, config.batesNumbering, sections);
  }

  // ── Phase 6: Fill TOC ──
  const tocEntries: TOCEntry[] = [];
  if (config.includeTableOfContents) {
    emitProgress({ phase: "finalizing", percent: 95 });
    const entries = buildTOCEntries(sections);
    tocEntries.push(...entries);
    fillTOCPages(masterPdf, font, fontBold, entries, tocStartPage - 1, tocPageCount, pageSize);
  }

  // ── Phase 7: Serialize ──
  emitProgress({ phase: "finalizing", percent: 97, currentFile: "Generating PDF" });
  const pdfBytes = await masterPdf.save();

  // ── Phase 8: Upload to storage ──
  emitProgress({ phase: "finalizing", percent: 99, currentFile: "Uploading packet" });
  let outputFile;
  try {
    outputFile = await storageApi.uploadFile(
      folderId,
      config.outputFileName,
      pdfBytes.buffer as ArrayBuffer,
      "application/pdf"
    );
  } catch (err: any) {
    // If upload fails, still return the packet data — caller can handle
    errors.push(assemblyError(
      "UNKNOWN",
      `Failed to upload assembled packet: ${err.message}`,
      null, null, true
    ));
    // Create a fake output file ref
    outputFile = {
      id: "local-" + Date.now(),
      name: config.outputFileName,
      path: "",
      size: pdfBytes.length,
    };
  }

  const duration = Date.now() - startTime;
  emitProgress({ phase: "idle", percent: 100 });

  return {
    success: errors.filter(e => !e.recoverable).length === 0,
    outputFileId: outputFile.id,
    outputFileName: outputFile.name,
    outputFilePath: outputFile.path || "",
    outputFileSize: pdfBytes.length,
    totalPages: masterPdf.getPageCount(),
    sections,
    tableOfContents: tocEntries,
    errors,
    warnings,
    assembledAt: new Date().toISOString(),
    assemblyDurationMs: duration,
  };
}


// ═══════════════════════════════════════════════════════════
// PDF LOADING — with format conversion + error handling
// ═══════════════════════════════════════════════════════════

/**
 * Safely load a file as a PDFDocument.
 * Handles: direct PDF, server-side conversion for DOCX/images,
 * encrypted PDFs, corrupt files.
 */
async function safeLoadPdf(
  fileId: string,
  label: string,
  errors: AssemblyError[]
): Promise<PDFDocument | null> {
  try {
    const buffer = await storageApi.downloadFileBuffer(fileId);

    if (buffer.byteLength > MAX_FILE_SIZE) {
      errors.push(assemblyError(
        "FILE_TOO_LARGE",
        `${label} exceeds ${MAX_FILE_SIZE / 1024 / 1024}MB limit`,
        null, fileId, false
      ));
      return null;
    }

    return await PDFDocument.load(buffer, {
      ignoreEncryption: false, // will throw if encrypted
    });
  } catch (err: any) {
    if (err.message?.includes("encrypted") || err.message?.includes("password")) {
      errors.push(assemblyError(
        "ENCRYPTION_BLOCKED",
        `${label} is password-protected and cannot be merged`,
        null, fileId, false
      ));
      return null;
    }

    errors.push(assemblyError(
      "FILE_CORRUPT",
      `${label}: ${err.message}`,
      null, fileId, true
    ));
    return null;
  }
}

/**
 * Load a MatchedFile as PDF, converting if necessary.
 */
async function safeLoadFileAsPdf(
  file: MatchedFile,
  errors: AssemblyError[]
): Promise<PDFDocument | null> {
  const isPdf = file.mimeType === "application/pdf"
    || file.fileName.toLowerCase().endsWith(".pdf");

  if (isPdf) {
    return safeLoadPdf(file.fileId, file.fileName, errors);
  }

  // Not a PDF — try server-side conversion
  if (!storageApi.canConvertToPdf(file.mimeType)) {
    errors.push(assemblyError(
      "UNSUPPORTED_FORMAT",
      `${file.fileName} (${file.mimeType}) cannot be converted to PDF`,
      null, file.fileId, false
    ));
    return null;
  }

  try {
    const convertedBlob = await storageApi.convertToPdf(file.fileId);
    const buffer = await convertedBlob.arrayBuffer();
    return await PDFDocument.load(buffer);
  } catch (err: any) {
    errors.push(assemblyError(
      "CONVERSION_FAILED",
      `Failed to convert ${file.fileName} to PDF: ${err.message}`,
      null, file.fileId, true
    ));
    return null;
  }
}


// ═══════════════════════════════════════════════════════════
// PAGE GENERATION — cover pages, separators, stamps
// ═══════════════════════════════════════════════════════════

/**
 * Add a packet cover page.
 */
function addCoverPage(
  pdf: PDFDocument,
  fontBold: PDFFont,
  fontRegular: PDFFont,
  pageSize: { width: number; height: number },
  config: PacketConfig,
  exhibits: DocumentMatch[]
): number {
  const page = pdf.addPage([pageSize.width, pageSize.height]);
  const { width, height } = page.getSize();

  // Title
  page.drawText("IMMIGRATION PETITION", {
    x: width / 2 - fontBold.widthOfTextAtSize("IMMIGRATION PETITION", 24) / 2,
    y: height - 150,
    size: 24,
    font: fontBold,
    color: rgb(0.1, 0.1, 0.1),
  });

  // Subtitle
  page.drawText("Supporting Documentation Packet", {
    x: width / 2 - fontRegular.widthOfTextAtSize("Supporting Documentation Packet", 14) / 2,
    y: height - 185,
    size: 14,
    font: fontRegular,
    color: rgb(0.3, 0.3, 0.3),
  });

  // Divider line
  page.drawLine({
    start: { x: 72, y: height - 210 },
    end: { x: width - 72, y: height - 210 },
    thickness: 1,
    color: rgb(0.7, 0.7, 0.7),
  });

  // Exhibit summary
  let y = height - 250;
  page.drawText("Exhibits Included:", {
    x: 72, y, size: 12, font: fontBold, color: rgb(0.15, 0.15, 0.15),
  });
  y -= 25;

  for (const match of exhibits) {
    if (y < 72) break; // don't overflow page
    const text = `${match.exhibitLabel.raw} — ${match.matchedFiles.length} document${match.matchedFiles.length !== 1 ? "s" : ""}`;
    page.drawText(text, {
      x: 90, y, size: 10, font: fontRegular, color: rgb(0.2, 0.2, 0.2),
    });
    y -= 18;
  }

  // Date
  page.drawText(`Assembled: ${new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}`, {
    x: 72, y: 72, size: 9, font: fontRegular, color: rgb(0.5, 0.5, 0.5),
  });

  return 1;
}

/**
 * Add an exhibit separator page.
 */
function addSeparatorPage(
  pdf: PDFDocument,
  fontBold: PDFFont,
  fontRegular: PDFFont,
  pageSize: { width: number; height: number },
  label: ExhibitLabel,
  config: PacketConfig
): number {
  const page = pdf.addPage([pageSize.width, pageSize.height]);
  const { width, height } = page.getSize();

  if (config.separatorStyle === "full-page") {
    // Large centered label
    const text = label.raw.toUpperCase();
    const textWidth = fontBold.widthOfTextAtSize(text, 48);
    page.drawText(text, {
      x: width / 2 - textWidth / 2,
      y: height / 2 + 20,
      size: 48,
      font: fontBold,
      color: rgb(0.1, 0.1, 0.15),
    });

    // Decorative lines
    const lineY = height / 2 - 15;
    page.drawLine({
      start: { x: width / 2 - 120, y: lineY },
      end: { x: width / 2 + 120, y: lineY },
      thickness: 2,
      color: rgb(0.2, 0.2, 0.3),
    });
  } else if (config.separatorStyle === "half-page") {
    // Top-half banner
    page.drawRectangle({
      x: 0, y: height / 2,
      width, height: height / 2,
      color: rgb(0.95, 0.95, 0.97),
    });

    const text = label.raw.toUpperCase();
    const textWidth = fontBold.widthOfTextAtSize(text, 36);
    page.drawText(text, {
      x: width / 2 - textWidth / 2,
      y: height * 0.7,
      size: 36,
      font: fontBold,
      color: rgb(0.15, 0.15, 0.2),
    });
  } else {
    // Tab style — small label at top
    page.drawRectangle({
      x: 0, y: height - 60,
      width, height: 60,
      color: rgb(0.12, 0.12, 0.18),
    });

    const text = label.raw.toUpperCase();
    page.drawText(text, {
      x: 36,
      y: height - 40,
      size: 18,
      font: fontBold,
      color: rgb(1, 1, 1),
    });
  }

  return 1;
}

/**
 * Stamp exhibit label onto the corner of a document page.
 */
function stampExhibitLabel(
  page: PDFPage,
  font: PDFFont,
  label: ExhibitLabel,
  position: PacketConfig["stampPosition"],
  pageSize: { width: number; height: number }
) {
  const text = label.raw;
  const fontSize = 9;
  const textWidth = font.widthOfTextAtSize(text, fontSize);
  const padding = 4;
  const boxWidth = textWidth + padding * 2;
  const boxHeight = fontSize + padding * 2;
  const { width, height } = page.getSize();

  let x: number, y: number;
  switch (position) {
    case "top-right":
      x = width - boxWidth - 20;
      y = height - boxHeight - 20;
      break;
    case "top-left":
      x = 20;
      y = height - boxHeight - 20;
      break;
    case "bottom-right":
      x = width - boxWidth - 20;
      y = 20;
      break;
    case "bottom-left":
      x = 20;
      y = 20;
      break;
  }

  // White background box
  page.drawRectangle({
    x, y,
    width: boxWidth,
    height: boxHeight,
    color: rgb(1, 1, 1),
    borderColor: rgb(0.3, 0.3, 0.3),
    borderWidth: 0.5,
  });

  // Label text
  page.drawText(text, {
    x: x + padding,
    y: y + padding,
    size: fontSize,
    font,
    color: rgb(0.15, 0.15, 0.15),
  });
}


// ═══════════════════════════════════════════════════════════
// PAGE NUMBERING + BATES NUMBERING
// ═══════════════════════════════════════════════════════════

function applyPageNumbers(
  pdf: PDFDocument,
  font: PDFFont,
  config: PageNumberingConfig,
  sections: PacketSection[],
  pageSize: { width: number; height: number }
) {
  const pages = pdf.getPages();
  const skipPages = new Set<number>();

  // Build set of page indices to skip
  for (const section of sections) {
    if (config.skipCoverPage && section.type === "cover-page") {
      for (let p = section.startPage; p <= section.endPage; p++) {
        skipPages.add(p - 1); // convert to 0-indexed
      }
    }
    if (config.skipSeparators && section.type === "exhibit-separator") {
      for (let p = section.startPage; p <= section.endPage; p++) {
        skipPages.add(p - 1);
      }
    }
  }

  let displayNumber = config.startFrom;

  for (let i = 0; i < pages.length; i++) {
    if (skipPages.has(i)) continue;

    const page = pages[i];
    const { width, height } = page.getSize();

    const numText = config.prefix + formatPageNumber(displayNumber, config.format);
    const textWidth = font.widthOfTextAtSize(numText, 9);

    let x: number, y: number;
    switch (config.position) {
      case "bottom-center":
        x = width / 2 - textWidth / 2;
        y = 30;
        break;
      case "bottom-right":
        x = width - textWidth - 36;
        y = 30;
        break;
      case "top-right":
        x = width - textWidth - 36;
        y = height - 30;
        break;
    }

    page.drawText(numText, {
      x, y,
      size: 9,
      font,
      color: rgb(0.4, 0.4, 0.4),
    });

    displayNumber++;
  }
}

function formatPageNumber(num: number, format: PageNumberingConfig["format"]): string {
  switch (format) {
    case "arabic": return String(num);
    case "roman-lower": return toRoman(num).toLowerCase();
    case "roman-upper": return toRoman(num);
  }
}

function toRoman(num: number): string {
  const vals = [1000, 900, 500, 400, 100, 90, 50, 40, 10, 9, 5, 4, 1];
  const syms = ["M", "CM", "D", "CD", "C", "XC", "L", "XL", "X", "IX", "V", "IV", "I"];
  let result = "";
  for (let i = 0; i < vals.length; i++) {
    while (num >= vals[i]) { result += syms[i]; num -= vals[i]; }
  }
  return result;
}

function applyBatesNumbers(
  pdf: PDFDocument,
  font: PDFFont,
  config: BatesConfig,
  sections: PacketSection[]
) {
  const pages = pdf.getPages();
  let batesNum = config.startNumber;

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    const { width, height } = page.getSize();

    const batesText = config.prefix + String(batesNum).padStart(config.zeroPadding, "0");
    const textWidth = font.widthOfTextAtSize(batesText, 8);

    let x: number, y: number;
    switch (config.position) {
      case "bottom-right":
        x = width - textWidth - 36;
        y = 15;
        break;
      case "bottom-left":
        x = 36;
        y = 15;
        break;
    }

    page.drawText(batesText, {
      x, y,
      size: 8,
      font,
      color: rgb(0.5, 0.5, 0.5),
    });

    batesNum++;
  }
}


// ═══════════════════════════════════════════════════════════
// TABLE OF CONTENTS
// ═══════════════════════════════════════════════════════════

function buildTOCEntries(sections: PacketSection[]): TOCEntry[] {
  const entries: TOCEntry[] = [];

  for (const section of sections) {
    if (section.type === "toc") continue; // don't list the TOC itself

    if (section.type === "cover-page") {
      entries.push({ label: "Cover Page", pageNumber: section.startPage, indent: 0 });
    }
    else if (section.type === "cover-letter") {
      entries.push({ label: "Cover Letter", pageNumber: section.startPage, indent: 0 });
    }
    else if (section.type === "exhibit-separator") {
      entries.push({
        label: section.exhibitLabel?.raw || section.label,
        pageNumber: section.startPage,
        indent: 0,
      });
    }
    else if (section.type === "exhibit-document") {
      entries.push({
        label: section.sourceFileName || section.label,
        pageNumber: section.startPage,
        indent: 1,
      });
    }
  }

  return entries;
}

function fillTOCPages(
  pdf: PDFDocument,
  font: PDFFont,
  fontBold: PDFFont,
  entries: TOCEntry[],
  startPageIndex: number, // 0-indexed
  pageCount: number,
  pageSize: { width: number; height: number }
) {
  const lineHeight = 18;
  const marginTop = 80;
  const marginBottom = 60;
  const marginLeft = 72;
  const marginRight = 72;
  const maxLinesPerPage = Math.floor((pageSize.height - marginTop - marginBottom) / lineHeight);

  let entryIndex = 0;

  for (let p = 0; p < pageCount; p++) {
    const page = pdf.getPage(startPageIndex + p);
    const { width, height } = page.getSize();

    // Title on first page
    if (p === 0) {
      page.drawText("TABLE OF CONTENTS", {
        x: width / 2 - fontBold.widthOfTextAtSize("TABLE OF CONTENTS", 16) / 2,
        y: height - 50,
        size: 16,
        font: fontBold,
        color: rgb(0.1, 0.1, 0.1),
      });
    }

    let y = height - marginTop;
    let linesDrawn = 0;

    while (entryIndex < entries.length && linesDrawn < maxLinesPerPage) {
      const entry = entries[entryIndex];
      const indent = entry.indent * 20;
      const entryFont = entry.indent === 0 ? fontBold : font;
      const fontSize = entry.indent === 0 ? 11 : 10;
      const textColor = entry.indent === 0 ? rgb(0.1, 0.1, 0.1) : rgb(0.25, 0.25, 0.25);

      // Truncate long names
      let label = entry.label;
      const maxLabelWidth = width - marginLeft - marginRight - indent - 50; // space for page num
      while (entryFont.widthOfTextAtSize(label, fontSize) > maxLabelWidth && label.length > 3) {
        label = label.slice(0, -4) + "…";
      }

      // Draw label
      page.drawText(label, {
        x: marginLeft + indent,
        y,
        size: fontSize,
        font: entryFont,
        color: textColor,
      });

      // Draw page number right-aligned
      const pageNumText = String(entry.pageNumber);
      const pageNumWidth = font.widthOfTextAtSize(pageNumText, fontSize);
      page.drawText(pageNumText, {
        x: width - marginRight - pageNumWidth,
        y,
        size: fontSize,
        font,
        color: textColor,
      });

      // Dot leader between label and page number
      const labelEnd = marginLeft + indent + entryFont.widthOfTextAtSize(label, fontSize) + 5;
      const dotsStart = labelEnd;
      const dotsEnd = width - marginRight - pageNumWidth - 5;
      if (dotsEnd - dotsStart > 20) {
        let dotX = dotsStart;
        while (dotX < dotsEnd) {
          page.drawText(".", {
            x: dotX, y: y + 1,
            size: 8, font, color: rgb(0.7, 0.7, 0.7),
          });
          dotX += 5;
        }
      }

      y -= lineHeight;
      linesDrawn++;
      entryIndex++;
    }
  }
}


// ═══════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════

function assemblyError(
  code: AssemblyErrorCode,
  message: string,
  exhibitLabel: string | null,
  fileId: string | null,
  recoverable: boolean
): AssemblyError {
  return { code, message, exhibitLabel, fileId, recoverable };
}
