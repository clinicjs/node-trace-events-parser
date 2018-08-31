const turbo = require('turbo-json-parse')

module.exports = turbo({
  type: 'object',
  ordered: true,
  properties: {
    pid: {type: 'number'},
    tid: {type: 'number'},
    ts: {type: 'number'},
    tts: {type: 'number'},
    ph: {type: 'string'},
    cat: {type: 'string'},
    name: {type: 'string'},
    dur: {type: 'number'},
    tdur: {type: 'number'},
    id: {type: 'string'},
    args: {
      type: 'object',
      properties: {
        node: {type: 'string'},
        name: {type: 'string'},
        executionAsyncId: {type: 'number'},
        triggerAsyncId: {type: 'number'}
      }
    }
  }
}, {
  // we trust the input so no need for fullMatch and validate
  // also none of the strings have escaped props, so we can
  // disable string escaping as well for a nice boost
  // fullMatch: false,
  // validate: false,
  unescapeStrings: false,
  defaults: false
})
