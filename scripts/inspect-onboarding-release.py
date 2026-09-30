#!/usr/bin/env python3
import json
from pathlib import Path
import re
import runpy
import subprocess
import sys
from urllib.error import HTTPError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
N8N_ROOT = Path('/Volumes/UG/MAM/opencode/n8n')
VERCEL = ('npx', 'vercel', '--global-config', '/Users/nixon/.vercel-profiles/mam')
PROJECT = 'mam-team-management-system'
SCOPE = 'ai-7033s-projects'
PROJECT_ID = 'prj_FRkEjfAFHj2FKfoYaowGMgicl1hu'
WORKFLOW = 'MAM People Hub - Onboarding Credentials (Live)'
CREDENTIALS = {
    'vFEolsXoEOOxNyan': ('Microsoft Outlook account - hr@mobilityaccess.com.au', 'microsoftOutlookOAuth2Api'),
    'tGtpwegru8OxtdCt': ('MAM Team Management - Notification Webhook Header', 'httpHeaderAuth'),
}
VARIABLES = (
    'ONBOARDING_CREDENTIAL_EMAIL_MODE', 'ONBOARDING_CREDENTIAL_WEBHOOK_ORIGIN',
    'ONBOARDING_CREDENTIAL_WEBHOOK_URL', 'ONBOARDING_CREDENTIAL_WEBHOOK_SECRET',
)


def run(*args, cwd=ROOT):
    return subprocess.run(args, cwd=cwd, capture_output=True, text=True, check=True, timeout=90).stdout


def api(config, path):
    base = config['N8N_BASE_URL'].rstrip('/')
    request = Request(base + '/api/v1/' + path,
                      headers={'X-N8N-API-KEY': config['N8N_API_KEY'], 'Accept': 'application/json'})
    with urlopen(request, timeout=20) as response:
        return json.load(response)


def inspect_n8n(config):
    credentials = api(config, 'credentials').get('data', [])
    workflows = []
    cursor = None
    while True:
        page = api(config, 'workflows?limit=250' + ('&cursor=' + cursor if cursor else ''))
        workflows.extend(page.get('data', []))
        cursor = page.get('nextCursor')
        if not cursor:
            break
    for ident, (name, kind) in CREDENTIALS.items():
        matches = [c for c in credentials if c.get('id') == ident]
        if len(matches) != 1 or matches[0].get('name') != name or matches[0].get('type') != kind:
            raise RuntimeError('Expected MAM n8n credential identity differs')
    collisions = [w for w in workflows if w.get('name') == WORKFLOW]
    if collisions:
        raise RuntimeError('Onboarding workflow name already exists; inspect it before staging')
    for workflow in workflows:
        detail = api(config, 'workflows/' + workflow['id'])
        if any(n.get('type') == 'n8n-nodes-base.webhook' and
               n.get('parameters', {}).get('path') == 'mam-people-hub-onboarding-credentials-v1'
               for n in detail.get('nodes', [])):
            raise RuntimeError('Onboarding webhook path already exists; inspect it before staging')
    try:
        projects = api(config, 'projects').get('data', [])
    except HTTPError as error:
        if error.code == 403:
            return 'blocked: MAM n8n project listing denied (HTTP 403); project ownership cannot be verified'
        raise
    if not projects:
        return 'blocked: no accessible MAM n8n project returned'
    return 'projects visible; select and verify the exact MAM project before staging'


def inspect_vercel():
    project = json.loads(run(*VERCEL, 'project', 'inspect', PROJECT, '--json'))
    if (project.get('id'), project.get('name'), project.get('owner', {}).get('slug')) != (PROJECT_ID, PROJECT, SCOPE):
        raise RuntimeError('MAM Vercel project identity differs')
    listing = subprocess.run((*VERCEL, 'env', 'ls', 'production', '--project', PROJECT,
                              '--scope', SCOPE, '--no-color'), cwd=ROOT, capture_output=True,
                             text=True, check=True, timeout=90)
    listing = listing.stdout + listing.stderr
    if f'Environment Variables found for {SCOPE}/{PROJECT}' not in listing:
        raise RuntimeError('MAM Vercel production environment listing target differs')
    found = {name for name in VARIABLES if re.search(r'^\s*' + re.escape(name) + r'\s+.*\bProduction\b', listing, re.M)}
    return {'project': f'{SCOPE}/{PROJECT}', 'productionVariablesPresent': sorted(found),
            'productionVariablesMissing': sorted(set(VARIABLES) - found)}


def main():
    if sys.argv[1:] != ['inspect']:
        raise RuntimeError('Only read-only inspect is supported')
    run('python3', 'scripts/verify.py', cwd=N8N_ROOT)
    config = runpy.run_path(str(N8N_ROOT / 'scripts' / 'verify.py'))['load_local_env']()
    if config.get('N8N_INSTANCE_LABEL') != 'MAM':
        raise RuntimeError('MAM n8n instance label differs')
    n8n = inspect_n8n(config)
    vercel = inspect_vercel()
    print(json.dumps({'n8n': n8n, 'vercel': vercel}, indent=2))


if __name__ == '__main__':
    try:
        main()
    except RuntimeError as error:
        print(str(error) if str(error) in {
            'Expected MAM n8n credential identity differs',
            'Onboarding workflow name already exists; inspect it before staging',
            'Onboarding webhook path already exists; inspect it before staging',
            'MAM Vercel project identity differs',
            'MAM Vercel production environment listing target differs',
            'MAM n8n instance label differs', 'Only read-only inspect is supported',
        } else 'Onboarding release inspection blocked (RuntimeError).', file=sys.stderr)
        sys.exit(1)
    except (KeyError, ValueError, OSError, subprocess.SubprocessError, HTTPError) as error:
        print('Onboarding release inspection blocked (' + type(error).__name__ + ').', file=sys.stderr)
        sys.exit(1)
