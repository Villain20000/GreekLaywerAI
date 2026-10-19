import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { TranslateService } from '@ngx-translate/core';
import { LandingComponent } from './landing.component';
import { ExperimentService } from '../../services/experiment.service';
import { provideTestTranslate, lookupTranslation } from '../../i18n/testing';

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

describe('LandingComponent (motion, lifecycle, hero experiment)', () => {
  const realMatchMedia = window.matchMedia;
  const routerStub = { navigate: jasmine.createSpy('navigate') };
  let experimentStub: {
    ready: jasmine.Spy;
    getVariant: jasmine.Spy;
    getClientId: jasmine.Spy;
  };

  beforeEach(async () => {
    window.matchMedia = ((query: string) => mediaQueryList(false, query)) as typeof window.matchMedia;
    experimentStub = {
      ready: jasmine.createSpy('ready').and.resolveTo(undefined),
      getVariant: jasmine.createSpy('getVariant').and.returnValue('control'),
      getClientId: jasmine.createSpy('getClientId').and.returnValue('test-client')
    };
    await TestBed.configureTestingModule({
      imports: [LandingComponent],
      // 2-8 (i18n): the hero template uses the `translate` pipe, so the spec
      // needs the ngx-translate providers (TranslateStore is not
      // `providedIn: 'root'` in @ngx-translate/core@16).
      providers: [
        { provide: Router, useValue: routerStub },
        { provide: ExperimentService, useValue: experimentStub },
        ...provideTestTranslate()
      ]
    }).compileComponents();
    TestBed.inject(TranslateService).use('el');
  });

  afterEach(() => {
    window.matchMedia = realMatchMedia;
  });

  function useReducedMotion(): void {
    window.matchMedia = ((query: string) => mediaQueryList(true, query)) as typeof window.matchMedia;
  }

  async function render(): Promise<ComponentFixture<LandingComponent>> {
    const fixture = TestBed.createComponent(LandingComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    await Promise.resolve();
    fixture.detectChanges();
    return fixture;
  }

  function subtitleText(fixture: ComponentFixture<LandingComponent>): string {
    const subtitle = fixture.nativeElement.querySelector('.hero-subtitle') as HTMLElement;
    return (subtitle.textContent || '').trim();
  }

  it('skips Three.js and GSAP entrance motion when prefers-reduced-motion is set', () => {
    useReducedMotion();
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

  it('renders the control hero subtitle after the experiment is ready', async () => {
    useReducedMotion();
    const fixture = await render();
    const component = fixture.componentInstance;

    expect(experimentStub.ready).toHaveBeenCalled();
    expect(experimentStub.getVariant).toHaveBeenCalledWith('landing-hero');
    expect(component.heroVariant).toBe('control');
    expect(component.heroSubtitleKey).toBe('landing.subtitle');
    expect(subtitleText(fixture)).toBe(
      lookupTranslation('el', 'landing.subtitle') ?? ''
    );
  });

  it('applies the variant hero subtitle for the landing-hero experiment', async () => {
    useReducedMotion();
    experimentStub.getVariant.and.returnValue('variant');
    TestBed.inject(TranslateService).setTranslation(
      'el',
      { landing: { hero: { variant: { subtitle: 'Variant hero subtitle' } } } },
      true
    );

    const fixture = await render();
    const component = fixture.componentInstance;

    expect(component.heroVariant).toBe('variant');
    expect(component.heroSubtitleKey).toBe('landing.hero.variant.subtitle');
    expect(subtitleText(fixture)).toBe('Variant hero subtitle');
  });

  it('falls back to control when the experiment service fails', async () => {
    useReducedMotion();
    experimentStub.ready.and.returnValue(Promise.reject(new Error('config down')));

    const fixture = await render();

    expect(fixture.componentInstance.heroVariant).toBe('control');
    expect(subtitleText(fixture)).toBe(
      lookupTranslation('el', 'landing.subtitle') ?? ''
    );
  });
});
