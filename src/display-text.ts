import stripAnsi from 'strip-ansi';

/** Remove terminal commands and controls while retaining readable line breaks. */
export function cleanText(text: string): string {
  return stripAnsi(text).replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '')
    .replaceAll('\t', '    ');
}

export function oneLine(text: string): string {
  return [...cleanText(text).split('\n')[0].trim()].slice(0, 240).join('');
}
