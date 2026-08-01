import { Injectable } from '@angular/core';
import { environment } from '../../environments/environment';
import { apiFetch } from './api-client';

export interface LegalDocument {
  id: number;
  filename: string;
  title?: string | null;
  content_type: string;
  metadata: Record<string, unknown>;
  created_at: string;
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

  async list(limit = 20, offset = 0): Promise<LegalDocument[]> {
    const res = await apiFetch(`${this.apiUrl}?limit=${limit}&offset=${offset}`, {
      headers: { Authorization: `Bearer ${localStorage.getItem('nomos_token') || ''}` }
    });
    if (!res.ok) throw new Error(`List documents failed (HTTP ${res.status})`);
    const data = await res.json();
    return data.documents || [];
  }

  async upload(file: File, title?: string): Promise<{ document: LegalDocument; chunkCount: number }> {
    const formData = new FormData();
    formData.append('file', file);
    if (title) formData.append('title', title);
    const res = await apiFetch(this.apiUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${localStorage.getItem('nomos_token') || ''}` },
      body: formData
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `Upload failed (HTTP ${res.status})`);
    }
    return res.json();
  }

  async remove(id: number): Promise<void> {
    const res = await apiFetch(`${this.apiUrl}/${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${localStorage.getItem('nomos_token') || ''}` }
    });
    if (!res.ok) throw new Error(`Delete failed (HTTP ${res.status})`);
  }

  async search(query: string, limit = 5): Promise<SearchResult[]> {
    const res = await apiFetch(`${this.apiUrl}/search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${localStorage.getItem('nomos_token') || ''}`
      },
      body: JSON.stringify({ query, limit })
    });
    if (!res.ok) throw new Error(`Search failed (HTTP ${res.status})`);
    const data = await res.json();
    return data.results || [];
  }
}
