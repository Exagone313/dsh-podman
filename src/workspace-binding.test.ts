import test from 'node:test'
import assert from 'node:assert/strict'
import { posix } from 'node:path'
import { workspaceSlug } from './workspace-binding.js'

test('workspace slugs are stable and container-safe', () => {
  assert.equal(workspaceSlug({ projectName: 'my/project' }), 'my-project')
  assert.equal(workspaceSlug({ id: 'session-1' }), 'session-1')
  assert.equal(workspaceSlug({ projectName: '../../etc' }), 'etc')
  const selectedPath = '/arbitrary/container/root/nested/test-dh'
  assert.equal(workspaceSlug(selectedPath), posix.basename(selectedPath))
})
