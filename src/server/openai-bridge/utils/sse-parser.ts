// Incremental SSE parser that handles partial chunks
// Compliant with the SSE spec: supports \n, \r\n, and \r line endings

export interface SSEEvent {
  event?: string;
  data: string;
}

export class SSEParser {
  private buffer = '';
  private eventType: string | undefined;
  private dataLines: string[] = [];

  /** Feed a text chunk, returns parsed SSE events */
  feed(chunk: string): SSEEvent[] {
    this.buffer += chunk;
    const events: SSEEvent[] = [];

    while (this.buffer.length > 0) {
      // Find the next line ending: \n, \r\n, or standalone \r
      const lfPos = this.buffer.indexOf('\n');
      const crPos = this.buffer.indexOf('\r');

      // No line ending found — need more data
      if (lfPos === -1 && crPos === -1) break;

      let lineEnd: number;
      let skip: number;

      if (crPos !== -1 && (lfPos === -1 || crPos < lfPos)) {
        // \r found first — could be \r\n or standalone \r
        lineEnd = crPos;
        if (crPos + 1 >= this.buffer.length) {
          // \r at buffer end: might be start of \r\n split across chunks — defer
          break;
        }
        skip = this.buffer[crPos + 1] === '\n' ? 2 : 1;
      } else {
        // \n found first
        lineEnd = lfPos;
        skip = 1;
      }

      const line = this.buffer.slice(0, lineEnd);
      this.buffer = this.buffer.slice(lineEnd + skip);

      if (line === '') {
        // Empty line → dispatch accumulated event
        if (this.dataLines.length > 0) {
          const data = this.dataLines.join('\n');
          if (data !== '[DONE]') {
            events.push({ event: this.eventType, data });
          }
        }
        this.eventType = undefined;
        this.dataLines = [];
      } else if (line.startsWith('event:')) {
        this.eventType = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        this.dataLines.push(line.slice(5).trimStart());
      }
      // Ignore comments (: prefix) and other SSE fields (id:, retry:)
    }

    return events;
  }
}
