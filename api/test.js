module.exports = async function handler(req, res) {
  res.json({
    status: 'ok',
    has_plaid_client_id: !!process.env.PLAID_CLIENT_ID,
    has_plaid_secret: !!process.env.PLAID_SECRET,
    plaid_env: process.env.PLAID_ENV || 'not set',
    has_supabase_url: !!process.env.SUPABASE_URL,
    has_supabase_key: !!process.env.SUPABASE_SERVICE_KEY,
    has_anthropic_key: !!process.env.ANTHROPIC_API_KEY,
    plaid_client_id_preview: process.env.PLAID_CLIENT_ID ? process.env.PLAID_CLIENT_ID.substring(0, 6) + '...' : 'missing',
    node_version: process.version
  });
};
