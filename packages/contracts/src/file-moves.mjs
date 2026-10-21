export const withinPath = (value, parent) => value === parent || value.startsWith(`${parent}/`);
export function pathAfterMove(value, move) {
  return value === move.source || move.kind === 'directory' && withinPath(value, move.source) ? move.path + value.slice(move.source.length) : value;
}

// Patch only directory listings that are already complete. Creating a destination
// listing containing just the moved item would hide its other, unread children.
export function treeAfterMove(tree, move) {
  if (!move.moved) return tree;
  const source = Object.values(tree).flat().find(entry => entry.path === move.source);
  const next = {};
  for (const [directory, entries] of Object.entries(tree)) {
    if (withinPath(directory, move.path) && !withinPath(directory, move.source)) continue;
    if (move.kind !== 'directory' && withinPath(directory, move.source)) continue;
    next[pathAfterMove(directory, move)] = entries.filter(entry => entry.path !== move.source).map(entry => ({ ...entry, path: pathAfterMove(entry.path, move) }));
  }
  if (source && next[move.directory]) {
    next[move.directory] = [...next[move.directory].filter(entry => entry.path !== move.path), { ...source, path: move.path }]
      .sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name));
  }
  return next;
}
