import { Component, OnInit, ElementRef, ViewChild, AfterViewInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import * as THREE from 'three';
import gsap from 'gsap';
import { ExperimentService } from '../../services/experiment.service';

@Component({
  selector: 'app-landing',
  standalone: true,
  imports: [CommonModule, TranslatePipe],
  template: `
    <div class="landing-container">
      <div #canvasContainer class="canvas-container"></div>
      <div class="content">
        <h1 class="hero-title">NomosAI</h1>
        <p class="hero-subtitle">{{ heroSubtitleKey | translate }}</p>
        <button class="cta-button" (click)="enterApp()">{{ 'landing.enter' | translate }}</button>
      </div>
    </div>
  `,
  // Phase 27 — zero per-component CSS. All landing-page chrome
  // (.landing-container / .canvas-container / .content / .hero-title /
  // .hero-subtitle / .cta-button) lives in src/styles.scss under
  // combined `.nl-landing-*` + legacy-name selectors. Template is
  // left untouched so the template references continue to resolve.
  styles: []
})
export class LandingComponent implements OnInit, AfterViewInit, OnDestroy {
  @ViewChild('canvasContainer', { static: true }) canvasContainer!: ElementRef;
  private renderer!: THREE.WebGLRenderer;
  private scene!: THREE.Scene;
  private camera!: THREE.PerspectiveCamera;
  private mesh!: THREE.Mesh;
  private animationId: number = 0;

  /** True when the OS asks for reduced motion; skips Three.js + GSAP motion. */
  reducedMotion = false;

  /** Assignment for the `landing-hero` experiment; control by default. */
  heroVariant = 'control';

  /**
   * Stable bound handler so ngOnDestroy can actually remove the listener
   * (the old code bound a fresh function on add and could never detach it).
   */
  private readonly resizeHandler = (): void => this.onWindowResize();
  private resizeListenerAttached = false;

  constructor(
    private router: Router,
    private readonly experiments: ExperimentService
  ) {}

  get heroSubtitleKey(): string {
    return this.heroVariant === 'variant'
      ? 'landing.hero.variant.subtitle'
      : 'landing.subtitle';
  }

  ngOnInit(): void {
    this.reducedMotion = this.prefersReducedMotion();
    void this.experiments
      .ready()
      .then(() => {
        this.heroVariant = this.experiments.getVariant('landing-hero');
      })
      .catch(() => {
        this.heroVariant = 'control';
      });
  }

  ngAfterViewInit(): void {
    if (!this.reducedMotion) {
      this.initThreeJS();
    }
    this.animateContent();
    if (!this.reducedMotion) {
      this.attachResizeListener();
    }
  }

  ngOnDestroy(): void {
    cancelAnimationFrame(this.animationId);
    this.animationId = 0;
    this.detachResizeListener();
    if (this.renderer) {
      this.renderer.dispose();
    }
  }

  /** Guarded matchMedia lookup (older browsers / test doubles). */
  private prefersReducedMotion(): boolean {
    try {
      return typeof window !== 'undefined'
        && typeof window.matchMedia === 'function'
        && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch (_e) {
      return false;
    }
  }

  private initThreeJS(): void {
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);

    this.renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.canvasContainer.nativeElement.appendChild(this.renderer.domElement);

    // Abstract Geometry representing a modern scale/legal structure
    const geometry = new THREE.OctahedronGeometry(2, 0);
    const material = new THREE.MeshBasicMaterial({ color: 0x444444, wireframe: true });
    this.mesh = new THREE.Mesh(geometry, material);
    this.scene.add(this.mesh);

    this.camera.position.z = 5;

    // 2-9: never start the render loop when reduced motion is requested.
    if (this.reducedMotion) return;

    const animate = () => {
      this.animationId = requestAnimationFrame(animate);
      this.mesh.rotation.x += 0.005;
      this.mesh.rotation.y += 0.005;
      this.renderer.render(this.scene, this.camera);
    };
    animate();
  }

  /** Idempotent so a double ngAfterViewInit can't register two listeners. */
  private attachResizeListener(): void {
    if (this.resizeListenerAttached) return;
    window.addEventListener('resize', this.resizeHandler);
    this.resizeListenerAttached = true;
  }

  private detachResizeListener(): void {
    if (!this.resizeListenerAttached) return;
    window.removeEventListener('resize', this.resizeHandler);
    this.resizeListenerAttached = false;
  }

  private onWindowResize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }

  private animateContent() {
    if (this.reducedMotion) {
      // Show the hero immediately; only the entrance motion is skipped.
      gsap.set(['.hero-title', '.hero-subtitle', '.cta-button'], { opacity: 1, y: 0 });
      return;
    }
    const tl = gsap.timeline();
    tl.to('.hero-title', { opacity: 1, y: -20, duration: 1, ease: 'power3.out', delay: 0.5 })
      .to('.hero-subtitle', { opacity: 1, y: -20, duration: 1, ease: 'power3.out' }, "-=0.5")
      .to('.cta-button', { opacity: 1, y: -20, duration: 1, ease: 'power3.out' }, "-=0.5");
  }

  enterApp() {
    this.router.navigate(['/chat']);
  }
}
