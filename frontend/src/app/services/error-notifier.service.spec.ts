import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting
} from '@angular/common/http/testing';
import {
  AppErrorNotification,
  ErrorNotifierService
} from './error-notifier.service';
import {
  GlobalErrorHandler,
  ERROR_THROTTLE_WINDOW_MS
} from './global-error-handler';
import { environment } from '../../environments/environment';

describe('ErrorNotifierService', () => {
  let service: ErrorNotifierService;
  let emissions: Array<AppErrorNotification | null>;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(ErrorNotifierService);
    emissions = [];
    service.error$.subscribe((error) => emissions.push(error));
  });

  it('starts without an active error', () => {
    expect(service).toBeTruthy();
    expect(emissions).toEqual([null]);
  });

  it('publishes the latest notification', () => {
    const first: AppErrorNotification = { message: 'boom', timestamp: 't1' };
    const second: AppErrorNotification = { message: 'bang', timestamp: 't2' };

    service.notify(first);
    service.notify(second);

    expect(emissions[emissions.length - 1]).toEqual(second);
  });

  it('dismiss() clears the active notification', () => {
    service.notify({ message: 'boom', timestamp: 't1' });

    service.dismiss();

    expect(emissions[emissions.length - 1]).toBeNull();
  });

  it('dismiss() is a no-op when nothing is shown', () => {
    expect(() => service.dismiss()).not.toThrow();
    expect(emissions).toEqual([null]);
  });
});

describe('GlobalErrorHandler', () => {
  let handler: GlobalErrorHandler;
  let notifier: ErrorNotifierService;
  let httpMock: HttpTestingController;
  let notifications: AppErrorNotification[];
  let consoleSpy: jasmine.Spy;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        GlobalErrorHandler,
        provideHttpClient(),
        provideHttpClientTesting()
      ]
    });
    handler = TestBed.inject(GlobalErrorHandler);
    notifier = TestBed.inject(ErrorNotifierService);
    httpMock = TestBed.inject(HttpTestingController);
    notifications = [];
    notifier.error$.subscribe((error) => {
      if (error) {
        notifications.push(error);
      }
    });
    consoleSpy = spyOn(console, 'error').and.stub();
    environment.errorReportingUrl = '';
  });

  afterEach(() => {
    environment.errorReportingUrl = '';
    httpMock.verify();
    consoleSpy.calls.reset();
  });

  it('logs with a timestamp and notifies the service', () => {
    handler.handleError(new Error('kaboom'));

    expect(consoleSpy).toHaveBeenCalled();
    const logged = consoleSpy.calls.mostRecent().args[0] as string;
    expect(logged).toContain('[NomosAI][');
    expect(logged).toContain('Unhandled error');

    expect(notifications.length).toBe(1);
    expect(notifications[0].message).toBe('kaboom');
    expect(notifications[0].timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('throttles duplicate errors inside the window and allows them afterwards', () => {
    let now = 1_000_000;
    spyOn(Date, 'now').and.callFake(() => now);
    const error = new Error('repeated');

    handler.handleError(error);
    expect(notifications.length).toBe(1);

    handler.handleError(error);
    expect(notifications.length).toBe(1);

    now += ERROR_THROTTLE_WINDOW_MS - 1;
    handler.handleError(error);
    expect(notifications.length).toBe(1);

    now += 1;
    handler.handleError(error);
    expect(notifications.length).toBe(2);
  });

  it('notifies for distinct errors even inside the throttle window', () => {
    handler.handleError(new Error('first'));
    handler.handleError(new Error('second'));

    expect(notifications.map((n) => n.message)).toEqual(['first', 'second']);
  });

  it('does not post a report when errorReportingUrl is empty', () => {
    handler.handleError(new Error('local only'));

    httpMock.expectNone(() => true);
  });

  it('posts a compact report when errorReportingUrl is configured', () => {
    environment.errorReportingUrl = '/api/client-errors';

    handler.handleError(new Error('report me'));

    const request = httpMock.expectOne('/api/client-errors');
    expect(request.request.method).toBe('POST');
    expect(request.request.body.message).toBe('report me');
    expect(typeof request.request.body.stack).toBe('string');
    expect(typeof request.request.body.url).toBe('string');
    expect(request.request.body.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    request.flush(null);
  });

  it('swallows reporting failures and never rethrows', () => {
    environment.errorReportingUrl = '/api/client-errors';

    expect(() => handler.handleError(new Error('report fails'))).not.toThrow();

    const request = httpMock.expectOne('/api/client-errors');
    expect(() => request.error(new ErrorEvent('network'))).not.toThrow();
    expect(notifications.length).toBe(1);
  });
});
