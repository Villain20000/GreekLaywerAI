import { ComponentFixture, TestBed } from '@angular/core/testing';
import { AdminDocumentsComponent } from './admin-documents.component';
import { ConfirmService } from '../../services/confirm.service';
import { lookupTranslation, provideTestTranslate } from '../../i18n/testing';

interface AdminDocumentStub {
  id: number;
  user_id: number;
  user_email?: string;
  filename: string;
  content_type: string;
  chunk_count?: number;
  created_at: string;
}

function documentStub(id: number): AdminDocumentStub {
  return {
    id,
    user_id: 10 + id,
    user_email: `user${id}@example.com`,
    filename: `doc-${id}.pdf`,
    content_type: 'application/pdf',
    chunk_count: 3,
    created_at: '2026-01-01'
  };
}

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body)
  } as unknown as Response;
}

function pageResponse(documents: AdminDocumentStub[], total: number): Response {
  return jsonResponse({ documents, total, limit: 20, offset: 0 });
}

describe('AdminDocumentsComponent', () => {
  let fixture: ComponentFixture<AdminDocumentsComponent>;
  let component: AdminDocumentsComponent;
  let confirmStub: { ask: jasmine.Spy };
  let fetchSpy: jasmine.Spy;
  let originalFetch: typeof fetch;

  async function init(): Promise<void> {
    fixture = TestBed.createComponent(AdminDocumentsComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  function lastGetUrl(): URL {
    const gets = fetchSpy.calls
      .allArgs()
      .filter(call => (call[1] as RequestInit | undefined)?.method !== 'DELETE');
    return new URL(String(gets[gets.length - 1][0]), 'http://localhost');
  }

  function getCalls(): unknown[][] {
    return fetchSpy.calls
      .allArgs()
      .filter(call => (call[1] as RequestInit | undefined)?.method !== 'DELETE');
  }

  beforeEach(async () => {
    originalFetch = window.fetch;
    fetchSpy = jasmine.createSpy('fetch');
    window.fetch = fetchSpy as unknown as typeof fetch;
    localStorage.setItem('nomos_token', 'test-token');

    confirmStub = { ask: jasmine.createSpy('ask').and.resolveTo(true) };

    await TestBed.configureTestingModule({
      imports: [AdminDocumentsComponent],
      providers: [
        ...provideTestTranslate(),
        { provide: ConfirmService, useValue: confirmStub }
      ]
    }).compileComponents();

    fetchSpy.and.callFake((_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        return Promise.resolve(jsonResponse({ ok: true }));
      }
      return Promise.resolve(pageResponse([documentStub(1), documentStub(2)], 2));
    });

    await init();
  });

  afterEach(() => {
    window.fetch = originalFetch;
    localStorage.removeItem('nomos_token');
  });

  it('loads page 1 with the 20-row page size from the admin endpoint', () => {
    expect(fetchSpy).toHaveBeenCalled();
    const url = lastGetUrl();
    expect(url.pathname).toBe('/api/admin/documents');
    expect(url.searchParams.get('limit')).toBe('20');
    expect(url.searchParams.get('offset')).toBe('0');
    expect(url.searchParams.has('q')).toBeFalse();
    expect(url.searchParams.has('userId')).toBeFalse();
    expect(component.documents.length).toBe(2);
    expect(component.total).toBe(2);
    expect(component.offset).toBe(0);
  });

  it('renders a row per user document', () => {
    const rows = fixture.nativeElement.querySelectorAll('tbody tr');
    expect(rows.length).toBe(2);

    const text = fixture.nativeElement.textContent;
    expect(text).toContain('doc-1.pdf');
    expect(text).toContain('user1@example.com');
    expect(text).toContain(lookupTranslation('el', 'adminDocuments.colFile')!);
  });

  it('renders the empty row when the admin endpoint returns nothing', async () => {
    fetchSpy.and.returnValue(Promise.resolve(pageResponse([], 0)));
    await init();

    expect(component.documents.length).toBe(0);
    expect(component.total).toBe(0);
    expect(fixture.nativeElement.textContent).toContain(
      lookupTranslation('el', 'adminDocuments.empty')!
    );
  });

  it('sends trimmed, encoded q and a numeric userId, resetting to page 1', async () => {
    component.q = '  contract & co  ';
    component.userId = 7;
    component.offset = 40;

    await component.applyFilters();
    fixture.detectChanges();

    const rawUrl = String(getCalls()[getCalls().length - 1][0]);
    expect(rawUrl).toContain('limit=20');
    expect(rawUrl).toContain('offset=0');
    expect(rawUrl).toContain('q=contract+%26+co');
    expect(rawUrl).toContain('userId=7');

    const url = lastGetUrl();
    expect(url.searchParams.get('q')).toBe('contract & co');
    expect(url.searchParams.get('userId')).toBe('7');
    expect(component.offset).toBe(0);
  });

  it('omits blank and non-positive filters', async () => {
    component.q = '   ';
    component.userId = 0;

    await component.applyFilters();

    const url = lastGetUrl();
    expect(url.searchParams.has('q')).toBeFalse();
    expect(url.searchParams.has('userId')).toBeFalse();
  });

  it('clears the filters and reloads page 1', async () => {
    component.q = 'contract';
    component.userId = 7;
    await component.applyFilters();

    await component.clearFilters();
    fixture.detectChanges();

    expect(component.q).toBe('');
    expect(component.userId).toBeNull();
    expect(component.offset).toBe(0);
    const url = lastGetUrl();
    expect(url.searchParams.has('q')).toBeFalse();
    expect(url.searchParams.has('userId')).toBeFalse();
    expect(url.searchParams.get('offset')).toBe('0');
  });

  it('pages forward and backward with accurate totals', async () => {
    const all = Array.from({ length: 45 }, (_, index) => documentStub(index + 1));
    fetchSpy.and.callFake((input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost');
      const offset = Number(url.searchParams.get('offset'));
      const limit = Number(url.searchParams.get('limit'));
      return Promise.resolve(pageResponse(all.slice(offset, offset + limit), all.length));
    });
    await init();

    expect(component.documents.length).toBe(20);
    expect(component.total).toBe(45);
    expect(component.pageStart()).toBe(1);
    expect(component.pageEnd()).toBe(20);

    const pagerButtons = fixture.nativeElement.querySelectorAll('.nl-pager button');
    expect((pagerButtons[0] as HTMLButtonElement).disabled).toBeTrue();
    expect((pagerButtons[1] as HTMLButtonElement).disabled).toBeFalse();

    await component.nextPage();
    fixture.detectChanges();
    expect(component.offset).toBe(20);
    expect(component.documents[0].id).toBe(21);
    expect(component.pageStart()).toBe(21);
    expect(component.pageEnd()).toBe(40);
    expect(lastGetUrl().searchParams.get('offset')).toBe('20');

    await component.nextPage();
    fixture.detectChanges();
    expect(component.offset).toBe(40);
    expect(component.documents.length).toBe(5);
    expect(component.pageEnd()).toBe(45);
    expect((fixture.nativeElement.querySelectorAll('.nl-pager button')[1] as HTMLButtonElement).disabled).toBeTrue();

    // Already on the last page: next is a no-op.
    await component.nextPage();
    expect(component.offset).toBe(40);

    await component.prevPage();
    expect(component.offset).toBe(20);
  });

  it('deletes a document after the confirmation and refreshes the current page', async () => {
    let docs = [documentStub(1), documentStub(2)];
    fetchSpy.and.callFake((_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        docs = docs.filter(doc => doc.id !== 2);
        return Promise.resolve(jsonResponse({ ok: true }));
      }
      return Promise.resolve(pageResponse(docs.slice(), docs.length));
    });
    await init();
    const getsBefore = getCalls().length;

    await component.deleteDoc(documentStub(2));

    expect(confirmStub.ask).toHaveBeenCalledWith(jasmine.objectContaining({
      title: lookupTranslation('el', 'adminDocuments.deleteTitle'),
      message: (lookupTranslation('el', 'adminDocuments.deleteMessage') || '')
        .replace('{{filename}}', 'doc-2.pdf')
        .replace('{{email}}', 'user2@example.com')
    }));

    const deleteCall = fetchSpy.calls.allArgs().find(call => (call[1] as RequestInit)?.method === 'DELETE');
    expect(deleteCall).toBeTruthy();
    expect(String(deleteCall![0])).toBe('/api/admin/documents/2');

    const getsAfter = getCalls();
    expect(getsAfter.length).toBe(getsBefore + 1);
    expect(String(getsAfter[getsAfter.length - 1][0])).toBe('/api/admin/documents?limit=20&offset=0');
    expect(component.documents.map(doc => doc.id)).toEqual([1]);
    expect(component.total).toBe(1);
  });

  it('steps back a page when deleting the last row of the last page', async () => {
    let docs = Array.from({ length: 21 }, (_, index) => documentStub(index + 1));
    fetchSpy.and.callFake((input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        const deletedId = Number(String(input).split('/').pop());
        docs = docs.filter(doc => doc.id !== deletedId);
        return Promise.resolve(jsonResponse({ ok: true }));
      }
      const url = new URL(String(input), 'http://localhost');
      const offset = Number(url.searchParams.get('offset'));
      const limit = Number(url.searchParams.get('limit'));
      return Promise.resolve(pageResponse(docs.slice(offset, offset + limit), docs.length));
    });
    await init();

    await component.nextPage();
    expect(component.offset).toBe(20);
    expect(component.documents.length).toBe(1);

    await component.deleteDoc(component.documents[0]);

    expect(component.offset).toBe(0);
    expect(component.total).toBe(20);
    expect(component.documents.length).toBe(20);
    expect(lastGetUrl().searchParams.get('offset')).toBe('0');
  });

  it('does not delete a document when the confirmation is dismissed', async () => {
    confirmStub.ask.and.resolveTo(false);

    await component.deleteDoc(documentStub(2));

    const deleteCall = fetchSpy.calls.allArgs().find(call => (call[1] as RequestInit)?.method === 'DELETE');
    expect(deleteCall).toBeUndefined();
    expect(component.documents.some(doc => doc.id === 2)).toBeTrue();
  });

  // ------------------------------------------------------------------
  // Error channels: the server's English prose is logged, never rendered.
  // ------------------------------------------------------------------

  it('shows the translated load copy — never the server prose — on a failed listing', async () => {
    fetchSpy.and.returnValue(Promise.resolve(jsonResponse({ error: 'Access denied.' }, 500)));
    await init();

    expect(component.error).toBe(lookupTranslation('el', 'adminDocuments.loadError')!);
    expect(component.error).not.toContain('List failed');
    expect(component.error).not.toContain('Access denied');
    expect(fixture.nativeElement.textContent).not.toContain('List failed');
    expect(fixture.nativeElement.textContent).not.toContain('Access denied');
  });

  it('shows the translated load copy — never the server prose — when the request rejects', async () => {
    fetchSpy.and.rejectWith(new Error('Access denied.'));
    await init();

    expect(component.error).toBe(lookupTranslation('el', 'adminDocuments.loadError')!);
    expect(component.error).not.toContain('Access denied');
    expect(fixture.nativeElement.textContent).not.toContain('Access denied');
  });

  it('shows the translated delete copy — never the server prose — on a failed deletion', async () => {
    fetchSpy.and.callFake((_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        return Promise.resolve(jsonResponse({ error: 'Access denied.' }, 500));
      }
      return Promise.resolve(pageResponse([documentStub(1), documentStub(2)], 2));
    });

    await component.deleteDoc(documentStub(2));
    fixture.detectChanges();

    expect(component.error).toBe(lookupTranslation('el', 'adminDocuments.deleteError')!);
    expect(component.error).not.toContain('Delete failed');
    expect(component.error).not.toContain('Access denied');
    expect(fixture.nativeElement.textContent).not.toContain('Delete failed');
    expect(fixture.nativeElement.textContent).not.toContain('Access denied');
    // The document survives a failed deletion, and no refresh is issued.
    expect(component.documents.some(doc => doc.id === 2)).toBeTrue();
    expect(getCalls().length).toBe(1);
  });
});
