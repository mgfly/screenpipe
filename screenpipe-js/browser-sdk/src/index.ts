import type {
  EventStreamResponse,
  InputAction,
  InputControlResponse,
  NotificationOptions,
  ScreenpipeQueryParams,
  ScreenpipeResponse,
  TranscriptionChunk,
  TranscriptionStreamResponse,
  VisionEvent,
  VisionStreamResponse,
} from "../../common/types";
import { toSnakeCase, convertToCamelCase } from "../../common/utils";
import { captureEvent, captureMainFeatureEvent } from "../../common/analytics";
import { PipesManager } from "../../common/PipesManager";

type Result<T> = { success: true; data: T } | { success: false; error: any };

const WS_URL = "ws://localhost:3030/ws/events";

// At the top of the file, add WebSocket instances
let wsWithImages: WebSocket | null = null;
let wsWithoutImages: WebSocket | null = null;

// Update the wsEvents generator to accept includeImages parameter and manage connections
async function* wsEvents(
  includeImages: boolean = false
): AsyncGenerator<EventStreamResponse, void, unknown> {
  // Reuse existing connection or create new one
  let ws = includeImages ? wsWithImages : wsWithoutImages;

  if (!ws || ws.readyState === WebSocket.CLOSED) {
    ws = new WebSocket(`${WS_URL}?images=${includeImages}`);
    if (includeImages) {
      wsWithImages = ws;
    } else {
      wsWithoutImages = ws;
    }

    // Wait for connection to establish
    await new Promise((resolve, reject) => {
      ws!.onopen = resolve;
      ws!.onerror = reject;
    });
  }

  while (true) {
    const event: MessageEvent = await new Promise((resolve) => {
      ws!.addEventListener("message", (ev: MessageEvent) => resolve(ev));
    });
    yield JSON.parse(event.data);
  }
}

async function sendInputControl(action: InputAction): Promise<boolean> {
  const apiUrl = "http://localhost:3030";
  try {
    const response = await fetch(`${apiUrl}/experimental/input_control`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    if (!response.ok) {
      throw new Error(`http error! status: ${response.status}`);
    }
    const data: InputControlResponse = await response.json();
    return data.success;
  } catch (error) {
    console.error("failed to control input:", error);
    return false;
  }
}

export interface BrowserPipe {
  sendDesktopNotification(options: NotificationOptions): Promise<boolean>;
  queryScreenpipe(
    params: ScreenpipeQueryParams
  ): Promise<ScreenpipeResponse | null>;
  input: {
    type: (text: string) => Promise<boolean>;
    press: (key: string) => Promise<boolean>;
    moveMouse: (x: number, y: number) => Promise<boolean>;
    click: (button: "left" | "right" | "middle") => Promise<boolean>;
  };
  streamTranscriptions(): AsyncGenerator<
    TranscriptionStreamResponse,
    void,
    unknown
  >;
  streamVision(
    includeImages?: boolean
  ): AsyncGenerator<VisionStreamResponse, void, unknown>;
  captureEvent: (
    event: string,
    properties?: Record<string, any>
  ) => Promise<void>;
  captureMainFeatureEvent: (
    name: string,
    properties?: Record<string, any>
  ) => Promise<void>;
  streamEvents(
    includeImages: boolean
  ): AsyncGenerator<EventStreamResponse, void, unknown>;
  pipes: {
    list: () => Promise<Result<string[]>>;
    enable: (pipeId: string) => Promise<boolean>;
    disable: (pipeId: string) => Promise<boolean>;
    delete: (pipeId: string,) => Promise<boolean>;
    download: (url: string) => Promise<Result<Record<string, any>>>;
    info: (pipeId: string) => Promise<Result<Record<string, any>>>;
    update: (
      pipeId: string,
      config: { [key: string]: string },
    ) => Promise<boolean>;
    downloadPrivate: (
      url: string,
      pipeName: string,
      pipeId: string
    ) => Promise<Result<Record<string, any>>>;
  };
}

class BrowserPipeImpl implements BrowserPipe {
  private async initAnalyticsIfNeeded(): Promise<{
    analyticsEnabled: boolean;
    userId?: string;
    email?: string;
  }> {
    try {
      // Connect to settings SSE stream
      const settingsStream = new EventSource(
        "http://localhost:11435/sse/settings"
      );

      // Get initial settings
      const settings = await new Promise<{
        analyticsEnabled: boolean;
        userId?: string;
        email?: string;
      }>((resolve, reject) => {
        const timeout = setTimeout(() => {
          settingsStream.close();
          reject(new Error("settings stream timeout"));
        }, 5000);

        settingsStream.onmessage = (event) => {
          clearTimeout(timeout);
          settingsStream.close();
          // Parse the settings array and find analyticsEnabled
          const settingsArray: [string, any][] = JSON.parse(event.data);
          const analyticsEnabled =
            settingsArray.find(([key]) => key === "analyticsEnabled")?.[1] ??
            false;
          const userId =
            settingsArray.find(([key]) => key === "user.clerk_id")?.[1] ??
            undefined;
          const userEmail =
            settingsArray.find(([key]) => key === "user.email")?.[1] ??
            undefined;
          resolve({ analyticsEnabled, userId, email: userEmail });
        };

        settingsStream.onerror = (error) => {
          clearTimeout(timeout);
          settingsStream.close();
          reject(error);
        };
      });

      return {
        analyticsEnabled: settings.analyticsEnabled,
        userId: settings.userId,
        email: settings.email,
      };
    } catch (error) {
      console.error(
        "failed to fetch settings, defaulting to analytics enabled:",
        error
      );
      return {
        analyticsEnabled: false,
        userId: undefined,
      };
    }
  }

  async sendDesktopNotification(
    options: NotificationOptions
  ): Promise<boolean> {
    const { userId, email } = await this.initAnalyticsIfNeeded();
    const notificationApiUrl = "http://localhost:11435";
    try {
      await fetch(`${notificationApiUrl}/notify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(options),
      });
      await this.captureEvent("notification_sent", {
        distinct_id: userId,
        email: email,
        success: true,
      });
      return true;
    } catch (error) {
      return false;
    }
  }

  async queryScreenpipe(
    params: ScreenpipeQueryParams
  ): Promise<ScreenpipeResponse | null> {
    console.log("queryScreenpipe:", params);
    const { userId, email } = await this.initAnalyticsIfNeeded();
    const queryParams = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== "") {
        if (key === "speakerIds" && Array.isArray(value)) {
          if (value.length > 0) {
            queryParams.append(toSnakeCase(key), value.join(","));
          }
        } else {
          const snakeKey = toSnakeCase(key);
          queryParams.append(snakeKey, value!.toString());
        }
      }
    });

    const url = `http://localhost:3030/search?${queryParams}`;
    try {
      const response = await fetch(url);
      if (!response.ok) {
        const errorText = await response.text();
        let errorJson;
        try {
          errorJson = JSON.parse(errorText);
          console.error("screenpipe api error:", {
            status: response.status,
            error: errorJson,
          });
        } catch {
          console.error("screenpipe api error:", {
            status: response.status,
            error: errorText,
          });
        }
        throw new Error(`http error! status: ${response.status}`);
      }
      const data = await response.json();
      await captureEvent("search_performed", {
        distinct_id: userId,
        content_type: params.contentType,
        result_count: data.pagination.total,
        email: email,
      });
      return convertToCamelCase(data) as ScreenpipeResponse;
    } catch (error) {
      console.error("error querying screenpipe:", error);
      return null;
    }
  }

  input: {
    type: (text: string) => Promise<boolean>;
    press: (key: string) => Promise<boolean>;
    moveMouse: (x: number, y: number) => Promise<boolean>;
    click: (button: "left" | "right" | "middle") => Promise<boolean>;
  } = {
    type: (text: string) => sendInputControl({ type: "WriteText", data: text }),
    press: (key: string) => sendInputControl({ type: "KeyPress", data: key }),
    moveMouse: (x: number, y: number) =>
      sendInputControl({ type: "MouseMove", data: { x, y } }),
    click: (button: "left" | "right" | "middle") =>
      sendInputControl({ type: "MouseClick", data: button }),
  };

  pipes: {
    list: () => Promise<Result<string[]>>;
    enable: (pipeId: string) => Promise<boolean>;
    disable: (pipeId: string) => Promise<boolean>;
    delete: (pipeId: string,) => Promise<boolean>;
    download: (url: string) => Promise<Result<Record<string, any>>>;
    info: (pipeId: string) => Promise<Result<Record<string, any>>>;
    update: (
      pipeId: string,
      config: { [key: string]: string },
    ) => Promise<boolean>;
    downloadPrivate: (
      url: string,
      pipeName: string,
      pipeId: string
    ) => Promise<Result<Record<string, any>>>;
  } = {
    list: async (): Promise<Result<string[]>> => {
      try {
        const response = await fetch("http://localhost:3030/pipes/list", {
          method: "GET",
          headers: { "Content-Type": "application/json" },
        });

        if (!response.ok) {
          throw new Error(`http error! status: ${response.status}`);
        }   

        const data = await response.json();
        return { success: true, data: data.data };
      } catch (error) {
        console.error("failed to list pipes:", error);
        return { success: false, error: error };
      }
    },
    download: async (url: string): Promise<Result<Record<string, any>>> => {
      try {
        const response = await fetch(`http://localhost:3030/pipes/download`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url,
          }),
        });

        if (!response.ok) {
          throw new Error(`http error! status: ${response.status}`);
        }   

        const data: Record<string, any> = await response.json();
        return { success: true, data: data.data };
      } catch (error) {
        console.error("failed to download pipe:", error);
        return { success: false, error: error };
      }
    },
    enable: async (pipeId: string): Promise<boolean> => {
      try {
        const response = await fetch(`http://localhost:3030/pipes/enable`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            pipe_id: pipeId,
          }),
        });

        return response.ok;
      } catch (error) {
        console.error("failed to enable pipe:", error);
        return false;
      }
    },
    disable: async (pipeId: string): Promise<boolean> => {
      try {
        const response = await fetch(`http://localhost:3030/pipes/disable`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            pipe_id: pipeId,
          }),
        });

        return response.ok;
      } catch (error) {
        console.error("failed to disable pipe:", error);
        return false;
      }
    },
    update: async (
      pipeId: string,
      config: { [key: string]: string 
      }): Promise<boolean> => {
      try {
        const response = await fetch(`http://localhost:3030/pipes/update`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            pipe_id: pipeId,
            config,
          }),
        }); 

        return response.ok;
      } catch (error) {
        console.error("failed to update pipe:", error);
        return false;
      }
    },
    info: async (pipeId: string): Promise<Result<Record<string, any>>> => {
      try {
        const response = await fetch(`http://localhost:3030/pipes/info/${pipeId}`, {
          method: "GET",
          headers: { "Content-Type": "application/json" },
        });

        if (!response.ok) {
          throw new Error(`http error! status: ${response.status}`);
        }

        const data: Record<string, any> = await response.json();
        return { success: true, data: data.data };
      } catch (error) {
        console.error("failed to get pipe info:", error);
        return { success: false, error: error };
      }
    },
    downloadPrivate: async (
      url: string,
      pipeName: string,
      pipeId: string
    ): Promise<Result<Record<string, any>>> => {
      try {
        const apiUrl = process.env.SCREENPIPE_SERVER_URL || "http://localhost:3030";
        const response = await fetch(`${apiUrl}/pipes/download-private`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url,
            pipe_name: pipeName,
            pipe_id: pipeId,
          }),
        });

        if (!response.ok) {
          throw new Error(`http error! status: ${response.status}`);
        }

        const data: Record<string, any> = await response.json();
        return { success: true, data: data.data };
      } catch (error) {
        console.error("failed to download private pipe:", error);
        return { success: false, error: error };
      }
    },
    delete: async (pipeId: string): Promise<boolean> => {
      try {
        const apiUrl = process.env.SCREENPIPE_SERVER_URL || "http://localhost:3030";
        const response = await fetch(`${apiUrl}/pipes/delete`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            pipe_id: pipeId,
          }),
        });

        return response.ok;
      } catch (error) {
        console.error("failed to delete pipe:", error);
        return false;
      }
    }
  };

  async *streamTranscriptions(): AsyncGenerator<
    TranscriptionStreamResponse,
    void,
    unknown
  > {
    try {
      while (true) {
        for await (const event of wsEvents()) {
          if (event.name === "transcription") {
            let chunk: TranscriptionChunk = event.data as TranscriptionChunk;
            yield {
              id: crypto.randomUUID(),
              object: "text_completion_chunk",
              created: Date.now(),
              model: "screenpipe-realtime",
              choices: [
                {
                  text: chunk.transcription,
                  index: 0,
                  finish_reason: chunk.is_final ? "stop" : null,
                },
              ],
              metadata: {
                timestamp: chunk.timestamp,
                device: chunk.device,
                isInput: chunk.is_input,
              },
            };
          }
        }
      }
    } catch (error) {
      console.error("error streaming transcriptions:", error);
    }
  }

  async *streamVision(
    includeImages: boolean = false
  ): AsyncGenerator<VisionStreamResponse, void, unknown> {
    try {
      for await (const event of wsEvents(includeImages)) {
        if (event.name === "ocr_result" || event.name === "ui_frame") {
          let data: VisionEvent = event.data as VisionEvent;
          yield {
            type: event.name,
            data,
          };
        }
      }
    } catch (error) {
      console.error("error streaming vision:", error);
    }
  }

  public async captureEvent(
    eventName: string,
    properties?: Record<string, any>
  ) {
    const { analyticsEnabled } = await this.initAnalyticsIfNeeded();
    if (!analyticsEnabled) return;
    return captureEvent(eventName, properties);
  }

  public async captureMainFeatureEvent(
    featureName: string,
    properties?: Record<string, any>
  ) {
    const { analyticsEnabled } = await this.initAnalyticsIfNeeded();
    if (!analyticsEnabled) return;
    return captureMainFeatureEvent(featureName, properties);
  }

  public async *streamEvents(
    includeImages: boolean = false
  ): AsyncGenerator<EventStreamResponse, void, unknown> {
    for await (const event of wsEvents(includeImages)) {
      yield event;
    }
  }
}

const pipeImpl = new BrowserPipeImpl();
const pipeManager = new PipesManager();
export const pipe = pipeImpl;
pipeImpl.pipes = pipeManager;

export * from "../../common/types";
export { getDefaultSettings } from "../../common/utils";
