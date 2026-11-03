const { Transform } = require('stream')
const { StringDecoder } = require('string_decoder')
const parse = require('./parse')
const TRACE_EVENTS_PREFIX_LENGTH = '{"traceEvents":['.length
const AFTER_EVENT = 1
const AFTER_COMMA = 2
const ARRAY_CLOSED = 4
const OBJECT_CLOSED = 8

/**
 * Parse complete top-level events in a trace-events array fragment.
 *
 * @param {string} input Trace-event JSON fragment to scan.
 * @param {Parser} parser Stream that receives parsed events.
 * @param {number} state Current document state bit field.
 * @returns {number} Start offset of an incomplete event, or -1 when none remains.
 */
function consumeEvents (input, parser, state) {
  let start = 0
  let depth = 0
  let inString = false
  let escaped = false
  let hasPendingEvent = false

  for (let i = 0; i < input.length; i++) {
    const char = input[i]

    if (!hasPendingEvent) {
      const isArrayClose = char === ']'
      const isDocumentClose = char === '}'
      const hasTrailingComma = state & AFTER_COMMA
      if (isArrayClose && hasTrailingComma) {
        throw new SyntaxError('Unexpected trailing comma in trace events')
      }

      if (char === '{') {
        if (state & (ARRAY_CLOSED | AFTER_EVENT)) throw new SyntaxError('Unexpected trace event')
        start = i
        hasPendingEvent = true
        depth = 1
        continue
      }

      if (char === ' ' || char === '\n' || char === '\r' || char === '\t') continue
      if (state & OBJECT_CLOSED) throw new SyntaxError('Unexpected content after trace document')
      if (state & ARRAY_CLOSED) {
        if (!isDocumentClose) throw new SyntaxError('Expected closing trace document object')
        state = OBJECT_CLOSED
        parser._jsonState = state
        continue
      }

      if (char === ',') {
        if (!(state & AFTER_EVENT)) throw new SyntaxError('Unexpected comma between trace events')
        state = (state & ~AFTER_EVENT) | AFTER_COMMA
        parser._jsonState = state
        continue
      }

      if (isArrayClose) {
        state = ARRAY_CLOSED
        parser._jsonState = state
        continue
      }

      throw new SyntaxError('Unexpected content in trace events')
    }

    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }

    if (char === '"') inString = true
    else if (char === '{') depth++
    else if (char === '}' && --depth === 0) {
      const source = input.slice(start, i + 1)
      let event
      try {
        event = source.includes('\\') ? JSON.parse(source) : parse(source)
      } catch (err) {
        event = JSON.parse(source)
      }
      parser.push(event)
      hasPendingEvent = false
      state = (state | AFTER_EVENT) & ~AFTER_COMMA
      parser._jsonState = state
    }
  }

  return hasPendingEvent ? start : -1
}

/**
 * A Chrome/Node.js trace event emitted by the parser.
 *
 * Only the fields listed here are retained by the parser. Trace events may
 * omit any of them; `args` may also contain additional input properties.
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
 * Arguments recognized in a trace event. The parser retains these properties.
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
    /** @type {string} Unprocessed text carried over from the previous chunk. */
    this._buffer = ''
    /** @type {StringDecoder} Preserves UTF-8 characters split across input chunks. */
    this._decoder = new StringDecoder('utf8')
    this._jsonState = 0
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
    const decoded = this._decoder.write(bytes)
    const str = this._buffer ? this._buffer + decoded : decoded
    try {
      const pendingStart = consumeEvents(str, this, this._jsonState)
      this._buffer = pendingStart === -1 ? '' : str.slice(pendingStart)
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
    this._buffer += this._decoder.end()
    if (this._buffer) return cb(new SyntaxError('Incomplete trace event'))
    if (!(this._jsonState & OBJECT_CLOSED)) return cb(new SyntaxError('Incomplete trace document'))
    cb(null)
  }
}
