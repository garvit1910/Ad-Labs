import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { resolveSpacetimeTarget } from '@/lib/adlab/spacetime-http';
import { BENCH_TARGETS, DEMO_DATABASE, LIVE_DATABASE, benchTarget, runsAllowed, sameTarget } from '@/lib/adlab/targets';

describe('resolveSpacetimeTarget', () => {
  const saved = { uri: process.env.SPACETIMEDB_URI, db: process.env.SPACETIMEDB_DB_NAME };
  beforeEach(() => {
    process.env.SPACETIMEDB_URI = 'https://maincloud.spacetimedb.com/';
    process.env.SPACETIMEDB_DB_NAME = DEMO_DATABASE;
  });
  afterEach(() => {
    for (const [key, value] of [['SPACETIMEDB_URI', saved.uri], ['SPACETIMEDB_DB_NAME', saved.db]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('falls back to the env, trimming the trailing slash', () => {
    const target = resolveSpacetimeTarget();
    assert.equal(target.uri, 'https://maincloud.spacetimedb.com');
    assert.equal(target.dbName, DEMO_DATABASE);
    assert.equal(target.isLocal, false);
    assert.equal(target.label, `https://maincloud.spacetimedb.com / ${DEMO_DATABASE} (MAINCLOUD)`);
  });

  it('takes an explicit pair over the env', () => {
    const target = resolveSpacetimeTarget({ uri: 'http://127.0.0.1:3100', dbName: 'adlab-local' });
    assert.deepEqual(target, {
      uri: 'http://127.0.0.1:3100',
      dbName: 'adlab-local',
      isLocal: true,
      label: 'http://127.0.0.1:3100 / adlab-local (LOCAL)',
    });
  });

  it('refuses half a pair, so a local uri is never paired with the shared database name', () => {
    assert.throws(() => resolveSpacetimeTarget({ uri: 'http://127.0.0.1:3100' }), /both uri and dbName/);
    assert.throws(() => resolveSpacetimeTarget({ dbName: 'adlab-local' }), /both uri and dbName/);
  });
});

describe('runsAllowed', () => {
  it("never allows B's demo database, local or not", () => {
    assert.equal(runsAllowed(resolveSpacetimeTarget({ uri: 'https://maincloud.spacetimedb.com', dbName: DEMO_DATABASE })), false);
    assert.equal(runsAllowed(resolveSpacetimeTarget({ uri: 'http://127.0.0.1:3100', dbName: DEMO_DATABASE })), false);
  });

  it('allows the local bench and the stage database, and no other remote database', () => {
    assert.equal(runsAllowed(benchTarget('local')), true);
    assert.equal(runsAllowed(benchTarget('live')), true);
    assert.equal(benchTarget('live').dbName, LIVE_DATABASE);
    assert.equal(runsAllowed(resolveSpacetimeTarget({ uri: 'https://maincloud.spacetimedb.com', dbName: 'adlab-other' })), false);
  });

  it('compares targets by uri and database', () => {
    assert.equal(sameTarget(benchTarget('local'), resolveSpacetimeTarget(BENCH_TARGETS.local)), true);
    assert.equal(sameTarget(benchTarget('local'), benchTarget('live')), false);
  });
});
