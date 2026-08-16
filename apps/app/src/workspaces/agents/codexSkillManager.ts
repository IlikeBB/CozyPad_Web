export type CodexSkillDependency = {
  type?: string;
  value?: string;
  description?: string;
};

export type CodexSkill = {
  name: string;
  description: string;
  path: string;
  enabled: boolean;
  cwd: string;
  displayName: string;
  shortDescription: string;
  dependencies: CodexSkillDependency[];
};

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : {};
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function normalizeCodexSkills(response: unknown): CodexSkill[] {
  const root = asRecord(response);
  const groups = Array.isArray(root.data) ? root.data : [];
  const normalized: CodexSkill[] = [];

  for (const rawGroup of groups) {
    const group = asRecord(rawGroup);
    const cwd = text(group.cwd);
    const rawSkills = Array.isArray(group.skills) ? group.skills : [rawGroup];
    for (const rawSkill of rawSkills) {
      const skill = asRecord(rawSkill);
      const name = text(skill.name);
      if (!name) continue;
      const interfaceInfo = asRecord(skill.interface);
      const dependencyInfo = asRecord(skill.dependencies);
      const rawDependencies = Array.isArray(dependencyInfo.tools)
        ? dependencyInfo.tools
        : [];
      normalized.push({
        name,
        description: text(skill.description),
        path: text(skill.path),
        enabled: skill.enabled !== false,
        cwd,
        displayName: text(interfaceInfo.displayName) || name,
        shortDescription: text(interfaceInfo.shortDescription),
        dependencies: rawDependencies.map((dependency) => {
          const item = asRecord(dependency);
          return {
            type: text(item.type),
            value: text(item.value),
            description: text(item.description),
          };
        }),
      });
    }
  }

  return [...new Map(
    normalized.map((skill) => [`${skill.cwd}\u0000${skill.path || skill.name}`, skill]),
  ).values()].sort((left, right) => left.displayName.localeCompare(right.displayName));
}

export function buildCodexSkillTurnInput(prompt: string, skill: CodexSkill | null): UnknownRecord[] {
  const cleanPrompt = prompt.trim();
  if (!skill || !skill.enabled) {
    return [{ type: 'text', text: cleanPrompt, text_elements: [] }];
  }

  const marker = `$${skill.name}`;
  const mentioned = new RegExp(
    `(^|\\s)\\$${escapeRegularExpression(skill.name)}(?=\\s|$)`,
  ).test(cleanPrompt);
  const input: UnknownRecord[] = [{
    type: 'text',
    text: mentioned ? cleanPrompt : `${marker} ${cleanPrompt}`,
    text_elements: [],
  }];
  if (skill.path) input.push({ type: 'skill', name: skill.name, path: skill.path });
  return input;
}
