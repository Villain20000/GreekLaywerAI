import { TestBed } from '@angular/core/testing';
import { DocumentService, LegalDocument } from './document.service';
import { QuotaExceededError } from './quota.service';

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body))
  } as unknown as Response;
}

class FakeXhr {
  static instances: FakeXhr[] = [];
  static autoComplete = true;

  upload: { onprogress?: (event: ProgressEvent) => void } = {};
  status = 0;
  responseText = '';
  method = '';
  url = '';
  headers: Record<string, string> = {};
  sentBody: FormData | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;

  constructor() {
    FakeXhr.instances.push(this);
  }

  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
  }

  setRequestHeader(key: string, value: string): void {
    this.headers[key] = value;
  }

  send(body: FormData): void {
    this.sentBody = body;
    this.upload.onprogress?.({ lengthComputable: true, loaded: 50, total: 100 } as ProgressEvent);
    if (!FakeXhr.autoComplete) return;
    this.status = 201;
    this.responseText = JSON.stringify({
      document: {
        id: 5,
        filename: 'test.pdf',
        content_type: 'application/pdf',
        metadata: { size_bytes: 10 },
        created_at: '2026-01-01'
      },
      chunkCount: 2
    });
    this.onload?.();
  }
}

function documentStub(id: number): LegalDocument {
  return {
    id,
    filename: `doc-${id}.pdf`,
    title: null,
    content_type: 'application/pdf',
    metadata: { size_bytes: 1024 },
    created_at: '2026-01-01'
  };
}

describe('DocumentService', () => {
  let service: DocumentService;
  let originalFetch: typeof fetch;
  let fetchSpy: jasmine.Spy;
  let originalXhr: typeof XMLHttpRequest;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(DocumentService);

    originalFetch = window.fetch;
    fetchSpy = jasmine.createSpy('fetch');
    window.fetch = fetchSpy as unknown as typeof fetch;

    originalXhr = window.XMLHttpRequest;
    FakeXhr.instances = [];
    FakeXhr.autoComplete = true;
    localStorage.setItem('nomos_token', 'test-token');
    window.XMLHttpRequest = FakeXhr as unknown as typeof XMLHttpRequest;
  });

  afterEach(() => {
    window.fetch = originalFetch;
    window.XMLHttpRequest = originalXhr;
    localStorage.removeItem('nomos_token');
  });

  it('lists documents with pagination parameters', async () => {
    fetchSpy.and.returnValue(Promise.resolve(jsonResponse({ documents: [documentStub(1)] })));

    const documents = await service.list(10, 20);

    expect(documents.length).toBe(1);
    const [url, init] = fetchSpy.calls.mostRecent().args;
    expect(String(url)).toBe('/api/documents?limit=10&offset=20');
    expect(new Headers((init as RequestInit).headers).get('Authorization')).toBe('Bearer test-token');
  });

  it('fetches a single document from GET /api/documents/:id', async () => {
    fetchSpy.and.returnValue(Promise.resolve(jsonResponse({ document: documentStub(5) })));

    const document = await service.get(5);

    expect(document.id).toBe(5);
    expect(String(fetchSpy.calls.mostRecent().args[0])).toBe('/api/documents/5');
  });

  it('fetches extracted content from GET /api/documents/:id/content', async () => {
    fetchSpy.and.returnValue(Promise.resolve({
      ok: true,
      status: 200,
      text: () => Promise.resolve('Περιεχόμενο εγγράφου')
    } as unknown as Response));

    const content = await service.getContent(5);

    expect(content).toBe('Περιεχόμενο εγγράφου');
    expect(String(fetchSpy.calls.mostRecent().args[0])).toBe('/api/documents/5/content');
  });

  it('uploads via XHR with auth header and progress callbacks', async () => {
    const file = new File(['hello'], 'test.pdf', { type: 'application/pdf' });
    const progress: number[] = [];

    const result = await service.upload(file, 'Τίτλος', percent => progress.push(percent));

    expect(result.document.id).toBe(5);
    expect(result.chunkCount).toBe(2);
    expect(progress).toEqual([50]);

    const xhr = FakeXhr.instances[0];
    expect(xhr.method).toBe('POST');
    expect(xhr.url).toBe('/api/documents');
    expect(xhr.headers['Authorization']).toMatch(/^Bearer /);
    expect(xhr.sentBody instanceof FormData).toBeTrue();
    expect((xhr.sentBody as FormData).get('title')).toBe('Τίτλος');
    expect(((xhr.sentBody as FormData).get('file') as File).name).toBe('test.pdf');
  });

  it('rejects uploads with the server error message', async () => {
    FakeXhr.autoComplete = false;
    const file = new File(['hello'], 'test.pdf', { type: 'application/pdf' });
    const promise = service.upload(file);

    const xhr = FakeXhr.instances[0];
    xhr.status = 413;
    xhr.responseText = JSON.stringify({ error: 'File too large' });
    xhr.onload?.();

    await expectAsync(promise).toBeRejectedWithError('File too large');
  });

  it('rejects uploads with a quota error when the document cap is reached (403)', async () => {
    FakeXhr.autoComplete = false;
    const file = new File(['hello'], 'test.pdf', { type: 'application/pdf' });
    const promise = service.upload(file);

    const xhr = FakeXhr.instances[0];
    xhr.status = 403;
    xhr.responseText = JSON.stringify({
      error: 'Document limit reached for your plan',
      limit: 10,
      used: 10,
      tier: 'basic'
    });
    xhr.onload?.();

    let caught: unknown = null;
    try {
      await promise;
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(QuotaExceededError);
    const quotaError = caught as QuotaExceededError;
    expect(quotaError.kind).toBe('documents');
    expect(quotaError.limit).toBe(10);
    expect(quotaError.used).toBe(10);
    expect(quotaError.tier).toBe('basic');
    expect(quotaError.resetAt).toBeNull();
  });

  it('omits the Authorization header entirely when there is no token', async () => {
    localStorage.removeItem('nomos_token');
    fetchSpy.and.returnValue(Promise.resolve(jsonResponse({ documents: [] })));

    await service.list();

    const init = fetchSpy.calls.mostRecent().args[1] as RequestInit;
    expect(new Headers(init.headers).get('Authorization')).toBeNull();
  });

  it('searches documents with a JSON body', async () => {
    fetchSpy.and.returnValue(Promise.resolve(jsonResponse({ results: [] })));

    await service.search('άρθρο 57', 3);

    const [url, init] = fetchSpy.calls.mostRecent().args;
    expect(String(url)).toBe('/api/documents/search');
    expect((init as RequestInit).method).toBe('POST');
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ query: 'άρθρο 57', limit: 3 });
  });

  it('deletes a document', async () => {
    fetchSpy.and.returnValue(Promise.resolve(jsonResponse({ ok: true })));

    await service.remove(8);

    const [url, init] = fetchSpy.calls.mostRecent().args;
    expect(String(url)).toBe('/api/documents/8');
    expect((init as RequestInit).method).toBe('DELETE');
  });
});
