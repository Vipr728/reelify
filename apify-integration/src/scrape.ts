import { ApifyClient } from 'apify-client';
import { loadEnv } from './env.js';
import type { Creator, ScrapedPost } from './types.js';

// Default actor is `apify/instagram-reel-scraper`: takes a `username` array,
// runs a real browser (Puppeteer), and returns one item per reel. The
// browser-based scrape gets blocked by IG's anti-bot far less than the
// Cheerio-based `apify/instagram-scraper`, which is what we used before.
//
// If you override APIFY_IG_ACTOR with a different actor, make sure its
// input takes a `username` array (or set APIFY_INPUT_KEY=directUrls) and
// its output items expose `ownerUsername` + `url` + `videoUrl`.

type RawIgItem = {
  url?: string;
  shortCode?: string;
  ownerUsername?: string;
  username?: string;
  videoUrl?: string;
  displayUrl?: string;
  caption?: string;
  likesCount?: number;
  commentsCount?: number;
  videoViewCount?: number;
  videoPlayCount?: number;
  videoDuration?: number;
  timestamp?: string;
  type?: string;
  productType?: string;
};

export async function scrapeCreators(creators: Creator[]): Promise<ScrapedPost[]> {
  const env = loadEnv();
  const client = new ApifyClient({ token: env.APIFY_TOKEN });

  if (creators.length === 0) {
    console.error('[apify] no creators to scrape');
    return [];
  }

  const usernames = creators.map((c) => c.handle);
  const input: Record<string, unknown> = {
    username: usernames,
    resultsLimit: env.APIFY_POSTS_PER_PROFILE,
  };

  console.error(
    `[apify] starting ${env.APIFY_IG_ACTOR} for ${creators.length} creators ` +
      `(${env.APIFY_POSTS_PER_PROFILE} reels each): ${usernames.join(', ')}`,
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
    const owner = it.ownerUsername ?? it.username;
    if (!owner) {
      skippedNoOwner++;
      continue;
    }
    if (!handles.has(owner.toLowerCase())) {
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
      creator_handle: owner,
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
    `[apify] kept ${posts.length} reels ` +
      `(skipped: no-owner=${skippedNoOwner}, not-in-list=${skippedNotInList}, not-video=${skippedNotVideo})`,
  );

  return posts;
}
