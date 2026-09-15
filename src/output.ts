import { StringDecoder } from 'node:string_decoder';

/** Rust owns the terminal fd; route Node's stdout/stderr writes through its transcript. */
export function captureOutput(onLine: (line: string) => void): () => string[] {
  const restore = [process.stdout, process.stderr].map(stream => {
    const original = stream.write;
    const decoder = new StringDecoder('utf8');
    let pending = '';
    stream.write = (chunk: string | Uint8Array, encoding?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void): boolean => {
      const done = typeof encoding === 'function' ? encoding : callback;
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk, typeof encoding === 'string' ? encoding : 'utf8') : Buffer.from(chunk);
      pending += decoder.write(bytes);
      const lines = pending.split('\n');
      pending = lines.pop()!;
      for (const line of lines) onLine(line);
      // Bound unterminated logs without splitting UTF-16 surrogate pairs.
      if (pending.length > 8192) { onLine(pending); pending = ''; }
      if (done) queueMicrotask(() => done(null));
      return true;
    };
    return () => { stream.write = original; return pending + decoder.end(); };
  });
  return () => restore.map(stop => stop()).filter(Boolean);
}
