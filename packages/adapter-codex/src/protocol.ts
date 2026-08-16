export type JsonRpcId = number;

export interface JsonRpcErrorShape {
  code: number;
  message: string;
  data?: unknown;
}

export interface AppServerNotification {
  method: string;
  params: unknown;
}

export interface AppServerRequest extends AppServerNotification {
  id: JsonRpcId;
}

export interface InitializeParams {
  clientInfo: {
    name: string;
    title?: string;
    version: string;
  };
  capabilities?: {
    experimentalApi?: boolean;
    optOutNotificationMethods?: string[];
  };
}

export interface TurnStartParams {
  threadId: string;
  input: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; url: string }
    | { type: 'localImage'; path: string }
  >;
  clientUserMessageId?: string;
  cwd?: string;
  model?: string;
  effort?: string;
  approvalPolicy?: string;
  [key: string]: unknown;
}

export interface AppServerWireMessage {
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: JsonRpcErrorShape;
}
