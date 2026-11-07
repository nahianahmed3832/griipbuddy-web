'use client';

import { ImageIcon, Play } from 'lucide-react';
import Image from 'next/image';
import { useState, type ReactNode } from 'react';

const poster = '/editorial/device-edit-campaign.webp';

export function CampaignStage({ video, children }: { video?: string; children: ReactNode }) {
  const [showVideo, setShowVideo] = useState(false);
  const [failed, setFailed] = useState(false);

  return <section className="retail-hero" aria-label="The Device Edit" data-video={showVideo || undefined}>
    <div className="retail-hero-media">
      {showVideo ? <video src={video} aria-label="iQOO case campaign video" poster={poster}
        autoPlay muted playsInline controls preload="metadata" onError={() => { setShowVideo(false); setFailed(true); }} />
        : <Image src={poster} alt="White, gray and charcoal phone cases with orange camera rims on terracotta"
          fill priority sizes="100vw" />}
    </div>
    <div className="retail-hero-copy" hidden={showVideo}>{children}</div>
    {video && <button className="retail-hero-media-toggle" type="button" onClick={() => {
      setFailed(false);
      setShowVideo(!showVideo);
    }}>
      {showVideo ? <><ImageIcon size={17} aria-hidden /> Show photo</> : <><Play size={17} aria-hidden /> Play video</>}
    </button>}
    {failed && <p className="retail-hero-media-error" role="status">The campaign video couldn’t load. Try playing it again.</p>}
  </section>;
}
