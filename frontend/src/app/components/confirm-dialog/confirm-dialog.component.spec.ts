import { ComponentFixture, TestBed, fakeAsync, tick, flushMicrotasks } from '@angular/core/testing';
import { ConfirmDialogComponent } from './confirm-dialog.component';
import { ConfirmService } from '../../services/confirm.service';

describe('ConfirmDialogComponent', () => {
  let fixture: ComponentFixture<ConfirmDialogComponent>;
  let service: ConfirmService;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ConfirmDialogComponent]
    }).compileComponents();

    service = TestBed.inject(ConfirmService);
    fixture = TestBed.createComponent(ConfirmDialogComponent);
    fixture.detectChanges();
  });

  function buttons(): HTMLButtonElement[] {
    return Array.from(
      fixture.nativeElement.querySelectorAll('.nl-confirm-actions button')
    ) as HTMLButtonElement[];
  }

  it('renders an accessible, labelled modal and resolves true on confirm', fakeAsync(() => {
    let result: boolean | undefined;
    void service.ask({
      title: 'Διαγραφή εγγράφου',
      message: 'Η ενέργεια δεν αναστρέφεται.',
      confirmLabel: 'Διαγραφή',
      cancelLabel: 'Άκυρο'
    }).then((value) => { result = value; });

    fixture.detectChanges();
    tick();

    const dialog = fixture.nativeElement.querySelector('[role="dialog"]') as HTMLElement;
    expect(dialog).not.toBeNull();
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-labelledby')).toBe('nl-confirm-title');
    expect(dialog.getAttribute('aria-describedby')).toBe('nl-confirm-description');
    expect(fixture.nativeElement.querySelector('#nl-confirm-title').textContent)
      .toContain('Διαγραφή εγγράφου');
    expect(fixture.nativeElement.querySelector('#nl-confirm-description').textContent)
      .toContain('δεν αναστρέφεται');
    expect(buttons().map((button) => button.textContent?.trim())).toEqual(['Άκυρο', 'Διαγραφή']);

    buttons()[1].click();
    flushMicrotasks();
    fixture.detectChanges();
    tick();

    expect(result).toBeTrue();
    expect(fixture.nativeElement.querySelector('[role="dialog"]')).toBeNull();
  }));

  it('resolves false when the cancel button is used and restores focus', fakeAsync(() => {
    const trigger = document.createElement('button');
    trigger.textContent = 'trigger';
    document.body.appendChild(trigger);
    trigger.focus();

    let result: boolean | undefined;
    void service.ask({ title: 'Ακύρωση', message: 'Συνέχεια;' })
      .then((value) => { result = value; });
    fixture.detectChanges();
    tick();

    buttons()[0].click();
    flushMicrotasks();
    fixture.detectChanges();
    tick();

    expect(result).toBeFalse();
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  }));

  it('cancels on Escape and restores focus to the trigger', fakeAsync(() => {
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    trigger.focus();

    let result: boolean | undefined;
    void service.ask({ title: 'Διαγραφή', confirmLabel: 'Διαγραφή' })
      .then((value) => { result = value; });
    fixture.detectChanges();
    tick();

    const dialog = fixture.nativeElement.querySelector('[role="dialog"]') as HTMLElement;
    dialog.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true
    }));
    flushMicrotasks();
    fixture.detectChanges();
    tick();

    expect(result).toBeFalse();
    expect(fixture.nativeElement.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  }));

  it('cancels on a backdrop click but not on a click inside the panel', fakeAsync(() => {
    let result: boolean | undefined;
    void service.ask({ title: 'Διαγραφή' }).then((value) => { result = value; });
    fixture.detectChanges();
    tick();

    const dialog = fixture.nativeElement.querySelector('.nl-confirm-dialog') as HTMLElement;
    dialog.click();
    flushMicrotasks();
    expect(result).toBeUndefined();

    const backdrop = fixture.nativeElement.querySelector('.nl-confirm-backdrop') as HTMLElement;
    backdrop.click();
    flushMicrotasks();
    fixture.detectChanges();
    tick();

    expect(result).toBeFalse();
  }));

  it('moves focus to cancel and traps Tab between the two actions', fakeAsync(() => {
    let result: boolean | undefined;
    void service.ask({ title: 'Διαγραφή', confirmLabel: 'Διαγραφή' })
      .then((value) => { result = value; });
    fixture.detectChanges();
    tick();

    const dialog = fixture.nativeElement.querySelector('[role="dialog"]') as HTMLElement;
    const [cancel, confirm] = buttons();

    expect(document.activeElement).toBe(cancel);

    confirm.focus();
    dialog.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Tab',
      bubbles: true,
      cancelable: true
    }));
    expect(document.activeElement).toBe(cancel);

    cancel.focus();
    dialog.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Tab',
      shiftKey: true,
      bubbles: true,
      cancelable: true
    }));
    expect(document.activeElement).toBe(confirm);

    service.respond(false);
    flushMicrotasks();
    fixture.detectChanges();
    tick();
    expect(result).toBeFalse();
  }));
});
