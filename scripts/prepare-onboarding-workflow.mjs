import { buildOnboardingCredentialWorkflow } from './build-onboarding-credential-workflow.mjs';

export function prepareInactiveWorkflow({ credentialId, credentialName }) {
  if (typeof credentialId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(credentialId)) {
    throw new Error('A verified MAM n8n webhook credential ID is required');
  }
  if (typeof credentialName !== 'string' || credentialName !== 'MAM People Hub - Onboarding Webhook Header') {
    throw new Error('The dedicated MAM webhook credential name is required');
  }
  const workflow = { ...buildOnboardingCredentialWorkflow({ webhookCredential: { id: credentialId, name: credentialName } }), active: false };
  if (workflow.nodes.some(node => node.type === 'n8n-nodes-base.webhook' &&
    (node.parameters.path !== 'mam-people-hub-onboarding-credentials-v1' || node.credentials?.httpHeaderAuth?.id !== credentialId))) {
    throw new Error('Unsafe onboarding workflow payload');
  }
  return workflow;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const [credentialId, credentialName] = process.argv.slice(2);
  if (process.argv.length !== 4) {
    console.error('Usage: node scripts/prepare-onboarding-workflow.mjs <verified-credential-id> "MAM People Hub - Onboarding Webhook Header"');
    process.exitCode = 1;
  } else {
    try {
      process.stdout.write(JSON.stringify(prepareInactiveWorkflow({ credentialId, credentialName })) + '\n');
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
