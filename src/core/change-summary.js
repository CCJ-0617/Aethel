import path from "node:path";

function parentPath(changePath) {
  const normalized = String(changePath || "").replace(/\\/g, "/").replace(/\/+$/, "");
  const parent = path.posix.dirname(normalized);
  return parent === "." ? "." : parent;
}

function sameValue(values) {
  return values.every((value) => value === values[0]);
}

function summaryStatus(changes) {
  const statuses = changes.map((change) => change.shortStatus);
  return sameValue(statuses) ? statuses[0] : "..";
}

function summaryDescription(changes) {
  const descriptions = changes.map((change) => change.description);
  if (sameValue(descriptions)) {
    return `${changes.length} changes: ${descriptions[0]}`;
  }
  return `${changes.length} changes`;
}

function makeChangeEntry(change, order) {
  return {
    kind: "change",
    order,
    path: change.path,
    shortStatus: change.shortStatus,
    description: change.description,
    count: 1,
    changes: [change],
    change,
  };
}

function makeGroupEntry(parent, changes, order) {
  return {
    kind: "group",
    order,
    path: parent === "." ? "." : `${parent}/`,
    shortStatus: summaryStatus(changes),
    description: summaryDescription(changes),
    count: changes.length,
    changes,
  };
}

export function summarizeChanges(changes, { detail = false } = {}) {
  if (detail) {
    return changes.map((change, order) => makeChangeEntry(change, order));
  }

  const groups = new Map();
  for (const [order, change] of changes.entries()) {
    const parent = parentPath(change.path);
    const group = groups.get(parent) || { parent, order, changes: [] };
    group.changes.push(change);
    groups.set(parent, group);
  }

  const entries = [];
  for (const group of groups.values()) {
    if (group.parent !== "." && group.changes.length > 1) {
      entries.push(makeGroupEntry(group.parent, group.changes, group.order));
      continue;
    }

    for (const change of group.changes) {
      entries.push(makeChangeEntry(change, group.order));
      group.order += 0.001;
    }
  }

  return entries.sort((left, right) => left.order - right.order);
}
