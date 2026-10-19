import { TestBed } from '@angular/core/testing';
import { ConversationsService } from './conversations.service';

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body)
  } as unknown as Response;
}

function conversationStub(id: number) {
  return { id, title: `Συνομιλία ${id}`, created_at: '2026-01-01', updated_at: '2026-01-02' };
}

describe('ConversationsService', () => {
  let service: ConversationsService;
  let originalFetch: typeof fetch;
  let fetchSpy: jasmine.Spy;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(ConversationsService);

    originalFetch = window.fetch;
    fetchSpy = jasmine.createSpy('fetch');
    window.fetch = fetchSpy as unknown as typeof fetch;
    localStorage.setItem('nomos_token', 'test-token');
  });

  afterEach(() => {
    window.fetch = originalFetch;
    localStorage.removeItem('nomos_token');
  });

  it('lists a page with limit, offset and a search query', async () => {
    fetchSpy.and.returnValue(Promise.resolve(jsonResponse({
      conversations: [conversationStub(1)],
      total: 42
    })));

    const page = await service.listPage(10, 20, 'αστικό δίκαιο');

    expect(page.conversations.length).toBe(1);
    expect(page.total).toBe(42);

    const [rawUrl, init] = fetchSpy.calls.mostRecent().args;
    const url = new URL(String(rawUrl), 'http://localhost');
    expect(url.pathname).toBe('/api/conversations');
    expect(url.searchParams.get('limit')).toBe('10');
    expect(url.searchParams.get('offset')).toBe('20');
    expect(url.searchParams.get('q')).toBe('αστικό δίκαιο');
    expect(new Headers((init as RequestInit).headers).get('Authorization')).toMatch(/^Bearer /);
  });

  it('omits an empty search query', async () => {
    fetchSpy.and.returnValue(Promise.resolve(jsonResponse({ conversations: [], total: 0 })));

    await service.listPage(20, 0, '   ');

    const url = new URL(String(fetchSpy.calls.mostRecent().args[0]), 'http://localhost');
    expect(url.searchParams.has('q')).toBeFalse();
  });

  it('falls back to the page length when the backend omits total', async () => {
    fetchSpy.and.returnValue(Promise.resolve(jsonResponse({ conversations: [conversationStub(1), conversationStub(2)] })));

    const page = await service.listPage();

    expect(page.total).toBe(2);
  });

  it('list() returns only the conversations array', async () => {
    fetchSpy.and.returnValue(Promise.resolve(jsonResponse({ conversations: [conversationStub(3)], total: 1 })));

    const conversations = await service.list();

    expect(conversations).toEqual([conversationStub(3)]);
  });

  it('fetches a single conversation with its messages', async () => {
    fetchSpy.and.returnValue(Promise.resolve(jsonResponse({
      conversation: conversationStub(5),
      messages: [{ id: 1, role: 'user', content: 'γεια', created_at: '2026-01-01' }]
    })));

    const result = await service.get(5);

    expect(result.conversation.id).toBe(5);
    expect(result.messages.length).toBe(1);
    expect(String(fetchSpy.calls.mostRecent().args[0])).toBe('/api/conversations/5');
  });

  it('creates, renames and deletes conversations with the expected verbs', async () => {
    fetchSpy.and.returnValue(Promise.resolve(jsonResponse({ conversation: conversationStub(7) })));

    await service.create('Νέα');
    let call = fetchSpy.calls.mostRecent().args;
    expect(String(call[0])).toBe('/api/conversations');
    expect((call[1] as RequestInit).method).toBe('POST');
    expect(JSON.parse(String((call[1] as RequestInit).body))).toEqual({ title: 'Νέα' });

    fetchSpy.and.returnValue(Promise.resolve(jsonResponse({ conversation: conversationStub(7) })));
    await service.rename(7, 'Μετονομασία');
    call = fetchSpy.calls.mostRecent().args;
    expect(String(call[0])).toBe('/api/conversations/7');
    expect((call[1] as RequestInit).method).toBe('PUT');

    fetchSpy.and.returnValue(Promise.resolve(jsonResponse({ ok: true })));
    await service.remove(7);
    call = fetchSpy.calls.mostRecent().args;
    expect(String(call[0])).toBe('/api/conversations/7');
    expect((call[1] as RequestInit).method).toBe('DELETE');
  });
});
