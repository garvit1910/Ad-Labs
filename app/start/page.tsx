'use client';

import { useCallback, useEffect, useRef, useState, type DragEvent, type FormEvent } from 'react';
import Link from 'next/link';
import { Activity, ArrowRight, Bot, Check, Fingerprint, ImagePlus, Loader2, Swords, type LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { EyebrowChip } from '@/components/ui/eyebrow-chip';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/page-header';
import { cn } from '@/lib/utils';

// /start: the brand kit, the step right after the landing page and before any other. The user
// gives the brand's website and a product photo; POST /api/brand-kit saves the photo and the
// SpacetimeDB brand_kit row, which the agents check before a run and render the winning ads from.

interface Kit {
  ready: boolean;
  reason: string;
  brand_url: string;
  brand_name: string;
  image_file: string;
  image_path: string;
  updated_at: string | null;
}

interface OnFile {
  brand_name: string;
  facts: number;
  personas: number;
  mentions: number;
  ads: number;
  competitors: number;
}

type Envelope<T> = { ok: true; data: T } | { ok: false; error: string; code: string };

const NEXT: { href: string; title: string; description: string; icon: LucideIcon; primary?: boolean }[] = [
  {
    href: '/agents',
    title: 'Agents',
    description: 'Open ASI:One beside this room and ask Ad Lab to find ads that beat the current ones.',
    icon: Bot,
    primary: true,
  },
  { href: '/sim', title: 'Live sim', description: 'Watch the recipes tested on simulated shoppers.', icon: Activity },
  { href: '/brand-identity', title: 'Brand Identity', description: 'Positioning, proof points and customer voice.', icon: Fingerprint },
  {
    href: '/brand-identity/competitor-analysis',
    title: 'Competitor Analysis',
    description: "The competitors' live Meta ads, labelled.",
    icon: Swords,
  },
];

const DEFAULT_URL = 'https://magicspoon.com/';
const ACCEPT = 'image/png,image/jpeg,image/webp';

export default function StartPage() {
  const [kit, setKit] = useState<Kit | null>(null);
  const [onFile, setOnFile] = useState<OnFile | null>(null);
  const [loading, setLoading] = useState(true);
  const [url, setUrl] = useState(DEFAULT_URL);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetch('/api/brand-kit', { cache: 'no-store' })
      .then((res) => res.json() as Promise<Envelope<{ kit: Kit; on_file: OnFile | null }>>)
      .then((body) => {
        if (!body.ok) return setError(body.error);
        setKit(body.data.kit);
        setOnFile(body.data.on_file);
        if (body.data.kit.brand_url) setUrl(body.data.kit.brand_url);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!file) return setPreview(null);
    const objectUrl = URL.createObjectURL(file);
    setPreview(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [file]);

  const pick = useCallback((f: File | undefined | null) => {
    if (!f) return;
    if (!ACCEPT.split(',').includes(f.type)) return setError('Use a PNG, JPEG or WebP photo of the product.');
    setError(null);
    setFile(f);
  }, []);

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(false);
    pick(e.dataTransfer.files?.[0]);
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!file) return setError('Add a product photo.');
    setSaving(true);
    setError(null);
    const form = new FormData();
    form.set('url', url);
    form.set('image', file);
    try {
      const res = await fetch('/api/brand-kit', { method: 'POST', body: form });
      const body = (await res.json()) as Envelope<{ kit: Kit; on_file: OnFile | null }>;
      if (!body.ok) return setError(body.error);
      setKit(body.data.kit);
      setOnFile(body.data.on_file);
      setFile(null);
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const saved = kit?.ready && !editing;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow={<EyebrowChip icon={ImagePlus}>Step 1 · Brand kit</EyebrowChip>}
        title="Start with your brand"
        description="Your brand's website and a photo of the product. The agents won't start a run without them, and every ad image is rendered with the real product."
      />

      {loading ? (
        <div className="frost-card flex items-center gap-2 p-6 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading the brand kit…
        </div>
      ) : saved ? (
        <SavedKit kit={kit} onFile={onFile} onEdit={() => setEditing(true)} />
      ) : (
        <form onSubmit={onSubmit} className="frost-card grid gap-6 p-6 md:grid-cols-[1fr_320px]">
          <div className="flex flex-col gap-5">
            <label className="flex flex-col gap-2">
              <span className="text-sm font-medium">Brand website</span>
              <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://yourbrand.com" inputMode="url" required />
            </label>
            <div className="flex flex-col gap-2">
              <span className="text-sm font-medium">Product reference photo</span>
              <span className="text-xs text-muted-foreground">
                A clear shot of the packaging, label facing the camera. PNG, JPEG or WebP, up to 8 MB.
              </span>
              <div
                role="button"
                tabIndex={0}
                onClick={() => input.current?.click()}
                onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && input.current?.click()}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={onDrop}
                className={cn(
                  'flex min-h-36 cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border border-dashed p-6 text-center text-sm transition-colors',
                  dragging ? 'border-brand bg-brand-soft' : 'border-border hover:border-foreground/40'
                )}
              >
                <ImagePlus className="size-5 text-brand-text" />
                <span>{file ? file.name : 'Drop the photo here, or click to choose'}</span>
              </div>
              <input ref={input} type="file" accept={ACCEPT} className="hidden" onChange={(e) => pick(e.target.files?.[0])} />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <div className="flex items-center gap-3">
              <Button type="submit" variant="gradient1" disabled={saving || !file}>
                {saving ? <Loader2 className="animate-spin" /> : <Check />}
                Save brand kit
              </Button>
              {kit?.ready && (
                <Button type="button" variant="outline" onClick={() => setEditing(false)}>
                  Cancel
                </Button>
              )}
            </div>
          </div>
          <div className="flex aspect-square items-center justify-center overflow-hidden rounded-lg border border-border/60 bg-muted/20">
            {preview ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={preview} alt="Product photo preview" className="h-full w-full object-contain" />
            ) : (
              <span className="px-6 text-center text-xs text-muted-foreground">The product photo shows here</span>
            )}
          </div>
        </form>
      )}

      {!loading && !saved && kit && !kit.ready && kit.reason && !error && (
        <p className="text-xs text-muted-foreground">{kit.reason}</p>
      )}
    </div>
  );
}

function SavedKit({ kit, onFile, onEdit }: { kit: Kit; onFile: OnFile | null; onEdit: () => void }) {
  return (
    <>
      <div className="frost-card grid gap-6 p-6 md:grid-cols-[220px_1fr]">
        <div className="aspect-square overflow-hidden rounded-lg border border-border/60 bg-muted/20">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={kit.image_path} alt="Product reference photo" className="h-full w-full object-contain" />
        </div>
        <div className="flex flex-col gap-3">
          <span className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-brand-text">
            <Check className="size-3.5" /> Brand kit saved
          </span>
          <span className="text-2xl font-semibold tracking-tight">{kit.brand_name || kit.brand_url}</span>
          <a href={kit.brand_url} target="_blank" rel="noreferrer" className="text-sm text-muted-foreground hover:text-foreground">
            {kit.brand_url}
          </a>
          {onFile && (
            <div className="mt-1 grid grid-cols-2 gap-3 sm:grid-cols-5">
              <Stat label="brand facts" value={onFile.facts} />
              <Stat label="personas" value={onFile.personas} />
              <Stat label="customer mentions" value={onFile.mentions} />
              <Stat label="Meta ads" value={onFile.ads} />
              <Stat label="competitors" value={onFile.competitors} />
            </div>
          )}
          <div className="mt-auto">
            <Button variant="outline" size="sm" onClick={onEdit}>
              Change the URL or photo
            </Button>
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <span className="text-sm font-medium text-muted-foreground">Next</span>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
          {NEXT.map(({ href, title, description, icon: Icon, primary }) => (
            <Link
              key={href}
              href={href}
              className={cn('frost-card flex flex-col gap-3 p-5 transition-colors hover:border-brand/40', primary && 'border-brand/50')}
            >
              <span className="flex size-9 items-center justify-center rounded-lg bg-brand-soft text-brand-text">
                <Icon className="size-4" />
              </span>
              <span className="flex items-center gap-2 text-lg font-semibold tracking-tight">
                {title}
                {primary && <ArrowRight className="size-4 text-brand-text" />}
              </span>
              <span className="text-sm text-muted-foreground">{description}</span>
            </Link>
          ))}
        </div>
      </div>
    </>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-border/60 px-3 py-2">
      <div className="text-lg font-semibold tabular-nums">{value.toLocaleString()}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}
