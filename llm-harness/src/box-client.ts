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
      const url = new URL(`https://api.box.com/2.0/folders/${folderId}/items`);
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

  async downloadTextFile(fileId: string): Promise<string> {
    const response = await this.request(`https://api.box.com/2.0/files/${fileId}/content`);
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

  private async requestJson<T>(url: URL | string): Promise<T> {
    const response = await this.request(url);
    return (await response.json()) as T;
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
