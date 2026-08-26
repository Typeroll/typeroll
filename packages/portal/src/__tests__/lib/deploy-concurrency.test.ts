// The per-process build-slot gate.
//
// A build pegs a core, and the deploy worker shares its service with the
// portal at --cpu=1. Two builds on one instance don't run twice as fast; they
// halve each other and starve user requests routed there. Default 1 is right
// for a self-hosted single box AND for a 1-vCPU Cloud Run instance.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  _resetBuildSlotsForTests,
  acquireBuildSlot,
  buildSlotStats,
  maxConcurrentBuilds,
  slotWaitMs,
} from '../../lib/deploy/concurrency';

describe('maxConcurrentBuilds', () => {
  it('defaults to 1 — one build per instance', () => {
    expect(maxConcurrentBuilds({})).toBe(1);
  });

  it('honours an explicit raise', () => {
    expect(maxConcurrentBuilds({ DEPLOY_MAX_CONCURRENT: '3' })).toBe(3);
  });

  it('refuses to be configured below 1, which would deadlock every deploy', () => {
    expect(maxConcurrentBuilds({ DEPLOY_MAX_CONCURRENT: '0' })).toBe(1);
    expect(maxConcurrentBuilds({ DEPLOY_MAX_CONCURRENT: '-2' })).toBe(1);
    expect(maxConcurrentBuilds({ DEPLOY_MAX_CONCURRENT: 'lots' })).toBe(1);
  });
});

describe('slotWaitMs', () => {
  it('stays well under Cloud Run\'s 900s request limit by default', () => {
    // A worker that waits past the request timeout dies holding nothing,
    // having consumed a retry attempt for no reason.
    expect(slotWaitMs({})).toBeLessThan(900_000 / 2);
  });

  it('accepts 0 for an operator who wants immediate hand-back', () => {
    expect(slotWaitMs({ DEPLOY_SLOT_WAIT_MS: '0' })).toBe(0);
  });
});

describe('acquireBuildSlot', () => {
  beforeEach(() => {
    _resetBuildSlotsForTests();
    delete process.env.DEPLOY_MAX_CONCURRENT;
  });
  afterEach(() => {
    _resetBuildSlotsForTests();
    delete process.env.DEPLOY_MAX_CONCURRENT;
  });

  it('grants a slot when the process is idle', async () => {
    const slot = await acquireBuildSlot(0);
    expect(slot).not.toBeNull();
    expect(buildSlotStats().active).toBe(1);
  });

  it('refuses immediately at the limit when there is no wait budget', async () => {
    const first = await acquireBuildSlot(0);
    expect(await acquireBuildSlot(0)).toBeNull();
    first!.release();
  });

  it('hands the slot to a waiter on release', async () => {
    const first = await acquireBuildSlot(0);
    const second = acquireBuildSlot(5_000);
    expect(buildSlotStats().waiting).toBe(1);

    first!.release();
    expect(await second).not.toBeNull();
    // Still exactly one build in flight: the slot transferred, it did not
    // multiply. A double-decrement here would let a second build through.
    expect(buildSlotStats().active).toBe(1);
  });

  it('serves waiters FIFO so a busy platform cannot starve the oldest', async () => {
    const held = await acquireBuildSlot(0);
    const order: string[] = [];
    const a = acquireBuildSlot(5_000).then((s) => { order.push('a'); return s; });
    const b = acquireBuildSlot(5_000).then((s) => { order.push('b'); return s; });

    held!.release();
    (await a)!.release();
    (await b)!.release();
    expect(order).toEqual(['a', 'b']);
  });

  it('gives up after the wait budget and leaves no waiter behind', async () => {
    const held = await acquireBuildSlot(0);
    expect(await acquireBuildSlot(20)).toBeNull();
    expect(buildSlotStats().waiting).toBe(0);
    held!.release();
    // The abandoned wait must not have consumed the slot it timed out on.
    expect(buildSlotStats().active).toBe(0);
  });

  it('does not leak a slot when the wait times out just before release', async () => {
    const held = await acquireBuildSlot(0);
    const timingOut = acquireBuildSlot(10);
    await new Promise((r) => setTimeout(r, 40));
    held!.release();
    expect(await timingOut).toBeNull();
    // The slot handed to a settled waiter is returned rather than stranded for
    // the lifetime of the process — otherwise the gate closes permanently.
    expect(buildSlotStats().active).toBe(0);
  });

  it('treats a double release as one', async () => {
    const slot = await acquireBuildSlot(0);
    slot!.release();
    slot!.release();
    expect(buildSlotStats().active).toBe(0);
    expect(await acquireBuildSlot(0)).not.toBeNull();
  });

  it('allows the configured number in parallel', async () => {
    process.env.DEPLOY_MAX_CONCURRENT = '2';
    const a = await acquireBuildSlot(0);
    const b = await acquireBuildSlot(0);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(await acquireBuildSlot(0)).toBeNull();
    a!.release();
    b!.release();
  });
});
