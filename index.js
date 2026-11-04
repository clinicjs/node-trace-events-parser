const { Transform } = require('stream')
const TRACE_EVENTS_PREFIX_LENGTH = '{"traceEvents":['.length
// Longest string given to one consumeEvents call; larger chunks are scanned in slices.
const MAX_SCAN_CHUNK_LENGTH = 1024 * 1024
const AFTER_EVENT = 1
const AFTER_COMMA = 2
const ARRAY_CLOSED = 4
const OBJECT_CLOSED = 8
const IN_STRING = 1
const ESCAPED = 2
const OUTSIDE_WHITESPACE = 1
const OUTSIDE_COMMA = 2
const OUTSIDE_ARRAY_CLOSE = 3
const OUTSIDE_OBJECT_CLOSE = 4
const OUTSIDE_ACTION = new Uint8Array(128)
const OUTSIDE_TRANSITIONS = new Uint8Array(16 * 8)
const OUTSIDE_ERRORS = [
  'Unexpected content after trace document',
  'Expected closing trace document object',
  'Unexpected comma between trace events',
  'Unexpected trailing comma in trace events',
  'Unexpected content in trace events'
]
const ERROR_AFTER_DOCUMENT = 16
const ERROR_EXPECT_DOCUMENT_CLOSE = 17
const ERROR_COMMA = 18
const ERROR_TRAILING_COMMA = 19
const ERROR_CONTENT = 20
OUTSIDE_ACTION[9] = OUTSIDE_WHITESPACE
OUTSIDE_ACTION[10] = OUTSIDE_WHITESPACE
OUTSIDE_ACTION[13] = OUTSIDE_WHITESPACE
OUTSIDE_ACTION[32] = OUTSIDE_WHITESPACE
OUTSIDE_ACTION[44] = OUTSIDE_COMMA
OUTSIDE_ACTION[93] = OUTSIDE_ARRAY_CLOSE
OUTSIDE_ACTION[125] = OUTSIDE_OBJECT_CLOSE

for (let documentState = 0; documentState < 16; documentState++) {
  for (let action = 0; action < 5; action++) {
    let nextState
    if (action === OUTSIDE_WHITESPACE) nextState = documentState
    else if (documentState & OBJECT_CLOSED) nextState = ERROR_AFTER_DOCUMENT
    else if (action === OUTSIDE_COMMA) {
      if (documentState === AFTER_EVENT) nextState = AFTER_COMMA
      else if (documentState === ARRAY_CLOSED || documentState === (ARRAY_CLOSED | AFTER_EVENT)) {
        nextState = ERROR_EXPECT_DOCUMENT_CLOSE
      } else nextState = ERROR_COMMA
    } else if (action === OUTSIDE_ARRAY_CLOSE) {
      if (documentState === AFTER_COMMA) nextState = ERROR_TRAILING_COMMA
      else if (documentState === ARRAY_CLOSED || documentState === (ARRAY_CLOSED | AFTER_EVENT)) {
        nextState = ERROR_EXPECT_DOCUMENT_CLOSE
      } else nextState = documentState | ARRAY_CLOSED
    } else if (action === OUTSIDE_OBJECT_CLOSE) {
      if (documentState === ARRAY_CLOSED || documentState === (ARRAY_CLOSED | AFTER_EVENT)) {
        nextState = ARRAY_CLOSED | OBJECT_CLOSED
      } else nextState = ERROR_CONTENT
    } else if (documentState === ARRAY_CLOSED || documentState === (ARRAY_CLOSED | AFTER_EVENT)) {
      nextState = ERROR_EXPECT_DOCUMENT_CLOSE
    } else nextState = ERROR_CONTENT

    OUTSIDE_TRANSITIONS[(documentState << 3) | action] = nextState
  }
}

/**
 * Parse and emit an event that has reached its closing brace.
 *
 * @param {string} input Current input fragment.
 * @param {number} start Start offset in the current fragment.
 * @param {number} end Exclusive end offset in the current fragment.
 * @param {string[]} parts Fragments retained from previous chunks.
 * @param {Parser} parser Stream receiving the parsed event.
 * @returns {void}
 */
function emitEvent (input, start, end, parts, parser) {
  let prefix = ''
  for (let i = 0; i < parts.length; i++) prefix += parts[i]
  const event = prefix + input.slice(start, end)
  parser.push(JSON.parse(event))
  parts.length = 0
}

/**
 * Find the byte offset before a trailing, incomplete UTF-8 sequence.
 *
 * @param {Buffer} buffer Bytes to inspect.
 * @returns {number} Length of the prefix that can be decoded safely.
 */
function completeUtf8Length (buffer) {
  let start = buffer.length - 1
  while (start >= 0 && (buffer[start] & 0xc0) === 0x80) start--
  if (start < 0) return buffer.length

  const lead = buffer[start]
  const expected = lead >= 0xf0 && lead <= 0xf4
    ? 4
    : lead >= 0xe0
      ? 3
      : lead >= 0xc2
        ? 2
        : 1

  return buffer.length - start < expected ? start : buffer.length
}

/**
 * Parse complete top-level event objects from a fragment, resuming any event
 * that spans chunks without rescanning its previous text.
 *
 * @param {string} input New trace-event text to scan.
 * @param {Parser} parser Stream that receives parsed events.
 * @param {string[]} parts Text fragments retained from previous chunks.
 * @returns {void}
 */
function consumeEvents (input, parser, parts) {
  let documentState = parser._jsonState
  let depth = parser._scanDepth
  let flags = parser._scanFlags
  let start = depth > 0 ? 0 : -1
  parser._pendingStart = start

  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i)

    if (start === -1) {
      if (code === 123) {
        if (documentState & (ARRAY_CLOSED | AFTER_EVENT)) {
          throw new SyntaxError('Unexpected trace event')
        }
        start = i
        depth = 1
        parser._scanDepth = depth
        parser._pendingStart = start
        continue
      }

      const action = code < OUTSIDE_ACTION.length ? OUTSIDE_ACTION[code] : 0
      const nextState = OUTSIDE_TRANSITIONS[(documentState << 3) | action]
      if (nextState >= ERROR_AFTER_DOCUMENT) {
        throw new SyntaxError(OUTSIDE_ERRORS[nextState - ERROR_AFTER_DOCUMENT])
      }
      documentState = nextState
      if (action !== OUTSIDE_WHITESPACE) parser._jsonState = documentState
      continue
    }

    if (flags & IN_STRING) {
      if (flags & ESCAPED) {
        flags &= ~ESCAPED
        parser._scanFlags = flags
      } else if (code === 92) {
        flags |= ESCAPED
        parser._scanFlags = flags
      } else if (code === 34) {
        flags &= ~IN_STRING
        parser._scanFlags = flags
      }
      continue
    }

    if (code === 34) {
      flags |= IN_STRING
      parser._scanFlags = flags
    } else if (code === 123) {
      depth++
      parser._scanDepth = depth
    } else if (code === 125) {
      depth--
      parser._scanDepth = depth
      if (depth === 0) {
        emitEvent(input, start, i + 1, parts, parser)
        parser._pendingStart = -1
        start = -1
        documentState = (documentState | AFTER_EVENT) & ~AFTER_COMMA
        parser._jsonState = documentState
      }
    }
  }
}

/**
 * A Chrome/Node.js trace event emitted by the parser.
 *
 * The parser retains all input properties. These commonly used fields are
 * documented here; trace events may omit any of them.
 *
 * @typedef {object} TraceEvent
 * @property {number} [pid] Process identifier.
 * @property {number} [tid] Thread identifier.
 * @property {number} [ts] Event timestamp, in microseconds.
 * @property {number} [tts] Thread timestamp, in microseconds.
 * @property {string} [ph] Event phase.
 * @property {string} [cat] Event category.
 * @property {string} [name] Event name.
 * @property {number} [dur] Event duration, in microseconds.
 * @property {number} [tdur] Thread duration, in microseconds.
 * @property {string} [id] Event identifier.
 * @property {TraceEventArgs} [args] Event-specific arguments.
 */

/**
 * Arguments attached to a trace event. The parser retains all input properties.
 *
 * @typedef {object} TraceEventArgs
 * @property {string} [node] Node.js node identifier.
 * @property {string} [name] Argument name.
 * @property {number} [executionAsyncId] Execution async resource identifier.
 * @property {number} [triggerAsyncId] Triggering async resource identifier.
 */

/**
 * A writable stream that parses a Node.js trace log and emits trace events.
 *
 * @typedef {Transform & import('stream').Readable & import('stream').Writable} Parser
 */

/**
 * Options for creating a trace-event parser.
 *
 * @typedef {object} ParserOptions
 * @property {boolean} [decodeStrings=true] Pass string chunks to the parser
 *   without converting them to Buffers first.
 */

/**
 * Create a streaming parser for the `traceEvents` array in a Node.js trace log.
 * The returned stream accepts the log as bytes and emits each event as an
 * object in readable object mode.
 *
 * @param {ParserOptions} [options] Stream configuration.
 * @returns {Parser} A transform stream emitting {@link TraceEvent} objects.
 */
module.exports = (options) => new Parser(options)

/**
 * Transform stream that extracts trace events from a Node.js trace log.
 *
 * @extends Transform
 */
class Parser extends Transform {
  /**
   * Create a parser stream configured to accept byte chunks and emit objects.
   *
   * @param {ParserOptions} [options] Stream configuration.
   */
  constructor ({ decodeStrings = true } = {}) {
    super({
      readableObjectMode: true,
      writableObjectMode: false,
      decodeStrings
    })

    /** @type {number} Number of leading bytes still to skip from the log. */
    this._skip = TRACE_EVENTS_PREFIX_LENGTH
    /** @type {Buffer} Incomplete UTF-8 bytes carried over from the previous chunk. */
    this._utf8Buffer = Buffer.alloc(0)
    /**
     * Text fragments for an event spanning chunks. Seeded with a string so the
     * array never changes elements kind, which would deoptimize `emitEvent`.
     *
     * @type {string[]}
     */
    this._eventParts = ['']
    /** @type {number} Document structure flags. */
    this._jsonState = 0
    /** @type {number} Open object depth in the current event. */
    this._scanDepth = 0
    /** @type {number} String and escape flags in the current event. */
    this._scanFlags = 0
    /** @type {number} Start of a pending event in the current chunk. */
    this._pendingStart = -1
  }

  /**
   * Parse complete events from an incoming chunk, buffering any incomplete
   * event for the next chunk.
   *
   * @param {Buffer|string} data Incoming trace-log chunk.
   * @param {BufferEncoding} enc Encoding when `data` is a string.
   * @param {(error?: Error|null) => void} cb Transform callback.
   * @returns {void}
   */
  _transform (data, enc, cb) {
    if (this._skip) {
      if (data.length <= this._skip) {
        this._skip -= data.length
        return cb(null)
      }
      data = data.slice(this._skip)
      this._skip = 0
    }

    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data, enc)
    const combined = this._utf8Buffer.length ? Buffer.concat([this._utf8Buffer, bytes]) : bytes
    const completeLength = completeUtf8Length(combined)
    this._utf8Buffer = combined.subarray(completeLength)
    const decoded = combined.subarray(0, completeLength).toString()
    try {
      let offset = 0
      while (offset < decoded.length) {
        const end = Math.min(offset + MAX_SCAN_CHUNK_LENGTH, decoded.length)
        const input = offset === 0 && end === decoded.length ? decoded : decoded.slice(offset, end)
        consumeEvents(input, this, this._eventParts)
        if (this._scanDepth > 0) this._eventParts.push(input.slice(this._pendingStart))
        offset = end
      }
    } catch (err) {
      return cb(err)
    }

    cb()
  }

  /**
   * Parse and emit the final event when the input stream ends.
   *
   * @param {(error?: Error|null) => void} cb Transform callback.
   * @returns {void}
   */
  _flush (cb) {
    if (this._utf8Buffer.length || this._scanDepth > 0) {
      return cb(new SyntaxError('Incomplete trace event'))
    }
    if (!(this._jsonState & OBJECT_CLOSED)) return cb(new SyntaxError('Incomplete trace document'))
    cb(null)
  }
}
