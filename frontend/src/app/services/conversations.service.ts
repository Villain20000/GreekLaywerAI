import { Injectable } from '@angular/core';
import { environment } from '../../environments/environment';

export interface Conversation {
  id: number;
  title: string;
  created_at: string;
  updated_at: string;
}

export interface Message {
  id: number;
  role: 'user' | 'assistant' | 'system';
  content: string;
  created_at: string;
}

@Injectable({
  providedIn: 'root'
})
export class ConversationsService {
  private apiUrl = `${environment.apiBaseUrl}/api/conversations`;

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${localStorage.getItem('nomos_token') || ''}` };
  }

  async list(limit = 20, offset = 0): Promise<Conversation[]> {
    const res = await fetch(`${this.apiUrl}?limit=${limit}&offset=${offset}`, { headers: this.headers() });
    if (!res.ok) throw new Error(`List conversations failed (HTTP ${res.status})`);
    const data = await res.json();
    return data.conversations || [];
  }

  async create(title?: string): Promise<Conversation> {
    const res = await fetch(this.apiUrl, {
      method: 'POST',
      headers: { ...this.headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ title })
    });
    if (!res.ok) throw new Error(`Create conversation failed (HTTP ${res.status})`);
    const data = await res.json();
    return data.conversation;
  }

  async get(id: number): Promise<{ conversation: Conversation; messages: Message[] }> {
    const res = await fetch(`${this.apiUrl}/${id}`, { headers: this.headers() });
    if (!res.ok) throw new Error(`Get conversation failed (HTTP ${res.status})`);
    return res.json();
  }

  async rename(id: number, title: string): Promise<Conversation> {
    const res = await fetch(`${this.apiUrl}/${id}`, {
      method: 'PUT',
      headers: { ...this.headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ title })
    });
    if (!res.ok) throw new Error(`Rename conversation failed (HTTP ${res.status})`);
    const data = await res.json();
    return data.conversation;
  }

  async remove(id: number): Promise<void> {
    const res = await fetch(`${this.apiUrl}/${id}`, {
      method: 'DELETE',
      headers: this.headers()
    });
    if (!res.ok) throw new Error(`Delete conversation failed (HTTP ${res.status})`);
  }
}
