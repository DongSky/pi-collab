// Share this filter between the executor and the standalone preview runner.
// Never publish an unfinished token: provider keys can span arbitrary RPC or
// stdout chunks. No timer flushes that token. Delimiters keep shell prompts live.
const marker = '[REDACTED]';
const tokenCharacter = /[A-Za-z0-9_+\/=.:@'"-]/;
const secretStart = /(?:^|[^A-Za-z0-9_])(?:sk-|gh[pousr]_|github_pat_|AKIA|Bearer|(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/)/i;
const credentialAssignment = /(?:^|[_."'-])(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)["']?[:=]/i;
const credentialName = /(?:^|[_."'-])(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)["']?$/i;

export class OutputRedactor {
  token = '';
  hiddenLine = false;
  pem = false;
  pemTail = '';

  /** @param {string} chunk */
  push(chunk) {
    let output = '';
    for (const char of chunk) {
      if (this.pem) {
        this.pemTail = (this.pemTail + char).slice(-100);
        if (/-----END [A-Z ]*KEY-----$/.test(this.pemTail)) { this.pem = false; this.hiddenLine = true; this.pemTail = ''; }
        continue;
      }
      if (this.hiddenLine) {
        if (char === '\n' || char === '\r') { this.hiddenLine = false; output += char; }
        continue;
      }
      if (tokenCharacter.test(char)) {
        this.token += char;
        if (this.token.includes('-----BEGIN')) {
          this.pem = true; this.token = ''; output += marker;
        } else if (secretStart.test(this.token) || credentialAssignment.test(this.token) || this.token.length > 256) {
          // Conservatively omit the rest of a credential-bearing line, including
          // quoted values containing spaces and color/control escape sequences.
          this.token = ''; this.hiddenLine = true; output += marker;
        }
      } else {
        if (credentialName.test(this.token)) { output += marker; this.hiddenLine = char !== '\n' && char !== '\r'; if (!this.hiddenLine) output += char; }
        else output += this.token + char;
        this.token = '';
      }
    }
    return output;
  }

  // Only a true end-of-message/process is a safe token boundary. An interrupted
  // stream may end midway through a key prefix, so discard its unfinished token.
  finish() { const tail = this.token ? marker : ''; this.token = ''; return tail; }
}

/** Complete values may flush their final ordinary token after classification.
 * @param {string} value */
export function redactOutput(value) { const filter = new OutputRedactor(); return filter.push(value) + filter.push('\n').replace(/\n$/, ''); }
