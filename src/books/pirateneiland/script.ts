// Script file handling of BBOEK32.EXE's TMainForm: FUN_00437904 (load), FUN_0043765c (argument extraction).
// Pure logic, no browser dependencies (testable under node).

export interface Label { name: string; line: number }

/** StrToInt. The original raises EConvertError on garbage (only the unreachable template page 065 does); 0 here. */
export function toInt(s: string): number {
  const n = parseInt(s.trim(), 10);
  return Number.isNaN(n) ? 0 : n;
}

export class Script {
  readonly lines: string[];
  readonly labels: Label[] = [];
  /** +0x634: the line pointer. Argument extraction of multi-line arguments moves it. */
  ip = 0;

  /** `text` is the decoded script. Empty lines are dropped (FUN_00437904); `{LABEL}` lines stay and execute as no-ops. */
  constructor(text: string) {
    this.lines = text.split(/\r?\n/).filter((l) => l.length > 0);
    this.lines.forEach((line, i) => {
      if (line.startsWith('{LABEL}')) {
        // copy(line, 8, length-8): drops "{LABEL}" and the last character (normally the "~"), name is a ShortString[20]
        this.labels.push({ name: line.slice(7, Math.max(7, line.length - 1)).slice(0, 20), line: i });
      }
    });
  }

  /** +0x62c: index of the last line. */
  get lastIndex() { return this.lines.length - 1; }

  get current(): string { return this.lines[this.ip] ?? ''; }

  /** The `{COMMAND}` word of the current line, including the braces ('' if the line does not start with one). */
  get command(): string {
    const m = /^\{[A-Z_]*\}/.exec(this.current);
    return m ? m[0] : '';
  }

  findLabel(name: string): Label | undefined {
    // the original keeps one entry per label and tests all of them: with duplicates the last one wins
    let found: Label | undefined;
    for (const l of this.labels) if (l.name === name) found = l;
    return found;
  }

  /**
   * FUN_0043765c(self, n): argument n (1-based) of the current line, exactly as the original splits it.
   * n = 1 is the text after "{CMD}" up to the first "~". For n > 1 the line (with its "{CMD}" prefix) is
   * cut after the first "~", n-1 times. A remainder without "~" is a multi-line argument (INIT_TEXTBOX's text).
   */
  arg(n: number): string {
    const L = this.current;
    if (n === 1) {
      const start = L[0] === '{' ? L.indexOf('}') + 2 : 1; // 1-based
      const pos = L.indexOf('~') + 1; // 1-based, 0 = none
      const len = (pos - start) & 255; // computed in a byte: no "~" wraps around and returns (most of) the rest
      return L.substr(start - 1, len);
    }
    let s = L;
    for (let i = 1; i < n; i++) {
      const p = s.indexOf('~') + 1;
      // copy(s, p+1, length-p): with no "~" (p = 0) s stays as it is
      s = s.slice(p);
    }
    const p = s.indexOf('~');
    if (p >= 0) return s.slice(0, p);
    if (s === '') return '';
    // multi-line argument: join the following lines with spaces up to the line that holds the closing "~"
    let acc = s;
    this.ip++;
    while (this.ip < this.lines.length && !this.lines[this.ip].includes('~')) {
      acc += ' ' + this.lines[this.ip];
      this.ip++;
    }
    // the last line contributes everything but its final character (the closing "~")
    const last = this.lines[this.ip] ?? '';
    return acc + ' ' + last.slice(0, Math.max(0, last.length - 1));
  }
}
