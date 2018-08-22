const { Transform } = require('stream')

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

    var end = this._buffer.length > 2 ? this._buffer.length - 2 : 0
    var prev = 0

    const str = this._buffer ? this._buffer + data.toString() : data.toString()

    while ((end = str.indexOf('}},', end)) > -1) {
      const msg = JSON.parse(str.slice(prev, end + 2))
      prev = end = end + 3
      this.push(msg)
    }

    this._buffer = str.slice(prev)
    cb()
  }

  _flush (cb) {
    const msg = JSON.parse(this._buffer.slice(0, this._buffer.indexOf('}}') + 2))
    this.push(msg)
    cb(null)
  }
}
