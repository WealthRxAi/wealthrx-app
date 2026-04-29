// Disconnect a bank from WealthRx
// Logic:
// 1. Revoke the Plaid item (removes our access)
// 2. Delete the bank_connections record
// 3. If this was the user's LAST connected bank, delete all their transactions
//    so dashboard shows zero. If they have other banks, leave transactions alone.

const PLAID_CLIENT_ID = process.env.PLAID_CLIENT_ID;
const PLAID_SECRET = process.env.PLAID_SECRET;
const PLAID_ENV = process.env.PLAID_ENV || 'production';
const PLAID_BASE_URL = PLAID_ENV === 'production' 
  ? 'https://production.plaid.com' 
  : 'https://sandbox.plaid.com';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { user_id, connection_id } = req.body;

    if (!user_id || !connection_id) {
      return res.status(400).json({ error: 'user_id and connection_id required' });
    }

    // Step 1: Get the bank connection details
    const getConnRes = await fetch(
      `${SUPABASE_URL}/rest/v1/bank_connections?id=eq.${connection_id}&user_id=eq.${user_id}&select=*`,
      {
        headers: {
          'apikey': SUPABASE_SERVICE_KEY,
          'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const connections = await getConnRes.json();

    if (!Array.isArray(connections) || connections.length === 0) {
      return res.status(404).json({ error: 'Bank connection not found' });
    }

    const connection = connections[0];
    const accessToken = connection.access_token;

    // Step 2: Revoke the Plaid item
    if (accessToken) {
      try {
        await fetch(`${PLAID_BASE_URL}/item/remove`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            client_id: PLAID_CLIENT_ID,
            secret: PLAID_SECRET,
            access_token: accessToken
          })
        });
      } catch (plaidErr) {
        // Continue even if Plaid revoke fails (token might be expired)
        console.error('Plaid revoke failed (continuing):', plaidErr.message);
      }
    }

    // Step 3: Delete the bank_connections record
    const deleteConnRes = await fetch(
      `${SUPABASE_URL}/rest/v1/bank_connections?id=eq.${connection_id}&user_id=eq.${user_id}`,
      {
        method: 'DELETE',
        headers: {
          'apikey': SUPABASE_SERVICE_KEY,
          'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=minimal'
        }
      }
    );

    if (!deleteConnRes.ok) {
      const errText = await deleteConnRes.text();
      return res.status(500).json({ error: 'Failed to delete bank connection', details: errText });
    }

    // Step 4: Check if user has any remaining bank connections
    const remainingRes = await fetch(
      `${SUPABASE_URL}/rest/v1/bank_connections?user_id=eq.${user_id}&select=id`,
      {
        headers: {
          'apikey': SUPABASE_SERVICE_KEY,
          'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const remainingConnections = await remainingRes.json();
    const hasOtherBanks = Array.isArray(remainingConnections) && remainingConnections.length > 0;

    let transactionsDeleted = false;

    // Step 5: If this was the LAST bank, clean up all transactions
    if (!hasOtherBanks) {
      const deleteTxRes = await fetch(
        `${SUPABASE_URL}/rest/v1/transactions?user_id=eq.${user_id}`,
        {
          method: 'DELETE',
          headers: {
            'apikey': SUPABASE_SERVICE_KEY,
            'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
            'Content-Type': 'application/json',
            'Prefer': 'return=minimal'
          }
        }
      );

      if (deleteTxRes.ok) {
        transactionsDeleted = true;
      } else {
        const errText = await deleteTxRes.text();
        console.error('Failed to delete transactions:', errText);
      }
    }

    return res.status(200).json({ 
      success: true,
      message: hasOtherBanks 
        ? 'Bank disconnected. Other banks remain connected.'
        : 'Bank disconnected. All transactions cleared since no banks remain.',
      transactions_deleted: transactionsDeleted
    });

  } catch (error) {
    console.error('Disconnect bank error:', error.message);
    return res.status(500).json({ 
      error: 'Server error', 
      details: error.message 
    });
  }
};
