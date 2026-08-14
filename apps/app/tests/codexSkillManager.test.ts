import { describe, expect, it } from 'vitest';
import {
  buildCodexSkillTurnInput,
  normalizeCodexSkills,
  type CodexSkill,
} from '../src/workspaces/agents/codexSkillManager';

const skill: CodexSkill = {
  name: 'browser-check',
  description: 'Verify a local page',
  path: '/home/codex/.agents/skills/browser-check/SKILL.md',
  enabled: true,
  cwd: '/workspace',
  displayName: 'Browser Check',
  shortDescription: 'Verify the UI',
  dependencies: [],
};

describe('Codex Skill management', () => {
  it('normalizes cwd-scoped skills and interface metadata', () => {
    expect(normalizeCodexSkills({
      data: [{
        cwd: '/workspace',
        skills: [{
          name: 'browser-check',
          description: 'Verify a local page',
          path: skill.path,
          enabled: true,
          interface: { displayName: 'Browser Check', shortDescription: 'Verify the UI' },
          dependencies: { tools: [{ type: 'mcp', value: 'browser' }] },
        }],
      }],
    })).toEqual([{ ...skill, dependencies: [{
      type: 'mcp', value: 'browser', description: '',
    }] }]);
  });

  it('adds both the marker and explicit skill input for the next turn', () => {
    expect(buildCodexSkillTurnInput('Check the page', skill)).toEqual([
      { type: 'text', text: '$browser-check Check the page', text_elements: [] },
      { type: 'skill', name: 'browser-check', path: skill.path },
    ]);
  });

  it('does not duplicate a marker already present in the prompt', () => {
    expect(buildCodexSkillTurnInput('$browser-check Check the page', skill)[0]).toEqual({
      type: 'text', text: '$browser-check Check the page', text_elements: [],
    });
  });

  it('does not invoke a disabled skill', () => {
    expect(buildCodexSkillTurnInput('Check the page', { ...skill, enabled: false })).toEqual([
      { type: 'text', text: 'Check the page', text_elements: [] },
    ]);
  });
});
