import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { assembleSynthesis, skippedSynthesis } from '@/lib/adlab/pages/facts';
import { claimHeadline, type InsightFact } from '@/lib/brand-object/insights';

// The reuse-export fixture's 35 facts (positioning, value_prop, voc_* and more).
const fixture = JSON.parse(
  readFileSync(path.join(process.cwd(), 'docs/reuse-export/fixtures/brand-identity.json'), 'utf8')
) as { 'brand-object/facts': { facts: InsightFact[] } };
const facts = fixture['brand-object/facts'].facts;
const scope = { organizationId: 'org', brandProfileId: 'profile', brandName: 'Brand' };
const bySection = (section: string) => facts.filter((f) => f.section === section);
const byStatement = new Map(facts.map((f) => [f.statement, f]));

describe('assembleSynthesis', () => {
  const synthesis = assembleSynthesis(facts, scope);

  it('builds a ready, deterministic narrative headed by the positioning claim', () => {
    assert.ok(synthesis);
    const positioning = bySection('positioning')[0];
    assert.equal(synthesis.status, 'ready');
    assert.equal(synthesis.trigger, 'deterministic');
    assert.equal(synthesis.model, null);
    assert.equal(synthesis.headline, claimHeadline(positioning.statement, { maxLength: null }));
    assert.equal(synthesis.story[0], positioning.statement);
    assert.equal(synthesis.factsCount, facts.length);
  });

  it('uses only stored statements: strengths are praise, tensions are pain or objection', () => {
    assert.ok(synthesis);
    assert.ok(synthesis.strengths.length > 0 && synthesis.strengths.length <= 3);
    assert.ok(synthesis.tensions.length > 0 && synthesis.tensions.length <= 3);
    for (const s of synthesis.strengths) assert.equal(byStatement.get(s.point)?.section, 'voc_praise');
    for (const t of synthesis.tensions) {
      assert.ok(['voc_pain', 'voc_objection'].includes(byStatement.get(t.point)?.section ?? ''), t.point);
    }
    const valueProps = new Set(bySection('value_prop').map((f) => f.statement));
    // The second paragraph is the top value_prop statements, joined unedited.
    const story = synthesis.story[1] ?? '';
    const used = [...valueProps].filter((v) => story.includes(v)).sort((a, b) => story.indexOf(a) - story.indexOf(b));
    assert.ok(used.length > 0);
    assert.equal(story, used.join(' '));
  });

  it("cites each finding's real mention count and only verbatim quotes", () => {
    assert.ok(synthesis);
    for (const finding of [...synthesis.strengths, ...synthesis.tensions]) {
      const fact = byStatement.get(finding.point);
      assert.ok(fact);
      const count = /^VOC (?:praise|pain|objection) (\d+) mentions/.exec(finding.evidence);
      assert.ok(count, finding.evidence);
      assert.equal(Number(count[1]), fact.metrics.frequency ?? 0);
      const quote = /verbatim: "([^"]*)"/.exec(finding.evidence)?.[1];
      if (quote) assert.ok(fact.evidence.some((ref) => ref.quote?.includes(quote)), quote);
    }
  });

  it('returns null without a positioning fact, and skippedSynthesis is empty', () => {
    const withoutPositioning = facts.filter((f) => f.section !== 'positioning');
    assert.equal(assembleSynthesis(withoutPositioning, scope), null);
    const skipped = skippedSynthesis(scope, withoutPositioning);
    assert.equal(skipped.status, 'skipped');
    assert.equal(skipped.headline, null);
    assert.deepEqual([skipped.story, skipped.strengths, skipped.tensions], [[], [], []]);
  });
});
