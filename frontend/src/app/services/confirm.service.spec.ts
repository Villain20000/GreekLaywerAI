import { TestBed } from '@angular/core/testing';
import { ConfirmRequest, ConfirmService } from './confirm.service';

describe('ConfirmService', () => {
  let service: ConfirmService;
  let current: ConfirmRequest | null;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(ConfirmService);
    current = null;
    service.request$.subscribe((request) => { current = request; });
  });

  it('publishes a request with Greek defaults while awaiting an answer', async () => {
    const answer = service.ask({ title: 'Διαγραφή εγγράφου' });

    expect(current).toEqual(jasmine.objectContaining({
      title: 'Διαγραφή εγγράφου',
      message: '',
      confirmLabel: 'Επιβεβαίωση',
      cancelLabel: 'Άκυρο'
    }));

    service.respond(true);
    await expectAsync(answer).toBeResolvedTo(true);
    expect(current).toBeNull();
  });

  it('resolves false when the request is cancelled', async () => {
    const answer = service.ask({ title: 'Ακύρωση', message: 'Συνέχεια;' });

    service.respond(false);

    await expectAsync(answer).toBeResolvedTo(false);
  });

  it('passes through caller labels and message', async () => {
    const answer = service.ask({
      title: 'Διαγραφή συνομιλίας',
      message: 'Οριστική ενέργεια;',
      confirmLabel: 'Διαγραφή',
      cancelLabel: 'Πίσω'
    });

    expect(current).toEqual({
      title: 'Διαγραφή συνομιλίας',
      message: 'Οριστική ενέργεια;',
      confirmLabel: 'Διαγραφή',
      cancelLabel: 'Πίσω'
    });

    service.respond(true);
    await answer;
  });

  it('cancels a previous request when a second one is opened', async () => {
    const first = service.ask({ title: 'Πρώτο' });
    const second = service.ask({ title: 'Δεύτερο' });

    await expectAsync(first).toBeResolvedTo(false);
    expect(current?.title).toBe('Δεύτερο');

    service.respond(true);
    await expectAsync(second).toBeResolvedTo(true);
  });

  it('ignores respond() when no request is open', () => {
    expect(() => service.respond(true)).not.toThrow();
    expect(current).toBeNull();
  });
});
