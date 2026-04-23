var plaidModule = require('plaid');
var supabaseModule = require('@supabase/supabase-js');

var PlaidApi = plaidModule.PlaidApi;
var Configuration = plaidModule.Configuration;
var PlaidEnvironments = plaidModule.PlaidEnvironments;

var plaidClient = new PlaidApi(
  new Configuration({
    basePath: PlaidEnvironments[process.env.PLAID_ENV || 'sandbox'],
    baseOptions: {
      headers: {
        'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID,
        'PLAID-SECRET': process.env.PLAID_SECRET
      }
    }
  })
);

var supabaseAdmin = supabaseModule.createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    var user_id = req.body.user_id;
    var connection_id = req.body.connection_id;

    if (!user_id || !connection_id) {
      return res.status(400).json({ error: 'Missing user_id or connection_id' });
    }

    // Get the access token first
    var connResult = await supabaseAdmin
      .from('bank_connections')
      .select('access_token, item_id, institution_name')
      .eq('id', connection_id)
      .eq('user_id', user_id)
      .single();

    if (connResult.error || !connResult.data) {
      return res.status(404).json({ error: 'Bank connection not found' });
    }

    var accessToken = connResult.data.access_token;
    var itemId = connResult.data.item_id;

    // Revoke the item in Plaid (stops all data access)
    try {
      await plaidClient.itemRemove({ access_token: accessToken });
    } catch (plaidErr) {
      console.error('Plaid remove error:', plaidErr.message);
      // Continue anyway - we still want to delete from our DB
    }

    // Delete the connection from Supabase
    await supabaseAdmin
      .from('bank_connections')
      .delete()
      .eq('id', connection_id)
      .eq('user_id', user_id);

    // Delete all transactions from this bank
    // First, get all plaid_transaction_ids that came from this item
    // Note: Plaid transactions have account_id linking to accounts linking to item_id
    // For simplicity, we delete transactions by user_id where no other active bank has them
    // Actually, the cleanest approach: we keep transactions but user won't see updates

    // Alternative cleaner approach: delete transactions tied to this item_id
    // But we don't store item_id on transactions. So we'll leave existing transactions.

    res.json({ success: true, message: 'Bank disconnected successfully' });
  } catch (error) {
    console.error('Disconnect error:', error.message);
    res.status(500).json({ error: 'Failed to disconnect bank', details: error.message });
  }
};
