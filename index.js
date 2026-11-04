const { Transform } = require('stream')
const TRACE_EVENTS_PREFIX_LENGTH = '{"traceEvents":['.length
const AFTER_EVENT = 1
const AFTER_COMMA = 2
const ARRAY_CLOSED = 4
const OBJECT_CLOSED = 8
const IN_STRING = 1
const ESCAPED = 2

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
 * @param {object} eventState Scanner state for an event spanning chunks.
 * @returns {void}
 */
function consumeEvents (input, parser, state, parts) {
  let documentState = state[0]
  let depth = state[1]
  let flags = state[2]
  let start = depth > 0 ? 0 : -1

  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i)

    if (start === -1) {
      if (code === 123) {
        if (documentState & (ARRAY_CLOSED | AFTER_EVENT)) {
          throw new SyntaxError('Unexpected trace event')
        }
        start = i
        depth = 1
        continue
      }

      if (code === 32 || code === 10 || code === 13 || code === 9) continue
      if (documentState & OBJECT_CLOSED) throw new SyntaxError('Unexpected content after trace document')
      if (documentState & ARRAY_CLOSED) {
        if (code !== 125) throw new SyntaxError('Expected closing trace document object')
        documentState |= OBJECT_CLOSED
        continue
      }

      if (code === 44) {
        if (!(documentState & AFTER_EVENT)) throw new SyntaxError('Unexpected comma between trace events')
        documentState = (documentState & ~AFTER_EVENT) | AFTER_COMMA
        continue
      }

      if (code === 93) {
        if (documentState & AFTER_COMMA) throw new SyntaxError('Unexpected trailing comma in trace events')
        documentState |= ARRAY_CLOSED
        continue
      }

      throw new SyntaxError('Unexpected content in trace events')
    }

    if (flags & IN_STRING) {
      if (flags & ESCAPED) flags &= ~ESCAPED
      else if (code === 92) flags |= ESCAPED
      else if (code === 34) flags &= ~IN_STRING
      continue
    }

    if (code === 34) flags |= IN_STRING
    else if (code === 123) depth++
    else if (code === 125 && --depth === 0) {
      const event = parts[0] !== ''
        ? parts.join('') + input.slice(start, i + 1)
        : input.slice(start, i + 1)
      parser.push(JSON.parse(event))
      parts.length = 1
      parts[0] = ''
      start = -1
      documentState = (documentState | AFTER_EVENT) & ~AFTER_COMMA
    }
  }

  if (start !== -1 && start < input.length) {
    const part = input.slice(start)
    if (parts[0] === '') parts[0] = part
    else parts.push(part)
  }

  state[0] = documentState
  state[1] = depth
  state[2] = flags
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
    /** @type {string[]} Text fragments for an event spanning chunks. */
    this._eventParts = ['']
    /** @type {Int32Array} Document flags, object depth and string flags. */
    this._scanState = new Int32Array(3)
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
      consumeEvents(decoded, this, this._scanState, this._eventParts)
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
    if (this._utf8Buffer.length || this._scanState[1] > 0) {
      return cb(new SyntaxError('Incomplete trace event'))
    }
    if (!(this._scanState[0] & OBJECT_CLOSED)) return cb(new SyntaxError('Incomplete trace document'))
    cb(null)
  }
}
