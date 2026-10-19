import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { DocumentsComponent } from './documents.component';
import { DocumentService, LegalDocument } from '../../services/document.service';
import { ConfirmService } from '../../services/confirm.service';
import { QuotaExceededError } from '../../services/quota.service';
import { lookupTranslation, provideTestTranslate } from '../../i18n/testing';

function documentStub(id: number): LegalDocument {
  return {
    id,
    filename: `doc-${id}.pdf`,
    title: null,
    content_type: 'application/pdf',
    metadata: { size_bytes: 2048 * id },
    created_at: '2026-01-01'
  };
}

function documents(count: number): LegalDocument[] {
  return Array.from({ length: count }, (_, index) => documentStub(index + 1));
}

describe('DocumentsComponent', () => {
  let fixture: ComponentFixture<DocumentsComponent>;
  let component: DocumentsComponent;
  let serviceStub: {
    list: jasmine.Spy;
    upload: jasmine.Spy;
    remove: jasmine.Spy;
    search: jasmine.Spy;
    get: jasmine.Spy;
    getContent: jasmine.Spy;
  };
  let confirmStub: { ask: jasmine.Spy };

  beforeEach(async () => {
    confirmStub = { ask: jasmine.createSpy('ask').and.resolveTo(true) };
    serviceStub = {
      list: jasmine.createSpy('list').and.resolveTo(documents(20)),
      upload: jasmine.createSpy('upload').and.resolveTo({ document: documentStub(1), chunkCount: 1 }),
      remove: jasmine.createSpy('remove').and.resolveTo(undefined),
      search: jasmine.createSpy('search').and.resolveTo([]),
      get: jasmine.createSpy('get').and.callFake((id: number) => Promise.resolve(documentStub(id))),
      getContent: jasmine.createSpy('getContent').and.resolveTo('Περιεχόμενο εγγράφου')
    };

    await TestBed.configureTestingModule({
      imports: [DocumentsComponent],
      providers: [
        // 2-8: the documents template renders through the translate pipe and
        // the confirm-dialog copy is resolved via TranslateService.instant().
        ...provideTestTranslate(),
        { provide: DocumentService, useValue: serviceStub },
        { provide: ConfirmService, useValue: confirmStub },
        { provide: Router, useValue: { navigate: jasmine.createSpy('navigate').and.resolveTo(true) } }
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(DocumentsComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
    await fixture.whenStable();
  });

  it('renders the document table, 25 MB hint and drop zone', () => {
    fixture.detectChanges();
    const rows = fixture.nativeElement.querySelectorAll('tbody tr');
    expect(rows.length).toBe(20);
    const text = fixture.nativeElement.textContent;
    expect(text).toContain('25 MB');
    expect(fixture.nativeElement.querySelector('.nl-dropzone')).not.toBeNull();
  });

  it('previews document content via getContent()', async () => {
    await component.previewDocument(documentStub(4));
    fixture.detectChanges();

    expect(serviceStub.getContent).toHaveBeenCalledWith(4);
    expect(fixture.nativeElement.querySelector('.nl-document-text').textContent).toContain('Περιεχόμενο εγγράφου');
    expect(component.previewDoc?.id).toBe(4);
  });

  it('downloads a document as a text blob', async () => {
    const createObjectURL = spyOn(URL, 'createObjectURL').and.returnValue('blob:test');
    const revokeObjectURL = spyOn(URL, 'revokeObjectURL');
    const click = spyOn(HTMLAnchorElement.prototype, 'click');

    await component.downloadDocument(documentStub(5));

    expect(serviceStub.getContent).toHaveBeenCalledWith(5);
    expect(createObjectURL).toHaveBeenCalled();
    expect(click).toHaveBeenCalled();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:test');
  });

  it('appends the next page with load more', async () => {
    expect(component.hasMore).toBeTrue();
    serviceStub.list.and.resolveTo(documents(3));

    await component.loadMore();

    expect(serviceStub.list).toHaveBeenCalledWith(20, 20);
    expect(component.documents.length).toBe(23);
    expect(component.hasMore).toBeFalse();
  });

  it('rejects files larger than 25 MB before uploading', async () => {
    const file = new File(['x'], 'big.pdf', { type: 'application/pdf' });
    Object.defineProperty(file, 'size', { value: 26 * 1024 * 1024 });

    component.onDrop({ preventDefault: () => undefined, dataTransfer: { files: [file] } } as unknown as DragEvent);
    await fixture.whenStable();

    expect(serviceStub.upload).not.toHaveBeenCalled();
    expect(component.uploadError).toContain('25 MB');
  });

  it('uploads a dropped file', async () => {
    const file = new File(['x'], 'small.pdf', { type: 'application/pdf' });

    component.onDrop({ preventDefault: () => undefined, dataTransfer: { files: [file] } } as unknown as DragEvent);
    await fixture.whenStable();

    expect(serviceStub.upload).toHaveBeenCalledWith(file, undefined, jasmine.any(Function));
    expect(component.uploadOk).toContain('ανέβηκε με επιτυχία');
  });

  it('deletes a document after confirmation', async () => {
    const doc = documentStub(2);

    await component.deleteDoc(doc);

    expect(confirmStub.ask).toHaveBeenCalledWith(jasmine.objectContaining({
      title: 'Διαγραφή εγγράφου',
      message: 'Διαγραφή του εγγράφου "doc-2.pdf"; Αυτή η ενέργεια δεν αναστρέφεται.'
    }));
    expect(serviceStub.remove).toHaveBeenCalledWith(2);
    expect(component.documents.some(item => item.id === 2)).toBeFalse();
  });

  it('does not delete a document when cancellation is chosen', async () => {
    confirmStub.ask.and.resolveTo(false);

    await component.deleteDoc(documentStub(2));

    expect(serviceStub.remove).not.toHaveBeenCalled();
    expect(component.documents.some(item => item.id === 2)).toBeTrue();
  });

  // ------------------------------------------------------------------
  // Quota UX + split error channels.
  // ------------------------------------------------------------------

  it('renders the document cap message with the counts and an upgrade affordance', async () => {
    serviceStub.upload.and.rejectWith(new QuotaExceededError({
      kind: 'documents',
      limit: 10,
      used: 10,
      tier: 'basic',
      resetAt: null,
      serverError: 'Document limit reached for your plan'
    }));

    const file = new File(['x'], 'small.pdf', { type: 'application/pdf' });
    component.onDrop({ preventDefault: () => undefined, dataTransfer: { files: [file] } } as unknown as DragEvent);
    await fixture.whenStable();
    fixture.detectChanges();

    const expected = (lookupTranslation('el', 'documents.capReached') || '')
      .replace('{{used}}', '10')
      .replace('{{limit}}', '10');
    const errorEl = fixture.nativeElement.querySelector('.nl-error-msg') as HTMLElement;
    expect(errorEl).not.toBeNull();
    expect(errorEl.textContent).toContain(expected);

    const upgrade = fixture.nativeElement.querySelector('.nl-quota-upgrade-link') as HTMLAnchorElement;
    expect(upgrade).not.toBeNull();
    expect(upgrade.textContent?.trim()).toBe(lookupTranslation('el', 'common.upgradePlan'));

    const router = TestBed.inject(Router) as unknown as { navigate: jasmine.Spy };
    upgrade.click();
    expect(router.navigate).toHaveBeenCalledWith(['/subscriptions']);
  });

  it('falls back to the generic cap message when the counts are missing', async () => {
    serviceStub.upload.and.rejectWith(new QuotaExceededError({
      kind: 'documents',
      limit: null,
      used: null,
      tier: 'enterprise',
      resetAt: null,
      serverError: 'Document limit reached for your plan'
    }));

    const file = new File(['x'], 'small.pdf', { type: 'application/pdf' });
    component.onDrop({ preventDefault: () => undefined, dataTransfer: { files: [file] } } as unknown as DragEvent);
    await fixture.whenStable();
    fixture.detectChanges();

    const errorEl = fixture.nativeElement.querySelector('.nl-error-msg') as HTMLElement;
    expect(errorEl.textContent).toContain(lookupTranslation('el', 'documents.capGeneric')!);
  });

  it('reports a failed listing in the load channel, not the upload channel', async () => {
    serviceStub.list.and.rejectWith(new Error('list failed'));

    component.ngOnInit();
    await fixture.whenStable();
    fixture.detectChanges();

    // The server's English prose is logged, never rendered: the user sees
    // the translated copy for this channel.
    expect(component.loadError).toBe(lookupTranslation('el', 'documents.loadError')!);
    expect(component.loadError).not.toContain('list failed');
    expect(component.uploadError).toBe('');
  });

  it('reports a failed search in the search channel, not the upload channel', async () => {
    serviceStub.search.and.rejectWith(new Error('search failed'));
    component.searchQuery = 'άρθρο 57';

    await component.doSearch();

    expect(component.searchError).toBe(lookupTranslation('el', 'documents.searchError')!);
    expect(component.searchError).not.toContain('search failed');
    expect(component.uploadError).toBe('');
  });

  it('reports a failed download in the download channel, not the upload channel', async () => {
    serviceStub.getContent.and.rejectWith(new Error('download failed'));

    await component.downloadDocument(documentStub(5));

    expect(component.downloadError).toBe(lookupTranslation('el', 'documents.downloadError')!);
    expect(component.downloadError).not.toContain('download failed');
    expect(component.uploadError).toBe('');
  });

  it('reports a failed delete in the delete channel, not the upload channel', async () => {
    serviceStub.remove.and.rejectWith(new Error('delete failed'));

    await component.deleteDoc(documentStub(2));

    expect(component.deleteError).toBe(lookupTranslation('el', 'documents.deleteError')!);
    expect(component.deleteError).not.toContain('delete failed');
    expect(component.uploadError).toBe('');
  });

  it('shows the translated upload copy — never the server prose — for a generic failure', async () => {
    // 403 "Access denied." is what the backend answers for a user without
    // the required scope; it must not surface as English inside a Greek UI.
    serviceStub.upload.and.rejectWith(new Error('Access denied.'));

    const file = new File(['x'], 'small.pdf', { type: 'application/pdf' });
    component.onDrop({ preventDefault: () => undefined, dataTransfer: { files: [file] } } as unknown as DragEvent);
    await fixture.whenStable();
    fixture.detectChanges();

    const errorEl = fixture.nativeElement.querySelector('.nl-error-msg') as HTMLElement;
    expect(errorEl).not.toBeNull();
    expect(component.uploadError).toBe(lookupTranslation('el', 'documents.uploadError')!);
    expect(component.uploadError).not.toContain('Access denied');
    expect(fixture.nativeElement.textContent).not.toContain('Access denied');
  });

  it('shows the translated preview copy — never the server prose — for a generic failure', async () => {
    serviceStub.getContent.and.rejectWith(new Error('No file uploaded'));

    await component.previewDocument(documentStub(4));
    fixture.detectChanges();

    expect(component.previewError).toBe(lookupTranslation('el', 'documents.previewError')!);
    expect(component.previewError).not.toContain('No file uploaded');
  });
});
