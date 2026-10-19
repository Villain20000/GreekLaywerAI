import { ComponentFixture, TestBed } from '@angular/core/testing';
import { RouterTestingModule } from '@angular/router/testing';
import { Router } from '@angular/router';
import { ConversationsComponent } from './conversations.component';
import { ConversationsService, Conversation } from '../../services/conversations.service';
import { ConfirmService } from '../../services/confirm.service';
import { lookupTranslation, provideTestTranslate } from '../../i18n/testing';

function conversationStub(id: number, title = `Συνομιλία ${id}`): Conversation {
  return { id, title, created_at: '2026-01-01', updated_at: '2026-01-02' };
}

describe('ConversationsComponent', () => {
  let fixture: ComponentFixture<ConversationsComponent>;
  let component: ConversationsComponent;
  let serviceStub: {
    listPage: jasmine.Spy;
    create: jasmine.Spy;
    rename: jasmine.Spy;
    remove: jasmine.Spy;
  };
  let router: Router;
  let confirmStub: { ask: jasmine.Spy };

  beforeEach(async () => {
    confirmStub = {
      ask: jasmine.createSpy('ask').and.resolveTo(true)
    };
    serviceStub = {
      listPage: jasmine.createSpy('listPage').and.resolveTo({
        conversations: [conversationStub(1), conversationStub(2)],
        total: 45
      }),
      create: jasmine.createSpy('create').and.resolveTo(conversationStub(99, 'Νέα συνομιλία')),
      rename: jasmine.createSpy('rename').and.resolveTo(conversationStub(1, 'Νέος τίτλος')),
      remove: jasmine.createSpy('remove').and.resolveTo(undefined)
    };

    await TestBed.configureTestingModule({
      imports: [ConversationsComponent, RouterTestingModule],
      providers: [
        // 2-8: the conversations template renders through the translate pipe
        // and the confirm-dialog copy is resolved via TranslateService.instant().
        ...provideTestTranslate(),
        { provide: ConversationsService, useValue: serviceStub },
        { provide: ConfirmService, useValue: confirmStub }
      ]
    }).compileComponents();

    router = TestBed.inject(Router);
    spyOn(router, 'navigate').and.resolveTo(true);

    fixture = TestBed.createComponent(ConversationsComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
    await fixture.whenStable();
  });

  it('loads the first page with the total count', () => {
    fixture.detectChanges();
    expect(serviceStub.listPage).toHaveBeenCalledWith(20, 0, '');
    expect(component.conversations.length).toBe(2);
    expect(component.total).toBe(45);
    expect(component.totalPages).toBe(3);
    expect(fixture.nativeElement.textContent).toContain('Σελίδα 1 από 3');
  });

  it('applies a search filter and resets to the first page', async () => {
    component.offset = 20;
    component.query = ' αστικό ';

    component.applySearch();
    await fixture.whenStable();

    expect(serviceStub.listPage).toHaveBeenCalledWith(20, 0, ' αστικό ');
    expect(component.offset).toBe(0);
  });

  it('paginates forward and backward', async () => {
    await component.nextPage();
    expect(serviceStub.listPage).toHaveBeenCalledWith(20, 20, '');
    expect(component.page).toBe(2);

    await component.previousPage();
    expect(serviceStub.listPage).toHaveBeenCalledWith(20, 0, '');
    expect(component.page).toBe(1);
  });

  it('navigates into the new chat after creating a conversation', async () => {
    await component.newConversation();

    expect(router.navigate).toHaveBeenCalledWith(['/chat'], { queryParams: { conversation: 99 } });
  });

  it('renames and deletes conversations', async () => {
    component.startRename(conversationStub(1, 'Παλιός τίτλος'));
    component.renameTitle = 'Νέος τίτλος';
    await component.confirmRename();
    expect(serviceStub.rename).toHaveBeenCalledWith(1, 'Νέος τίτλος');

    await component.deleteConversation(conversationStub(2));
    expect(confirmStub.ask).toHaveBeenCalledWith(jasmine.objectContaining({
      title: 'Διαγραφή συνομιλίας',
      message: 'Διαγραφή της συνομιλίας "Συνομιλία 2";'
    }));
    expect(serviceStub.remove).toHaveBeenCalledWith(2);
    expect(serviceStub.listPage).toHaveBeenCalledTimes(3);
  });

  it('keeps the conversation when the confirm dialog is cancelled', async () => {
    confirmStub.ask.and.resolveTo(false);

    await component.deleteConversation(conversationStub(2));

    expect(serviceStub.remove).not.toHaveBeenCalled();
  });

  // ------------------------------------------------------------------
  // Error channels: the server's English prose is logged, never rendered.
  // ------------------------------------------------------------------

  it('shows the translated load copy — never the server prose — when the listing fails', async () => {
    serviceStub.listPage.and.rejectWith(new Error('List conversations failed (HTTP 500)'));

    component.ngOnInit();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(component.error).toBe(lookupTranslation('el', 'conversations.loadError')!);
    expect(component.error).not.toContain('List conversations failed');
    expect(fixture.nativeElement.textContent).not.toContain('List conversations failed');
    expect(component.loading).toBeFalse();
  });

  it('shows the translated create copy — never the server prose — when the creation fails', async () => {
    serviceStub.create.and.rejectWith(new Error('Create conversation failed (HTTP 500)'));

    await component.newConversation();
    fixture.detectChanges();

    expect(component.error).toBe(lookupTranslation('el', 'conversations.createError')!);
    expect(component.error).not.toContain('Create conversation failed');
    expect(fixture.nativeElement.textContent).not.toContain('Create conversation failed');
    expect(router.navigate).not.toHaveBeenCalled();
  });

  it('shows the translated rename copy — never the server prose — when the rename fails', async () => {
    serviceStub.rename.and.rejectWith(new Error('Rename conversation failed (HTTP 500)'));
    component.startRename(conversationStub(1, 'Παλιός τίτλος'));
    component.renameTitle = 'Νέος τίτλος';

    await component.confirmRename();
    fixture.detectChanges();

    expect(component.error).toBe(lookupTranslation('el', 'conversations.renameError')!);
    expect(component.error).not.toContain('Rename conversation failed');
    expect(fixture.nativeElement.textContent).not.toContain('Rename conversation failed');
  });

  it('shows the translated delete copy — never the server prose — when the delete fails', async () => {
    serviceStub.remove.and.rejectWith(new Error('Delete conversation failed (HTTP 500)'));

    await component.deleteConversation(conversationStub(2));
    fixture.detectChanges();

    expect(component.error).toBe(lookupTranslation('el', 'conversations.deleteError')!);
    expect(component.error).not.toContain('Delete conversation failed');
    expect(fixture.nativeElement.textContent).not.toContain('Delete conversation failed');
  });
});
