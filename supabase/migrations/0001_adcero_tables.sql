-- Ad Lab A1: the Adcero tables of REUSE_MANIFEST §13 (17 tables).
-- Generated from Adcero drizzle/meta/0174_snapshot.json at f9bb088c, which matches
-- drizzle/schema.ts (§13) column for column. Kept: every column, default, CHECK,
-- index (unique and partial ones too; PostgREST onConflict needs them) and the
-- foreign keys between these tables.
-- Dropped: the foreign keys to organizations (single tenant, one constant org id:
-- lib/adlab/org.ts) and every RLS policy. With no RLS, only the service role is
-- granted access; anon and authenticated get nothing.
-- Dropped foreign keys:
--   brand_presence_profiles.organization_id -> organizations
--   brand_presence_sources.organization_id -> organizations
--   tracked_competitors.organization_id -> organizations
--   library_ads.organization_id -> organizations
--   ad_labels.organization_id -> organizations
--   ad_embeddings.organization_id -> organizations
--   brand_mentions.organization_id -> organizations
--   brand_presence_tiktok_videos.organization_id -> organizations
--   brand_presence_instagram_posts.organization_id -> organizations
--   brand_presence_themes.organization_id -> organizations
--   brand_presence_phrases.organization_id -> organizations
--   brand_facts.organization_id -> organizations
--   brand_chunks.organization_id -> organizations
--   brand_object_state.organization_id -> organizations
--   brand_fact_suggestions.organization_id -> organizations
--   brand_context_rows.organization_id -> organizations
--   brand_context_packs.organization_id -> organizations

create table public.brand_presence_profiles (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  website_url text not null,
  brand_name text not null,
  name_variants jsonb not null default '[]'::jsonb,
  product_description text,
  category text,
  competitors jsonb not null default '[]'::jsonb,
  status text not null default 'draft',
  presence_role text,
  amazon_marketplace text not null default 'com',
  amazon_storefront_url text,
  amazon_product_urls jsonb not null default '[]'::jsonb,
  meta jsonb not null default '{}'::jsonb,
  brand_kit jsonb,
  created_at timestamp with time zone not null default timezone('utc'::text, now()),
  updated_at timestamp with time zone not null default timezone('utc'::text, now()),
  tags jsonb not null default '{}'::jsonb,
  scores jsonb not null default '{}'::jsonb,
  entity_constraints jsonb not null default '{}'::jsonb,
  edit_history jsonb not null default '[]'::jsonb,
  constraint brand_presence_profiles_status_check check (status = ANY (ARRAY['draft'::text, 'confirmed'::text])),
  constraint brand_presence_profiles_presence_role_check check (presence_role IS NULL OR presence_role = ANY (ARRAY['self'::text, 'competitor'::text]))
);

create index idx_brand_presence_profiles_org on public.brand_presence_profiles using btree (organization_id);

revoke all on table public.brand_presence_profiles from anon, authenticated;
grant all on table public.brand_presence_profiles to service_role;

create table public.brand_presence_sources (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  brand_profile_id uuid not null,
  source_type text not null,
  uri text not null default '',
  label text,
  status text not null default 'available',
  meta jsonb not null default '{}'::jsonb,
  last_synced_at timestamp with time zone,
  created_at timestamp with time zone not null default timezone('utc'::text, now()),
  updated_at timestamp with time zone not null default timezone('utc'::text, now()),
  tags jsonb not null default '{}'::jsonb,
  scores jsonb not null default '{}'::jsonb,
  entity_constraints jsonb not null default '{}'::jsonb,
  edit_history jsonb not null default '[]'::jsonb,
  constraint brand_presence_sources_source_type_check check (source_type = ANY (ARRAY['reddit_search'::text, 'reddit_subreddit'::text, 'reddit_category'::text, 'amazon_reviews'::text, 'google_maps_reviews'::text, 'instagram_comments'::text, 'tiktok_comments'::text, 'trustpilot'::text, 'onsite_reviews'::text, 'youtube'::text, 'x'::text])),
  constraint brand_presence_sources_status_check check (status = ANY (ARRAY['available'::text, 'coming_soon'::text, 'pending'::text, 'running'::text, 'synced'::text, 'error'::text])),
  constraint brand_presence_sources_brand_profile_id_fkey foreign key (brand_profile_id) references public.brand_presence_profiles (id) on delete cascade
);

create unique index brand_presence_sources_profile_type_uri_unique on public.brand_presence_sources using btree (brand_profile_id, source_type, uri);

create index idx_brand_presence_sources_org on public.brand_presence_sources using btree (organization_id);

revoke all on table public.brand_presence_sources from anon, authenticated;
grant all on table public.brand_presence_sources to service_role;

create table public.tracked_competitors (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  brand_profile_id uuid,
  name text not null,
  platform text not null default 'meta',
  keyword text,
  country text not null default 'US',
  page_ref text,
  meta_page_id text,
  meta_page_name text,
  google_advertiser_id text,
  google_advertiser_name text,
  industry text,
  brand_type text not null default 'unknown',
  is_brand_self boolean not null default false,
  status text not null default 'active',
  last_synced_at timestamp with time zone,
  sync_run_id text,
  sync_run_started_at timestamp with time zone,
  created_at timestamp with time zone not null default timezone('utc'::text, now()),
  updated_at timestamp with time zone not null default timezone('utc'::text, now()),
  tags jsonb not null default '{}'::jsonb,
  scores jsonb not null default '{}'::jsonb,
  entity_constraints jsonb not null default '{}'::jsonb,
  edit_history jsonb not null default '[]'::jsonb,
  constraint tracked_competitors_status_check check (status = ANY (ARRAY['active'::text, 'paused'::text])),
  constraint tracked_competitors_platform_check check (platform = ANY (ARRAY['meta'::text, 'google'::text, 'twitter'::text])),
  constraint tracked_competitors_brand_type_check check (brand_type = ANY (ARRAY['dtc_performance'::text, 'brand_cpg'::text, 'unknown'::text])),
  constraint tracked_competitors_brand_profile_id_fkey foreign key (brand_profile_id) references public.brand_presence_profiles (id) on delete set null
);

create unique index tracked_competitors_org_page_unique on public.tracked_competitors using btree (organization_id, meta_page_id);

create unique index tracked_competitors_org_keyword_country_unique on public.tracked_competitors using btree (organization_id, keyword, country);

create unique index tracked_competitors_org_google_unique on public.tracked_competitors using btree (organization_id, google_advertiser_id);

create index idx_tracked_competitors_org_status on public.tracked_competitors using btree (organization_id, status);

create index idx_tracked_competitors_brand_profile on public.tracked_competitors using btree (brand_profile_id);

create index idx_tracked_competitors_industry_platform on public.tracked_competitors using btree (industry, platform);

revoke all on table public.tracked_competitors from anon, authenticated;
grant all on table public.tracked_competitors to service_role;

create table public.library_ads (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  competitor_id uuid not null,
  external_ad_id text not null,
  platform text not null default 'meta',
  ad_snapshot_url text,
  creative_bodies jsonb not null default '[]'::jsonb,
  creative_link_titles jsonb not null default '[]'::jsonb,
  page_name text,
  publisher_platforms jsonb not null default '[]'::jsonb,
  delivery_start timestamp with time zone not null,
  delivery_stop timestamp with time zone,
  eu_total_reach integer,
  currency text,
  spend_range jsonb,
  media_type text not null default 'unknown',
  media_urls jsonb,
  video_urls jsonb,
  hosted_media_urls jsonb,
  hosted_video_urls jsonb,
  num_served_days integer,
  landing_url text,
  landing_domain text,
  raw_ref text,
  first_seen_at timestamp with time zone not null default timezone('utc'::text, now()),
  last_seen_at timestamp with time zone not null default timezone('utc'::text, now()),
  created_at timestamp with time zone not null default timezone('utc'::text, now()),
  updated_at timestamp with time zone not null default timezone('utc'::text, now()),
  tags jsonb not null default '{}'::jsonb,
  scores jsonb not null default '{}'::jsonb,
  entity_constraints jsonb not null default '{}'::jsonb,
  edit_history jsonb not null default '[]'::jsonb,
  constraint library_ads_platform_check check (platform = ANY (ARRAY['meta'::text, 'tiktok'::text, 'google'::text, 'twitter'::text])),
  constraint library_ads_media_type_check check (media_type = ANY (ARRAY['image'::text, 'video'::text, 'carousel'::text, 'text'::text, 'unknown'::text])),
  constraint library_ads_competitor_id_fkey foreign key (competitor_id) references public.tracked_competitors (id) on delete cascade
);

create unique index library_ads_org_platform_external_ad_unique on public.library_ads using btree (organization_id, platform, external_ad_id);

create index idx_library_ads_org_competitor_delivery on public.library_ads using btree (organization_id, competitor_id, delivery_start desc);

create index idx_library_ads_competitor_first_seen on public.library_ads using btree (competitor_id, first_seen_at desc);

revoke all on table public.library_ads from anon, authenticated;
grant all on table public.library_ads to service_role;

create table public.ad_labels (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  library_ad_id uuid not null,
  hook_archetype text not null,
  angle text not null,
  angle_universal text,
  persona text,
  persona_universal text,
  funnel_stage text,
  format text not null,
  style text,
  aspect_ratio text,
  fingerprint jsonb,
  offer_type text,
  hook_text text,
  summary text,
  confidence numeric,
  model text not null,
  labeled_at timestamp with time zone not null default timezone('utc'::text, now()),
  created_at timestamp with time zone not null default timezone('utc'::text, now()),
  tags jsonb not null default '{}'::jsonb,
  scores jsonb not null default '{}'::jsonb,
  entity_constraints jsonb not null default '{}'::jsonb,
  edit_history jsonb not null default '[]'::jsonb,
  constraint ad_labels_library_ad_id_fkey foreign key (library_ad_id) references public.library_ads (id) on delete cascade
);

create unique index ad_labels_library_ad_unique on public.ad_labels using btree (library_ad_id);

create index idx_ad_labels_org_id on public.ad_labels using btree (organization_id);

revoke all on table public.ad_labels from anon, authenticated;
grant all on table public.ad_labels to service_role;

create table public.ad_embeddings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  library_ad_id uuid not null,
  embedding extensions.vector(1536) not null,
  embedding_model text not null,
  embedding_dims integer not null,
  content_hash text not null,
  embedded_at timestamp with time zone not null default timezone('utc'::text, now()),
  created_at timestamp with time zone not null default timezone('utc'::text, now()),
  updated_at timestamp with time zone not null default timezone('utc'::text, now()),
  tags jsonb not null default '{}'::jsonb,
  scores jsonb not null default '{}'::jsonb,
  entity_constraints jsonb not null default '{}'::jsonb,
  edit_history jsonb not null default '[]'::jsonb,
  constraint ad_embeddings_library_ad_id_fkey foreign key (library_ad_id) references public.library_ads (id) on delete cascade
);

create unique index ad_embeddings_library_ad_unique on public.ad_embeddings using btree (library_ad_id);

create index idx_ad_embeddings_org_library_ad on public.ad_embeddings using btree (organization_id, library_ad_id);

revoke all on table public.ad_embeddings from anon, authenticated;
grant all on table public.ad_embeddings to service_role;

create table public.brand_mentions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  brand_profile_id uuid not null,
  source_id uuid,
  platform text not null default 'reddit',
  external_id text not null,
  data_type text not null,
  scope text not null,
  url text,
  subreddit text,
  author_ref text,
  title text,
  body text,
  parent_external_id text,
  parent_title text,
  posted_at timestamp with time zone,
  relevance text not null default 'pending',
  relevance_confidence numeric,
  rating numeric,
  extraction_status text not null default 'pending',
  extraction jsonb,
  raw_ref text,
  created_at timestamp with time zone not null default timezone('utc'::text, now()),
  tags jsonb not null default '{}'::jsonb,
  scores jsonb not null default '{}'::jsonb,
  entity_constraints jsonb not null default '{}'::jsonb,
  edit_history jsonb not null default '[]'::jsonb,
  constraint brand_mentions_data_type_check check (data_type = ANY (ARRAY['post'::text, 'comment'::text, 'review'::text])),
  constraint brand_mentions_extraction_status_check check (extraction_status = ANY (ARRAY['pending'::text, 'done'::text, 'skipped'::text, 'error'::text])),
  constraint brand_mentions_scope_check check (scope = ANY (ARRAY['brand'::text, 'competitor'::text, 'category'::text])),
  constraint brand_mentions_relevance_check check (relevance = ANY (ARRAY['pending'::text, 'relevant'::text, 'irrelevant'::text, 'not_required'::text])),
  constraint brand_mentions_brand_profile_id_fkey foreign key (brand_profile_id) references public.brand_presence_profiles (id) on delete cascade,
  constraint brand_mentions_source_id_fkey foreign key (source_id) references public.brand_presence_sources (id) on delete set null
);

create unique index brand_mentions_profile_platform_external_unique on public.brand_mentions using btree (brand_profile_id, platform, external_id);

create index idx_brand_mentions_profile_posted_at on public.brand_mentions using btree (brand_profile_id, posted_at desc);

create index idx_brand_mentions_source on public.brand_mentions using btree (source_id);

create index idx_brand_mentions_profile_parent on public.brand_mentions using btree (brand_profile_id, parent_external_id);

create index idx_brand_mentions_org on public.brand_mentions using btree (organization_id);

create index idx_brand_mentions_profile_extraction on public.brand_mentions using btree (brand_profile_id, extraction_status);

revoke all on table public.brand_mentions from anon, authenticated;
grant all on table public.brand_mentions to service_role;

create table public.brand_presence_tiktok_videos (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  brand_profile_id uuid not null,
  source_id uuid,
  video_id text not null,
  url text not null,
  caption text,
  posted_at timestamp with time zone,
  comment_count integer not null default 0,
  baseline_comment_count integer not null default 0,
  comments_ingested integer not null default 0,
  last_enumerated_at timestamp with time zone,
  last_scraped_at timestamp with time zone,
  meta jsonb not null default '{}'::jsonb,
  first_seen_at timestamp with time zone not null default timezone('utc'::text, now()),
  updated_at timestamp with time zone not null default timezone('utc'::text, now()),
  tags jsonb not null default '{}'::jsonb,
  scores jsonb not null default '{}'::jsonb,
  entity_constraints jsonb not null default '{}'::jsonb,
  edit_history jsonb not null default '[]'::jsonb,
  constraint brand_presence_tiktok_videos_brand_profile_id_fkey foreign key (brand_profile_id) references public.brand_presence_profiles (id) on delete cascade,
  constraint brand_presence_tiktok_videos_source_id_fkey foreign key (source_id) references public.brand_presence_sources (id) on delete set null
);

create unique index brand_presence_tiktok_videos_profile_video_unique on public.brand_presence_tiktok_videos using btree (brand_profile_id, video_id);

create index idx_brand_presence_tiktok_videos_org on public.brand_presence_tiktok_videos using btree (organization_id);

create index idx_brand_presence_tiktok_videos_source on public.brand_presence_tiktok_videos using btree (source_id);

revoke all on table public.brand_presence_tiktok_videos from anon, authenticated;
grant all on table public.brand_presence_tiktok_videos to service_role;

create table public.brand_presence_instagram_posts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  brand_profile_id uuid not null,
  source_id uuid,
  post_id text not null,
  kind text not null default 'post',
  url text not null,
  caption text,
  posted_at timestamp with time zone,
  comment_count integer not null default 0,
  baseline_comment_count integer not null default 0,
  comments_ingested integer not null default 0,
  last_enumerated_at timestamp with time zone,
  last_scraped_at timestamp with time zone,
  meta jsonb not null default '{}'::jsonb,
  first_seen_at timestamp with time zone not null default timezone('utc'::text, now()),
  updated_at timestamp with time zone not null default timezone('utc'::text, now()),
  tags jsonb not null default '{}'::jsonb,
  scores jsonb not null default '{}'::jsonb,
  entity_constraints jsonb not null default '{}'::jsonb,
  edit_history jsonb not null default '[]'::jsonb,
  constraint brand_presence_instagram_posts_brand_profile_id_fkey foreign key (brand_profile_id) references public.brand_presence_profiles (id) on delete cascade,
  constraint brand_presence_instagram_posts_source_id_fkey foreign key (source_id) references public.brand_presence_sources (id) on delete set null
);

create unique index brand_presence_instagram_posts_profile_post_unique on public.brand_presence_instagram_posts using btree (brand_profile_id, post_id);

create index idx_brand_presence_instagram_posts_org on public.brand_presence_instagram_posts using btree (organization_id);

create index idx_brand_presence_instagram_posts_source on public.brand_presence_instagram_posts using btree (source_id);

revoke all on table public.brand_presence_instagram_posts from anon, authenticated;
grant all on table public.brand_presence_instagram_posts to service_role;

create table public.brand_presence_themes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  brand_profile_id uuid not null,
  kind text not null,
  scope text not null,
  label text not null,
  summary text,
  is_catchall boolean not null default false,
  frequency integer not null default 0,
  mention_count integer not null default 0,
  avg_sentiment numeric,
  representative_phrase_ids jsonb not null default '[]'::jsonb,
  cluster_run_id uuid not null,
  created_at timestamp with time zone not null default timezone('utc'::text, now()),
  tags jsonb not null default '{}'::jsonb,
  scores jsonb not null default '{}'::jsonb,
  entity_constraints jsonb not null default '{}'::jsonb,
  edit_history jsonb not null default '[]'::jsonb,
  constraint brand_presence_themes_kind_check check (kind = ANY (ARRAY['pain'::text, 'desire'::text, 'objection'::text, 'praise'::text])),
  constraint brand_presence_themes_scope_check check (scope = ANY (ARRAY['brand'::text, 'category'::text])),
  constraint brand_presence_themes_brand_profile_id_fkey foreign key (brand_profile_id) references public.brand_presence_profiles (id) on delete cascade
);

create index idx_brand_presence_themes_profile_kind_scope on public.brand_presence_themes using btree (brand_profile_id, kind, scope);

create index idx_brand_presence_themes_org on public.brand_presence_themes using btree (organization_id);

revoke all on table public.brand_presence_themes from anon, authenticated;
grant all on table public.brand_presence_themes to service_role;

create table public.brand_presence_phrases (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  brand_profile_id uuid not null,
  mention_id uuid not null,
  kind text not null,
  phrase text not null,
  paraphrase text,
  sentiment numeric,
  scope text not null,
  embedding extensions.vector(1536),
  embedding_model text,
  theme_id uuid,
  content_hash text not null,
  created_at timestamp with time zone not null default timezone('utc'::text, now()),
  tags jsonb not null default '{}'::jsonb,
  scores jsonb not null default '{}'::jsonb,
  entity_constraints jsonb not null default '{}'::jsonb,
  edit_history jsonb not null default '[]'::jsonb,
  constraint brand_presence_phrases_kind_check check (kind = ANY (ARRAY['pain'::text, 'desire'::text, 'objection'::text, 'praise'::text, 'quote'::text])),
  constraint brand_presence_phrases_scope_check check (scope = ANY (ARRAY['brand'::text, 'category'::text])),
  constraint brand_presence_phrases_brand_profile_id_fkey foreign key (brand_profile_id) references public.brand_presence_profiles (id) on delete cascade,
  constraint brand_presence_phrases_mention_id_fkey foreign key (mention_id) references public.brand_mentions (id) on delete cascade,
  constraint brand_presence_phrases_theme_id_fkey foreign key (theme_id) references public.brand_presence_themes (id) on delete set null
);

create unique index brand_presence_phrases_mention_kind_hash_unique on public.brand_presence_phrases using btree (mention_id, kind, content_hash);

create index idx_brand_presence_phrases_profile_scope_kind on public.brand_presence_phrases using btree (brand_profile_id, scope, kind);

create index idx_brand_presence_phrases_theme on public.brand_presence_phrases using btree (theme_id);

create index idx_brand_presence_phrases_mention on public.brand_presence_phrases using btree (mention_id);

create index idx_brand_presence_phrases_org on public.brand_presence_phrases using btree (organization_id);

revoke all on table public.brand_presence_phrases from anon, authenticated;
grant all on table public.brand_presence_phrases to service_role;

create table public.brand_facts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  brand_profile_id uuid not null,
  section text not null,
  fact_key text not null,
  statement text not null,
  details jsonb not null default '{}'::jsonb,
  confidence real not null,
  source text not null,
  status text not null default 'candidate',
  evidence jsonb not null default '[]'::jsonb,
  metrics jsonb not null default '{}'::jsonb,
  valid_from timestamp with time zone not null default timezone('utc'::text, now()),
  valid_to timestamp with time zone,
  previous_version_id uuid,
  created_at timestamp with time zone not null default timezone('utc'::text, now()),
  updated_at timestamp with time zone not null default timezone('utc'::text, now()),
  tags jsonb not null default '{}'::jsonb,
  scores jsonb not null default '{}'::jsonb,
  entity_constraints jsonb not null default '{}'::jsonb,
  edit_history jsonb not null default '[]'::jsonb,
  constraint brand_facts_status_check check (status = ANY (ARRAY['candidate'::text, 'confirmed'::text, 'rejected'::text])),
  constraint brand_facts_brand_profile_id_fkey foreign key (brand_profile_id) references public.brand_presence_profiles (id) on delete cascade,
  constraint brand_facts_previous_version_id_fkey foreign key (previous_version_id) references public.brand_facts (id) on delete set null
);

create unique index brand_facts_live_identity_unique on public.brand_facts using btree (brand_profile_id, section, fact_key) where (valid_to IS NULL);

create index idx_brand_facts_profile_section_valid on public.brand_facts using btree (brand_profile_id, section, valid_to);

create index idx_brand_facts_org on public.brand_facts using btree (organization_id);

create index idx_brand_facts_previous_version on public.brand_facts using btree (previous_version_id);

revoke all on table public.brand_facts from anon, authenticated;
grant all on table public.brand_facts to service_role;

create table public.brand_chunks (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  brand_profile_id uuid not null,
  fact_id uuid not null,
  content text not null,
  section text not null,
  persona_key text,
  awareness_stage text,
  source_type text not null,
  metadata jsonb not null default '{}'::jsonb,
  embedding extensions.vector(1536),
  embedding_model text,
  content_hash text not null,
  created_at timestamp with time zone not null default timezone('utc'::text, now()),
  tags jsonb not null default '{}'::jsonb,
  scores jsonb not null default '{}'::jsonb,
  entity_constraints jsonb not null default '{}'::jsonb,
  edit_history jsonb not null default '[]'::jsonb,
  constraint brand_chunks_brand_profile_id_fkey foreign key (brand_profile_id) references public.brand_presence_profiles (id) on delete cascade,
  constraint brand_chunks_fact_id_fkey foreign key (fact_id) references public.brand_facts (id) on delete cascade
);

create unique index brand_chunks_fact_hash_unique on public.brand_chunks using btree (fact_id, content_hash);

create index idx_brand_chunks_profile_section on public.brand_chunks using btree (brand_profile_id, section);

create index idx_brand_chunks_org on public.brand_chunks using btree (organization_id);

revoke all on table public.brand_chunks from anon, authenticated;
grant all on table public.brand_chunks to service_role;

create table public.brand_object_state (
  brand_profile_id uuid primary key,
  organization_id uuid not null,
  status text not null default 'empty',
  completeness jsonb not null default '{}'::jsonb,
  cursors jsonb not null default '{}'::jsonb,
  cost jsonb not null default '{}'::jsonb,
  created_at timestamp with time zone not null default timezone('utc'::text, now()),
  updated_at timestamp with time zone not null default timezone('utc'::text, now()),
  tags jsonb not null default '{}'::jsonb,
  scores jsonb not null default '{}'::jsonb,
  entity_constraints jsonb not null default '{}'::jsonb,
  edit_history jsonb not null default '[]'::jsonb,
  constraint brand_object_state_status_check check (status = ANY (ARRAY['empty'::text, 'building'::text, 'in_review'::text, 'ready'::text])),
  constraint brand_object_state_brand_profile_id_fkey foreign key (brand_profile_id) references public.brand_presence_profiles (id) on delete cascade
);

create index idx_brand_object_state_org on public.brand_object_state using btree (organization_id);

revoke all on table public.brand_object_state from anon, authenticated;
grant all on table public.brand_object_state to service_role;

create table public.brand_fact_suggestions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  brand_profile_id uuid not null,
  fact_id uuid not null,
  proposed_statement text not null,
  proposed_details jsonb not null default '{}'::jsonb,
  evidence jsonb not null default '[]'::jsonb,
  reason text not null,
  confidence real not null,
  status text not null default 'proposed',
  decided_by uuid,
  decided_at timestamp with time zone,
  dedupe_key text not null,
  created_at timestamp with time zone not null default timezone('utc'::text, now()),
  updated_at timestamp with time zone not null default timezone('utc'::text, now()),
  tags jsonb not null default '{}'::jsonb,
  scores jsonb not null default '{}'::jsonb,
  entity_constraints jsonb not null default '{}'::jsonb,
  edit_history jsonb not null default '[]'::jsonb,
  constraint brand_fact_suggestions_status_check check (status = ANY (ARRAY['proposed'::text, 'accepted'::text, 'dismissed'::text])),
  constraint brand_fact_suggestions_brand_profile_id_fkey foreign key (brand_profile_id) references public.brand_presence_profiles (id) on delete cascade,
  constraint brand_fact_suggestions_fact_id_fkey foreign key (fact_id) references public.brand_facts (id) on delete cascade
);

create unique index brand_fact_suggestions_org_dedupe_unique on public.brand_fact_suggestions using btree (organization_id, dedupe_key);

create index idx_brand_fact_suggestions_profile_status on public.brand_fact_suggestions using btree (brand_profile_id, status);

create index idx_brand_fact_suggestions_fact on public.brand_fact_suggestions using btree (fact_id);

revoke all on table public.brand_fact_suggestions from anon, authenticated;
grant all on table public.brand_fact_suggestions to service_role;

create table public.brand_context_rows (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  brand_profile_id uuid not null,
  row_id text not null,
  row_type text not null,
  version integer not null,
  priority integer not null,
  tag_filters jsonb not null default '{}'::jsonb,
  content jsonb not null,
  content_hash text not null,
  source_ref jsonb not null default '{}'::jsonb,
  superseded_at timestamp with time zone,
  retired_at timestamp with time zone,
  created_at timestamp with time zone not null default timezone('utc'::text, now()),
  updated_at timestamp with time zone not null default timezone('utc'::text, now()),
  tags jsonb not null default '{}'::jsonb,
  scores jsonb not null default '{}'::jsonb,
  entity_constraints jsonb not null default '{}'::jsonb,
  edit_history jsonb not null default '[]'::jsonb,
  constraint brand_context_rows_row_type_check check (row_type = ANY (ARRAY['fact'::text, 'voice'::text, 'rule'::text, 'asset'::text, 'persona'::text])),
  constraint brand_context_rows_version_check check (version >= 1),
  constraint brand_context_rows_brand_profile_id_fkey foreign key (brand_profile_id) references public.brand_presence_profiles (id) on delete cascade
);

create unique index brand_context_rows_identity_unique on public.brand_context_rows using btree (brand_profile_id, row_id, version);

create unique index brand_context_rows_latest_unique on public.brand_context_rows using btree (brand_profile_id, row_id) where (superseded_at IS NULL);

create index idx_brand_context_rows_profile_live on public.brand_context_rows using btree (brand_profile_id, row_type) where ((superseded_at IS NULL) AND (retired_at IS NULL));

create index idx_brand_context_rows_org on public.brand_context_rows using btree (organization_id);

revoke all on table public.brand_context_rows from anon, authenticated;
grant all on table public.brand_context_rows to service_role;

create table public.brand_context_packs (
  fingerprint text primary key,
  organization_id uuid not null,
  brand_profile_id uuid not null,
  compiler_version integer not null,
  pack jsonb not null,
  created_at timestamp with time zone not null default timezone('utc'::text, now()),
  tags jsonb not null default '{}'::jsonb,
  scores jsonb not null default '{}'::jsonb,
  entity_constraints jsonb not null default '{}'::jsonb,
  edit_history jsonb not null default '[]'::jsonb,
  constraint brand_context_packs_fingerprint_check check (fingerprint ~ '^[0-9a-f]{64}$'),
  constraint brand_context_packs_brand_profile_id_fkey foreign key (brand_profile_id) references public.brand_presence_profiles (id) on delete cascade
);

create index idx_brand_context_packs_org on public.brand_context_packs using btree (organization_id);

create index idx_brand_context_packs_profile_created on public.brand_context_packs using btree (brand_profile_id, created_at desc nulls last);

revoke all on table public.brand_context_packs from anon, authenticated;
grant all on table public.brand_context_packs to service_role;

