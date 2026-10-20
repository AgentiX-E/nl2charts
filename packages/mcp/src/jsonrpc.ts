export interface JsonRpcRequest {
  readonly jsonrpc: '2.0';
  readonly id?: string | number | null;
  readonly method: string;
  readonly params?: unknown;
}

export interface JsonRpcError {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

export interface JsonRpcResponse {
  readonly jsonrpc: '2.0';
  readonly id: string | number | null;
  readonly result?: unknown;
  readonly error?: JsonRpcError;
}

export function encodeMessage(message: JsonRpcResponse | JsonRpcRequest): string {
  return `${JSON.stringify(message)}\n`;
}

/**
 * Newline-delimited JSON decoder. A chunk boundary may split a message, so the
 * remainder is buffered until the newline arrives.
 */
export function createDecoder(): (chunk: string) => JsonRpcRequest[] {
  let buffer = '';
  return (chunk: string): JsonRpcRequest[] => {
    buffer += chunk;
    const messages: JsonRpcRequest[] = [];
    let index = buffer.indexOf('\n');
    while (index !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line.length > 0) messages.push(JSON.parse(line) as JsonRpcRequest);
      index = buffer.indexOf('\n');
    }
    return messages;
  };
}
