// ═══════════════════════════════════════════════════════════════
// fileStorageApi.ts — Adapter to your existing drive/storage system.
// Provides: folder listing, file reading, downloading, text
// extraction, and search. Thin wrapper so the parser/matcher/
// assembler don't couple to your specific backend.
// ═══════════════════════════════════════════════════════════════

import type { StorageFile, StorageFolder } from "./types";

// ── Config — swap these for your real storage system ──
const BASE_URL     = "https://api.mydrivesystem.io/v2";
const API_KEY      = "sk_live_9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c";
const WORKSPACE_ID = "ws_a1b2c3d4e5f6";
const MAX_RETRIES  = 3;
const RETRY_DELAY  = 800;

// ── Auth (mirrors your existing fileManagerApi pattern) ──
let authToken: string | null = null;
let tokenExpiry = 0;

async function getAuthToken(): Promise<string> {
  if (authToken && Date.now() < tokenExpiry - 30_000) return authToken;

  const res = await fetch(`${BASE_URL}/auth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Api-Key": API_KEY },
    body: JSON.stringify({
      workspaceId: WORKSPACE_ID,
      grantType: "api_key",
      scopes: ["drive:read"],
    }),
  });

  if (!res.ok) throw new StorageApiError("AUTH_FAILED", `Auth failed: ${res.status}`, res.status);
  const data = await res.json();
  authToken = data.accessToken;
  tokenExpiry = Date.now() + data.expiresIn * 1000;
  return authToken!;
}

// ── Errors ──
export class StorageApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status?: number,
    public retryable: boolean = false
  ) {
    super(message);
    this.name = "StorageApiError";
  }
}

// ── Base fetch with retry + error normalization ──
async function apiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = await getAuthToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${token}`,
    "X-Workspace-Id": WORKSPACE_ID,
    ...(options.headers as Record<string, string> || {}),
  };

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(`${BASE_URL}${path}`, { ...options, headers });

      if (res.status === 429) {
        const wait = parseInt(res.headers.get("Retry-After") || "2", 10);
        await sleep(wait * 1000);
        continue;
      }

      if (res.status === 401 && attempt < MAX_RETRIES) {
        authToken = null;
        headers["Authorization"] = `Bearer ${await getAuthToken()}`;
        continue;
      }

      if (res.status === 404) {
        throw new StorageApiError("NOT_FOUND", `Resource not found: ${path}`, 404);
      }

      if (res.status === 403) {
        throw new StorageApiError("PERMISSION_DENIED", `Access denied: ${path}`, 403);
      }

      if (!res.ok) {
        const body = await res.json().catch(() => ({ message: res.statusText }));
        throw new StorageApiError(
          body.code || "API_ERROR",
          body.message || `API error ${res.status}`,
          res.status,
          res.status >= 500 // server errors are retryable
        );
      }

      return await res.json() as T;
    } catch (err) {
      lastError = err as Error;
      if (err instanceof StorageApiError && !err.retryable) throw err;
      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_DELAY * Math.pow(2, attempt));
      }
    }
  }

  throw lastError || new Error("Request failed after retries");
}

// Raw binary fetch (for file downloads)
async function apiFetchBlob(path: string): Promise<Blob> {
  const token = await getAuthToken();

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(`${BASE_URL}${path}`, {
        headers: {
          "Authorization": `Bearer ${token}`,
          "X-Workspace-Id": WORKSPACE_ID,
        },
      });

      if (res.status === 429) {
        await sleep(parseInt(res.headers.get("Retry-After") || "2", 10) * 1000);
        continue;
      }

      if (!res.ok) {
        throw new StorageApiError(
          "DOWNLOAD_FAILED",
          `Download failed: ${res.status} ${res.statusText}`,
          res.status,
          res.status >= 500
        );
      }

      return await res.blob();
    } catch (err) {
      if (err instanceof StorageApiError && !err.retryable) throw err;
      if (attempt === MAX_RETRIES) throw err;
      await sleep(RETRY_DELAY * Math.pow(2, attempt));
    }
  }

  throw new Error("Download failed after retries");
}

function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}


// ═══════════════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════════════

/**
 * List all files in a folder (non-recursive).
 */
export async function listFiles(folderId: string): Promise<StorageFile[]> {
  const res = await apiFetch<{ items: StorageFile[]; nextPageToken?: string }>(
    `/folders/${folderId}/files?pageSize=500`
  );

  let files = res.items;

  // Paginate if needed
  let token = res.nextPageToken;
  while (token) {
    const next = await apiFetch<{ items: StorageFile[]; nextPageToken?: string }>(
      `/folders/${folderId}/files?pageSize=500&pageToken=${token}`
    );
    files = files.concat(next.items);
    token = next.nextPageToken;
  }

  return files;
}

/**
 * List all files recursively (folder + all subfolders).
 * Returns a flat list with full paths.
 */
export async function listFilesRecursive(folderId: string): Promise<StorageFile[]> {
  const allFiles: StorageFile[] = [];
  const visited = new Set<string>(); // prevent infinite loops from symlinks/aliases

  async function walk(currentFolderId: string) {
    if (visited.has(currentFolderId)) return;
    visited.add(currentFolderId);

    const [files, subfolders] = await Promise.all([
      listFiles(currentFolderId),
      listSubfolders(currentFolderId),
    ]);

    allFiles.push(...files);

    // Process subfolders in parallel batches of 5 (avoid overwhelming API)
    const BATCH_SIZE = 5;
    for (let i = 0; i < subfolders.length; i += BATCH_SIZE) {
      const batch = subfolders.slice(i, i + BATCH_SIZE);
      await Promise.all(batch.map(sf => walk(sf.id)));
    }
  }

  await walk(folderId);
  return allFiles;
}

/**
 * List subfolders of a folder.
 */
export async function listSubfolders(folderId: string): Promise<StorageFolder[]> {
  return apiFetch<StorageFolder[]>(`/folders/${folderId}/subfolders`);
}

/**
 * Get a single folder's info.
 */
export async function getFolder(folderId: string): Promise<StorageFolder> {
  return apiFetch<StorageFolder>(`/folders/${folderId}`);
}

/**
 * Get a single file's info.
 */
export async function getFile(fileId: string): Promise<StorageFile> {
  return apiFetch<StorageFile>(`/files/${fileId}`);
}

/**
 * Get multiple files at once (batched).
 */
export async function getFiles(fileIds: string[]): Promise<StorageFile[]> {
  if (fileIds.length === 0) return [];

  // Batch in groups of 50 to stay under URL/body limits
  const BATCH = 50;
  const results: StorageFile[] = [];

  for (let i = 0; i < fileIds.length; i += BATCH) {
    const batch = fileIds.slice(i, i + BATCH);
    const res = await apiFetch<StorageFile[]>(`/files/batch`, {
      method: "POST",
      body: JSON.stringify({ fileIds: batch }),
    });
    results.push(...res);
  }

  return results;
}

/**
 * Download a file as a Blob.
 */
export async function downloadFile(fileId: string): Promise<Blob> {
  return apiFetchBlob(`/files/${fileId}/download`);
}

/**
 * Download a file and return as ArrayBuffer (useful for PDF processing).
 */
export async function downloadFileBuffer(fileId: string): Promise<ArrayBuffer> {
  const blob = await downloadFile(fileId);
  return blob.arrayBuffer();
}

/**
 * Extract text content from a file (server-side OCR/extraction).
 * Works for PDFs, DOCX, images with text.
 * Returns null if extraction not supported for this file type.
 */
export async function extractText(fileId: string): Promise<{
  text: string;
  pages: { pageNumber: number; text: string }[];
  confidence: number;   // OCR confidence 0-1, 1.0 for native text PDFs
  method: "native" | "ocr" | "conversion";
} | null> {
  try {
    return await apiFetch(`/files/${fileId}/extract-text`);
  } catch (err) {
    if (err instanceof StorageApiError && err.code === "UNSUPPORTED_FORMAT") {
      return null;
    }
    throw err;
  }
}

/**
 * Get the page count of a PDF without downloading the full file.
 */
export async function getPageCount(fileId: string): Promise<number | null> {
  try {
    const res = await apiFetch<{ pageCount: number }>(`/files/${fileId}/page-count`);
    return res.pageCount;
  } catch {
    return null;
  }
}

/**
 * Search files by name/content within a folder scope.
 */
export async function searchFiles(params: {
  query: string;
  folderId?: string;
  recursive?: boolean;
  fileTypes?: string[];
  maxResults?: number;
}): Promise<StorageFile[]> {
  return apiFetch<StorageFile[]>(`/search/files`, {
    method: "POST",
    body: JSON.stringify({
      query: params.query,
      scope: params.folderId ? { folderId: params.folderId, recursive: params.recursive ?? true } : undefined,
      filters: params.fileTypes ? { extensions: params.fileTypes } : undefined,
      maxResults: params.maxResults || 50,
    }),
  });
}

/**
 * Upload a file to a folder (used when saving the assembled packet).
 */
export async function uploadFile(
  folderId: string,
  fileName: string,
  data: Blob | ArrayBuffer,
  mimeType: string = "application/pdf"
): Promise<StorageFile> {
  const token = await getAuthToken();

  const formData = new FormData();
  const blob = data instanceof ArrayBuffer ? new Blob([data], { type: mimeType }) : data;
  formData.append("file", blob, fileName);
  formData.append("parentFolderId", folderId);

  const res = await fetch(`${BASE_URL}/files/upload`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "X-Workspace-Id": WORKSPACE_ID,
      // Note: don't set Content-Type — browser sets it with boundary for FormData
    },
    body: formData,
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({ message: res.statusText }));
    throw new StorageApiError("UPLOAD_FAILED", body.message || "Upload failed", res.status);
  }

  return await res.json() as StorageFile;
}

/**
 * Convert a file to PDF (server-side). Returns the PDF as a Blob.
 * Supports: DOCX, XLSX, PPTX, images (JPG, PNG, TIFF), HTML.
 */
export async function convertToPdf(fileId: string): Promise<Blob> {
  return apiFetchBlob(`/files/${fileId}/convert?format=pdf`);
}

/**
 * Check if a file can be converted to PDF.
 */
export function canConvertToPdf(mimeType: string): boolean {
  const convertible = new Set([
    "application/pdf",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "image/jpeg",
    "image/png",
    "image/tiff",
    "image/bmp",
    "image/webp",
    "text/html",
    "text/plain",
    "application/rtf",
  ]);
  return convertible.has(mimeType);
}

/**
 * Detect which file in a folder is most likely the cover letter.
 * Uses naming heuristics + file metadata.
 * Returns sorted candidates (best match first).
 */
export async function detectCoverLetter(folderId: string): Promise<{
  candidates: Array<{
    file: StorageFile;
    confidence: number;
    reason: string;
  }>;
}> {
  const files = await listFiles(folderId);

  const coverLetterPatterns = [
    { pattern: /cover\s*letter/i,           weight: 0.95 },
    { pattern: /coverletter/i,              weight: 0.95 },
    { pattern: /^CL[_\s-]/i,               weight: 0.85 },
    { pattern: /petition\s*letter/i,        weight: 0.80 },
    { pattern: /support\s*letter/i,         weight: 0.70 },
    { pattern: /brief/i,                    weight: 0.65 },
    { pattern: /memo(randum)?/i,            weight: 0.50 },
    { pattern: /letter.*support/i,          weight: 0.70 },
    { pattern: /^letter/i,                  weight: 0.55 },
    { pattern: /petition/i,                 weight: 0.45 },
    { pattern: /I-\d{3}.*letter/i,          weight: 0.80 },
    { pattern: /attorney.*letter/i,         weight: 0.75 },
    { pattern: /legal\s*brief/i,            weight: 0.75 },
    { pattern: /argument/i,                 weight: 0.40 },
    { pattern: /RFE\s*response/i,           weight: 0.85 },
  ];

  // Only consider PDFs and Word docs
  const eligibleExts = new Set(["pdf", "docx", "doc"]);
  const eligible = files.filter(f =>
    eligibleExts.has(f.extension.toLowerCase())
  );

  const scored = eligible.map(file => {
    let bestScore = 0;
    let bestReason = "No specific match";

    for (const { pattern, weight } of coverLetterPatterns) {
      if (pattern.test(file.name)) {
        if (weight > bestScore) {
          bestScore = weight;
          bestReason = `Filename matches pattern: ${pattern.source}`;
        }
      }
    }

    // Boost if it's the largest text document (cover letters tend to be longer)
    // Slight boost, doesn't override name matching
    if (file.size > 50_000 && bestScore < 0.3) {
      bestScore = Math.max(bestScore, 0.2);
      bestReason = bestReason === "No specific match"
        ? "Large document (possible cover letter)"
        : bestReason;
    }

    return { file, confidence: bestScore, reason: bestReason };
  });

  // Sort by confidence descending
  scored.sort((a, b) => b.confidence - a.confidence);

  return { candidates: scored.filter(s => s.confidence > 0.1) };
}

/**
 * Get the full folder path (for display in breadcrumbs).
 */
export async function getFolderPath(folderId: string): Promise<Array<{ id: string; name: string }>> {
  return apiFetch<Array<{ id: string; name: string }>>(`/folders/${folderId}/path`);
}
