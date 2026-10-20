const b = $json.body;
const address = value => typeof value === 'string' && value.toLowerCase() === 'ai@mobilityaccess.com.au';
const valid = $json.statusCode === 200 && b !== null && typeof b === 'object' && !Array.isArray(b)
  && (address(b.mail) || address(b.userPrincipalName))
  && (b.mail == null || address(b.mail)) && (b.userPrincipalName == null || address(b.userPrincipalName));
return [{json: {valid}}];
