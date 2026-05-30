import { readFile } from "node:fs/promises";
import path from "node:path";

const BOX_API_BASE = "https://api.box.com/2.0";
const BOX_UPLOAD_BASE = "https://upload.box.com/api/2.0";

export type BoxItemType = "file" | "folder" | "web_link";

export type BoxItem = {
  id: string;
  type: BoxItemType;
  name: string;
};

export type BoxClientConfig = {
  developerToken?: string;
  clientId?: string;
  clientSecret?: string;
  subjectType?: string;
  subjectId?: string;
};

export class BoxClient {
  private accessToken: string | undefined;

  constructor(private readonly config: BoxClientConfig) {}

  async listFolderItems(folderId: string): Promise<BoxItem[]> {
    const entries: BoxItem[] = [];
    let offset = 0;
    const limit = 1000;

    while (true) {
      const url = new URL(`${BOX_API_BASE}/folders/${folderId}/items`);
      url.searchParams.set("limit", String(limit));
      url.searchParams.set("offset", String(offset));
      url.searchParams.set("fields", "id,type,name");

      const body = await this.requestJson<{
        entries: BoxItem[];
        total_count: number;
        limit: number;
        offset: number;
      }>(url);

      entries.push(...body.entries);
      offset += body.entries.length;

      if (body.entries.length === 0 || offset >= body.total_count) {
        return entries;
      }
    }
  }

  async findFolder(parentFolderId: string, name: string): Promise<BoxItem | null> {
    const items = await this.listFolderItems(parentFolderId);
    return items.find((item) => item.type === "folder" && item.name === name) ?? null;
  }

  async findFile(parentFolderId: string, name: string): Promise<BoxItem | null> {
    const items = await this.listFolderItems(parentFolderId);
    return items.find((item) => item.type === "file" && item.name === name) ?? null;
  }

  async ensureFolder(parentFolderId: string, name: string): Promise<BoxItem> {
    const existing = await this.findFolder(parentFolderId, name);
    if (existing) {
      return existing;
    }

    return this.requestJson<BoxItem>(`${BOX_API_BASE}/folders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, parent: { id: parentFolderId } }),
    });
  }

  async uploadFileOrVersion(folderId: string, filePath: string, mimeType = "application/octet-stream"): Promise<BoxItem> {
    const fileName = path.basename(filePath);
    const existing = await this.findFile(folderId, fileName);
    const bytes = await readFile(filePath);

    if (existing) {
      return this.uploadBufferVersion(existing.id, fileName, bytes, mimeType);
    }

    return this.uploadBuffer(folderId, fileName, bytes, mimeType);
  }

  async downloadTextFile(fileId: string): Promise<string> {
    const response = await this.request(`${BOX_API_BASE}/files/${fileId}/content`);
    return response.text();
  }

  async downloadJsonFile(fileId: string): Promise<unknown> {
    const text = await this.downloadTextFile(fileId);
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new Error(`Box file ${fileId} did not contain valid JSON: ${errorMessage(error)}`);
    }
  }

  private async requestJson<T>(url: URL | string, init: RequestInit = {}): Promise<T> {
    const response = await this.request(url, init);
    return (await response.json()) as T;
  }

  private async uploadBuffer(folderId: string, name: string, bytes: Buffer, mimeType: string): Promise<BoxItem> {
    const formData = new FormData();
    formData.append("attributes", JSON.stringify({ name, parent: { id: folderId } }));
    formData.append("file", new Blob([toArrayBuffer(bytes)], { type: mimeType }), name);

    const response = await this.request(`${BOX_UPLOAD_BASE}/files/content`, {
      method: "POST",
      body: formData,
    });
    const payload = (await response.json()) as { entries?: BoxItem[] };

    return payload.entries?.[0] ?? (payload as unknown as BoxItem);
  }

  private async uploadBufferVersion(fileId: string, name: string, bytes: Buffer, mimeType: string): Promise<BoxItem> {
    const formData = new FormData();
    formData.append("attributes", JSON.stringify({ name }));
    formData.append("file", new Blob([toArrayBuffer(bytes)], { type: mimeType }), name);

    const response = await this.request(`${BOX_UPLOAD_BASE}/files/${fileId}/content`, {
      method: "POST",
      body: formData,
    });
    const payload = (await response.json()) as { entries?: BoxItem[] };

    return payload.entries?.[0] ?? (payload as unknown as BoxItem);
  }

  private async request(url: URL | string, init: RequestInit = {}): Promise<Response> {
    const accessToken = await this.getAccessToken();
    const response = await fetch(url, {
      ...init,
      headers: {
        ...init.headers,
        authorization: `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      throw new Error(`Box API ${response.status} ${response.statusText}: ${await response.text()}`);
    }

    return response;
  }

  private async getAccessToken(): Promise<string> {
    if (this.config.developerToken) {
      return this.config.developerToken;
    }

    if (this.accessToken) {
      return this.accessToken;
    }

    const subjectType = this.config.subjectType ?? "enterprise";
    const subjectId = this.config.subjectId;

    if (!this.config.clientId || !this.config.clientSecret || !subjectId) {
      throw new Error(
        [
          "Box credentials are incomplete.",
          "Set BOX_DEVELOPER_TOKEN, or set BOX_CLIENT_ID, BOX_CLIENT_SECRET, BOX_SUBJECT_TYPE, and BOX_SUBJECT_ID.",
          "For enterprise CCG, BOX_SUBJECT_TYPE=enterprise and BOX_SUBJECT_ID can be the enterprise ID.",
        ].join(" "),
      );
    }

    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      box_subject_type: subjectType,
      box_subject_id: subjectId,
    });

    const response = await fetch("https://api.box.com/oauth2/token", {
      method: "POST",
      body,
    });

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(
        [
          `Box auth failed: ${response.status} ${response.statusText}.`,
          detail,
          "If this says box_subject_type is unauthorized, set BOX_SUBJECT_TYPE and BOX_SUBJECT_ID for the subject your Box app is allowed to authenticate as.",
        ].join(" "),
      );
    }

    const token = (await response.json()) as { access_token?: string };
    if (!token.access_token) {
      throw new Error("Box auth response did not include access_token.");
    }

    this.accessToken = token.access_token;
    return token.access_token;
  }
}

export function createBoxClientFromEnv(env: NodeJS.ProcessEnv): BoxClient {
  return new BoxClient({
    developerToken: optionalEnv(env.BOX_DEVELOPER_TOKEN),
    clientId: optionalEnv(env.BOX_CLIENT_ID),
    clientSecret: optionalEnv(env.BOX_CLIENT_SECRET),
    subjectType: optionalEnv(env.BOX_SUBJECT_TYPE) ?? "enterprise",
    subjectId: optionalEnv(env.BOX_SUBJECT_ID) ?? optionalEnv(env.BOX_ENTERPRISE_ID),
  });
}

function optionalEnv(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function toArrayBuffer(bytes: Buffer): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
