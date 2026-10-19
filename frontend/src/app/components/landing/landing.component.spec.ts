import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { LandingComponent } from './landing.component';
import { provideTestTranslate } from '../../i18n/testing';

function mediaQueryList(matches: boolean, query: string): MediaQueryList {
  return {
    matches,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false
  } as unknown as MediaQueryList;
}

describe('LandingComponent (reduced motion + listener lifecycle)', () => {
  const realMatchMedia = window.matchMedia;
  const routerStub = { navigate: jasmine.createSpy('navigate') };

  beforeEach(async () => {
    window.matchMedia = ((query: string) => mediaQueryList(false, query)) as typeof window.matchMedia;
    await TestBed.configureTestingModule({
      imports: [LandingComponent],
      // 2-8 (i18n): the hero template uses the `translate` pipe, so the spec
      // needs the ngx-translate providers (TranslateStore is not
      // `providedIn: 'root'` in @ngx-translate/core@16).
      providers: [{ provide: Router, useValue: routerStub }, ...provideTestTranslate()]
    }).compileComponents();
  });

  afterEach(() => {
    window.matchMedia = realMatchMedia;
  });

  it('skips Three.js and GSAP entrance motion when prefers-reduced-motion is set', () => {
    window.matchMedia = ((query: string) => mediaQueryList(true, query)) as typeof window.matchMedia;
    const fixture: ComponentFixture<LandingComponent> = TestBed.createComponent(LandingComponent);
    const component = fixture.componentInstance;
    const initSpy = spyOn(component as unknown as { initThreeJS: () => void }, 'initThreeJS');

    fixture.detectChanges();

    expect(component.reducedMotion).toBeTrue();
    expect(initSpy).not.toHaveBeenCalled();
    expect((component as unknown as { renderer?: unknown }).renderer).toBeUndefined();
    expect(fixture.nativeElement.querySelector('.canvas-container').children.length).toBe(0);
    const title = fixture.nativeElement.querySelector('.hero-title') as HTMLElement;
    expect(title.style.opacity).toBe('1');
  });

  it('adds the resize listener once and removes it on destroy', () => {
    const fixture = TestBed.createComponent(LandingComponent);
    const component = fixture.componentInstance as unknown as {
      attachResizeListener: () => void;
      detachResizeListener: () => void;
      ngOnDestroy: () => void;
    };
    const addSpy = spyOn(window, 'addEventListener').and.callThrough();
    const removeSpy = spyOn(window, 'removeEventListener').and.callThrough();

    component.attachResizeListener();
    component.attachResizeListener();
    expect(addSpy.calls.allArgs().filter((args) => args[0] === 'resize').length).toBe(1);

    component.ngOnDestroy();
    expect(removeSpy.calls.allArgs().filter((args) => args[0] === 'resize').length).toBe(1);

    // A second destroy must not try to remove a listener that is already gone.
    component.ngOnDestroy();
    expect(removeSpy.calls.allArgs().filter((args) => args[0] === 'resize').length).toBe(1);
  });
});
