import { Component, OnInit, ElementRef, ViewChild, AfterViewInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import * as THREE from 'three';
import gsap from 'gsap';

@Component({
  selector: 'app-landing',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="landing-container">
      <div #canvasContainer class="canvas-container"></div>
      <div class="content">
        <h1 class="hero-title">NomosAI</h1>
        <p class="hero-subtitle">The Elite Greek AI Lawyer powered by Gemma 4</p>
        <button class="cta-button" (click)="enterApp()">Enter Application</button>
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

  constructor(private router: Router) {}

  ngOnInit() {}

  ngAfterViewInit() {
    this.initThreeJS();
    this.animateContent();
  }

  ngOnDestroy() {
    cancelAnimationFrame(this.animationId);
    if (this.renderer) {
        this.renderer.dispose();
    }
  }

  private initThreeJS() {
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

    const animate = () => {
      this.animationId = requestAnimationFrame(animate);
      this.mesh.rotation.x += 0.005;
      this.mesh.rotation.y += 0.005;
      this.renderer.render(this.scene, this.camera);
    };
    animate();

    window.addEventListener('resize', this.onWindowResize.bind(this));
  }

  private onWindowResize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }

  private animateContent() {
    const tl = gsap.timeline();
    tl.to('.hero-title', { opacity: 1, y: -20, duration: 1, ease: 'power3.out', delay: 0.5 })
      .to('.hero-subtitle', { opacity: 1, y: -20, duration: 1, ease: 'power3.out' }, "-=0.5")
      .to('.cta-button', { opacity: 1, y: -20, duration: 1, ease: 'power3.out' }, "-=0.5");
  }

  enterApp() {
    this.router.navigate(['/chat']);
  }
}
