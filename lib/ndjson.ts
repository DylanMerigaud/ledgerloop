/**
 * Tiny NDJSON line buffer — the framing both ends of the run stream agree on.
 *
 * The route writes one JSON value per line; the client reads arbitrary byte
 * chunks and must reassemble whole lines (a chunk can split a line anywhere).
 * This pure helper does the buffering so the logic is testable in isolation
 * rather than buried in the streaming read loop.
 */
export class NdjsonBuffer {
  private buffer = "";

  /** Feed a decoded text chunk; returns every COMPLETE line it now contains. */
  push(chunk: string): string[] {
    this.buffer += chunk;
    const lines: string[] = [];
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const raw = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (raw) lines.push(raw);
    }
    return lines;
  }

  /** Any trailing partial line not yet terminated by a newline. */
  rest(): string {
    return this.buffer.trim();
  }
}

/** Serialize a value as one NDJSON line (JSON + "\n"). */
export const ndjsonLine = (value: unknown): string => {
  return JSON.stringify(value) + "\n";
};
