'use client';

import { Check, Clock3, Copy, Ticket, Users } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { updateBrowserList, useBrowserList } from '@/features/catalog/browser-lists';
import { formatMoney, type Market } from '@/features/catalog/catalog';
import { useBagCommands } from '@/features/cart/store';
import type { Campaign, CouponOffer, GroupCampaign } from './contracts';

export function CampaignClock({ campaign }: { campaign: Campaign }) {
  const [now, setNow] = useState<number>();
  const start = Date.parse(campaign.startsAt);
  const end = Date.parse(campaign.endsAt);

  useEffect(() => {
    const tick = () => setNow(Date.now());
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, []);

  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  if (now === undefined) return <p className="campaign-clock"><Clock3 size={17} aria-hidden /> Scheduled end <time dateTime={campaign.endsAt}>{campaign.endsAt.slice(0, 10)} UTC</time></p>;
  if (now < start) return <p className="campaign-clock"><Clock3 size={17} aria-hidden /> Starts <time dateTime={campaign.startsAt}>{campaign.startsAt.slice(0, 10)} UTC</time></p>;
  if (now >= end) return <p className="campaign-clock"><Clock3 size={17} aria-hidden /> Campaign ended</p>;

  const seconds = Math.ceil((end - now) / 1000);
  const digits = [Math.floor(seconds / 3600) % 24, Math.floor(seconds / 60) % 60, seconds % 60];
  const duration = Math.floor(seconds / 86400) + 'd ' + digits.map((value) => String(value).padStart(2, '0')).join(':');
  return <p className="campaign-clock"><Clock3 size={17} aria-hidden /> Ends in <span role="timer">{duration}</span></p>;
}

export function ShareLink({ path, label = 'Copy link' }: { path: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const [manual, setManual] = useState('');
  const fieldId = useId();

  async function copy() {
    const url = new URL(path, window.location.origin).href;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setManual('');
    } catch {
      setManual(url);
    }
  }

  return <div className="share-control">
    <button type="button" className="button button-outline" onClick={() => void copy()}><Copy size={16} aria-hidden /> {label}</button>
    {copied && <small role="status">Link copied</small>}
    {manual && <div className="share-manual"><label htmlFor={fieldId}>Copy this link</label>
      <input id={fieldId} readOnly value={manual} onFocus={(event) => event.currentTarget.select()} /></div>}
  </div>;
}

export function GroupProgress({ campaign }: { campaign: GroupCampaign }) {
  const storageKey = 'griipbuddy-preview-group:' + campaign.id;
  const { items, hydrated } = useBrowserList(storageKey);
  const joined = items.includes('joined');
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const tick = () => setOpen(Date.now() >= Date.parse(campaign.startsAt) && Date.now() < Date.parse(campaign.endsAt));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [campaign.endsAt, campaign.startsAt]);
  const count = Math.min(campaign.goal, campaign.participants + Number(joined));

  return <>
    <div className="group-progress">
      <p><Users size={17} aria-hidden /> <strong>{count} of {campaign.goal}</strong> sample spots filled</p>
      <progress value={count} max={campaign.goal} aria-label="Sample group progress" />
    </div>
    <ol className="group-tiers">
      {campaign.tiers.map((tier) => <li key={tier.minimum} data-unlocked={count >= tier.minimum}>
        <strong>{tier.percent}% off</strong><span>{tier.minimum} participants</span>
        {count >= tier.minimum && <small><Check size={14} aria-hidden /> Preview tier reached</small>}
      </li>)}
    </ol>
    <button type="button" className="button button-primary" disabled={!hydrated || !open || (!joined && count >= campaign.goal)}
      onClick={() => updateBrowserList(storageKey, (previous) => previous.includes('joined') ? [] : ['joined'])}>
      {joined ? 'Leave sample group' : 'Join sample group'}
    </button>
  </>;
}

export function CouponWallet({ offers, market }: { offers: CouponOffer[]; market: Market }) {
  const key = 'griipbuddy-coupons:' + market.code;
  const { items, hydrated } = useBrowserList(key);
  const { coupon, error } = useBagCommands();
  const [savedOnly, setSavedOnly] = useState(false);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const visible = savedOnly ? offers.filter(({ code }) => items.includes(code)) : offers;

  return <>
    <div className="discovery-tabs" aria-label="Coupon view">
      <button type="button" aria-pressed={!savedOnly} onClick={() => setSavedOnly(false)}>Available</button>
      <button type="button" aria-pressed={savedOnly} onClick={() => setSavedOnly(true)}>Saved on this device</button>
    </div>
    <p role="status" className="coupon-status">{error || status}</p>
    {visible.length ? <div className="coupon-grid">
      {visible.map((offer) => {
        const saved = items.includes(offer.code);
        const discount = offer.discount.type === 'percent' ? offer.discount.amount + '%' : formatMoney(offer.discount.amount, market);
        return <article key={offer.code} className="coupon-ticket">
          <div className="coupon-ticket-header"><Ticket aria-hidden /><span>{offer.fixture ? 'SAMPLE COUPON' : offer.firstOrder ? 'FIRST ORDER' : 'STORE OFFER'}</span></div>
          <h2>{discount} off</h2>
          {offer.description && <p>{offer.description}</p>}
          <ul>
            {offer.minSpend !== undefined && <li>Minimum spend {formatMoney(offer.minSpend, market)}</li>}
            {offer.maxDiscount !== undefined && <li>Maximum discount {formatMoney(offer.maxDiscount, market)}</li>}
            {offer.restrictedItems && <li>Selected items only</li>}
            {offer.endsAt && <li>Ends <time dateTime={offer.endsAt}>{new Intl.DateTimeFormat(market.locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(offer.endsAt))} UTC</time></li>}
            {!offer.fixture && <li>Subject to eligibility at checkout</li>}
          </ul>
          <div className="coupon-ticket-actions">
            <code>{offer.code}</code>
            <button className="button button-outline" type="button" disabled={!hydrated} aria-pressed={saved}
              onClick={() => updateBrowserList(key, (previous) => saved ? previous.filter((code) => code !== offer.code) : [offer.code, ...previous].slice(0, 50))}>
              {saved ? 'Remove saved coupon' : 'Save coupon'}
            </button>
            {offer.fixture && <button className="button button-primary" type="button" disabled={busy} onClick={async () => {
              setBusy(true);
              try {
                setStatus(await coupon(market.code, offer.code) ? offer.code + ' added to your bag.' : 'Could not add the code. Try again.');
              } catch { setStatus('Could not add the code. Try again.'); }
              finally { setBusy(false); }
            }}>Use in bag</button>}
          </div>
        </article>;
      })}
    </div> : <div className="empty-state"><Ticket aria-hidden /><h2>{savedOnly ? 'No saved offers' : 'No active coupons'}</h2>
      <p>{savedOnly ? 'Save an available offer to find it again on this device.' : 'Offers for this market will appear here when available.'}</p></div>}
  </>;
}
