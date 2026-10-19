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

  beforeEach(async () => {
    originalFetch = window.fetch;
    fetchSpy = jasmine.createSpy('fetch');
    window.fetch = fetchSpy as unknown as typeof fetch;
    localStorage.setItem('nomos_token', 'test-token');

    confirmStub = { ask: jasmine.createSpy('ask').and.resolveTo(true) };

    await TestBed.configureTestingModule({
      imports: [AdminDocumentsComponent],
      providers: [
        // 2-8: the admin-documents template renders through the translate
        // pipe and the confirm-dialog copy is resolved via
        // TranslateService.instant().
        ...provideTestTranslate(),
        { provide: ConfirmService, useValue: confirmStub }
      ]
    }).compileComponents();

    fetchSpy.and.callFake((_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        return Promise.resolve(jsonResponse({ ok: true }));
      }
      return Promise.resolve(jsonResponse({ documents: [documentStub(1), documentStub(2)] }));
    });

    await init();
  });

  afterEach(() => {
    window.fetch = originalFetch;
    localStorage.removeItem('nomos_token');
  });

  it('loads the user documents from the admin endpoint', () => {
    expect(fetchSpy).toHaveBeenCalled();
    const url = String(fetchSpy.calls.mostRecent().args[0]);
    expect(url).toBe('/api/admin/documents?limit=100');
    expect(component.documents.length).toBe(2);
    expect(component.documents[0].filename).toBe('doc-1.pdf');
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
    fetchSpy.and.returnValue(Promise.resolve(jsonResponse({ documents: [] })));
    await init();

    expect(component.documents.length).toBe(0);
    expect(fixture.nativeElement.textContent).toContain(
      lookupTranslation('el', 'adminDocuments.empty')!
    );
  });

  it('deletes a document after the confirmation', async () => {
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
    expect(component.documents.some(doc => doc.id === 2)).toBeFalse();
    expect(component.documents.length).toBe(1);
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
      return Promise.resolve(jsonResponse({ documents: [documentStub(1), documentStub(2)] }));
    });

    await component.deleteDoc(documentStub(2));
    fixture.detectChanges();

    expect(component.error).toBe(lookupTranslation('el', 'adminDocuments.deleteError')!);
    expect(component.error).not.toContain('Delete failed');
    expect(component.error).not.toContain('Access denied');
    expect(fixture.nativeElement.textContent).not.toContain('Delete failed');
    expect(fixture.nativeElement.textContent).not.toContain('Access denied');
    // The document survives a failed deletion.
    expect(component.documents.some(doc => doc.id === 2)).toBeTrue();
  });
});
