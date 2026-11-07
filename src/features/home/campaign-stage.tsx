'use client';

import { ArrowRight, Pause, Play } from 'lucide-react';
import Image from 'next/image';
import Link from 'next/link';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';

export type CampaignSlide = {
  title: string;
  image?: string;
  imageAlt?: string;
  video?: string;
  href?: string;
  label?: string;
};

const reducedMotion = '(prefers-reduced-motion: reduce)';
function subscribeMotion(change: () => void) {
  const query = window.matchMedia(reducedMotion);
  query.addEventListener('change', change);
  return () => query.removeEventListener('change', change);
}
function subscribeVisibility(change: () => void) {
  document.addEventListener('visibilitychange', change);
  return () => document.removeEventListener('visibilitychange', change);
}

export function CampaignStage({ slides }: { slides: [CampaignSlide, ...CampaignSlide[]] }) {
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const [focused, setFocused] = useState(false);
  const [failedIndex, setFailedIndex] = useState(-1);
  const motion = useSyncExternalStore(subscribeMotion, () => !window.matchMedia(reducedMotion).matches, () => false);
  const visible = useSyncExternalStore(subscribeVisibility, () => !document.hidden, () => false);
  const video = useRef<HTMLVideoElement>(null);
  const slide = slides[index] ?? slides[0];
  const multiple = slides.length > 1;
  const moving = motion && visible && !paused;

  useEffect(() => {
    const element = video.current;
    if (!element) return;
    if (moving) void element.play().catch(() => {});
    else element.pause();
  }, [index, moving]);

  useEffect(() => {
    if (!multiple || !moving || focused) return;
    const timer = window.setTimeout(() => setIndex((value) => (value + 1) % slides.length),
      slide.video && failedIndex !== index ? 10000 : 6000);
    return () => window.clearTimeout(timer);
  }, [multiple, moving, focused, slides.length, index, slide.video, failedIndex]);

  const image = slide.image ?? '/editorial/device-edit-campaign.webp';
  return <section className="retail-hero" aria-label="Featured campaigns" aria-roledescription="carousel">
    <div className="retail-hero-media">
      {slide.video && failedIndex !== index && motion
        ? <video aria-hidden="true" key={index} ref={video} src={slide.video} poster={slide.image} autoPlay={moving} muted playsInline loop
          preload="metadata" onError={() => setFailedIndex(index)} />
        : <Image src={image} alt={slide.imageAlt ?? ''} fill priority={index === 0} unoptimized={image.startsWith('https:')} sizes="(max-width: 760px) 100vw, 1440px" />}
    </div>
    <div className="retail-hero-copy" onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}>
      <p className="eyebrow"><span aria-hidden="true" /> THE DEVICE EDIT</p>
      <h1 className="retail-hero-title">{slide.title}</h1>
      {slide.href && <Link className="button button-primary" href={slide.href}>
        {slide.label || 'Shop now'} <ArrowRight size={16} aria-hidden="true" />
      </Link>}
    </div>
    {(multiple || (motion && slide.video)) && <div className="retail-hero-controls" aria-label="Campaign carousel controls">
      {multiple && slides.map((item, position) => <button key={position} type="button"
        aria-label={`Show slide ${position + 1}: ${item.title}`} aria-current={position === index ? 'true' : undefined}
        onClick={() => { setIndex(position); setFailedIndex(-1); }}><span aria-hidden="true" /></button>)}
      {motion && <button type="button" className="retail-hero-pause" aria-label={paused ? 'Resume banner motion' : 'Pause banner motion'}
        onClick={() => setPaused(!paused)}>{paused ? <Play size={15} aria-hidden="true" /> : <Pause size={15} aria-hidden="true" />}</button>}
    </div>}
  </section>;
}
