/* ============================================================================
   UGC VIDEO GALLERY — behaviour
   ----------------------------------------------------------------------------
   Vanilla JS, zero dependencies. One custom element per section instance, so
   multiple UGC Gallery sections can live on the same page without clashing.

   Responsibilities:
     - Carousel arrows (scroll-snap does the actual scrolling)
     - Spotlight active-card highlighting (IntersectionObserver)
     - Optional muted inline previews, loaded/played only while on screen
     - Floating row dismissal (remembered for the browser session)
     - Fullscreen modal: TikTok-style vertical feed with
         - lazy video loading (active slide ± 1 neighbour)
         - autoplay on the active slide, pause on the rest
         - tap to pause/play, mute toggle (state shared across slides)
         - keyboard: Esc close, arrows/PageUp/PageDown/Space navigate
         - native scroll-snap swipe on touch
         - focus trap + scroll lock + focus restore on close

   Progressive enhancement: without JS the section still renders posters and
   creator info; only the modal/preview interactions require JS.
   ========================================================================== */
(() => {
  'use strict';

  if (customElements.get('ugc-gallery')) return;

  /** Formats reused observer options. */
  const IO_SUPPORTED = 'IntersectionObserver' in window;

  class UGCGallery extends HTMLElement {
    connectedCallback() {
      // Defer setup until the element is fully parsed.
      if (!this._initialized) {
        this._initialized = true;
        requestAnimationFrame(() => this._init());
      }
    }

    disconnectedCallback() {
      this._teardownFns?.forEach((fn) => fn());
      this._teardownFns = [];
    }

    /* ------------------------------------------------------------------ */
    /* Setup                                                                */
    /* ------------------------------------------------------------------ */
    _init() {
      this._teardownFns = [];
      this.modal = this.querySelector('[data-ugcg-modal]');
      this.track = this.querySelector('[data-ugcg-track]');
      this._migrateBlockItems();
      this.slides = this.track ? Array.from(this.track.querySelectorAll('.ugcg-slide')) : [];
      this._setupLoopClones();
      this.scroller = this.querySelector('[data-ugcg-scroller]');
      this.muted = true; // shared mute state across slides
      this._lastFocused = null;

      this._setupOpeners();
      this._setupArrows();
      this._setupSpotlight();
      this._setupPreviews();
      this._setupFloating();
      this._setupModal();
    }

    _listen(target, type, handler, options) {
      target.addEventListener(type, handler, options);
      this._teardownFns.push(() => target.removeEventListener(type, handler, options));
    }

    /* ------------------------------------------------------------------ */
    /* Block version: move each item's slide into the modal track          */
    /* ------------------------------------------------------------------ */
    /*
      The "UGC Video Gallery" theme block (blocks/ugc-video-gallery.liquid)
      can't render its nested "UGC item" blocks twice — once as a card,
      once as a modal slide — the way the section does with section.blocks,
      since theme blocks only expose {% content_for 'blocks' %} (render
      each child once, in place). Instead each item block renders its card
      inline and its slide into a hidden holder next to it; this runs once
      at init to move those slides into the real modal track, in document
      order, and number both the card trigger and its slide to match.
      No-op for the section (it has no .ugcg-item elements).
    */
    _migrateBlockItems() {
      const items = Array.from(this.querySelectorAll('.ugcg-item'));
      if (!items.length || !this.track) return;
      items.forEach((item, i) => {
        const opener = item.querySelector('[data-ugcg-open]');
        if (opener) opener.dataset.index = String(i);
        const holder = item.querySelector('.ugcg-slide-holder');
        const slide = holder?.firstElementChild;
        if (slide) {
          slide.dataset.slideIndex = String(i);
          this.track.appendChild(slide);
        }
        holder?.remove();
      });
    }

    /* ------------------------------------------------------------------ */
    /* Card triggers                                                        */
    /* ------------------------------------------------------------------ */
    _setupOpeners() {
      this.querySelectorAll('[data-ugcg-open]').forEach((btn) => {
        this._listen(btn, 'click', () => {
          this.openModal(parseInt(btn.dataset.index, 10) || 0);
        });
      });
    }

    /* ------------------------------------------------------------------ */
    /* Carousel arrows                                                      */
    /* ------------------------------------------------------------------ */
    _setupArrows() {
      const arrows = this.querySelectorAll('[data-ugcg-arrow]');
      if (!arrows.length || !this.scroller) return;

      const step = () => {
        const card = this.scroller.querySelector('.ugcg-card, .ugcg-bubble');
        const gap = parseFloat(getComputedStyle(this.scroller).columnGap) || 14;
        return card ? card.getBoundingClientRect().width + gap : this.scroller.clientWidth * 0.8;
      };

      const updateState = () => {
        const max = this.scroller.scrollWidth - this.scroller.clientWidth - 2;
        arrows.forEach((a) => {
          const prev = a.dataset.ugcgArrow === 'prev';
          a.toggleAttribute('disabled', prev ? this.scroller.scrollLeft <= 2 : this.scroller.scrollLeft >= max);
        });
      };

      arrows.forEach((a) => {
        this._listen(a, 'click', () => {
          const dir = a.dataset.ugcgArrow === 'prev' ? -1 : 1;
          this.scroller.scrollBy({ left: dir * step(), behavior: 'smooth' });
        });
      });

      this._listen(this.scroller, 'scroll', updateState, { passive: true });
      updateState();

      // Keyboard support on the focusable track.
      this._listen(this.scroller, 'keydown', (e) => {
        if (e.key === 'ArrowRight') { e.preventDefault(); this.scroller.scrollBy({ left: step(), behavior: 'smooth' }); }
        if (e.key === 'ArrowLeft') { e.preventDefault(); this.scroller.scrollBy({ left: -step(), behavior: 'smooth' }); }
      });
    }

    /* ------------------------------------------------------------------ */
    /* Spotlight: highlight the centered card                               */
    /* ------------------------------------------------------------------ */
    _setupSpotlight() {
      if (!this.classList.contains('ugcg--spotlight') || !this.scroller || !IO_SUPPORTED) return;
      const cards = this.scroller.querySelectorAll('.ugcg-card');
      const io = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => entry.target.classList.toggle('is-active', entry.intersectionRatio > 0.75));
        },
        { root: this.scroller, threshold: [0.5, 0.75, 0.9] }
      );
      cards.forEach((c) => io.observe(c));
      this._teardownFns.push(() => io.disconnect());
    }

    /* ------------------------------------------------------------------ */
    /* Optional inline previews (muted, on-screen only)                     */
    /* ------------------------------------------------------------------ */
    /*
      Only one preview ever plays at a time — starting with the first card —
      rotating through whichever cards are currently on screen. Playing every
      visible preview at once (the old behaviour) meant loading + decoding
      several videos simultaneously, which tanks performance on slower
      connections/devices. Off-screen cards never load at all.
    */
    _setupPreviews() {
      if (!this.hasAttribute('data-preview-autoplay') || !IO_SUPPORTED) return;
      const previews = Array.from(this.querySelectorAll('.ugcg-card__preview[data-preview-src]'));
      if (!previews.length) return;

      const ROTATE_MS = 5000;
      let visible = [];
      let active = null;

      const deactivate = (video) => {
        if (!video) return;
        video.pause();
        video.classList.remove('is-playing');
      };

      const activate = (video) => {
        if (active === video) return;
        deactivate(active);
        active = video;
        if (!video) return;
        if (!video.src) video.src = video.dataset.previewSrc;
        video.currentTime = 0;
        video.play().then(() => video.classList.add('is-playing')).catch(() => {});
      };

      const advance = () => {
        if (!visible.length) { activate(null); return; }
        const idx = active ? visible.indexOf(active) : -1;
        activate(visible[(idx + 1) % visible.length]);
      };

      const io = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            const video = entry.target;
            if (entry.isIntersecting) {
              if (!visible.includes(video)) visible.push(video);
            } else {
              visible = visible.filter((v) => v !== video);
              if (video.src) deactivate(video);
              if (active === video) active = null;
            }
          });
          // Keep in DOM order so "first video" always means the first card.
          visible.sort((a, b) => previews.indexOf(a) - previews.indexOf(b));
          if (!active && visible.length) activate(visible[0]);
        },
        { rootMargin: '80px 0px', threshold: 0.35 }
      );
      previews.forEach((v) => io.observe(v));
      this._teardownFns.push(() => io.disconnect());

      const timer = setInterval(advance, ROTATE_MS);
      this._teardownFns.push(() => clearInterval(timer));
    }

    /* ------------------------------------------------------------------ */
    /* Floating row dismissal                                               */
    /* ------------------------------------------------------------------ */
    _setupFloating() {
      const floating = this.querySelector('[data-ugcg-floating]');
      if (!floating) return;
      const key = `ugcg-dismissed-${this.dataset.sectionId}`;

      try {
        if (sessionStorage.getItem(key)) floating.classList.add('is-dismissed');
      } catch (e) { /* storage unavailable — ignore */ }

      const dismiss = floating.querySelector('[data-ugcg-dismiss]');
      if (dismiss) {
        this._listen(dismiss, 'click', () => {
          floating.classList.add('is-dismissed');
          try { sessionStorage.setItem(key, '1'); } catch (e) { /* ignore */ }
        });
      }
    }

    /* ------------------------------------------------------------------ */
    /* Infinite loop (modal feed)                                           */
    /* ------------------------------------------------------------------ */
    /*
      Clones of the first/last slide are appended at the opposite ends of
      the track so swiping past the last video continues into what looks
      like the first one (and vice versa). Once the clone settles as the
      active slide, we jump — no animation — to its real counterpart, which
      is visually identical, so the loop reads as seamless. The clones are
      real, independent DOM nodes: they get their own video/playpause/mute
      listeners from the setup below, just like any other slide.
    */
    _setupLoopClones() {
      this._loopOffset = 0;
      this._realSlideCount = this.slides.length;
      if (!this.track || this.slides.length < 2) return;

      const first = this.slides[0];
      const last = this.slides[this.slides.length - 1];
      const firstClone = first.cloneNode(true);
      const lastClone = last.cloneNode(true);
      firstClone.setAttribute('data-ugcg-clone', 'first');
      lastClone.setAttribute('data-ugcg-clone', 'last');
      firstClone.setAttribute('aria-hidden', 'true');
      lastClone.setAttribute('aria-hidden', 'true');

      this.track.insertBefore(lastClone, first);
      this.track.appendChild(firstClone);
      this.slides = Array.from(this.track.querySelectorAll('.ugcg-slide'));
      this._loopOffset = 1;
    }

    /** If the settled slide is a loop clone, silently jump to its real counterpart. */
    _correctLoopClone() {
      if (!this._loopOffset) return;
      const slide = this._activeSlide;
      const cloneSide = slide?.dataset.ugcgClone;
      if (!cloneSide) return;
      const targetIndex = cloneSide === 'first' ? this._loopOffset : this.slides.length - 1 - this._loopOffset;
      const target = this.slides[targetIndex];
      if (!target) return;
      target.scrollIntoView({ block: 'start', behavior: 'instant' in Element.prototype ? 'instant' : 'auto' });
      this._activateSlide(target);
    }

    /* ------------------------------------------------------------------ */
    /* Fullscreen modal                                                     */
    /* ------------------------------------------------------------------ */
    _setupModal() {
      if (!this.modal || !this.track || !this.slides.length) return;

      // Close button + Escape.
      const closeBtn = this.modal.querySelector('[data-ugcg-close]');
      if (closeBtn) this._listen(closeBtn, 'click', () => this.closeModal());

      // Clicking the backdrop (outside the video itself) closes the modal —
      // the slide/stage elements are the empty space around the video, so a
      // click that lands directly on them (rather than the video or a
      // control) means the shopper tapped outside it.
      this._listen(this.track, 'click', (e) => {
        if (
          e.target === this.track ||
          e.target.classList.contains('ugcg-slide') ||
          e.target.classList.contains('ugcg-slide__stage')
        ) {
          this.closeModal();
        }
      });

      // Desktop prev/next buttons.
      this.modal.querySelectorAll('[data-ugcg-nav]').forEach((btn) => {
        this._listen(btn, 'click', () => {
          this._scrollToSlide(this._activeIndex() + (btn.dataset.ugcgNav === 'next' ? 1 : -1));
        });
      });

      // Keyboard.
      this._onKeydown = (e) => {
        if (this.modal.hidden) return;
        switch (e.key) {
          case 'Escape':
            e.preventDefault();
            this.closeModal();
            break;
          case 'ArrowDown':
          case 'ArrowRight':
          case 'PageDown':
            e.preventDefault();
            this._scrollToSlide(this._activeIndex() + 1);
            break;
          case 'ArrowUp':
          case 'ArrowLeft':
          case 'PageUp':
            e.preventDefault();
            this._scrollToSlide(this._activeIndex() - 1);
            break;
          case ' ':
            // Space toggles play/pause instead of scrolling the feed.
            if (e.target === this.track || e.target === document.body) {
              e.preventDefault();
              this._togglePlayback(this.slides[this._activeIndex()]);
            }
            break;
          case 'Tab':
            this._trapFocus(e);
            break;
        }
      };

      // Product pill carousels (one per slide, when multiple products tagged).
      this.modal.querySelectorAll('[data-ugcg-pcarousel]').forEach((pc) => {
        const ptrack = pc.querySelector('[data-ugcg-ptrack]');
        if (!ptrack) return;
        pc.querySelectorAll('[data-ugcg-pnav]').forEach((btn) => {
          this._listen(btn, 'click', (e) => {
            e.stopPropagation();
            const dir = btn.dataset.ugcgPnav === 'next' ? 1 : -1;
            ptrack.scrollBy({ left: dir * ptrack.clientWidth, behavior: 'smooth' });
          });
        });
      });

      // Global mute toggle (top-right). Hidden when the feed has no videos.
      this.modal.querySelectorAll('[data-ugcg-mute]').forEach((btn) => {
        if (!this.track.querySelector('video')) {
          btn.hidden = true;
          return;
        }
        this._listen(btn, 'click', () => {
          this.muted = !this.muted;
          this._applyMuteState();
        });
      });

      // Per-slide controls.
      this.slides.forEach((slide) => {
        const playpause = slide.querySelector('[data-ugcg-playpause]');
        if (playpause) this._listen(playpause, 'click', () => this._togglePlayback(slide));
      });

      // Infinite loop: after scrolling settles, snap off any clone onto its
      // real counterpart (see _setupLoopClones).
      if (this._loopOffset) {
        this._listen(this.track, 'scroll', () => {
          clearTimeout(this._loopSettleTimer);
          this._loopSettleTimer = setTimeout(() => this._correctLoopClone(), 120);
        }, { passive: true });
        this._teardownFns.push(() => clearTimeout(this._loopSettleTimer));
      }

      // Track which slide is active while the user swipes/scrolls.
      if (IO_SUPPORTED) {
        this._slideObserver = new IntersectionObserver(
          (entries) => {
            entries.forEach((entry) => {
              if (entry.intersectionRatio >= 0.6) this._activateSlide(entry.target);
            });
          },
          { root: this.track, threshold: [0.6] }
        );
        this._teardownFns.push(() => this._slideObserver.disconnect());
      } else {
        // Fallback: derive active slide from scroll position.
        this._listen(
          this.track,
          'scroll',
          () => {
            clearTimeout(this._scrollTimer);
            this._scrollTimer = setTimeout(() => {
              const idx = Math.round(this.track.scrollTop / this.track.clientHeight);
              if (this.slides[idx]) this._activateSlide(this.slides[idx]);
            }, 90);
          },
          { passive: true }
        );
      }
    }

    openModal(index) {
      if (!this.modal) return;
      this._lastFocused = document.activeElement;
      this.modal.hidden = false;
      document.body.classList.add('ugcg-modal-open');
      document.addEventListener('keydown', this._onKeydown);

      if (this._slideObserver) this.slides.forEach((s) => this._slideObserver.observe(s));

      // Jump (not smooth-scroll) straight to the requested slide. `index` is
      // a real 0-based card index — offset past the prepended loop clone.
      const real = Math.max(0, Math.min(index, this._realSlideCount - 1));
      const target = this.slides[real + this._loopOffset];
      target.scrollIntoView({ block: 'start', behavior: 'instant' in Element.prototype ? 'instant' : 'auto' });
      this._activateSlide(target);
      this.track.focus({ preventScroll: true });
    }

    closeModal() {
      if (!this.modal || this.modal.hidden) return;
      this.modal.hidden = true;
      document.body.classList.remove('ugcg-modal-open');
      document.removeEventListener('keydown', this._onKeydown);
      if (this._slideObserver) this.slides.forEach((s) => this._slideObserver.unobserve(s));

      // Stop all playback.
      this.track.querySelectorAll('video').forEach((v) => v.pause());
      this._activeSlide = null;

      if (this._lastFocused && document.contains(this._lastFocused)) {
        this._lastFocused.focus({ preventScroll: true });
      }
    }

    /* -------------------- modal internals -------------------- */

    _activeIndex() {
      return this._activeSlide ? this.slides.indexOf(this._activeSlide) : 0;
    }

    /** Wraps around instead of clamping — the loop clones make either end
        of this look continuous (see _setupLoopClones/_correctLoopClone). */
    _scrollToSlide(index) {
      const total = this.slides.length;
      if (!total) return;
      const wrapped = ((index % total) + total) % total;
      this.slides[wrapped].scrollIntoView({ block: 'start', behavior: 'smooth' });
    }

    /** Marks a slide active: load + play its video, pause the others. */
    _activateSlide(slide) {
      if (this._activeSlide === slide) return;
      this._activeSlide = slide;

      const idx = this.slides.indexOf(slide);
      // Hydrate active slide ± 1 so the next swipe starts instantly.
      [idx - 1, idx, idx + 1].forEach((i) => {
        if (this.slides[i]) this._hydrateVideo(this.slides[i]);
      });

      this.slides.forEach((s) => {
        const video = s.querySelector('video');
        if (!video) return;
        if (s === slide) {
          video.muted = this.muted;
          video.play().catch(() => {
            // Autoplay w/ sound may be blocked — retry muted.
            video.muted = true;
            this.muted = true;
            this._applyMuteState();
            video.play().catch(() => {});
          });
          s.classList.remove('is-paused');
        } else {
          video.pause();
          s.classList.remove('is-paused');
        }
      });
      this._applyMuteState();
    }

    /** Attaches the real src to a slide's <source> elements once. */
    _hydrateVideo(slide) {
      const video = slide.querySelector('video');
      if (!video || video.dataset.hydrated) return;
      let hasSource = false;
      video.querySelectorAll('source[data-src]').forEach((source) => {
        source.src = source.dataset.src;
        hasSource = true;
      });
      if (hasSource) {
        video.dataset.hydrated = 'true';
        video.load();
      }
    }

    _togglePlayback(slide) {
      const video = slide?.querySelector('video');
      if (!video) return;
      if (video.paused) {
        video.play().catch(() => {});
        slide.classList.remove('is-paused');
      } else {
        video.pause();
        slide.classList.add('is-paused');
      }
    }

    /** Syncs the shared mute state to every video + toggle button. */
    _applyMuteState() {
      this.track.querySelectorAll('video').forEach((v) => { v.muted = this.muted; });
      this.modal.querySelectorAll('[data-ugcg-mute]').forEach((btn) => {
        btn.setAttribute('aria-pressed', String(!this.muted));
        btn.setAttribute('aria-label', this.muted ? 'Unmute video' : 'Mute video');
      });
    }

    /** Minimal focus trap while the modal is open. */
    _trapFocus(e) {
      const focusables = this.modal.querySelectorAll(
        'button:not([tabindex="-1"]), a[href], [tabindex]:not([tabindex="-1"])'
      );
      if (!focusables.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }

  customElements.define('ugc-gallery', UGCGallery);
})();
