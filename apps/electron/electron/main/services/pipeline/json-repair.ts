/**
 * Pure JSON repair for model output. Moved out of transcription.ts so the structured-output
 * contract can use it without pulling Electron in.
 */

/**
 * Repair the two malformations Gemini's JSON-mode reliably produces on real
 * (especially Spanish) transcripts, neither of which it escapes: unescaped
 * inner double-quotes inside string values (e.g. `dijo "no" y ...`) and raw
 * control characters (newline/tab) inside string values. Also strips trailing
 * commas. Single left-to-right scan tracking string context.
 *
 * Inner-quote heuristic: a `"` seen inside a string is treated as the string's
 * closing quote only when the next non-whitespace char is structural
 * (`, } ] :` or end-of-input); otherwise it is an unescaped inner quote and
 * gets escaped. This is the documented signature of the failures observed live
 * (`SyntaxError: Expected ',' or '}' after property value`).
 *
 * Bracket balancing (last pass): the scan tracks the open `{`/`[` stack. A closer
 * is emitted as the one its opener actually requires, correcting a mismatch such
 * as a top-level array closed with `}` instead of `]` (the live position-699
 * failure); a stray closer with nothing open is dropped; and at end-of-input any
 * still-open brackets are appended in innermost-first order (with a dangling
 * trailing comma stripped first). Once the root value closes, anything after it
 * is discarded — an extra trailing `}`/`]` or text-after-JSON garbage (the live
 * "Unexpected non-whitespace character after JSON" failure). Balanced JSON is
 * left untouched.
 */
export function repairJsonString(input: string): string {
  let out = ''
  let inString = false
  // Expected closer for each still-open `{`/`[`, innermost last.
  const stack: string[] = []
  // Set once the outermost bracket closes; everything after the root value is
  // trailing garbage (stray closer, second object, prose) and is dropped.
  let rootClosed = false
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]

    // Ignore anything after the root value has fully closed.
    if (rootClosed) continue

    if (!inString) {
      if (ch === '"') {
        inString = true
        out += ch
        continue
      }
      if (ch === '{' || ch === '[') {
        stack.push(ch === '{' ? '}' : ']')
        out += ch
        continue
      }
      if (ch === '}' || ch === ']') {
        // Drop a stray closer that matches nothing that is open.
        if (stack.length === 0) continue
        // Emit the closer the opener requires (corrects `}`/`]` mismatches).
        out += stack.pop()
        // Root just closed — discard whatever follows.
        if (stack.length === 0) rootClosed = true
        continue
      }
      if (ch === ',') {
        // Drop a trailing comma: `,` followed only by whitespace then `}`/`]`
        // or end-of-input (a closer may still be appended by the EOF balancing).
        let j = i + 1
        while (j < input.length && /\s/.test(input[j])) j++
        if (j >= input.length || input[j] === '}' || input[j] === ']') continue
      }
      out += ch
      continue
    }

    // Inside a string.
    if (ch === '\\') {
      // Preserve an existing escape sequence verbatim (this char + the next).
      out += ch
      if (i + 1 < input.length) {
        out += input[i + 1]
        i++
      }
      continue
    }

    if (ch === '"') {
      // Closing quote only if the next non-whitespace char is structural.
      let j = i + 1
      while (j < input.length && /\s/.test(input[j])) j++
      const next = input[j]
      if (next === undefined || next === ',' || next === '}' || next === ']' || next === ':') {
        inString = false
        out += ch
      } else {
        out += '\\"'
      }
      continue
    }

    const code = ch.charCodeAt(0)
    if (code < 0x20) {
      // Raw control character inside a string — escape it.
      if (ch === '\n') out += '\\n'
      else if (ch === '\r') out += '\\r'
      else if (ch === '\t') out += '\\t'
      else out += '\\u' + code.toString(16).padStart(4, '0')
      continue
    }

    out += ch
  }

  // EOF balancing: close an unterminated string, drop a dangling trailing comma,
  // then append any brackets left open (innermost first).
  if (inString) out += '"'
  if (stack.length > 0) {
    out = out.replace(/[\s,]+$/, '')
    while (stack.length > 0) out += stack.pop()
  }
  return out
}
