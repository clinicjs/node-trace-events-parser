const { Transform } = require('stream')
const parse = require('./parse')

module.exports = () => new Parser()

class Parser extends Transform {
  constructor () {
    super({
      readableObjectMode: true,
      writableObjectMode: false
    })

    this._skip = '{"traceEvents":['.length
    this._buffer = ''
  }

  _transform (data, enc, cb) {
    if (this._skip) {
      if (data.length <= this._skip) {
        this._skip -= data.length
        return cb(null)
      }
      data = data.slice(this._skip)
      this._skip = 0
    }

    const str = this._buffer ? this._buffer + data.toString() : data.toString()
    const last = str.lastIndexOf('}},')

    if (last === -1) {
      this._buffer = str
    } else {
      parse.pointer = 0
      while (parse.pointer < last) {
        try {
          const msg = parse(str, parse.pointer)
          parse.pointer++
          this.push(msg)
        } catch (err) {
          const rem = '[' + str.slice(parse.pointer, last + 2) + ']'
          for (const msg of JSON.parse(rem)) {
            this.push(msg)
          }
          parse.pointer = last + 3
        }
      }
      this._buffer = str.slice(parse.pointer)
    }

    cb()
  }

  _flush (cb) {
    try {
      const msg = parse(this._buffer.slice(0, this._buffer.lastIndexOf('}}') + 2))
      this.push(msg)
    } catch (err) {
      const msg = JSON.parse(this._buffer.slice(0, this._buffer.lastIndexOf('}}') + 2))
      this.push(msg)
    }
    cb(null)
  }
}
