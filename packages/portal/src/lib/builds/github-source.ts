import executor from './executor.mjs?raw';
import contract from './contract.mjs?raw';
import assets from './assets.mjs?raw';
import sandbox from './github-sandbox.mjs?raw';
import runner from './github-runner.mjs?raw';
import { BUILD_RUNTIME } from './contract.mjs';

export function githubBuildFiles(origin: string, org: string, revision: string) {
  return { 'executor.mjs': executor, 'contract.mjs': contract, 'assets.mjs': assets, 'github-sandbox.mjs': sandbox, 'github-runner.mjs': runner,
    'engine.json': JSON.stringify({ origin, org_id: org, revision }),
    'README.md': '# Typeroll GitHub builds\n\nGenerated organization runner. Typeroll dispatches frozen site/version publications explicitly. Source commits do not trigger builds. Images and hosting credentials are never stored in Git. Edit content in Typeroll.\n',
    '.github/workflows/build.yml': `name: Typeroll static build
run-name: Typeroll build \${{ inputs.dispatch_nonce }}
on:
  workflow_dispatch:
    inputs:
      task_key:
        type: string
        required: true
      dispatch_nonce:
        type: string
        required: true
permissions:
  contents: read
  id-token: write
jobs:
  build:
    runs-on: ubuntu-24.04
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1
        with:
          persist-credentials: false
      - uses: actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38
        with:
          node-version: '${BUILD_RUNTIME}'
      - name: Prepare qualified Linux sandbox
        run: sudo --preserve-env=GITHUB_ACTIONS,RUNNER_ENVIRONMENT "$(command -v node)" github-sandbox.mjs
      - name: Build frozen publication
        env:
          TYPEROLL_TASK_KEY: \${{ inputs.task_key }}
          TYPEROLL_DISPATCH_NONCE: \${{ inputs.dispatch_nonce }}
        run: node github-runner.mjs
` };
}
