// Box API helpers (Deno / Supabase edge runtime).
// Two auth modes:
//  - Skill payload tokens (read/write) arrive in the webhook event itself.
//  - App token via Client Credentials Grant (CCG) for everything else.

const BOX_API = "https://api.box.com/2.0";

// Client Credentials Grant. Set these as Supabase function secrets.
export async function getAppToken(): Promise<string> {
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: Deno.env.get("BOX_CLIENT_ID")!,
    client_secret: Deno.env.get("BOX_CLIENT_SECRET")!,
    box_subject_type: "enterprise",
    box_subject_id: Deno.env.get("BOX_ENTERPRISE_ID")!,
  });
  const res = await fetch("https://api.box.com/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`Box token failed: ${await res.text()}`);
  return (await res.json()).access_token;
}

// Downscope an app token to a single folder so the RN app can upload directly
// to Box without ever holding full credentials. Returned token is short-lived.
export async function downscopeForUpload(appToken: string, folderId: string): Promise<string> {
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    subject_token: appToken,
    subject_token_type: "urn:ietf:params:oauth:token-type:access_token",
    scope: "item_upload item_preview item_read",
    resource: `https://api.box.com/2.0/folders/${folderId}`,
  });
  const res = await fetch("https://api.box.com/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`Box downscope failed: ${await res.text()}`);
  return (await res.json()).access_token;
}

// Create an open shared link on a file and return a URL the app can stream.
export async function createSharedLink(appToken: string, fileId: string): Promise<string> {
  const res = await fetch(`${BOX_API}/files/${fileId}?fields=shared_link`, {
    method: "PUT",
    headers: { authorization: `Bearer ${appToken}`, "content-type": "application/json" },
    body: JSON.stringify({ shared_link: { access: "open" } }),
  });
  if (!res.ok) throw new Error(`Box shared link failed: ${await res.text()}`);
  const sl = (await res.json()).shared_link;
  return sl.download_url ?? sl.url;
}

// Download raw bytes for a file. Use the read token from the skill payload,
// or an app token elsewhere.
export async function downloadFile(token: string, fileId: string): Promise<Uint8Array> {
  const res = await fetch(`${BOX_API}/files/${fileId}/content`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Box download failed: ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

// Write transcript + keyword skill cards back to Box via the skill_invocations
// endpoint. Uses the WRITE token + skill id + invocation id from the payload.
export async function writeSkillCards(
  writeToken: string,
  skillId: string,
  invocationId: string,
  opts: { transcript: string; keywords: string[] },
) {
  const cards = [
    {
      type: "skill_card",
      skill_card_type: "transcript",
      skill_card_title: { code: "reelify-transcript", message: "Transcript" },
      skill: { type: "service", id: skillId },
      invocation: { type: "skill_invocation", id: invocationId },
      entries: [{ text: opts.transcript, appears: [{ start: 0 }] }],
    },
    {
      type: "skill_card",
      skill_card_type: "keyword",
      skill_card_title: { code: "reelify-keywords", message: "Topics" },
      skill: { type: "service", id: skillId },
      invocation: { type: "skill_invocation", id: invocationId },
      entries: opts.keywords.map((text) => ({ text })),
    },
  ];
  const res = await fetch(`${BOX_API}/skill_invocations/${skillId}`, {
    method: "PUT",
    headers: { authorization: `Bearer ${writeToken}`, "content-type": "application/json" },
    body: JSON.stringify({ status: "success", metadata: { cards } }),
  });
  if (!res.ok) throw new Error(`Box skill write failed: ${await res.text()}`);
}

// Write the richer structured datapoint to a metadata template instance.
// Create the `reelify_datapoint` template in the Box dev console first.
export async function writeDatapoint(appToken: string, fileId: string, data: Record<string, unknown>) {
  const res = await fetch(
    `${BOX_API}/files/${fileId}/metadata/enterprise/reelifyDatapoint`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${appToken}`, "content-type": "application/json" },
      body: JSON.stringify(data),
    },
  );
  // 409 means the instance already exists; ignore for the hackathon.
  if (!res.ok && res.status !== 409) throw new Error(`Box metadata failed: ${await res.text()}`);
}

// Upload the rendered video back into Box (used by the render worker via app token).
export async function uploadFile(appToken: string, parentFolderId: string, name: string, bytes: Uint8Array): Promise<string> {
  const form = new FormData();
  form.append("attributes", JSON.stringify({ name, parent: { id: parentFolderId } }));
  form.append("file", new Blob([bytes]), name);
  const res = await fetch("https://upload.box.com/api/2.0/files/content", {
    method: "POST",
    headers: { authorization: `Bearer ${appToken}` },
    body: form,
  });
  if (!res.ok) throw new Error(`Box upload failed: ${await res.text()}`);
  return (await res.json()).entries[0].id;
}
