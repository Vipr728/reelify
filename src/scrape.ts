import { ApifyClient } from 'apify-client';
import { loadEnv } from './env.js';
import type { Creator, ScrapedPost } from './types.js';

// Initial Apify scrape: hit each creator's profile, pull the most recent N posts.
// We default to `apify/instagram-scraper` because it returns flat post items
// keyed by `ownerUsername` + `url` + `videoUrl` — the shape we parse.
// The older `apify/instagram-profile-scraper` returns nested profile objects
// with `latestPosts` arrays instead, which would silently yield zero posts here.

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
  videoPlayCount?: number;
  videoDuration?: number;
  timestamp?: string;
  type?: string; // 'Video' | 'Image' | 'Sidecar'
  productType?: string; // 'clips' = Reels
};

export async function scrapeCreators(creators: Creator[]): Promise<ScrapedPost[]> {
  const env = loadEnv();
  const client = new ApifyClient({ token: env.APIFY_TOKEN });

  if (creators.length === 0) {
    console.error('[apify] no creators to scrape');
    return [];
  }

  const input = {
    directUrls: creators.map((c) => `https://www.instagram.com/${c.handle}/`),
    resultsType: 'posts',
    resultsLimit: env.APIFY_POSTS_PER_PROFILE,
    addParentData: false,
    searchType: 'user',
    searchLimit: 1,
  };

  console.error(
    `[apify] starting ${env.APIFY_IG_ACTOR} for ${creators.length} creators ` +
      `(${env.APIFY_POSTS_PER_PROFILE} posts each)`,
  );

  const run = await client.actor(env.APIFY_IG_ACTOR).call(input, { waitSecs: 600 });

  console.error(
    `[apify] run ${run.id} status=${run.status} dataset=${run.defaultDatasetId} ` +
      `started=${run.startedAt} finished=${run.finishedAt}`,
  );

  if (!run.defaultDatasetId) {
    throw new Error(`apify run ${run.id} finished without a dataset (status=${run.status})`);
  }

  const { items } = await client.dataset<RawIgItem>(run.defaultDatasetId).listItems();
  console.error(`[apify] dataset returned ${items.length} raw items`);

  const handles = new Set(creators.map((c) => c.handle.toLowerCase()));
  const posts: ScrapedPost[] = [];

  let skippedNoOwner = 0;
  let skippedNotInList = 0;
  let skippedNotVideo = 0;

  for (const it of items) {
    if (!it.url) continue;
    if (!it.ownerUsername) {
      skippedNoOwner++;
      continue;
    }
    if (!handles.has(it.ownerUsername.toLowerCase())) {
      skippedNotInList++;
      continue;
    }
    const isVideo =
      it.type === 'Video' || it.productType === 'clips' || !!it.videoUrl;
    if (!isVideo) {
      skippedNotVideo++;
      continue;
    }

    posts.push({
      creator_handle: it.ownerUsername,
      post_url: it.url,
      shortcode: it.shortCode ?? it.url.split('/').filter(Boolean).pop() ?? '',
      video_url: it.videoUrl,
      thumbnail_url: it.displayUrl,
      caption: it.caption,
      likes: it.likesCount,
      comments: it.commentsCount,
      views: it.videoViewCount ?? it.videoPlayCount,
      duration_s: it.videoDuration,
      timestamp: it.timestamp,
    });
  }

  console.error(
    `[apify] kept ${posts.length} video posts ` +
      `(skipped: no-owner=${skippedNoOwner}, not-in-list=${skippedNotInList}, not-video=${skippedNotVideo})`,
  );

  return posts;
}
