// Raw bytes → the lines a diff viewer counts. No I/O, no transport: this lives here rather
// than beside the ADO blob fetcher because `gates/static.ts` (files on local disk) and
// `git/intake.ts` (a working tree) need it too, and neither should have to import the Azure
// DevOps client — with it comes auth, the PAT and undici — to split a buffer.

/**
 * Splits raw bytes into lines the way a diff viewer counts them.
 * - Keeps a trailing \r on the line content (CRLF files stay byte-faithful).
 * - Strips a leading UTF-8 BOM, which would otherwise corrupt column offsets on line 1.
 * - A trailing newline does NOT create a phantom final line.
 */
export function splitLines(buf: Buffer): string[] {
  let text = buf.toString("utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}
