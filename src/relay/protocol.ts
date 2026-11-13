export type TunnelFrame =
  | {
      type: "req_start";
      streamId: string;
      method: string;
      path: string;
      headers: Record<string, string | string[] | undefined>;
    }
  | {
      type: "req_body";
      streamId: string;
      chunkBase64: string;
    }
  | {
      type: "req_end";
      streamId: string;
    }
  | {
      type: "req_abort";
      streamId: string;
    }
  | {
      type: "res_start";
      streamId: string;
      status: number;
      headers: Record<string, string>;
    }
  | {
      type: "res_body";
      streamId: string;
      chunkBase64: string;
    }
  | {
      type: "res_end";
      streamId: string;
    }
  | {
      type: "ping";
    }
  | {
      type: "pong";
    };
