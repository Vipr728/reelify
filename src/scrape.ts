import { ApifyClient } from 'apify-client';
import { loadEnv } from './env.js';
import type { Creator, ScrapedPost } from './types.js';

// Initial Apify scrape: hit each creator's profile, pull the most recent N posts.
// Downstream `quantify` step is what actually extracts video features —
// this step is just the raw fetch.

type RawIgItem = {
  url?: string;
  shortCode?: string;
  ownerUsername?: string;
  videoUrl?: string;
  displayUrl?: string;
  caption?: string;
  likesCount?: number;
  commentsCount?: number;
  videoViewCount?: number;
  videoDuration?: number;
  timestamp?: string;
  type?: string; // 'Video' | 'Image' | 'Sidecar'
};

export async function scrapeCreators(creators: Creator[]): Promise<ScrapedPost[]> {
  const env = loadEnv();
  const client = new ApifyClient({ token: env.APIFY_TOKEN });

  const input = {
    usernames: creators.map((c) => c.handle),
    resultsType: 'posts',
    resultsLimit: env.APIFY_POSTS_PER_PROFILE,
    onlyPostsNewerThan: '180 days',
  };

  // Actor ids accept the slash form ("apify/instagram-profile-scraper").
  const run = await client.actor(env.APIFY_IG_PROFILE_ACTOR).call(input, {
    waitSecs: 600,
  });

  if (!run.defaultDatasetId) {
    throw new Error('apify run finished without a dataset');
  }

  const { items } = await client.dataset<RawIgItem>(run.defaultDatasetId).listItems();

  const handles = new Set(creators.map((c) => c.handle.toLowerCase()));
  const posts: ScrapedPost[] = [];

  for (const it of items) {
    if (!it.ownerUsername || !it.url) continue;
    if (!handles.has(it.ownerUsername.toLowerCase())) continue;
    if (it.type && it.type !== 'Video') continue;

    posts.push({
      creator_handle: it.ownerUsername,
      post_url: it.url,
      shortcode: it.shortCode ?? it.url.split('/').filter(Boolean).pop() ?? '',
      video_url: it.videoUrl,
      thumbnail_url: it.displayUrl,
      caption: it.caption,
      likes: it.likesCount,
      comments: it.commentsCount,
      views: it.videoViewCount,
      duration_s: it.videoDuration,
      timestamp: it.timestamp,
    });
  }

  return posts;
}
