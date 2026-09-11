// Report safe deployment-token metadata when diagnosing CI permission failures.
for (const endpoint of [`accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/tokens/verify`, 'user/tokens/verify']) {
  const response = await fetch(`https://api.cloudflare.com/client/v4/${endpoint}`, { headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}` } });
  const data = await response.json();
  if (data.success) { console.log(JSON.stringify({ token_id: data.result.id, status: data.result.status })); process.exit(0); }
}
throw new Error('Cloudflare deployment token could not be verified');
