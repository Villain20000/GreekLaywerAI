import { Injectable } from '@angular/core';
import { environment } from '../../environments/environment';
import { apiFetch } from './api-client';
import { parseQuotaError } from './quota.service';

export interface LegalDocument {
  id: number;
  filename: string;
  title?: string | null;
  content_type: string;
  metadata: Record<string, unknown>;
  created_at: string;
  file_size?: number | null;
  chunk_count?: number;
}

export interface SearchResult {
  chunk_id: number;
  content: string;
  chunk_index: number;
  similarity: number;
  document_id: number;
  filename: string;
  title?: string | null;
}

@Injectable({
  providedIn: 'root'
})
export class DocumentService {
  private apiUrl = `${environment.apiBaseUrl}/api/documents`;

  /**
   * Auth headers for the fetch-based calls.
   *
   * The header is OMITTED when there is no token: sending `Authorization:
   * Bearer ` (bearer + trailing space, no credential) used to override the
   * token that `apiFetch` would otherwise attach, and it is also a header
   * value that no server accepts.
   */
  private headers(): Record<string, string> {
    const token = localStorage.getItem('nomos_token');
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  async list(limit = 20, offset = 0): Promise<LegalDocument[]> {
    const res = await apiFetch(`${this.apiUrl}?limit=${limit}&offset=${offset}`, {
      headers: this.headers()
    });
    if (!res.ok) throw new Error(`List documents failed (HTTP ${res.status})`);
    const data = await res.json();
    return data.documents || [];
  }

  /** Document details incl. chunk count (GET /api/documents/:id). */
  async get(id: number): Promise<LegalDocument> {
    const res = await apiFetch(`${this.apiUrl}/${id}`, { headers: this.headers() });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `Get document failed (HTTP ${res.status})`);
    }
    const data = await res.json();
    return data.document;
  }

  /** Extracted plain-text content (GET /api/documents/:id/content?format=text). */
  async getContent(id: number): Promise<string> {
    const res = await apiFetch(`${this.apiUrl}/${id}/content?format=text`, { headers: this.headers() });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `Get document content failed (HTTP ${res.status})`);
    }
    return res.text();
  }

  /**
   * Downloads the original uploaded file. The server always sends an
   * attachment; its Content-Disposition filename (UTF-8 aware) wins over the
   * stored filename when present.
   */
  async downloadOriginal(id: number): Promise<{ blob: Blob; filename: string | null }> {
    const res = await apiFetch(`${this.apiUrl}/${id}/content?download=1`, { headers: this.headers() });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `Download document failed (HTTP ${res.status})`);
    }
    return {
      blob: await res.blob(),
      filename: this.filenameFromContentDisposition(res.headers.get('Content-Disposition'))
    };
  }

  /** Prefer RFC 5987 `filename*=UTF-8''...`, then the quoted ASCII fallback. */
  private filenameFromContentDisposition(header: string | null): string | null {
    if (!header) return null;

    const extended = /filename\*\s*=\s*[^']*''([^;]+)/i.exec(header);
    const rawExtended = extended && extended[1].trim().replace(/^"|"$/g, '');
    if (rawExtended) {
      try {
        return decodeURIComponent(rawExtended);
      } catch {
        return rawExtended;
      }
    }

    const plain = /filename\s*=\s*"([^"]+)"/i.exec(header)
      || /filename\s*=\s*([^;]+)/i.exec(header);
    return plain ? plain[1].trim() : null;
  }

  /**
   * Uploads via XMLHttpRequest so callers can render real progress.
   * Keeps the same FormData/auth/error contract as the previous fetch call.
   */
  upload(
    file: File,
    title?: string,
    onProgress?: (percent: number) => void
  ): Promise<{ document: LegalDocument; chunkCount: number }> {
    return new Promise((resolve, reject) => {
      const formData = new FormData();
      formData.append('file', file);
      if (title) formData.append('title', title);

      const xhr = new XMLHttpRequest();
      xhr.open('POST', this.apiUrl);
      const token = localStorage.getItem('nomos_token');
      if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);

      if (onProgress) {
        xhr.upload.onprogress = (event) => {
          if (event.lengthComputable && event.total > 0) {
            onProgress(Math.round((event.loaded / event.total) * 100));
          }
        };
      }

      xhr.onload = () => {
        let body: { document?: LegalDocument; chunkCount?: number; error?: string } = {};
        try {
          body = JSON.parse(xhr.responseText || '{}');
        } catch {
          body = {};
        }
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve({
            document: body.document as LegalDocument,
            chunkCount: Number(body.chunkCount) || 0
          });
          return;
        }
        if (xhr.status === 401 && token && localStorage.getItem('nomos_token') === token) {
          window.dispatchEvent(new CustomEvent('nomos:auth-expired'));
        }
        // 403 = the plan's document cap is exhausted. Keep the payload so the
        // UI can show the cap message (used/limit) instead of the raw
        // English server string.
        const quotaError = parseQuotaError(body, 'documents');
        if (quotaError) {
          reject(quotaError);
          return;
        }
        reject(new Error(body.error || `Upload failed (HTTP ${xhr.status})`));
      };
      xhr.onerror = () => reject(new Error('Upload failed (network error)'));
      xhr.onabort = () => reject(new Error('Upload aborted'));

      xhr.send(formData);
    });
  }

  async remove(id: number): Promise<void> {
    const res = await apiFetch(`${this.apiUrl}/${id}`, {
      method: 'DELETE',
      headers: this.headers()
    });
    if (!res.ok) throw new Error(`Delete failed (HTTP ${res.status})`);
  }

  async search(query: string, limit = 5): Promise<SearchResult[]> {
    const res = await apiFetch(`${this.apiUrl}/search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.headers()
      },
      body: JSON.stringify({ query, limit })
    });
    if (!res.ok) throw new Error(`Search failed (HTTP ${res.status})`);
    const data = await res.json();
    return data.results || [];
  }
}
