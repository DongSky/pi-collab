import { pathToFileURL } from 'node:url';

// One catalogue for local selection and the manual foundation acceptance gate.
// Each item uses the existing isolated server/database and two browser accounts.
export const collabSuites = [
 'core', 'project-map', 'run-control', 'discussions', 'inline-integration',
 'workspace-git', 'push-history', 'pull-release', 'gitlab', 'evidence',
 'subtasks', 'capacity', 'administration', 'environment-handoff', 'history',
 'shared-terminal', 'editor', 'oidc', 'compatibility', 'memory', 'previews',
];
export function resolveCollabSuite(value) {
 const suite = value || 'core';
 if (!collabSuites.includes(suite)) throw new Error(`Unknown collaboration acceptance suite: ${suite}. Choose one of: ${collabSuites.join(', ')}`);
 return suite;
}
export function collabMatrix(value = 'all') {
 return { suite: value === 'all' ? collabSuites : [resolveCollabSuite(value)] };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
 if (process.argv[2] === '--matrix') console.log(`matrix=${JSON.stringify(collabMatrix(process.env.PI_COLLAB_SUITE_REQUEST))}`);
 else if (process.argv[2] === '--list') console.log(collabSuites.join('\n'));
 else throw new Error('Use --list or --matrix');
}
