import { beforeEach, expect, it } from 'vitest';
import { getStore } from '../../lib/datastore';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { completedBuild } from '../../lib/builds/jobs';
import { ConnectionError } from '../../lib/publishing/connections';

const taskPath = 'organizations/org/build_tasks/task';
beforeEach(async () => { makeTmpFixtures(); await resetDatastore(); });

it('names the failed step and its cause, and hands the diagnostic to the publication', async () => {
  const error_detail = { cause: 'Error: Invalid media completion receipt', lines: ['Error: Invalid media completion receipt'] };
  await getStore().setDoc(taskPath, { status: 'failed', error_code: 'media_build_process_exit_1', error_detail });
  const error = await completedBuild('org', 'task').catch(failure => failure);
  expect(error).toBeInstanceOf(ConnectionError);
  expect(error).toMatchObject({ status: 502, code: 'media_build_process_exit_1', details: { build_diagnostic: error_detail } });
  expect(error.message).toBe('The build failed while preparing images and files: the step exited with code 1. Cause: Error: Invalid media completion receipt. Resolve the cause, then retry publishing. (media_build_process_exit_1) Prepared images are retained.');
});

it('still names the step for an engine that reports no diagnostic', async () => {
  await getStore().setDoc(taskPath, { status: 'failed', error_code: 'dependencies_build_process_exit_1' });
  const error = await completedBuild('org', 'task').catch(failure => failure);
  expect(error.message).toMatch(/^The build failed while installing the site’s build dependencies: the step exited with code 1\. Check the build log/);
  expect(error.details).toBeUndefined();
});
