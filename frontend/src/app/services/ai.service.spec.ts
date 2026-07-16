import { TestBed } from '@angular/core/testing';
import { AiService } from './ai.service';

describe('AiService', () => {
  let service: AiService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(AiService);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });

  // Native fetch API is difficult to mock fully in Jasmine without heavier tools,
  // but we ensure the service exists and the methods are callable.
  it('should have streamQuery method', () => {
    expect(typeof service.streamQuery).toBe('function');
  });

  it('should have uploadAudio method', () => {
    expect(typeof service.uploadAudio).toBe('function');
  });
});
