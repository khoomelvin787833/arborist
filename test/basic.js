var test = require('tap').test
var rpt = require('../rpt.js')
var path = require('path')
var resolve = path.resolve
var fs = require('fs')
var archy = require('archy')
var mkdirp = require('mkdirp')
var fixtures = path.resolve(__dirname, 'fixtures')
var roots = [ 'root', 'other', 'selflink', 'noname' ]
var cwd = path.resolve(__dirname, '..')

var symlinks = {
  'selflink/node_modules/@scope/z/node_modules/glob':
    '../../../foo/node_modules/glob',
  'other/node_modules/glob':
    '../../root/node_modules/@scope/x/node_modules/glob',
  'linkedroot':
    'root',
  'deep/root':
    '../root',
  'deeproot':
    'deep',
  'badlink/node_modules/foo':
    'foo',
  'badlink/node_modules/bar':
    'baz'
}

function cleanup () {
  Object.keys(symlinks).forEach(function (s) {
    var p = path.resolve(cwd, 'test/fixtures', s)
    try {
      fs.unlinkSync(p)
    } catch (er) {}
  })
}

const archyize = {
  enter (d) {
    const path = d.target ? d.target.path : d.path
    const {_id, version, name} = d.package
    const label = (
      !Object.keys(d.package).length ? '' :
      _id ? _id + ' ' :
      d.name ? d.name + (version ? '@' + version : '') + ' ' :
      name ? name + (version ? '@' + version : '') + ' ' :
      ''
    ) + path.substr(cwd.length + 1)
    + (d.target ? ' (symlink)' : '')
    + (d.invalidTo.size ? (' (invalid for ' + [...d.invalidTo].map(node =>
      (node.target || node).path.substr(cwd.length + 1)).join(' ') + ')') : '')

    return {
      label,
      target: d.target,
      tree: d,
      parent: d.parent,
      node: d,
    }
  },
  exit (d, nodes) {
    return Object.assign({}, d, {
      nodes: d.target ? [] : nodes.map(node =>
        node.parent === d.node ? node
        : Object.assign({}, node, { label: node.label + ' (deduped)' }))
    })
  }
}

const archyPhysical = d => archy(d.walkPhysical(archyize)).trim()
const archyLogical = d => archy(d.walkLogical(archyize)).trim()

test('setup symlinks', function (t) {
  cleanup()

  Object.keys(symlinks).forEach(function (s) {
    var p = path.resolve(cwd, 'test/fixtures', s)
    mkdirp.sync(path.dirname(p))
    fs.symlinkSync(symlinks [ s ], p, 'dir')
  })

  t.end()
})

roots.forEach(function (root) {
  var dir = path.resolve(fixtures, root)

  // test promisey nature
  test(root, t => rpt(dir).then(d => {
    t.matchSnapshot(archyPhysical(d), 'physical')
    t.matchSnapshot(archyLogical(d), 'logical')
    t.matchSnapshot(JSON.stringify(d.packageLock, null, 2), 'package lock')
  }))
})

test('linkedroot', function (t) {
  var dir = path.resolve(fixtures, 'linkedroot')
  // test legacy cb nature
  return rpt(dir, function (er, d) {
    if (er && er.code !== 'ENOENT') throw er

    t.matchSnapshot(archyPhysical(d), 'physical')
    t.matchSnapshot(archyLogical(d), 'logical')
    t.matchSnapshot(JSON.stringify(d.packageLock, null, 2), 'package lock')
  })
})

test('deeproot', function (t) {
  var dir = path.resolve(fixtures, 'deeproot/root')
  return rpt(dir, function (er, d) {
    if (er && er.code !== 'ENOENT') throw er

    t.matchSnapshot(archyPhysical(d), 'physical')
    t.matchSnapshot(archyLogical(d), 'logical')
    t.matchSnapshot(JSON.stringify(d.packageLock, null, 2), 'package lock')
  })
})

test('filterWith', t =>
  rpt(
    path.join(fixtures, 'root'),
    (node, kid) => !node.parent,
    true
  ).then(d => {
    t.matchSnapshot(archyPhysical(d), 'physical')
    t.matchSnapshot(archyLogical(d), 'logical')
    t.matchSnapshot(JSON.stringify(d.packageLock, null, 2), 'package lock')
  })
)

test('looking outside of cwd', t => {
  const cwd = process.cwd()
  t.teardown(() => process.chdir(cwd))
  process.chdir('test/fixtures/selflink')
  return rpt('../root').then(d => {
    t.matchSnapshot(archyPhysical(d), 'physical')
    t.matchSnapshot(archyLogical(d), 'logical')
    t.matchSnapshot(JSON.stringify(d.packageLock, null, 2), 'package lock')
  })
})

test('shake out Link target timing issue', t => {
  process.env._TEST_RPT_SLOW_LINK_TARGET_ = '1'
  const cwd = process.cwd()
  t.teardown(() => process.env._TEST_RPT_SLOW_LINK_TARGET_ = '')
  return rpt(path.resolve(fixtures, 'selflink')).then(d => {
    t.matchSnapshot(archyPhysical(d), 'physical')
    t.matchSnapshot(archyLogical(d), 'logical')
    t.matchSnapshot(JSON.stringify(d.packageLock, null, 2), 'package lock')
  })
})

test('broken json', function (t) {
  rpt(path.resolve(fixtures, 'bad'), function (er, d) {
    t.ok(d.error, 'Got an error object')
    t.equal(d.error && d.error.code, 'EJSONPARSE')
    t.ok(d, 'Got a tree')
    t.end()
  })
})

test('missing json does not obscure deeper errors', function (t) {
  rpt(path.resolve(fixtures, 'empty'), function (er, d) {
    var error = d.error
    t.ok(error, 'Error reading json of top level')
    t.equal(error && error.code, 'ENOENT')
    var childError = d.children.length===1 && d.children[0].error
    t.ok(childError, 'Error parsing JSON of child node')
    t.equal(childError && childError.code, 'EJSONPARSE')
    t.end()
  })
})

test('missing folder', function (t) {
  rpt(path.resolve(fixtures, 'does-not-exist'), function (er, d) {
    t.ok(er, 'Got an error object')
    t.equal(er && er.code, 'ENOENT')
    t.ok(!d, 'No tree on top level error')
    t.end()
  })
})

test('missing symlinks', function (t) {
  rpt(path.resolve(fixtures, 'badlink'), function (er, d) {
    if (er && er.code !== 'ENOENT') throw er
    t.is(d.children.length, 2, 'both broken children are included')
    d.children.forEach(function (child) {
      t.ok(child.error, 'Child node has an error')
    })
    t.end()
  })
})

test('realpath gutchecks', t => {
  const d = path.resolve(cwd, 'test/fixtures')
  const realpath = require('../realpath.js')
  const {realpathSync} = fs
  Object.keys(symlinks).map(link => t.test(link, t =>
    realpath(
      path.resolve(d, link),
      new Map(),
      new Map(),
      0
    ).then(
      real => t.equal(real, realpathSync(path.resolve(d, link))),
      er => t.throws(()=> realpathSync(path.resolve(d, link)))
    )))
  t.end()
})

test('walking through trees', t => rpt('test/fixtures/root').then(d => {
  let logicalStrollResult
  let logicalSprintResult
  let physicalStrollResult
  let physicalSprintResult
  t.test('logical stroll', t => {
    const log = []
    // NB: because logical trees can have loops, this can result in
    // a node being exited before all of its children have exited.
    // To get the same result while sync or async, we need to use a
    // result object that will be updated along the way, so that
    // child nodes will eventually update the parent reference.
    // That's why we're returning an array object and updating it
    // in-place, to verify that the same result eventually is produced,
    // whether it's done asynchronously or synchronously, or else we'll
    // get the enter value instead of the exit value in the kids array,
    // and because this is order-dependent, the sync and async runs will
    // get different results.
    const p = d.walkLogical({
      enter (node) {
        const p = node.name
        log.push(['ENTER', p])
        return Promise.resolve([p])
      },
      exit (p, kids) {
        log.push(['EXIT', p])
        p.push(kids)
        return Promise.resolve(p)
      }
    })
    t.isa(p, Promise)
    return p.then(result => {
      logicalStrollResult = result
      t.matchSnapshot(log, 'logical walk log')
      t.matchSnapshot(result, 'logical walk result')
    })
  })
  t.test('logical sprint', t => {
    const log = []
    const p = d.walkLogical({
      enter (node) {
        const p = node.name
        log.push(['ENTER', p])
        return [p]
      },
      exit (p, kids) {
        log.push(['EXIT', p])
        p.push(kids)
        return p
      }
    })
    t.notOk(p.then, 'not a promise')
    t.matchSnapshot(log, 'logical walk log')
    t.matchSnapshot(p, 'logical walk result')
    logicalSprintResult = p
    t.end()
  })

  t.test('same logical results using promises or sync', t => {
    t.same(logicalStrollResult, logicalSprintResult)
    t.end()
  })

  t.test('physical stroll', t => {
    const log = []
    const p = d.walkPhysical({
      enter (node) {
        const p = node.name
        log.push(['ENTER', p])
        return Promise.resolve(p)
      },
      exit (p, kids) {
        log.push(['EXIT', p])
        return Promise.resolve([p, kids])
      }
    })
    t.isa(p, Promise)
    return p.then(result => {
      physicalStrollResult = result
      t.matchSnapshot(log, 'physical walk log')
      t.matchSnapshot(result, 'physical walk result')
    })
  })
  t.test('physical sprint', t => {
    const log = []
    const p = d.walkPhysical({
      enter (node) {
        const p = node.name
        log.push(['ENTER', p])
        return p
      },
      exit (p, kids) {
        log.push(['EXIT', p])
        return [p, kids]
      }
    })
    t.notOk(p.then, 'not a promise')
    t.matchSnapshot(log, 'physical walk log')
    t.matchSnapshot(p, 'physical walk result')
    physicalSprintResult = p
    t.end()
  })

  t.test('same physical results using promises or sync', t => {
    t.same(physicalStrollResult, physicalSprintResult)
    t.end()
  })

  t.test('no exit', t => {
    const log = []
    d.walkPhysical({
      enter (node) {
        log.push(['ENTER', node.path.substr(cwd.length + 1)])
        return Promise.resolve(node)
      }
    })
    t.matchSnapshot(log, 'no exit walk log')
    t.end()
  })

  t.test('no entry', t => {
    const log = []
    d.walkPhysical({
      exit (node) {
        log.push(['EXIT', node.path.substr(cwd.length + 1)])
      }
    })
    t.matchSnapshot(log, 'no entry walk log')
    t.end()
  })
}))

test(`rpt's own package-lock.json`, t =>
  rpt(cwd).then(d => {
    const rptlock = d.packageLock
    const npmlock = JSON.parse(fs.readFileSync(cwd + '/package-lock.json', 'utf8'))
    t.same(rptlock, npmlock)
  }))

test('cleanup', function (t) {
  cleanup()
  t.end()
})
