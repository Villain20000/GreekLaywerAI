import { Injectable } from '@angular/core';
import { environment } from '../../environments/environment';
import { apiFetch } from './api-client';

export interface Conversation {
  id: number;
  title: string;
  created_at: string;
  updated_at: string;
}

import type { AnswerSource } from './ai.service';

export interface Message {
  id: number;
  role: 'user' | 'assistant' | 'system';
  content: string;
  citation_metadata?: {
    sources?: AnswerSource[];
    confidence?: number;
  } | null;
  feedback_helpful?: boolean | null;
  created_at: string;
}

export interface ConversationPage {
  conversations: Conversation[];
  total: number;
}

export interface MessagePageOptions {
  messageLimit?: number;
  before?: number;
}

export interface ConversationMessagesPage {
  conversation: Conversation;
  messages: Message[];
  /** True when at least one message older than this page exists. */
  hasMore: boolean;
  /** Oldest message id in this page; pass it as `before` for the next page. */
  nextCursor: number | null;
}

@Injectable({
  providedIn: 'root'
})
export class ConversationsService {
  private apiUrl = `${environment.apiBaseUrl}/api/conversations`;

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${localStorage.getItem('nomos_token') || ''}` };
  }

  /** One page of conversations plus the total match count. */
  async listPage(limit = 20, offset = 0, q = ''): Promise<ConversationPage> {
    const params = new URLSearchParams({
      limit: String(limit),
      offset: String(offset)
    });
    if (q.trim()) params.set('q', q.trim());
    const res = await apiFetch(`${this.apiUrl}?${params.toString()}`, { headers: this.headers() });
    if (!res.ok) throw new Error(`List conversations failed (HTTP ${res.status})`);
    const data = await res.json();
    const conversations: Conversation[] = data.conversations || [];
    const total = Number.isFinite(Number(data.total)) ? Number(data.total) : conversations.length;
    return { conversations, total };
  }

  /** Backwards-compatible array-only helper used by the chat side panel. */
  async list(limit = 20, offset = 0, q = ''): Promise<Conversation[]> {
    const page = await this.listPage(limit, offset, q);
    return page.conversations;
  }

  async create(title?: string): Promise<Conversation> {
    const res = await apiFetch(this.apiUrl, {
      method: 'POST',
      headers: { ...this.headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ title })
    });
    if (!res.ok) throw new Error(`Create conversation failed (HTTP ${res.status})`);
    const data = await res.json();
    return data.conversation;
  }

  /**
   * Fetch a conversation with its newest messages.
   *
   * Without options the response keeps the legacy "all messages" shape.
   * With `messageLimit` the backend returns a cursor page; `before` asks
   * for the page older than that message id.
   */
  async get(id: number, options: MessagePageOptions = {}): Promise<ConversationMessagesPage> {
    const params = new URLSearchParams();
    if (options.messageLimit !== undefined) {
      params.set('messageLimit', String(options.messageLimit));
    }
    if (options.before !== undefined) {
      params.set('before', String(options.before));
    }
    const query = params.toString();
    const res = await apiFetch(`${this.apiUrl}/${id}${query ? `?${query}` : ''}`, {
      headers: this.headers()
    });
    if (!res.ok) throw new Error(`Get conversation failed (HTTP ${res.status})`);
    const data = await res.json();
    const cursor = Number(data.nextCursor);
    return {
      conversation: data.conversation,
      messages: data.messages || [],
      hasMore: data.hasMore === true,
      nextCursor: data.nextCursor !== null && data.nextCursor !== undefined && Number.isFinite(cursor)
        ? cursor
        : null
    };
  }

  async rename(id: number, title: string): Promise<Conversation> {
    const res = await apiFetch(`${this.apiUrl}/${id}`, {
      method: 'PUT',
      headers: { ...this.headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ title })
    });
    if (!res.ok) throw new Error(`Rename conversation failed (HTTP ${res.status})`);
    const data = await res.json();
    return data.conversation;
  }

  async remove(id: number): Promise<void> {
    const res = await apiFetch(`${this.apiUrl}/${id}`, {
      method: 'DELETE',
      headers: this.headers()
    });
    if (!res.ok) throw new Error(`Delete conversation failed (HTTP ${res.status})`);
  }
}
